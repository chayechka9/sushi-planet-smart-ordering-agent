import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addItem,
  createOrder,
  markAwaitingPayment,
  setPickup,
  type MenuItemSnapshot,
  type Order,
} from "../src/domain/order.js";
import type { SumUpMerchantSummary } from "../src/integrations/sumup/client.js";
import {
  prepareSumUpHostedCheckoutDryRun,
} from "../src/integrations/sumup/dry-run.js";
import {
  buildSumUpHostedCheckout,
  SUMUP_CREATE_CHECKOUT_ENDPOINT,
} from "../src/integrations/sumup/hosted-checkout.js";

const testMerchant: SumUpMerchantSummary = {
  merchantCode: "MTEST123",
  country: "IE",
  defaultCurrency: "EUR",
  sandbox: true,
};

function createAwaitingPaymentOrder(
  unitPriceCents = 1_000,
  orderId = "ord_sumup_test_001",
): Order {
  const product: MenuItemSnapshot = {
    id: "test-product-1",
    name: "Test Product",
    unitPriceCents,
    available: true,
  };

  let order = createOrder({ createId: () => orderId });
  order = addItem(order, product);
  order = setPickup(order);
  return markAwaitingPayment(order);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildSumUpHostedCheckout", () => {
  it("builds the documented EUR payload from integer cents", () => {
    expect(
      buildSumUpHostedCheckout({
        order: createAwaitingPaymentOrder(1_099),
        paymentAttempt: 1,
        merchant: testMerchant,
      }),
    ).toEqual({
      checkoutReference: "sumup-ord_sumup_test_001-1",
      amountCents: 1_099,
      payload: {
        checkout_reference: "sumup-ord_sumup_test_001-1",
        amount: 10.99,
        currency: "EUR",
        merchant_code: "MTEST123",
        hosted_checkout: { enabled: true },
      },
    });
  });

  it("keeps one reference stable per attempt and changes it for a new attempt", () => {
    const order = createAwaitingPaymentOrder();
    const build = (paymentAttempt: number) =>
      buildSumUpHostedCheckout({ order, paymentAttempt, merchant: testMerchant });

    expect(build(1).checkoutReference).toBe(build(1).checkoutReference);
    expect(build(2).checkoutReference).not.toBe(build(1).checkoutReference);
  });

  it("rejects orders that are not awaiting payment", () => {
    const draft = setPickup(
      addItem(createOrder(), {
        id: "test-product-1",
        name: "Test Product",
        unitPriceCents: 1_000,
        available: true,
      }),
    );

    expect(() =>
      buildSumUpHostedCheckout({
        order: draft,
        paymentAttempt: 1,
        merchant: testMerchant,
      }),
    ).toThrow("requires an order awaiting payment");
  });

  it("rejects live or non-EUR merchants", () => {
    const order = createAwaitingPaymentOrder();

    expect(() =>
      buildSumUpHostedCheckout({
        order,
        paymentAttempt: 1,
        merchant: { ...testMerchant, sandbox: false },
      }),
    ).toThrow("requires a sandbox merchant");

    expect(() =>
      buildSumUpHostedCheckout({
        order,
        paymentAttempt: 1,
        merchant: { ...testMerchant, defaultCurrency: "GBP" },
      }),
    ).toThrow("currency must be EUR");
  });

  it("rejects an invalid attempt or an overlong reference", () => {
    expect(() =>
      buildSumUpHostedCheckout({
        order: createAwaitingPaymentOrder(),
        paymentAttempt: 0,
        merchant: testMerchant,
      }),
    ).toThrow("Payment attempt must be a positive integer");

    expect(() =>
      buildSumUpHostedCheckout({
        order: createAwaitingPaymentOrder(1_000, `ord_${"x".repeat(82)}`),
        paymentAttempt: 1,
        merchant: testMerchant,
      }),
    ).toThrow("must not exceed 90 characters");
  });
});

describe("prepareSumUpHostedCheckoutDryRun", () => {
  it("prepares POST metadata and body without an API key or network call", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Network access is forbidden in dry-run tests");
    });

    const request = prepareSumUpHostedCheckoutDryRun({
      order: createAwaitingPaymentOrder(),
      paymentAttempt: 1,
      merchant: testMerchant,
    });

    expect(request).toEqual({
      mode: "dry-run",
      method: "POST",
      endpoint: SUMUP_CREATE_CHECKOUT_ENDPOINT,
      headers: {
        "Content-Type": "application/json",
      },
      amountCents: 1_000,
      body: JSON.stringify({
        checkout_reference: "sumup-ord_sumup_test_001-1",
        amount: 10,
        currency: "EUR",
        merchant_code: "MTEST123",
        hosted_checkout: { enabled: true },
      }),
    });
    expect(new URL(request.endpoint).search).toBe("");
    expect(request.headers).not.toHaveProperty("Authorization");
    expect(request.body).not.toContain("api_key");
    expect(request.body).not.toContain("token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
