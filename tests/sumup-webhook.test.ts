import { afterEach, describe, expect, it, vi } from "vitest";

import { createSumUpPayment } from "../src/domain/payment.js";
import {
  addItem,
  createOrder,
  markAwaitingPayment,
  setPickup,
} from "../src/domain/order.js";
import {
  decideSumUpWebhookHandling,
  parseSumUpWebhook,
} from "../src/integrations/sumup/webhook.js";
import { InMemoryPaymentStore } from "../src/storage/in-memory-payment-store.js";

function createStore(status: "pending" | "paid" = "pending") {
  let order = createOrder({ createId: () => "ord_sumup_test_001" });
  order = addItem(order, {
    id: "test-product-1",
    name: "Test Product",
    unitPriceCents: 1_000,
    available: true,
  });
  order = markAwaitingPayment(setPickup(order));

  const payment = createSumUpPayment({
    order,
    checkoutId: "checkout-test-1",
    checkoutReference: "sumup-ord_sumup_test_001-1",
    merchantCode: "MTEST123",
    amountCents: 1_000,
    currency: "EUR",
  });
  const store = new InMemoryPaymentStore();
  store.create(
    status === "paid"
      ? {
          ...payment,
          status: "paid",
          successfulTransactionId: "transaction-test-1",
          paidAt: "2026-08-25T19:13:00.000Z",
        }
      : payment,
  );
  return store;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SumUp webhook contract", () => {
  it("parses the documented checkout status notification", () => {
    expect(
      parseSumUpWebhook({
        event_type: "CHECKOUT_STATUS_CHANGED",
        id: "checkout-test-1",
      }),
    ).toEqual({
      kind: "checkout_status_changed",
      checkoutId: "checkout-test-1",
    });
  });

  it("ignores an unknown event type without guessing its contract", () => {
    expect(
      parseSumUpWebhook({ event_type: "FUTURE_EVENT", arbitrary: true }),
    ).toEqual({ kind: "ignored", eventType: "FUTURE_EVENT" });
  });

  it("rejects malformed checkout status notifications", () => {
    expect(() =>
      parseSumUpWebhook({ event_type: "CHECKOUT_STATUS_CHANGED" }),
    ).toThrow("Webhook id must be a non-empty string");
    expect(() => parseSumUpWebhook(null)).toThrow(
      "Webhook body must be an object",
    );
  });

  it("requires verification for a known pending payment without mutation or I/O", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Network access is forbidden in webhook unit tests");
    });
    const store = createStore();
    const before = store.findByCheckoutId("checkout-test-1");

    expect(
      decideSumUpWebhookHandling(
        {
          event_type: "CHECKOUT_STATUS_CHANGED",
          id: "checkout-test-1",
        },
        store,
      ),
    ).toEqual({
      action: "verification_required",
      checkoutId: "checkout-test-1",
      orderId: "ord_sumup_test_001",
    });
    expect(store.findByCheckoutId("checkout-test-1")).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not reprocess an already paid payment", () => {
    expect(
      decideSumUpWebhookHandling(
        {
          event_type: "CHECKOUT_STATUS_CHANGED",
          id: "checkout-test-1",
        },
        createStore("paid"),
      ),
    ).toEqual({
      action: "already_processed",
      checkoutId: "checkout-test-1",
      orderId: "ord_sumup_test_001",
    });
  });

  it("does not associate an unknown checkout with an order", () => {
    expect(
      decideSumUpWebhookHandling(
        {
          event_type: "CHECKOUT_STATUS_CHANGED",
          id: "checkout-unknown",
        },
        createStore(),
      ),
    ).toEqual({
      action: "unknown_checkout",
      checkoutId: "checkout-unknown",
    });
  });
});
