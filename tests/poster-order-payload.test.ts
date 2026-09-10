import { describe, expect, it } from "vitest";

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
  PosterOrderPayloadError,
  buildPosterIncomingOrderPayload,
  buildPosterMinimalIncomingOrderPayload,
  type BuildPosterIncomingOrderPayloadInput,
} from "../src/integrations/poster/order-payload.js";

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

function createInput(
  overrides: Partial<BuildPosterIncomingOrderPayloadInput> = {},
): BuildPosterIncomingOrderPayloadInput {
  return {
    order: createPaidPickupOrder(),
    spotId: "1",
    customer: testCustomer,
    comment: "TEST ONLY - ord_poster_test_001 - pickup",
    ...overrides,
  };
}

describe("buildPosterIncomingOrderPayload", () => {
  it("builds the documented one-product prepaid pickup payload", () => {
    expect(buildPosterIncomingOrderPayload(createInput())).toEqual({
      spot_id: 1,
      first_name: "Poster API Test",
      last_name: "Customer",
      phone: "+353000000000",
      comment: "TEST ONLY - ord_poster_test_001 - pickup",
      products: [{ product_id: 1, count: 1, price: 1_000 }],
      payment: { type: 1, sum: 1_000, currency: "EUR" },
    });
  });

  it("rejects an order that is not paid", () => {
    const draft = setPickup(addItem(createOrder(), testMenuProduct));

    expect(() =>
      buildPosterIncomingOrderPayload(createInput({ order: draft })),
    ).toThrow("requires a paid order");
  });

  it("rejects delivery until its Poster fields are confirmed", () => {
    let delivery = createOrder();
    delivery = addItem(delivery, testMenuProduct);
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
      buildPosterIncomingOrderPayload(createInput({ order: delivery })),
    ).toThrow("Only pickup is supported");
  });

  it("rejects more than one product for the first Poster test", () => {
    const paidOrder = createPaidPickupOrder();
    const [paidItem] = paidOrder.items;
    if (paidItem === undefined) {
      throw new Error("Expected the test order to contain one product");
    }
    const order = { ...paidOrder, items: [paidItem, { ...paidItem }] };

    expect(() =>
      buildPosterIncomingOrderPayload(createInput({ order })),
    ).toThrow("exactly one product");
  });

  it("rejects IDs and customer fields it cannot validate safely", () => {
    const paidOrder = createPaidPickupOrder();
    const [paidItem] = paidOrder.items;
    if (paidItem === undefined) {
      throw new Error("Expected the test order to contain one product");
    }
    const order = {
      ...paidOrder,
      items: [
        {
          ...paidItem,
          menuItemId: "not-a-poster-id",
        },
      ],
    };

    expect(() =>
      buildPosterIncomingOrderPayload(createInput({ order })),
    ).toThrow("Poster product ID must contain only digits");
    expect(() =>
      buildPosterIncomingOrderPayload(
        createInput({ customer: { ...testCustomer, phone: " " } }),
      ),
    ).toThrow(PosterOrderPayloadError);
  });
});

describe("buildPosterMinimalIncomingOrderPayload", () => {
  it("builds only the historically confirmed required fields", () => {
    const payload = buildPosterMinimalIncomingOrderPayload({
      order: createPaidPickupOrder(),
      spotId: "1",
      phone: testCustomer.phone,
    });

    expect(payload).toEqual({
      spot_id: 1,
      phone: "+353000000000",
      products: [{ product_id: 1, count: 1 }],
    });
    expect(Object.keys(payload).sort()).toEqual([
      "phone",
      "products",
      "spot_id",
    ]);
    expect(Object.keys(payload.products[0]).sort()).toEqual([
      "count",
      "product_id",
    ]);
  });

  it("keeps paid pickup and single-product validation", () => {
    const unpaid = setPickup(addItem(createOrder(), testMenuProduct));

    expect(() =>
      buildPosterMinimalIncomingOrderPayload({
        order: unpaid,
        spotId: "1",
        phone: testCustomer.phone,
      }),
    ).toThrow("requires a paid order");
  });
});
