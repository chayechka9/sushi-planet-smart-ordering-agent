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

const createdAt = new Date("2026-09-10T14:00:00.000Z");
const paidAt = new Date("2026-09-10T14:01:00.000Z");

function createAwaitingPickupOrder(): Order {
  let order = createOrder({
    createId: () => "ord_poster_test_001",
    now: () => createdAt,
  });
  order = addItem(order, testMenuProduct);
  order = setPickup(order);
  return markAwaitingPayment(order);
}

function createPaidPickupPair(): { order: Order; payment: PaymentRecord } {
  const awaitingOrder = createAwaitingPickupOrder();
  const pendingPayment = createSumUpPayment({
    order: awaitingOrder,
    checkoutId: "checkout-poster-test-1",
    checkoutReference: "sumup-ord_poster_test_001-1",
    merchantCode: "MTEST123",
    amountCents: 1_000,
    currency: "EUR",
    now: createdAt,
  });
  const result = reconcileVerifiedSumUpCheckout(
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
          id: "transaction-poster-test-1",
          status: "SUCCESSFUL",
          amountCents: pendingPayment.amountCents,
          currency: "EUR",
        },
      ],
    },
    paidAt,
  );
  return { order: result.order, payment: result.payment };
}

function createPaidPickupOrder(): Order {
  return createPaidPickupPair().order;
}

function createInput(
  overrides: Partial<BuildPosterIncomingOrderPayloadInput> = {},
): BuildPosterIncomingOrderPayloadInput {
  const pair = createPaidPickupPair();
  return {
    order: pair.order,
    payment: pair.payment,
    spotId: "1",
    customer: testCustomer,
    comment: "TEST ONLY - ord_poster_test_001 - pickup",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("derives the exact EUR prepayment from the verified linked payment", () => {
    const input = createInput();
    const payload = buildPosterIncomingOrderPayload(input);

    expect(input.payment).toMatchObject({
      status: "paid",
      amountCents: 1_000,
      currency: "EUR",
      successfulTransactionId: "transaction-poster-test-1",
    });
    expect(payload.payment).toEqual({
      type: 1,
      sum: input.payment?.amountCents,
      currency: "EUR",
    });
  });

  it("rejects a missing or unconfirmed payment", () => {
    const withoutPayment = createInput();
    delete withoutPayment.payment;
    expect(() => buildPosterIncomingOrderPayload(withoutPayment)).toThrow(
      "requires a verified payment",
    );

    const awaitingOrder = createAwaitingPickupOrder();
    const pendingPayment = createSumUpPayment({
      order: awaitingOrder,
      checkoutId: "checkout-pending",
      checkoutReference: "sumup-pending",
      merchantCode: "MTEST123",
      amountCents: 1_000,
      currency: "EUR",
      now: createdAt,
    });
    expect(() =>
      buildPosterIncomingOrderPayload(
        createInput({
          order: markPaid(awaitingOrder),
          payment: pendingPayment,
        }),
      ),
    ).toThrow("linked to a verified transaction");
  });

  it("rejects an order that is not paid", () => {
    const draft = setPickup(addItem(createOrder(), testMenuProduct));

    expect(() =>
      buildPosterIncomingOrderPayload(createInput({ order: draft })),
    ).toThrow("requires a paid order");
  });

  it("rejects a verified payment with a different amount or currency", () => {
    const input = createInput();
    const payment = input.payment;
    if (payment === undefined) {
      throw new Error("Expected a verified payment fixture");
    }

    expect(() =>
      buildPosterIncomingOrderPayload({
        ...input,
        payment: { ...payment, amountCents: 999 },
      }),
    ).toThrow("amount does not match");

    expect(() =>
      buildPosterIncomingOrderPayload({
        ...input,
        payment: {
          ...payment,
          currency: "USD",
        } as unknown as PaymentRecord,
      }),
    ).toThrow("currency must be EUR");
  });

  it("rejects a payment whose order, transaction or reference is not linked", () => {
    const input = createInput();
    const payment = input.payment;
    if (payment === undefined) {
      throw new Error("Expected a verified payment fixture");
    }

    const unlinkedPayments: PaymentRecord[] = [
      { ...payment, orderId: "ord_other" },
      { ...payment, successfulTransactionId: null },
      { ...payment, successfulTransactionId: " " },
      { ...payment, checkoutReference: " " },
    ];

    for (const unlinkedPayment of unlinkedPayments) {
      expect(() =>
        buildPosterIncomingOrderPayload({
          ...input,
          payment: unlinkedPayment,
        }),
      ).toThrow("linked to a verified transaction");
    }
  });

  it("does not perform HTTP while building verified prepayment", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Network access is forbidden in payload tests");
    });

    buildPosterIncomingOrderPayload(createInput());

    expect(fetchSpy).not.toHaveBeenCalled();
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
