import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PosterHandoffRecoveryError,
  RecoverPosterHandoffService,
} from "../src/application/recover-poster-handoff.js";
import {
  createPosterHandoffIdentity,
  PosterHandoffError,
  SubmitPaidOrderToPosterService,
} from "../src/application/submit-paid-order-to-poster.js";
import {
  createSumUpPayment,
  type PaymentRecord,
  type VerifiedSumUpCheckout,
} from "../src/domain/payment.js";
import {
  addItem,
  createOrder,
  markAwaitingPayment,
  setPickup,
  type Order,
} from "../src/domain/order.js";
import type {
  PosterOrderSubmissionIdentity,
  PosterOrderSubmissionInspector,
  PosterOrderSubmitter,
} from "../src/integrations/poster/submitter.js";
import {
  InjectedPosterSandboxSubmitter,
  type PosterSandboxPostTransport,
} from "../src/integrations/poster/sandbox-submitter.js";
import { SqliteOrderPaymentRepository } from "../src/storage/sqlite/order-payment-repository.js";

const createdAt = new Date("2026-09-10T14:00:00.000Z");
const paidAt = new Date("2026-09-10T14:01:00.000Z");
const submittedAt = new Date("2026-09-10T14:02:00.000Z");

const repositories: SqliteOrderPaymentRepository[] = [];
const temporaryDirectories: string[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network access is forbidden in Poster handoff tests");
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0).reverse()) {
    repository.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "poster-handoff-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "orders.sqlite");
}

function openRepository(databasePath: string): SqliteOrderPaymentRepository {
  const repository = new SqliteOrderPaymentRepository(databasePath);
  repositories.push(repository);
  return repository;
}

function createStoredPair(
  repository: SqliteOrderPaymentRepository,
  suffix: string,
): { order: Order; payment: PaymentRecord } {
  let order = createOrder({
    createId: () => `ord_poster_handoff_${suffix}`,
    now: () => createdAt,
  });
  order = addItem(
    order,
    {
      id: "1",
      name: "Local Test Product",
      unitPriceCents: 1_000,
      available: true,
    },
    1,
    createdAt,
  );
  order = markAwaitingPayment(setPickup(order, createdAt), createdAt);
  const payment = createSumUpPayment({
    order,
    checkoutId: `checkout-${suffix}`,
    checkoutReference: `sumup-${order.id}-1`,
    merchantCode: "MTEST123",
    amountCents: 1_000,
    currency: "EUR",
    now: createdAt,
  });
  repository.createOrderWithPayment(order, payment);
  return { order, payment };
}

function markStoredPairPaid(
  repository: SqliteOrderPaymentRepository,
  pair: { order: Order; payment: PaymentRecord },
): void {
  const checkout: VerifiedSumUpCheckout = {
    checkoutId: pair.payment.checkoutId,
    checkoutReference: pair.payment.checkoutReference,
    merchantCode: pair.payment.merchantCode,
    amountCents: pair.payment.amountCents,
    currency: "EUR",
    status: "PAID",
    transactions: [
      {
        id: `transaction-${pair.order.id}`,
        status: "SUCCESSFUL",
        amountCents: pair.payment.amountCents,
        currency: "EUR",
      },
    ],
  };
  repository.reconcileVerifiedSumUpCheckout(checkout, paidAt);
}

function createInput(orderId: string) {
  return {
    orderId,
    spotId: "1",
    customer: {
      firstName: "Local Test",
      lastName: "Customer",
      phone: "+353000000000",
    },
    comment: "LOCAL TEST ONLY",
  };
}

function createSubmitter(posterOrderId: string): PosterOrderSubmitter {
  return {
    submitOrder: vi.fn(async () => ({ posterOrderId })),
  };
}

function createIdentity(orderId: string): PosterOrderSubmissionIdentity {
  return {
    correlationId: `poster-handoff:${orderId}`,
    payloadFingerprint: "a".repeat(64),
  };
}

function createService(
  repository: SqliteOrderPaymentRepository,
  submitter: PosterOrderSubmitter,
): SubmitPaidOrderToPosterService {
  return new SubmitPaidOrderToPosterService({
    repository,
    submitter,
    now: () => submittedAt,
  });
}

function createRecoveryService(
  repository: SqliteOrderPaymentRepository,
  inspector: PosterOrderSubmissionInspector,
): RecoverPosterHandoffService {
  return new RecoverPosterHandoffService({
    repository,
    inspector,
    now: () => submittedAt,
  });
}

describe("local paid-order Poster handoff", () => {
  it("creates a stable local identity for the minimal diagnostic shape", () => {
    const payload = {
      spot_id: 1,
      phone: "+353000000000",
      products: [{ product_id: 1, count: 1 }] as [
        { product_id: number; count: number },
      ],
    };

    const identity = createPosterHandoffIdentity("ord_minimal", payload);
    expect(identity.correlationId).toBe("poster-handoff:ord_minimal");
    expect(identity.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(createPosterHandoffIdentity("ord_minimal", payload)).toEqual(
      identity,
    );
  });

  it("does not submit an order that is still awaiting payment", async () => {
    const repository = openRepository(createDatabasePath());
    const pair = createStoredPair(repository, "awaiting-payment");
    const submitter = createSubmitter("poster-order-unused");
    const service = createService(repository, submitter);

    await expect(service.submit(createInput(pair.order.id))).rejects.toThrow(
      "requires a locally confirmed paid order",
    );
    expect(submitter.submitOrder).not.toHaveBeenCalled();
    expect(repository.findPosterHandoffByOrderId(pair.order.id)).toBeUndefined();
  });

  it("submits a paid order once with only the agreed current payload", async () => {
    const repository = openRepository(createDatabasePath());
    const pair = createStoredPair(repository, "success");
    markStoredPairPaid(repository, pair);
    const submitter = createSubmitter("poster-order-success");
    const service = createService(repository, submitter);

    await expect(service.submit(createInput(pair.order.id))).resolves.toEqual({
      outcome: "submitted",
    });
    expect(submitter.submitOrder).toHaveBeenCalledOnce();
    expect(submitter.submitOrder).toHaveBeenCalledWith({
      correlationId: `poster-handoff:${pair.order.id}`,
      payloadFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      payload: {
        spot_id: 1,
        first_name: "Local Test",
        last_name: "Customer",
        phone: "+353000000000",
        comment: "LOCAL TEST ONLY",
        products: [{ product_id: 1, count: 1, price: 1_000 }],
        payment: { type: 1, sum: 1_000, currency: "EUR" },
      },
    });
    const submission = vi.mocked(submitter.submitOrder).mock.calls.at(0)?.at(0);
    expect(submission).toBeDefined();
    if (submission === undefined) {
      throw new Error("Expected one local Poster submission");
    }
    expect(submission.correlationId).toBe(`poster-handoff:${pair.order.id}`);
    expect(repository.findOrderById(pair.order.id)?.status).toBe(
      "submitted_to_poster",
    );
    expect(repository.findPosterHandoffByOrderId(pair.order.id)).toMatchObject({
      status: "submitted",
      posterOrderId: "poster-order-success",
      submittedAt: submittedAt.toISOString(),
      correlationId: submission.correlationId,
      payloadFingerprint: submission.payloadFingerprint,
    });
  });

  it("returns duplicate without a second transport call", async () => {
    const repository = openRepository(createDatabasePath());
    const pair = createStoredPair(repository, "duplicate");
    markStoredPairPaid(repository, pair);
    const submitter = createSubmitter("poster-order-duplicate");
    const service = createService(repository, submitter);

    await expect(service.submit(createInput(pair.order.id))).resolves.toEqual({
      outcome: "submitted",
    });
    const orderAfterSubmission = repository.findOrderById(pair.order.id);
    const paymentAfterSubmission = repository.findByOrderId(pair.order.id);
    const handoffAfterSubmission =
      repository.findPosterHandoffByOrderId(pair.order.id);
    await expect(service.submit(createInput(pair.order.id))).resolves.toEqual({
      outcome: "duplicate",
    });
    expect(submitter.submitOrder).toHaveBeenCalledOnce();
    expect(repository.findOrderById(pair.order.id)).toEqual(orderAfterSubmission);
    expect(repository.findByOrderId(pair.order.id)).toEqual(
      paymentAfterSubmission,
    );
    expect(repository.findPosterHandoffByOrderId(pair.order.id)).toEqual(
      handoffAfterSubmission,
    );
  });

  it("allows only one concurrent submission on the same SQLite connection", async () => {
    const repository = openRepository(createDatabasePath());
    const pair = createStoredPair(repository, "same-connection-race");
    markStoredPairPaid(repository, pair);
    let releaseTransport: ((value: { posterOrderId: string }) => void) | undefined;
    const submitter: PosterOrderSubmitter = {
      submitOrder: vi.fn(
        () =>
          new Promise<{ posterOrderId: string }>((resolve) => {
            releaseTransport = resolve;
          }),
      ),
    };
    const service = createService(repository, submitter);

    const first = service.submit(createInput(pair.order.id));
    await expect(service.submit(createInput(pair.order.id))).resolves.toEqual({
      outcome: "in_progress",
    });
    expect(submitter.submitOrder).toHaveBeenCalledOnce();

    releaseTransport?.({ posterOrderId: "poster-order-same-connection" });
    await expect(first).resolves.toEqual({ outcome: "submitted" });
  });

  it("allows only one concurrent submission across SQLite connections", async () => {
    const databasePath = createDatabasePath();
    const firstRepository = openRepository(databasePath);
    const pair = createStoredPair(firstRepository, "two-connection-race");
    markStoredPairPaid(firstRepository, pair);
    const secondRepository = openRepository(databasePath);
    let releaseTransport: ((value: { posterOrderId: string }) => void) | undefined;
    const firstSubmitter: PosterOrderSubmitter = {
      submitOrder: vi.fn(
        () =>
          new Promise<{ posterOrderId: string }>((resolve) => {
            releaseTransport = resolve;
          }),
      ),
    };
    const secondSubmitter = createSubmitter("poster-order-must-not-be-used");

    const first = createService(firstRepository, firstSubmitter).submit(
      createInput(pair.order.id),
    );
    await expect(
      createService(secondRepository, secondSubmitter).submit(
        createInput(pair.order.id),
      ),
    ).resolves.toEqual({ outcome: "in_progress" });
    expect(firstSubmitter.submitOrder).toHaveBeenCalledOnce();
    expect(secondSubmitter.submitOrder).not.toHaveBeenCalled();

    releaseTransport?.({ posterOrderId: "poster-order-two-connections" });
    await expect(first).resolves.toEqual({ outcome: "submitted" });
  });

  it("keeps the order paid and blocks retry after a transport error", async () => {
    const databasePath = createDatabasePath();
    const repository = openRepository(databasePath);
    const pair = createStoredPair(repository, "transport-error");
    markStoredPairPaid(repository, pair);
    const submitter: PosterOrderSubmitter = {
      submitOrder: vi.fn(async () => {
        throw new Error("private transport detail");
      }),
    };
    const service = createService(repository, submitter);

    await expect(service.submit(createInput(pair.order.id))).rejects.toMatchObject({
      name: "PosterHandoffError",
      message: "Poster submission was not confirmed; automatic retry is blocked",
    });
    expect(repository.findOrderById(pair.order.id)?.status).toBe("paid");
    expect(repository.findPosterHandoffByOrderId(pair.order.id)).toMatchObject({
      status: "uncertain",
      posterOrderId: null,
      submittedAt: null,
    });

    await expect(service.submit(createInput(pair.order.id))).resolves.toEqual({
      outcome: "uncertain",
    });
    expect(submitter.submitOrder).toHaveBeenCalledOnce();

    repository.close();
    const reopenedRepository = openRepository(databasePath);
    const restartedSubmitter = createSubmitter("poster-order-must-not-be-used");
    await expect(
      createService(reopenedRepository, restartedSubmitter).submit(
        createInput(pair.order.id),
      ),
    ).resolves.toEqual({ outcome: "uncertain" });
    expect(restartedSubmitter.submitOrder).not.toHaveBeenCalled();
    expect(reopenedRepository.findOrderById(pair.order.id)?.status).toBe("paid");
  });

  it("keeps a concrete sandbox network failure uncertain without false submission", async () => {
    const repository = openRepository(createDatabasePath());
    const pair = createStoredPair(repository, "sandbox-network-error");
    markStoredPairPaid(repository, pair);
    const transport: PosterSandboxPostTransport = {
      isEnabled: () => true,
      post: vi.fn(async () => {
        throw new Error("synthetic timeout");
      }),
    };
    const submitter = new InjectedPosterSandboxSubmitter(transport);
    const service = createService(repository, submitter);

    await expect(
      service.submit({
        ...createInput(pair.order.id),
        comment: `poster-handoff:${pair.order.id}`,
      }),
    ).rejects.toMatchObject({
      name: "PosterHandoffError",
      message: "Poster submission was not confirmed; automatic retry is blocked",
    });
    expect(transport.post).toHaveBeenCalledOnce();
    expect(repository.findOrderById(pair.order.id)?.status).toBe("paid");
    expect(repository.findPosterHandoffByOrderId(pair.order.id)).toMatchObject({
      status: "uncertain",
      posterOrderId: null,
      submittedAt: null,
    });

    await expect(
      service.submit({
        ...createInput(pair.order.id),
        comment: `poster-handoff:${pair.order.id}`,
      }),
    ).resolves.toEqual({ outcome: "uncertain" });
    expect(transport.post).toHaveBeenCalledOnce();
  });

  it("deduplicates a completed handoff after reopening SQLite", async () => {
    const databasePath = createDatabasePath();
    const firstRepository = openRepository(databasePath);
    const pair = createStoredPair(firstRepository, "restart");
    markStoredPairPaid(firstRepository, pair);
    const firstSubmitter = createSubmitter("poster-order-restart");

    await expect(
      createService(firstRepository, firstSubmitter).submit(
        createInput(pair.order.id),
      ),
    ).resolves.toEqual({ outcome: "submitted" });
    const orderAfterSubmission = firstRepository.findOrderById(pair.order.id);
    const paymentAfterSubmission = firstRepository.findByOrderId(pair.order.id);
    const handoffAfterSubmission =
      firstRepository.findPosterHandoffByOrderId(pair.order.id);
    firstRepository.close();

    const reopenedRepository = openRepository(databasePath);
    const secondSubmitter = createSubmitter("poster-order-must-not-be-used");
    await expect(
      createService(reopenedRepository, secondSubmitter).submit(
        createInput(pair.order.id),
      ),
    ).resolves.toEqual({ outcome: "duplicate" });
    expect(firstSubmitter.submitOrder).toHaveBeenCalledOnce();
    expect(secondSubmitter.submitOrder).not.toHaveBeenCalled();
    expect(reopenedRepository.findOrderById(pair.order.id)?.status).toBe(
      "submitted_to_poster",
    );
    expect(reopenedRepository.findOrderById(pair.order.id)).toEqual(
      orderAfterSubmission,
    );
    expect(reopenedRepository.findByOrderId(pair.order.id)).toEqual(
      paymentAfterSubmission,
    );
    expect(reopenedRepository.findByOrderId(pair.order.id)).toMatchObject({
      successfulTransactionId: `transaction-${pair.order.id}`,
      paidAt: paidAt.toISOString(),
    });
    expect(reopenedRepository.findPosterHandoffByOrderId(pair.order.id)).toEqual(
      handoffAfterSubmission,
    );
  });

  it("does not resend an in-progress handoff after reopening SQLite", async () => {
    const databasePath = createDatabasePath();
    const firstRepository = openRepository(databasePath);
    const pair = createStoredPair(firstRepository, "restart-in-progress");
    markStoredPairPaid(firstRepository, pair);

    expect(
      firstRepository.claimPosterHandoff(
        pair.order.id,
        createIdentity(pair.order.id),
        submittedAt,
      ),
    ).toEqual({ outcome: "claimed" });
    firstRepository.close();

    const reopenedRepository = openRepository(databasePath);
    const submitter = createSubmitter("poster-order-must-not-be-used");
    await expect(
      createService(reopenedRepository, submitter).submit(
        createInput(pair.order.id),
      ),
    ).resolves.toEqual({ outcome: "in_progress" });
    expect(submitter.submitOrder).not.toHaveBeenCalled();
    expect(reopenedRepository.findOrderById(pair.order.id)?.status).toBe("paid");
    expect(
      reopenedRepository.findPosterHandoffByOrderId(pair.order.id),
    ).toMatchObject({ status: "submitting" });
  });

  it("uses a safe error type without exposing the transport error", async () => {
    const repository = openRepository(createDatabasePath());
    const pair = createStoredPair(repository, "safe-error");
    markStoredPairPaid(repository, pair);
    const service = createService(repository, {
      submitOrder: vi.fn(async () => {
        throw new Error("secret response body");
      }),
    });

    const request = service.submit(createInput(pair.order.id));
    await expect(request).rejects.toBeInstanceOf(PosterHandoffError);
    await expect(request).rejects.not.toThrow("secret response body");
  });

  it("persists unknown recovery state without resubmitting after restart", async () => {
    const databasePath = createDatabasePath();
    const firstRepository = openRepository(databasePath);
    const pair = createStoredPair(firstRepository, "recovery-unknown");
    markStoredPairPaid(firstRepository, pair);
    const identity = createIdentity(pair.order.id);
    expect(
      firstRepository.claimPosterHandoff(pair.order.id, identity, submittedAt),
    ).toEqual({ outcome: "claimed" });
    firstRepository.close();

    const reopenedRepository = openRepository(databasePath);
    const inspector: PosterOrderSubmissionInspector = {
      inspectSubmission: vi.fn(async () => ({ outcome: "unknown" as const })),
    };
    const recovery = createRecoveryService(reopenedRepository, inspector);

    expect(recovery.inspect(pair.order.id)).toEqual({
      outcome: "unknown",
      state: "submitting",
      ...identity,
    });
    await expect(recovery.recover(pair.order.id)).resolves.toEqual({
      outcome: "unknown",
    });
    expect(inspector.inspectSubmission).toHaveBeenCalledOnce();
    expect(reopenedRepository.findOrderById(pair.order.id)?.status).toBe("paid");
    expect(
      reopenedRepository.findPosterHandoffByOrderId(pair.order.id),
    ).toMatchObject({ status: "uncertain", ...identity });

    reopenedRepository.close();
    const secondReopen = openRepository(databasePath);
    expect(
      createRecoveryService(secondReopen, inspector).inspect(pair.order.id),
    ).toEqual({ outcome: "unknown", state: "uncertain", ...identity });
  });

  it("completes recovery only from a matching confirmed inspection", async () => {
    const repository = openRepository(createDatabasePath());
    const pair = createStoredPair(repository, "recovery-confirmed");
    markStoredPairPaid(repository, pair);
    const identity = createIdentity(pair.order.id);
    repository.claimPosterHandoff(pair.order.id, identity, submittedAt);
    repository.markPosterHandoffUncertain(pair.order.id, identity, submittedAt);
    const inspector: PosterOrderSubmissionInspector = {
      inspectSubmission: vi.fn(async () => ({
        outcome: "confirmed" as const,
        orderId: pair.order.id,
        posterOrderId: "poster-order-recovered",
        ...identity,
      })),
    };
    const recovery = createRecoveryService(repository, inspector);

    await expect(recovery.recover(pair.order.id)).resolves.toEqual({
      outcome: "confirmed",
    });
    expect(repository.findOrderById(pair.order.id)?.status).toBe(
      "submitted_to_poster",
    );
    expect(repository.findPosterHandoffByOrderId(pair.order.id)).toMatchObject({
      status: "submitted",
      posterOrderId: "poster-order-recovered",
      ...identity,
    });

    const orderAfterConfirmation = repository.findOrderById(pair.order.id);
    const paymentAfterConfirmation = repository.findByOrderId(pair.order.id);
    const handoffAfterConfirmation =
      repository.findPosterHandoffByOrderId(pair.order.id);
    await expect(recovery.recover(pair.order.id)).resolves.toEqual({
      outcome: "duplicate",
    });
    expect(inspector.inspectSubmission).toHaveBeenCalledOnce();
    expect(repository.findOrderById(pair.order.id)).toEqual(
      orderAfterConfirmation,
    );
    expect(repository.findByOrderId(pair.order.id)).toEqual(
      paymentAfterConfirmation,
    );
    expect(repository.findPosterHandoffByOrderId(pair.order.id)).toEqual(
      handoffAfterConfirmation,
    );
  });

  it("rejects mismatched recovery confirmation without marking the order submitted", async () => {
    const repository = openRepository(createDatabasePath());
    const pair = createStoredPair(repository, "recovery-mismatch");
    markStoredPairPaid(repository, pair);
    const identity = createIdentity(pair.order.id);
    repository.claimPosterHandoff(pair.order.id, identity, submittedAt);
    const recovery = createRecoveryService(repository, {
      inspectSubmission: vi.fn(async () => ({
        outcome: "confirmed" as const,
        orderId: pair.order.id,
        posterOrderId: "poster-order-wrong-proof",
        correlationId: identity.correlationId,
        payloadFingerprint: "b".repeat(64),
      })),
    });

    await expect(recovery.recover(pair.order.id)).rejects.toBeInstanceOf(
      PosterHandoffRecoveryError,
    );
    expect(repository.findOrderById(pair.order.id)?.status).toBe("paid");
    expect(repository.findPosterHandoffByOrderId(pair.order.id)).toMatchObject({
      status: "uncertain",
      posterOrderId: null,
      ...identity,
    });
  });

  it("does not expose an inspector error while preserving unknown state", async () => {
    const repository = openRepository(createDatabasePath());
    const pair = createStoredPair(repository, "recovery-safe-error");
    markStoredPairPaid(repository, pair);
    const identity = createIdentity(pair.order.id);
    repository.claimPosterHandoff(pair.order.id, identity, submittedAt);
    const recovery = createRecoveryService(repository, {
      inspectSubmission: vi.fn(async () => {
        throw new Error("private Poster response body");
      }),
    });

    const request = recovery.recover(pair.order.id);
    await expect(request).rejects.toBeInstanceOf(PosterHandoffRecoveryError);
    await expect(request).rejects.not.toThrow("private Poster response body");
    expect(repository.findOrderById(pair.order.id)?.status).toBe("paid");
    expect(repository.findPosterHandoffByOrderId(pair.order.id)).toMatchObject({
      status: "uncertain",
      posterOrderId: null,
      ...identity,
    });
  });
});
