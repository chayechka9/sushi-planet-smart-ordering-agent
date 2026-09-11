import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LocalBackendFlowService,
  type LocalBackendCheckoutCreator,
} from "../src/application/local-backend-flow.js";
import type { VerifiedSumUpCheckout } from "../src/domain/payment.js";
import {
  addItem,
  createOrder,
  markAwaitingPayment,
  setPickup,
  type Order,
} from "../src/domain/order.js";
import type { PosterOrderSubmitter } from "../src/integrations/poster/submitter.js";
import type { SumUpMerchantSummary } from "../src/integrations/sumup/client.js";
import { SqliteOrderPaymentRepository } from "../src/storage/sqlite/order-payment-repository.js";

const fixedNow = new Date("2026-09-11T12:00:00.000Z");
const merchant: SumUpMerchantSummary = {
  merchantCode: "synthetic-merchant",
  country: "IE",
  defaultCurrency: "EUR",
  sandbox: true,
};

const repositories: SqliteOrderPaymentRepository[] = [];
const temporaryDirectories: string[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network access is forbidden in local flow tests");
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

function openRepository(): SqliteOrderPaymentRepository {
  const directory = mkdtempSync(join(tmpdir(), "local-backend-flow-test-"));
  temporaryDirectories.push(directory);
  const repository = new SqliteOrderPaymentRepository(
    join(directory, "orders.sqlite"),
  );
  repositories.push(repository);
  return repository;
}

function createReadyOrder(suffix: string): Order {
  let order = createOrder({
    createId: () => `ord_local_flow_${suffix}`,
    now: () => fixedNow,
  });
  order = addItem(
    order,
    {
      id: "1",
      name: "Synthetic Product",
      unitPriceCents: 1_000,
      available: true,
    },
    1,
    fixedNow,
  );
  return markAwaitingPayment(setPickup(order, fixedNow), fixedNow);
}

function posterHandoff(orderId: string) {
  return {
    orderId,
    spotId: "1",
    customer: {
      firstName: "Synthetic",
      lastName: "Customer",
      phone: "synthetic-phone",
    },
    comment: "SYNTHETIC LOCAL FLOW",
  };
}

function webhookBody(checkoutId: string): Record<string, string> {
  return {
    event_type: "CHECKOUT_STATUS_CHANGED",
    id: checkoutId,
  };
}

function createHarness(
  order: Order,
  options: {
    checkoutStatus?: VerifiedSumUpCheckout["status"];
    verifiedAmountCents?: number;
    posterSubmitter?: PosterOrderSubmitter;
  } = {},
) {
  const repository = openRepository();
  const checkoutId = `checkout-${order.id}`;
  const createCheckout = vi.fn<LocalBackendCheckoutCreator["createCheckout"]>(
    async (preparation) => ({
      checkoutId,
      checkoutReference: preparation.checkoutReference,
      merchantCode: preparation.payload.merchant_code,
      amountCents: preparation.amountCents,
      currency: "EUR",
      status: "PENDING",
      hostedCheckoutUrl: "synthetic-checkout-link",
    }),
  );
  const checkoutCreator: LocalBackendCheckoutCreator = {
    createCheckout,
  };
  const checkoutStatus = options.checkoutStatus ?? "PAID";
  const verifyCheckout = vi.fn(async (): Promise<VerifiedSumUpCheckout> => ({
    checkoutId,
    checkoutReference: `sumup-${order.id}-1`,
    merchantCode: merchant.merchantCode,
    amountCents: options.verifiedAmountCents ?? 1_000,
    currency: "EUR",
    status: checkoutStatus,
    transactions:
      checkoutStatus === "PAID"
        ? [
            {
              id: `transaction-${order.id}`,
              status: "SUCCESSFUL",
              amountCents: options.verifiedAmountCents ?? 1_000,
              currency: "EUR",
            },
          ]
        : [],
  }));
  const posterSubmitter =
    options.posterSubmitter ??
    ({
      submitOrder: vi.fn(async () => ({
        posterOrderId: `poster-${order.id}`,
      })),
    } satisfies PosterOrderSubmitter);
  const service = new LocalBackendFlowService({
    repository,
    checkoutCreator,
    checkoutVerifier: { verifyCheckout },
    posterSubmitter,
    now: () => fixedNow,
  });

  return {
    checkoutCreator,
    checkoutId,
    posterSubmitter,
    repository,
    service,
    verifyCheckout,
  };
}

async function prepareCheckout(
  service: LocalBackendFlowService,
  order: Order,
): Promise<void> {
  await expect(
    service.prepareCheckoutLink({ order, paymentAttempt: 1, merchant }),
  ).resolves.toEqual({
    orderId: order.id,
    checkoutId: `checkout-${order.id}`,
    checkoutReference: `sumup-${order.id}-1`,
    checkoutLink: "synthetic-checkout-link",
  });
}

describe("unified local backend flow", () => {
  it("reaches one Poster handoff after verified payment", async () => {
    const order = createReadyOrder("success");
    const harness = createHarness(order);
    await prepareCheckout(harness.service, order);

    await expect(
      harness.service.processPaymentWebhook({
        body: webhookBody(harness.checkoutId),
        posterHandoff: posterHandoff(order.id),
      }),
    ).resolves.toEqual({
      paymentOutcome: "paid",
      posterOutcome: "submitted",
    });

    expect(harness.checkoutCreator.createCheckout).toHaveBeenCalledOnce();
    expect(harness.verifyCheckout).toHaveBeenCalledOnce();
    expect(harness.posterSubmitter.submitOrder).toHaveBeenCalledOnce();
    expect(harness.repository.findByOrderId(order.id)).toMatchObject({
      status: "paid",
      successfulTransactionId: `transaction-${order.id}`,
    });
    expect(harness.repository.findOrderById(order.id)?.status).toBe(
      "submitted_to_poster",
    );
  });

  it.each([
    { checkoutStatus: "PENDING" as const, outcome: "pending" },
    { checkoutStatus: "FAILED" as const, outcome: "not_paid" },
  ])(
    "does not hand off a $checkoutStatus payment to Poster",
    async ({ checkoutStatus, outcome }) => {
      const order = createReadyOrder(checkoutStatus.toLowerCase());
      const harness = createHarness(order, { checkoutStatus });
      await prepareCheckout(harness.service, order);

      await expect(
        harness.service.processPaymentWebhook({
          body: webhookBody(harness.checkoutId),
          posterHandoff: posterHandoff(order.id),
        }),
      ).resolves.toEqual({ paymentOutcome: outcome });

      expect(harness.posterSubmitter.submitOrder).not.toHaveBeenCalled();
      expect(harness.repository.findOrderById(order.id)?.status).toBe(
        "awaiting_payment",
      );
    },
  );

  it("does not repeat the Poster handoff for a duplicate webhook", async () => {
    const order = createReadyOrder("duplicate");
    const harness = createHarness(order);
    await prepareCheckout(harness.service, order);
    const input = {
      body: webhookBody(harness.checkoutId),
      posterHandoff: posterHandoff(order.id),
    };

    await expect(harness.service.processPaymentWebhook(input)).resolves.toEqual({
      paymentOutcome: "paid",
      posterOutcome: "submitted",
    });
    await expect(harness.service.processPaymentWebhook(input)).resolves.toEqual({
      paymentOutcome: "duplicate",
    });

    expect(harness.verifyCheckout).toHaveBeenCalledOnce();
    expect(harness.posterSubmitter.submitOrder).toHaveBeenCalledOnce();
  });

  it("keeps an uncertain Poster result without automatic retry", async () => {
    const order = createReadyOrder("uncertain");
    const posterSubmitter: PosterOrderSubmitter = {
      submitOrder: vi.fn(async () => {
        throw new Error("synthetic ambiguous result");
      }),
    };
    const harness = createHarness(order, { posterSubmitter });
    await prepareCheckout(harness.service, order);
    const input = {
      body: webhookBody(harness.checkoutId),
      posterHandoff: posterHandoff(order.id),
    };

    await expect(harness.service.processPaymentWebhook(input)).rejects.toThrow(
      "Poster submission was not confirmed; automatic retry is blocked",
    );
    await expect(harness.service.processPaymentWebhook(input)).resolves.toEqual({
      paymentOutcome: "duplicate",
    });

    expect(posterSubmitter.submitOrder).toHaveBeenCalledOnce();
    expect(harness.repository.findOrderById(order.id)?.status).toBe("paid");
    expect(harness.repository.findPosterHandoffByOrderId(order.id)).toMatchObject(
      { status: "uncertain", posterOrderId: null },
    );
  });

  it("rejects mismatched verified payment data before Poster handoff", async () => {
    const order = createReadyOrder("mismatch");
    const harness = createHarness(order, { verifiedAmountCents: 1_001 });
    await prepareCheckout(harness.service, order);

    await expect(
      harness.service.processPaymentWebhook({
        body: webhookBody(harness.checkoutId),
        posterHandoff: posterHandoff(order.id),
      }),
    ).rejects.toThrow("Verified checkout does not match the stored payment");

    expect(harness.posterSubmitter.submitOrder).not.toHaveBeenCalled();
    expect(harness.repository.findOrderById(order.id)?.status).toBe(
      "awaiting_payment",
    );
    expect(harness.repository.findByOrderId(order.id)?.status).toBe("pending");
  });
});
