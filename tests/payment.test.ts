import { describe, expect, it } from "vitest";

import {
  createSumUpPayment,
  reconcileVerifiedSumUpCheckout,
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
import {
  InMemoryPaymentStore,
} from "../src/storage/in-memory-payment-store.js";

const createdAt = new Date("2026-08-25T19:00:00.000Z");
const paidAt = new Date("2026-08-25T19:13:00.000Z");

function createAwaitingPaymentOrder(): Order {
  let order = createOrder({
    createId: () => "ord_sumup_test_001",
    now: () => createdAt,
  });
  order = addItem(
    order,
    {
      id: "test-product-1",
      name: "Test Product",
      unitPriceCents: 1_000,
      available: true,
    },
    1,
    createdAt,
  );
  order = setPickup(order, createdAt);
  return markAwaitingPayment(order, createdAt);
}

function createPendingPayment(
  order: Order = createAwaitingPaymentOrder(),
): PaymentRecord {
  return createSumUpPayment({
    order,
    checkoutId: "checkout-test-1",
    checkoutReference: "sumup-ord_sumup_test_001-1",
    merchantCode: "MTEST123",
    amountCents: 1_000,
    currency: "EUR",
    now: createdAt,
  });
}

function createVerifiedCheckout(
  changes: Partial<VerifiedSumUpCheckout> = {},
): VerifiedSumUpCheckout {
  return {
    checkoutId: "checkout-test-1",
    checkoutReference: "sumup-ord_sumup_test_001-1",
    merchantCode: "MTEST123",
    amountCents: 1_000,
    currency: "EUR",
    status: "PAID",
    transactions: [
      {
        id: "transaction-test-1",
        status: "SUCCESSFUL",
        amountCents: 1_000,
        currency: "EUR",
      },
    ],
    ...changes,
  };
}

describe("payment and order state", () => {
  it("creates and stores a pending SumUp payment linked to one order", () => {
    const order = createAwaitingPaymentOrder();
    const payment = createPendingPayment(order);
    const store = new InMemoryPaymentStore();

    store.create(payment);

    expect(payment).toMatchObject({
      provider: "sumup",
      orderId: order.id,
      status: "pending",
      amountCents: 1_000,
      currency: "EUR",
      successfulTransactionId: null,
    });
    expect(store.findByCheckoutId(payment.checkoutId)).toEqual(payment);
    expect(store.findByOrderId(order.id)).toEqual(payment);
  });

  it("rejects a payment amount that differs from the order total", () => {
    const order = createAwaitingPaymentOrder();

    expect(() =>
      createSumUpPayment({
        order,
        checkoutId: "checkout-test-1",
        checkoutReference: "sumup-ord_sumup_test_001-1",
        merchantCode: "MTEST123",
        amountCents: 999,
        currency: "EUR",
      }),
    ).toThrow("Payment amount does not match the order");
  });

  it("enforces unique checkout, order, and reference bindings", () => {
    const payment = createPendingPayment();

    const duplicateCases: PaymentRecord[] = [
      { ...payment, orderId: "ord_other", checkoutReference: "ref-other" },
      { ...payment, checkoutId: "checkout-other", checkoutReference: "ref-other" },
      { ...payment, checkoutId: "checkout-other", orderId: "ord_other" },
    ];

    for (const duplicate of duplicateCases) {
      const store = new InMemoryPaymentStore();
      store.create(payment);
      expect(() => store.create(duplicate)).toThrow(/already/);
    }
  });

  it("marks payment and order paid only after a matching verified checkout", () => {
    const order = createAwaitingPaymentOrder();
    const payment = createPendingPayment(order);
    const store = new InMemoryPaymentStore();
    store.create(payment);

    const result = reconcileVerifiedSumUpCheckout(
      order,
      payment,
      createVerifiedCheckout(),
      paidAt,
    );

    expect(result.outcome).toBe("paid");
    expect(result.order.status).toBe("paid");
    expect(result.payment).toMatchObject({
      status: "paid",
      successfulTransactionId: "transaction-test-1",
      paidAt: paidAt.toISOString(),
      updatedAt: paidAt.toISOString(),
    });
    store.save(result.payment);
    expect(store.findByOrderId(order.id)).toEqual(result.payment);
  });

  it("treats the same successful transaction as an idempotent duplicate", () => {
    const first = reconcileVerifiedSumUpCheckout(
      createAwaitingPaymentOrder(),
      createPendingPayment(),
      createVerifiedCheckout(),
      paidAt,
    );

    const duplicate = reconcileVerifiedSumUpCheckout(
      first.order,
      first.payment,
      createVerifiedCheckout(),
      new Date("2026-08-25T19:14:00.000Z"),
    );

    expect(duplicate).toEqual({
      outcome: "duplicate",
      order: first.order,
      payment: first.payment,
    });
  });

  it("keeps the order unpaid for a verified non-paid checkout", () => {
    const order = createAwaitingPaymentOrder();
    const payment = createPendingPayment(order);

    const result = reconcileVerifiedSumUpCheckout(
      order,
      payment,
      createVerifiedCheckout({ status: "FAILED", transactions: [] }),
      paidAt,
    );

    expect(result.outcome).toBe("not_paid");
    expect(result.order).toEqual(order);
    expect(result.payment.status).toBe("failed");
    expect(result.payment.successfulTransactionId).toBeNull();
  });

  it("rejects mismatched checkout identity and successful transaction money", () => {
    const order = createAwaitingPaymentOrder();
    const payment = createPendingPayment(order);

    expect(() =>
      reconcileVerifiedSumUpCheckout(
        order,
        payment,
        createVerifiedCheckout({ merchantCode: "MOTHER" }),
      ),
    ).toThrow("does not match the stored payment");

    expect(() =>
      reconcileVerifiedSumUpCheckout(
        order,
        payment,
        createVerifiedCheckout({
          transactions: [
            {
              id: "transaction-test-1",
              status: "SUCCESSFUL",
              amountCents: 999,
              currency: "EUR",
            },
          ],
        }),
      ),
    ).toThrow("transaction amount does not match");
  });

  it("rejects PAID without exactly one successful transaction", () => {
    const order = createAwaitingPaymentOrder();
    const payment = createPendingPayment(order);

    expect(() =>
      reconcileVerifiedSumUpCheckout(
        order,
        payment,
        createVerifiedCheckout({ transactions: [] }),
      ),
    ).toThrow("exactly one successful transaction");
  });
});
