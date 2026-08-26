import { describe, expect, it, vi } from "vitest";

import type { SumUpCheckoutVerifier } from "../src/application/process-sumup-webhook.js";
import { createSumUpPayment } from "../src/domain/payment.js";
import {
  addItem,
  createOrder,
  markAwaitingPayment,
  setPickup,
} from "../src/domain/order.js";
import type { SumUpE2eRecoveryState } from "../src/scripts/sumup-e2e-local-state.js";
import { verifyRecoveredSumUpE2eCheckout } from "../src/scripts/sumup-e2e-recovery.js";

const createdAt = new Date("2026-08-26T12:00:00.000Z");

function createFixture() {
  let order = createOrder({
    createId: () => "private-order-id",
    now: () => createdAt,
  });
  order = addItem(
    order,
    {
      id: "test-product",
      name: "Test Product",
      unitPriceCents: 100,
      available: true,
    },
    1,
    createdAt,
  );
  order = markAwaitingPayment(setPickup(order, createdAt), createdAt);
  const payment = createSumUpPayment({
    order,
    checkoutId: "private-checkout-id",
    checkoutReference: "private-reference",
    merchantCode: "private-sandbox-merchant",
    amountCents: 100,
    currency: "EUR",
    now: createdAt,
  });
  const state: SumUpE2eRecoveryState = {
    orderId: order.id,
    paymentId: payment.checkoutId,
    checkoutId: payment.checkoutId,
    checkoutReference: payment.checkoutReference,
    databasePath: "/private/ignored/orders.sqlite",
  };
  return { order, payment, state };
}

describe("verifyRecoveredSumUpE2eCheckout", () => {
  it("verifies the stored binding without changing local state or exposing locators", async () => {
    const { order, payment, state } = createFixture();
    const repository = {
      findOrderById: vi.fn(() => structuredClone(order)),
      findByCheckoutId: vi.fn(() => structuredClone(payment)),
    };
    const verifyCheckout = vi.fn<SumUpCheckoutVerifier["verifyCheckout"]>(
      async () => ({
        checkoutId: payment.checkoutId,
        checkoutReference: payment.checkoutReference,
        merchantCode: payment.merchantCode,
        amountCents: payment.amountCents,
        currency: "EUR",
        status: "PAID",
        transactions: [
          {
            id: "private-transaction-id",
            status: "SUCCESSFUL",
            amountCents: payment.amountCents,
            currency: "EUR",
          },
        ],
      }),
    );

    const result = await verifyRecoveredSumUpE2eCheckout({
      state,
      repository,
      verifier: { verifyCheckout },
    });

    expect(result).toEqual({
      verified: true,
      checkoutStatus: "PAID",
      transactionStatus: "SUCCESSFUL",
      bindingMatched: true,
      localOrderStatus: "awaiting_payment",
      localPaymentStatus: "pending",
      localStateChanged: false,
    });
    expect(verifyCheckout).toHaveBeenCalledOnce();
    expect(verifyCheckout).toHaveBeenCalledWith(state.checkoutId);
    expect(repository.findOrderById).toHaveBeenCalledTimes(2);
    expect(repository.findByCheckoutId).toHaveBeenCalledTimes(2);
    const output = JSON.stringify(result);
    expect(output).not.toContain("private-");
    expect(output).not.toContain("sqlite");
  });

  it("rejects a verified checkout that does not match SQLite", async () => {
    const { order, payment, state } = createFixture();
    const repository = {
      findOrderById: vi.fn(() => structuredClone(order)),
      findByCheckoutId: vi.fn(() => structuredClone(payment)),
    };

    await expect(
      verifyRecoveredSumUpE2eCheckout({
        state,
        repository,
        verifier: {
          verifyCheckout: vi.fn<SumUpCheckoutVerifier["verifyCheckout"]>(
            async () => ({
              checkoutId: payment.checkoutId,
              checkoutReference: payment.checkoutReference,
              merchantCode: payment.merchantCode,
              amountCents: 200,
              currency: "EUR",
              status: "PAID",
              transactions: [
                {
                  id: "private-transaction-id",
                  status: "SUCCESSFUL",
                  amountCents: 200,
                  currency: "EUR",
                },
              ],
            }),
          ),
        },
      }),
    ).rejects.toThrow("does not match SQLite");
    expect(order.status).toBe("awaiting_payment");
    expect(payment.status).toBe("pending");
  });
});
