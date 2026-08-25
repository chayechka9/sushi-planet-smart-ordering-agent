import { describe, expect, it } from "vitest";

import {
  OrderDomainError,
  addItem,
  calculateOrderTotals,
  cancelOrder,
  createOrder,
  markAwaitingPayment,
  markPaid,
  markSubmittedToPoster,
  setDelivery,
  setItemQuantity,
  setPickup,
  type MenuItemSnapshot,
} from "../src/domain/order.js";

const salmonRoll: MenuItemSnapshot = {
  id: "poster-product-101",
  name: "Salmon Roll",
  unitPriceCents: 1_250,
  available: true,
};

const fixedDate = new Date("2026-08-25T12:00:00.000Z");

describe("order core", () => {
  it("creates a draft with a unique external ID", () => {
    const first = createOrder();
    const second = createOrder();

    expect(first.id).toMatch(/^ord_[0-9a-f-]{36}$/);
    expect(second.id).not.toBe(first.id);
    expect(first.status).toBe("draft");
  });

  it("supports deterministic IDs and timestamps in tests", () => {
    const order = createOrder({
      createId: () => "ord_test_001",
      now: () => fixedDate,
    });

    expect(order).toMatchObject({
      id: "ord_test_001",
      createdAt: fixedDate.toISOString(),
      updatedAt: fixedDate.toISOString(),
    });
  });

  it("adds and updates cart quantities without using floating point money", () => {
    let order = createOrder();
    order = addItem(order, salmonRoll, 2, fixedDate);
    order = addItem(order, salmonRoll, 1, fixedDate);

    expect(order.items).toEqual([
      {
        menuItemId: salmonRoll.id,
        name: salmonRoll.name,
        unitPriceCents: 1_250,
        quantity: 3,
      },
    ]);
    expect(calculateOrderTotals(order).subtotalCents).toBe(3_750);

    order = setItemQuantity(order, salmonRoll.id, 0, fixedDate);
    expect(order.items).toEqual([]);
  });

  it("rejects unavailable items and a changed price snapshot", () => {
    const order = createOrder();

    expect(() =>
      addItem(order, { ...salmonRoll, available: false }),
    ).toThrow(OrderDomainError);

    const withItem = addItem(order, salmonRoll);
    expect(() =>
      addItem(withItem, { ...salmonRoll, unitPriceCents: 1_350 }),
    ).toThrow("changed while it was in the cart");
  });

  it("calculates pickup with no fulfilment fee", () => {
    const order = setPickup(addItem(createOrder(), salmonRoll, 2));

    expect(calculateOrderTotals(order)).toEqual({
      subtotalCents: 2_500,
      fulfilmentCents: 0,
      totalCents: 2_500,
      currency: "EUR",
    });
  });

  it("adds an explicit delivery fee without inventing delivery rules", () => {
    const order = setDelivery(
      addItem(createOrder(), salmonRoll),
      {
        line1: " 1 Test Street ",
        city: " Dublin ",
        postalCode: " D01 TEST ",
      },
      350,
    );

    expect(order.fulfilment).toEqual({
      type: "delivery",
      address: {
        line1: "1 Test Street",
        city: "Dublin",
        postalCode: "D01 TEST",
      },
      deliveryFeeCents: 350,
    });
    expect(calculateOrderTotals(order).totalCents).toBe(1_600);
  });

  it("requires a cart and fulfilment before awaiting payment", () => {
    expect(() => markAwaitingPayment(createOrder())).toThrow(
      "empty cart",
    );

    const order = addItem(createOrder(), salmonRoll);
    expect(() => markAwaitingPayment(order)).toThrow(
      "Fulfilment must be selected",
    );
  });

  it("enforces the payment-to-Poster state sequence", () => {
    const ready = setPickup(addItem(createOrder(), salmonRoll));
    const awaitingPayment = markAwaitingPayment(ready);
    const paid = markPaid(awaitingPayment);
    const submitted = markSubmittedToPoster(paid);

    expect(awaitingPayment.status).toBe("awaiting_payment");
    expect(paid.status).toBe("paid");
    expect(submitted.status).toBe("submitted_to_poster");
    expect(() => markSubmittedToPoster(awaitingPayment)).toThrow(
      "Expected order status paid",
    );
  });

  it("only cancels orders before payment", () => {
    const ready = setPickup(addItem(createOrder(), salmonRoll));
    expect(cancelOrder(ready).status).toBe("cancelled");

    const paid = markPaid(markAwaitingPayment(ready));
    expect(() => cancelOrder(paid)).toThrow(
      "Cannot cancel an order with status paid",
    );
  });
});
