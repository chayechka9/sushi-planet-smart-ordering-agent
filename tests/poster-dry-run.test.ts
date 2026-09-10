import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSumUpPayment,
  reconcileVerifiedSumUpCheckout,
  type PaymentRecord,
} from "../src/domain/payment.js";

import {
  addItem,
  createOrder,
  markAwaitingPayment,
  markPaid,
  setDelivery,
  setPickup,
  type Order,
} from "../src/domain/order.js";
import {
  POSTER_CREATE_INCOMING_ORDER_ENDPOINT,
  preparePosterCreateIncomingOrderDryRun,
  preparePosterMinimalCreateIncomingOrderDryRun,
} from "../src/integrations/poster/dry-run.js";
import type { BuildPosterIncomingOrderPayloadInput } from "../src/integrations/poster/order-payload.js";

const testMenuProduct = {
  id: "1",
  name: "Вода минеральная Боржоми в стекле 0.5л",
  unitPriceCents: 1_000,
  available: true,
} as const;

const testCustomer = {
  firstName: "Poster API Test",
  lastName: "Customer",
  phone: "+353000000000",
} as const;

function createPaidPickupOrder(): Order {
  let order = createOrder({ createId: () => "ord_poster_test_001" });
  order = addItem(order, testMenuProduct);
  order = setPickup(order);
  order = markAwaitingPayment(order);
  return markPaid(order);
}

function createVerifiedPayment(order: Order): PaymentRecord {
  const awaitingOrder = markAwaitingPayment(
    setPickup(addItem(createOrder({ createId: () => order.id }), testMenuProduct)),
  );
  const pendingPayment = createSumUpPayment({
    order: awaitingOrder,
    checkoutId: "checkout-poster-dry-run",
    checkoutReference: "sumup-poster-dry-run",
    merchantCode: "MTEST123",
    amountCents: 1_000,
    currency: "EUR",
  });
  return reconcileVerifiedSumUpCheckout(
    awaitingOrder,
    pendingPayment,
    {
      checkoutId: pendingPayment.checkoutId,
      checkoutReference: pendingPayment.checkoutReference,
      merchantCode: pendingPayment.merchantCode,
      amountCents: pendingPayment.amountCents,
      currency: "EUR",
      status: "PAID",
      transactions: [
        {
          id: "transaction-poster-dry-run",
          status: "SUCCESSFUL",
          amountCents: pendingPayment.amountCents,
          currency: "EUR",
        },
      ],
    },
  ).payment;
}

function createInput(
  order: Order = createPaidPickupOrder(),
): BuildPosterIncomingOrderPayloadInput {
  return {
    order,
    payment: createVerifiedPayment(order),
    spotId: "1",
    customer: testCustomer,
    comment: "TEST ONLY - ord_poster_test_001 - pickup",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("preparePosterCreateIncomingOrderDryRun", () => {
  it("prepares the documented JSON POST without credentials or fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Network access is forbidden in dry-run tests");
    });

    const request = preparePosterCreateIncomingOrderDryRun(createInput());

    expect(request).toEqual({
      mode: "dry-run",
      method: "POST",
      endpoint: POSTER_CREATE_INCOMING_ORDER_ENDPOINT,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        spot_id: 1,
        first_name: "Poster API Test",
        last_name: "Customer",
        phone: "+353000000000",
        comment: "TEST ONLY - ord_poster_test_001 - pickup",
        products: [{ product_id: 1, count: 1, price: 1_000 }],
        payment: { type: 1, sum: 1_000, currency: "EUR" },
      }),
    });
    expect(new URL(request.endpoint).search).toBe("");
    expect(request.body).not.toContain("token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an unpaid order before preparing a request", () => {
    const unpaid = setPickup(addItem(createOrder(), testMenuProduct));

    expect(() =>
      preparePosterCreateIncomingOrderDryRun(createInput(unpaid)),
    ).toThrow("requires a paid order");
  });

  it("rejects delivery fields that are not confirmed for this endpoint", () => {
    let delivery = addItem(createOrder(), testMenuProduct);
    delivery = setDelivery(
      delivery,
      {
        line1: "1 Test Street",
        city: "Dublin",
        postalCode: "D01 TEST",
      },
      350,
    );
    delivery = markPaid(markAwaitingPayment(delivery));

    expect(() =>
      preparePosterCreateIncomingOrderDryRun(createInput(delivery)),
    ).toThrow("Only pickup is supported");
  });
});

describe("preparePosterMinimalCreateIncomingOrderDryRun", () => {
  it("prepares only spot, synthetic phone and one product without I/O", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Network access is forbidden in dry-run tests");
    });

    const request = preparePosterMinimalCreateIncomingOrderDryRun({
      order: createPaidPickupOrder(),
      spotId: "1",
      phone: testCustomer.phone,
    });

    expect(request).toEqual({
      mode: "dry-run",
      method: "POST",
      endpoint: POSTER_CREATE_INCOMING_ORDER_ENDPOINT,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spot_id: 1,
        phone: "+353000000000",
        products: [{ product_id: 1, count: 1 }],
      }),
    });
    expect(request.body).not.toMatch(
      /price|payment|first_name|last_name|comment|token/u,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
