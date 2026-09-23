import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  POSTER_PREPAID_SANDBOX_CHECKOUT_CONFIRMATION,
  createPosterPrepaidSandboxE2eCheckout,
} from "../src/application/create-poster-prepaid-sandbox-e2e-checkout.js";
import { POSTER_PREPAID_SANDBOX_E2E_CONFIRMATION } from "../src/application/prepare-poster-prepaid-sandbox-e2e.js";
import { SumUpSandboxCheckoutVerifier } from "../src/integrations/sumup/checkout-verifier.js";
import type { PosterOrderSubmitter } from "../src/integrations/poster/submitter.js";
import { SqliteOrderPaymentRepository } from "../src/storage/sqlite/order-payment-repository.js";
import {
  PosterPrepaidSandboxWebhookBridge,
  assertPosterPrepaidSandboxRecovery,
  submitPosterPrepaidSandboxPaidOrder,
  type PosterPrepaidSandboxRecoveryContext,
} from "../src/scripts/poster-prepaid-sandbox-e2e-bridge.js";
import {
  FilePosterPrepaidSandboxCheckoutLifecycle,
  FilePosterPrepaidSandboxVerificationClaim,
  readPosterPrepaidSandboxE2eAttempt,
  readPosterPrepaidSandboxE2eRecoveryState,
  resolvePosterPrepaidSandboxE2ePaths,
} from "../src/scripts/poster-prepaid-sandbox-e2e-local-state.js";
import { resolveSumUpE2eRecoveryPaths } from "../src/scripts/sumup-e2e-local-state.js";

const createdAt = new Date("2026-09-23T12:00:00.000Z");
const paidAt = new Date("2026-09-23T12:05:00.000Z");
const product = {
  productId: "1",
  spotId: "1",
  name: "Synthetic Poster Menu Item",
  unitPriceCents: 1_000,
  currency: "EUR" as const,
  quantity: 1 as const,
  fulfilment: "pickup" as const,
};
const merchant = {
  merchantCode: "synthetic-sandbox-merchant",
  country: "IE",
  defaultCurrency: "EUR",
  sandbox: true,
};

const temporaryDirectories: string[] = [];
const repositories: SqliteOrderPaymentRepository[] = [];
let globalFetch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Global fetch is forbidden in bridge tests");
  });
});

afterEach(() => {
  for (const repository of repositories.splice(0).reverse()) repository.close();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
  expect(globalFetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "poster-prepaid-bridge-"));
  temporaryDirectories.push(directory);
  const paths = resolvePosterPrepaidSandboxE2ePaths(directory);
  const checkoutCreator = vi.fn(async (checkout) => ({
    checkoutId: "synthetic-checkout",
    checkoutReference: checkout.checkoutReference,
    merchantCode: merchant.merchantCode,
    amountCents: 1_000,
    currency: "EUR" as const,
    status: "PENDING" as const,
    hostedCheckoutUrl: "https://checkout.invalid/hosted/synthetic",
  }));
  await createPosterPrepaidSandboxE2eCheckout({
    confirmation: POSTER_PREPAID_SANDBOX_CHECKOUT_CONFIRMATION,
    item: product,
    menuSnapshot: menuSnapshot(new Date("2026-09-23T11:59:00.000Z")),
    merchant,
    returnUrl: "https://sandbox.invalid/webhooks/sumup",
    now: createdAt,
    maxMenuSnapshotAgeMs: 30 * 60_000,
    createOrderId: () => "ord_poster_prepaid_bridge",
  }, {
    checkoutCreator: { createOnce: checkoutCreator },
    lifecycle: new FilePosterPrepaidSandboxCheckoutLifecycle(paths),
  });
  const state = readPosterPrepaidSandboxE2eRecoveryState(paths.recoveryStatePath);
  const attempt = readPosterPrepaidSandboxE2eAttempt(paths.attemptMarkerPath);
  const repository = new SqliteOrderPaymentRepository(paths.databasePath);
  repositories.push(repository);
  return {
    directory, paths, state, attempt, repository, checkoutCreator,
    merchantCode: merchant.merchantCode,
  };
}

function menuSnapshot(capturedAt: Date) {
  return {
    source: "poster_menu_read_only" as const,
    capturedAt: capturedAt.toISOString(),
    currency: "EUR" as const,
    items: [{
      id: product.productId,
      name: product.name,
      categoryId: "1",
      categoryName: "Synthetic",
      hidden: false,
      spots: [{ spotId: product.spotId, priceCents: 1_000, visible: true }],
    }],
  };
}

function createVerifier(state: { checkoutId: string; checkoutReference: string },
  transactionStatus: "SUCCESSFUL" | "FAILED" = "SUCCESSFUL",
  overrides: {
    checkoutAmount?: number;
    checkoutCurrency?: string;
    transactionAmount?: number;
    transactionCurrency?: string;
  } = {}) {
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path.includes("/checkouts/")) {
      return Response.json({
        id: state.checkoutId,
        checkout_reference: state.checkoutReference,
        merchant_code: merchant.merchantCode,
        amount: overrides.checkoutAmount ?? 10,
        currency: overrides.checkoutCurrency ?? "EUR",
        status: "PAID",
        transactions: [{ id: "synthetic-transaction", status: "SUCCESSFUL" }],
      });
    }
    return Response.json({
      id: "synthetic-transaction",
      merchant_code: merchant.merchantCode,
      amount: overrides.transactionAmount ?? 10,
      currency: overrides.transactionCurrency ?? "EUR",
      status: transactionStatus,
    });
  });
  return {
    fetcher,
    verifier: new SumUpSandboxCheckoutVerifier({
      apiKey: "synthetic-key",
      merchant,
      fetcher,
    }),
  };
}

function webhook(checkoutId: string) {
  return { event_type: "CHECKOUT_STATUS_CHANGED", id: checkoutId };
}

function createBridge(
  context: PosterPrepaidSandboxRecoveryContext,
  verifier: SumUpSandboxCheckoutVerifier,
  at: Date,
) {
  return new PosterPrepaidSandboxWebhookBridge(
    context,
    verifier,
    new FilePosterPrepaidSandboxVerificationClaim(context.paths),
    () => at,
  );
}

function account() {
  return {
    companyId: "sushi-planet-bot",
    currencyIso: "EUR",
    currencySymbol: "€",
    timezone: "Europe/Dublin",
  };
}

function handoffInput(fixture: Awaited<ReturnType<typeof createFixture>>,
  submitter: PosterOrderSubmitter, capturedAt: Date = paidAt) {
  return {
    paths: fixture.paths,
    state: fixture.state,
    attempt: fixture.attempt,
    repository: fixture.repository,
    merchantCode: fixture.merchantCode,
    confirmation: POSTER_PREPAID_SANDBOX_E2E_CONFIRMATION,
    account: account(),
    menuSnapshot: menuSnapshot(capturedAt),
    customer: { firstName: "Synthetic Test", phone: "+353000000000" },
    submitter,
    now: paidAt,
  };
}

describe("Poster prepaid sandbox lifecycle bridge", () => {
  it("reconciles the created checkout into the very same SQLite order/payment pair", async () => {
    const fixture = await createFixture();
    const { verifier, fetcher } = createVerifier(fixture.state);
    const bridge = createBridge(fixture, verifier, paidAt);
    const before = assertPosterPrepaidSandboxRecovery(fixture);

    expect(before.order.status).toBe("awaiting_payment");
    expect(before.payment.status).toBe("pending");
    await expect(bridge.process(webhook(fixture.state.checkoutId))).resolves.toEqual({
      outcome: "paid",
    });

    const after = assertPosterPrepaidSandboxRecovery(fixture);
    expect(after.order.id).toBe(before.order.id);
    expect(after.payment.checkoutId).toBe(before.payment.checkoutId);
    expect(after.order.status).toBe("paid");
    expect(after.payment).toMatchObject({
      status: "paid", successfulTransactionId: "synthetic-transaction",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(existsSync(fixture.paths.verificationAttemptPath)).toBe(true);
    expect(fixture.checkoutCreator).toHaveBeenCalledOnce();
  });

  it("submits one paid order after one successful transaction and deduplicates after restart", async () => {
    const fixture = await createFixture();
    const { verifier, fetcher } = createVerifier(fixture.state);
    const bridge = createBridge(fixture, verifier, paidAt);
    await bridge.process(webhook(fixture.state.checkoutId));
    const submitOrder = vi.fn<PosterOrderSubmitter["submitOrder"]>(
      async () => ({ posterOrderId: "synthetic-poster-order" }),
    );
    const submitter = { submitOrder };
    await expect(submitPosterPrepaidSandboxPaidOrder(
      handoffInput(fixture, submitter),
    )).resolves.toEqual({ outcome: "submitted" });
    expect(submitOrder).toHaveBeenCalledOnce();
    expect(submitOrder.mock.calls[0]?.[0]).toMatchObject({
      correlationId: `poster-handoff:${fixture.state.orderId}`,
      payload: {
        spot_id: 1,
        products: [{ product_id: 1, count: 1, price: 1_000 }],
        payment: { type: 1, sum: 1_000, currency: "EUR" },
      },
    });

    fixture.repository.close();
    repositories.splice(repositories.indexOf(fixture.repository), 1);
    const reopened = new SqliteOrderPaymentRepository(fixture.paths.databasePath);
    repositories.push(reopened);
    const restarted = { ...fixture, repository: reopened };
    const secondVerifier = createVerifier(fixture.state);
    const secondBridge = createBridge(restarted, secondVerifier.verifier, paidAt);
    await expect(secondBridge.process(webhook(fixture.state.checkoutId))).resolves.toEqual({
      outcome: "duplicate",
    });
    const secondSubmit = vi.fn(async () => ({ posterOrderId: "must-not-submit" }));
    await expect(submitPosterPrepaidSandboxPaidOrder(
      handoffInput(restarted, { submitOrder: secondSubmit }),
    )).resolves.toEqual({ outcome: "duplicate" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(secondVerifier.fetcher).not.toHaveBeenCalled();
    expect(secondSubmit).not.toHaveBeenCalled();
    expect(reopened.findOrderById(fixture.state.orderId)?.status).toBe(
      "submitted_to_poster",
    );
  });

  it("rejects unknown checkout without verification, paid transition or Poster submit", async () => {
    const fixture = await createFixture();
    const { verifier, fetcher } = createVerifier(fixture.state);
    const bridge = createBridge(fixture, verifier, paidAt);
    await expect(bridge.process(webhook("unknown-checkout"))).resolves.toEqual({
      outcome: "unknown_checkout",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(fixture.paths.verificationAttemptPath)).toBe(false);
    expect(fixture.repository.findOrderById(fixture.state.orderId)?.status).toBe(
      "awaiting_payment",
    );
    expect(fixture.repository.findPosterHandoffByOrderId(fixture.state.orderId))
      .toBeUndefined();
  });

  it.each([
    { name: "foreign order", mutate: (f: Awaited<ReturnType<typeof createFixture>>) =>
      ({ ...f, state: { ...f.state, orderId: "foreign-order" } }) },
    { name: "wrong amount", mutate: (f: Awaited<ReturnType<typeof createFixture>>) =>
      ({ ...f, state: { ...f.state, amountCents: 1_001 } }) },
    { name: "wrong currency", mutate: (f: Awaited<ReturnType<typeof createFixture>>) =>
      ({ ...f, state: { ...f.state, currency: "USD" as "EUR" } }) },
    { name: "bad database locator", mutate: (f: Awaited<ReturnType<typeof createFixture>>) =>
      ({ ...f, state: { ...f.state, databasePath: "wrong-database" } }) },
    { name: "bad fingerprint", mutate: (f: Awaited<ReturnType<typeof createFixture>>) =>
      ({ ...f, state: { ...f.state, preparationFingerprint: "a".repeat(64) } }) },
  ])("rejects $name before verification or handoff", async ({ mutate }) => {
    const fixture = await createFixture();
    const context = mutate(fixture);
    const { verifier, fetcher } = createVerifier(fixture.state);
    const bridge = createBridge(context, verifier, paidAt);
    await expect(bridge.process(webhook(fixture.state.checkoutId))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(fixture.repository.findOrderById(fixture.state.orderId)?.status).toBe(
      "awaiting_payment",
    );
    expect(fixture.repository.findPosterHandoffByOrderId(fixture.state.orderId))
      .toBeUndefined();
  });

  it("rejects a stale menu before verification and leaves the order pending", async () => {
    const fixture = await createFixture();
    const { verifier, fetcher } = createVerifier(fixture.state);
    const tooLate = new Date("2026-09-23T12:31:00.000Z");
    const bridge = createBridge(fixture, verifier, tooLate);
    await expect(bridge.process(webhook(fixture.state.checkoutId))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(fixture.repository.findOrderById(fixture.state.orderId)?.status).toBe(
      "awaiting_payment",
    );
  });

  it("rejects a failed transaction without paid state or Poster handoff", async () => {
    const fixture = await createFixture();
    const { verifier, fetcher } = createVerifier(fixture.state, "FAILED");
    const bridge = createBridge(fixture, verifier, paidAt);
    await expect(bridge.process(webhook(fixture.state.checkoutId))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(existsSync(fixture.paths.verificationAttemptPath)).toBe(true);
    await expect(createBridge(fixture, verifier, paidAt)
      .process(webhook(fixture.state.checkoutId))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fixture.repository.findOrderById(fixture.state.orderId)?.status).toBe(
      "awaiting_payment",
    );
    expect(fixture.repository.findPosterHandoffByOrderId(fixture.state.orderId))
      .toBeUndefined();
  });

  it.each([
    { name: "checkout amount", overrides: { checkoutAmount: 10.01 } },
    { name: "checkout currency", overrides: { checkoutCurrency: "USD" } },
    { name: "transaction amount", overrides: { transactionAmount: 10.01 } },
    { name: "transaction currency", overrides: { transactionCurrency: "USD" } },
  ])("rejects a mismatched provider $name before paid or Poster submit", async ({ overrides }) => {
    const fixture = await createFixture();
    const { verifier } = createVerifier(fixture.state, "SUCCESSFUL", overrides);
    await expect(createBridge(fixture, verifier, paidAt)
      .process(webhook(fixture.state.checkoutId))).rejects.toThrow();
    expect(fixture.repository.findOrderById(fixture.state.orderId)?.status).toBe(
      "awaiting_payment",
    );
    expect(fixture.repository.findPosterHandoffByOrderId(fixture.state.orderId))
      .toBeUndefined();
  });

  it("rejects a stale handoff menu without a Poster submit", async () => {
    const fixture = await createFixture();
    const { verifier } = createVerifier(fixture.state);
    await createBridge(fixture, verifier, paidAt)
      .process(webhook(fixture.state.checkoutId));
    const submitOrder = vi.fn(async () => ({ posterOrderId: "must-not-submit" }));
    await expect(submitPosterPrepaidSandboxPaidOrder({
      ...handoffInput(fixture, { submitOrder }),
      menuSnapshot: menuSnapshot(new Date("2026-09-23T11:34:00.000Z")),
    })).rejects.toThrow();
    expect(submitOrder).not.toHaveBeenCalled();
    expect(fixture.repository.findPosterHandoffByOrderId(fixture.state.orderId))
      .toBeUndefined();
  });

  it("keeps the generic SumUp SQLite lifecycle separate", async () => {
    const fixture = await createFixture();
    const genericPaths = resolveSumUpE2eRecoveryPaths(fixture.directory);
    mkdirSync(genericPaths.directoryPath);
    const generic = new SqliteOrderPaymentRepository(genericPaths.databasePath);
    repositories.push(generic);
    const pair = assertPosterPrepaidSandboxRecovery(fixture);
    generic.createOrderWithPayment(pair.order, pair.payment);

    const { verifier } = createVerifier(fixture.state);
    await createBridge(fixture, verifier, paidAt)
      .process(webhook(fixture.state.checkoutId));
    expect(fixture.paths.databasePath).not.toBe(genericPaths.databasePath);
    expect(fixture.repository.findOrderById(fixture.state.orderId)?.status).toBe("paid");
    expect(generic.findOrderById(fixture.state.orderId)?.status).toBe(
      "awaiting_payment",
    );
    expect(generic.findByCheckoutId(fixture.state.checkoutId)?.status).toBe("pending");
  });
});
