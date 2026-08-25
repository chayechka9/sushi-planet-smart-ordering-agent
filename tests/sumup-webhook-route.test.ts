import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import {
  ProcessSumUpWebhookService,
  type SumUpCheckoutVerifier,
} from "../src/application/process-sumup-webhook.js";
import { createApp } from "../src/app.js";
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
import { SqliteOrderPaymentRepository } from "../src/storage/sqlite/order-payment-repository.js";

const createdAt = new Date("2026-08-25T21:00:00.000Z");
const processedAt = new Date("2026-08-25T21:05:00.000Z");

const apps: ReturnType<typeof createApp>[] = [];
const repositories: SqliteOrderPaymentRepository[] = [];
const temporaryDirectories: string[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network access is forbidden in webhook route tests");
  });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const repository of repositories.splice(0).reverse()) {
    repository.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function openRepository(): SqliteOrderPaymentRepository {
  const directory = mkdtempSync(join(tmpdir(), "sushi-planet-webhook-"));
  temporaryDirectories.push(directory);
  const repository = new SqliteOrderPaymentRepository(
    join(directory, "orders.sqlite"),
  );
  repositories.push(repository);
  return repository;
}

function createPair(suffix: string): {
  order: Order;
  payment: PaymentRecord;
} {
  let order = createOrder({
    createId: () => `ord_webhook_${suffix}`,
    now: () => createdAt,
  });
  order = addItem(
    order,
    {
      id: `product-${suffix}`,
      name: "Test Product",
      unitPriceCents: 1_000,
      available: true,
    },
    1,
    createdAt,
  );
  order = markAwaitingPayment(setPickup(order, createdAt), createdAt);

  return {
    order,
    payment: createSumUpPayment({
      order,
      checkoutId: `checkout-${suffix}`,
      checkoutReference: `sumup-${order.id}-1`,
      merchantCode: "merchant-test",
      amountCents: 1_000,
      currency: "EUR",
      now: createdAt,
    }),
  };
}

function createVerifiedCheckout(
  payment: PaymentRecord,
  status: VerifiedSumUpCheckout["status"] = "PAID",
): VerifiedSumUpCheckout {
  return {
    checkoutId: payment.checkoutId,
    checkoutReference: payment.checkoutReference,
    merchantCode: payment.merchantCode,
    amountCents: payment.amountCents,
    currency: payment.currency,
    status,
    transactions:
      status === "PAID"
        ? [
            {
              id: "transaction-test",
              status: "SUCCESSFUL",
              amountCents: payment.amountCents,
              currency: payment.currency,
            },
          ]
        : [],
  };
}

function createHarness(
  repository: SqliteOrderPaymentRepository,
  verifiedCheckout: VerifiedSumUpCheckout,
): {
  app: ReturnType<typeof createApp>;
  verifyCheckout: Mock<SumUpCheckoutVerifier["verifyCheckout"]>;
} {
  const verifyCheckout = vi.fn<SumUpCheckoutVerifier["verifyCheckout"]>(
    async () => verifiedCheckout,
  );
  const service = new ProcessSumUpWebhookService({
    repository,
    verifier: { verifyCheckout },
    now: () => processedAt,
  });
  const app = createApp({}, { sumUpWebhookService: service });
  apps.push(app);

  return { app, verifyCheckout };
}

function webhookBody(checkoutId: string): Record<string, string> {
  return {
    event_type: "CHECKOUT_STATUS_CHANGED",
    id: checkoutId,
  };
}

describe("POST /webhooks/sumup", () => {
  it("marks the stored order/payment paid only after mock verification", async () => {
    const pair = createPair("paid");
    const repository = openRepository();
    repository.createOrderWithPayment(pair.order, pair.payment);
    const { app, verifyCheckout } = createHarness(
      repository,
      createVerifiedCheckout(pair.payment),
    );

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/sumup",
      payload: webhookBody(pair.payment.checkoutId),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, outcome: "paid" });
    expect(verifyCheckout).toHaveBeenCalledOnce();
    expect(verifyCheckout).toHaveBeenCalledWith(pair.payment.checkoutId);
    expect(repository.findOrderById(pair.order.id)?.status).toBe("paid");
    expect(repository.findByOrderId(pair.order.id)).toMatchObject({
      status: "paid",
      successfulTransactionId: "transaction-test",
    });
    expect(response.body).not.toContain(pair.payment.checkoutId);
    expect(response.body).not.toContain(pair.payment.merchantCode);
    expect(response.body).not.toContain("transaction-test");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns duplicate without calling the verifier for an already paid payment", async () => {
    const pair = createPair("duplicate");
    const repository = openRepository();
    repository.createOrderWithPayment(pair.order, pair.payment);
    const { app, verifyCheckout } = createHarness(
      repository,
      createVerifiedCheckout(pair.payment),
    );

    const first = await app.inject({
      method: "POST",
      url: "/webhooks/sumup",
      payload: webhookBody(pair.payment.checkoutId),
    });
    expect(first.json()).toEqual({ received: true, outcome: "paid" });
    verifyCheckout.mockClear();

    const duplicate = await app.inject({
      method: "POST",
      url: "/webhooks/sumup",
      payload: webhookBody(pair.payment.checkoutId),
    });

    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({
      received: true,
      outcome: "duplicate",
    });
    expect(verifyCheckout).not.toHaveBeenCalled();
    expect(repository.findOrderById(pair.order.id)?.status).toBe("paid");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    { checkoutStatus: "PENDING" as const, outcome: "pending", stored: "pending" },
    { checkoutStatus: "FAILED" as const, outcome: "not_paid", stored: "failed" },
  ])(
    "keeps the order unpaid for a verified $checkoutStatus checkout",
    async ({ checkoutStatus, outcome, stored }) => {
      const pair = createPair(checkoutStatus.toLowerCase());
      const repository = openRepository();
      repository.createOrderWithPayment(pair.order, pair.payment);
      const { app, verifyCheckout } = createHarness(
        repository,
        createVerifiedCheckout(pair.payment, checkoutStatus),
      );

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/sumup",
        payload: webhookBody(pair.payment.checkoutId),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ received: true, outcome });
      expect(verifyCheckout).toHaveBeenCalledOnce();
      expect(repository.findOrderById(pair.order.id)?.status).toBe(
        "awaiting_payment",
      );
      expect(repository.findByOrderId(pair.order.id)?.status).toBe(stored);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("handles an unknown checkout without calling the verifier", async () => {
    const repository = openRepository();
    const pair = createPair("unknown");
    const { app, verifyCheckout } = createHarness(
      repository,
      createVerifiedCheckout(pair.payment),
    );

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/sumup",
      payload: webhookBody("checkout-unknown"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      received: true,
      outcome: "unknown_checkout",
    });
    expect(verifyCheckout).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores an unknown event without calling the verifier", async () => {
    const repository = openRepository();
    const pair = createPair("ignored");
    repository.createOrderWithPayment(pair.order, pair.payment);
    const { app, verifyCheckout } = createHarness(
      repository,
      createVerifiedCheckout(pair.payment),
    );

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/sumup",
      payload: { event_type: "FUTURE_EVENT", arbitrary: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, outcome: "ignored" });
    expect(verifyCheckout).not.toHaveBeenCalled();
    expect(repository.findOrderById(pair.order.id)).toEqual(pair.order);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a verifier result for a different checkout without disclosure", async () => {
    const repository = openRepository();
    const pair = createPair("verifier-mismatch");
    repository.createOrderWithPayment(pair.order, pair.payment);
    const mismatchedCheckout = {
      ...createVerifiedCheckout(pair.payment),
      checkoutId: "checkout-different",
    };
    const { app, verifyCheckout } = createHarness(
      repository,
      mismatchedCheckout,
    );

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/sumup",
      payload: webhookBody(pair.payment.checkoutId),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ received: false, outcome: "retry" });
    expect(response.body).not.toContain(pair.payment.checkoutId);
    expect(response.body).not.toContain("checkout-different");
    expect(verifyCheckout).toHaveBeenCalledOnce();
    expect(repository.findOrderById(pair.order.id)).toEqual(pair.order);
    expect(repository.findByOrderId(pair.order.id)).toEqual(pair.payment);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
