import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  POSTER_PREPAID_SANDBOX_E2E_CONFIRMATION,
  PosterPrepaidSandboxE2ePreparationError,
  buildPreparedPosterPrepaidPayload,
  buildPreparedSumUpCheckout,
  preparePosterPrepaidSandboxE2e,
  type PosterPrepaidSandboxE2eItemInput,
  type PosterPrepaidSandboxE2eRunnerPorts,
  type PosterPrepaidSandboxE2ePreparation,
  type PosterPrepaidSandboxMenuSnapshot,
} from "../src/application/prepare-poster-prepaid-sandbox-e2e.js";
import {
  createSumUpPayment,
  reconcileVerifiedSumUpCheckout,
} from "../src/domain/payment.js";
import type { PosterOrderCustomer } from "../src/integrations/poster/order-payload.js";
import type { SumUpMerchantSummary } from "../src/integrations/sumup/client.js";

const createdAt = new Date("2026-09-22T12:00:00.000Z");
const paidAt = new Date("2026-09-22T12:01:00.000Z");
const menuCapturedAt = new Date("2026-09-22T12:01:30.000Z");
const payloadPreparedAt = new Date("2026-09-22T12:02:00.000Z");

const item: PosterPrepaidSandboxE2eItemInput = {
  productId: "101",
  spotId: "202",
  name: "Synthetic Poster Product",
  unitPriceCents: 1_375,
  currency: "EUR",
  quantity: 1,
  fulfilment: "pickup",
};

const merchant: SumUpMerchantSummary = {
  merchantCode: "synthetic-merchant",
  country: "IE",
  defaultCurrency: "EUR",
  sandbox: true,
};

const customer: PosterOrderCustomer = {
  firstName: "Synthetic",
  lastName: "Customer",
  phone: "synthetic-phone",
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network access is forbidden in preparation tests");
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

function prepare(
  inputItem: PosterPrepaidSandboxE2eItemInput = item,
): PosterPrepaidSandboxE2ePreparation {
  return preparePosterPrepaidSandboxE2e(
    { items: [inputItem] },
    {
      createOrderId: () => "ord_poster_prepaid_sandbox",
      now: () => createdAt,
    },
  );
}

function createFreshMenuSnapshot(
  overrides: Partial<PosterPrepaidSandboxMenuSnapshot> = {},
): PosterPrepaidSandboxMenuSnapshot {
  return {
    source: "poster_menu_read_only",
    capturedAt: menuCapturedAt.toISOString(),
    currency: "EUR",
    items: [
      {
        id: item.productId,
        name: item.name,
        categoryId: "synthetic-category",
        categoryName: "Synthetic",
        hidden: false,
        spots: [
          {
            spotId: item.spotId,
            priceCents: item.unitPriceCents,
            visible: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function createVerifiedPaidPair(preparation: PosterPrepaidSandboxE2ePreparation) {
  const payment = createSumUpPayment({
    order: preparation.order,
    checkoutId: "synthetic-checkout",
    checkoutReference: `sumup-${preparation.order.id}-1`,
    merchantCode: merchant.merchantCode,
    amountCents: preparation.totals.totalCents,
    currency: "EUR",
    now: createdAt,
  });
  const result = reconcileVerifiedSumUpCheckout(
    preparation.order,
    payment,
    {
      checkoutId: payment.checkoutId,
      checkoutReference: payment.checkoutReference,
      merchantCode: payment.merchantCode,
      amountCents: payment.amountCents,
      currency: "EUR",
      status: "PAID",
      transactions: [
        {
          id: "synthetic-successful-transaction",
          status: "SUCCESSFUL",
          amountCents: payment.amountCents,
          currency: "EUR",
        },
      ],
    },
    paidAt,
  );
  return { order: result.order, payment: result.payment };
}

describe("Poster prepaid sandbox E2E preparation", () => {
  it("prepares one authoritative pickup order without creating a payment", () => {
    const preparation = prepare();

    expect(preparation).toMatchObject({
      item,
      totals: {
        subtotalCents: 1_375,
        fulfilmentCents: 0,
        totalCents: 1_375,
        currency: "EUR",
      },
      paymentAttempt: 1,
      order: {
        status: "awaiting_payment",
        fulfilment: { type: "pickup" },
        items: [
          {
            menuItemId: item.productId,
            name: item.name,
            unitPriceCents: 1_375,
            quantity: 1,
          },
        ],
      },
    });
    expect(preparation).not.toHaveProperty("payment");
    expect(preparation.order.status).not.toBe("paid");
    expect(preparation.order.status).not.toBe("submitted_to_poster");
  });

  it("rejects missing, multiple and invalid product inputs", () => {
    expect(() => preparePosterPrepaidSandboxE2e({ items: [] })).toThrow(
      "exactly one product",
    );
    expect(() =>
      preparePosterPrepaidSandboxE2e({ items: [item, item] }),
    ).toThrow("exactly one product");

    const invalidInputs: Array<{
      value: PosterPrepaidSandboxE2eItemInput;
      message: string;
    }> = [
      { value: { ...item, productId: " " }, message: "product ID" },
      {
        value: { ...item, productId: "not-a-poster-id" },
        message: "must contain only digits",
      },
      { value: { ...item, spotId: " " }, message: "spot ID" },
      { value: { ...item, spotId: "0" }, message: "positive safe integer" },
      { value: { ...item, name: " " }, message: "product name" },
      { value: { ...item, unitPriceCents: 0 }, message: "positive integer" },
      { value: { ...item, unitPriceCents: -1 }, message: "positive integer" },
      { value: { ...item, unitPriceCents: 1.5 }, message: "positive integer" },
      {
        value: { ...item, currency: "USD" } as unknown as PosterPrepaidSandboxE2eItemInput,
        message: "currency must be EUR",
      },
      {
        value: { ...item, quantity: 2 } as unknown as PosterPrepaidSandboxE2eItemInput,
        message: "quantity must be exactly one",
      },
      {
        value: { ...item, fulfilment: "delivery" } as unknown as PosterPrepaidSandboxE2eItemInput,
        message: "fulfilment must be pickup",
      },
    ];

    for (const invalid of invalidInputs) {
      expect(() => prepare(invalid.value)).toThrow(invalid.message);
    }
  });

  it("uses the order-core amount for future SumUp and standard Poster payloads", () => {
    const preparation = prepare();
    const checkout = buildPreparedSumUpCheckout({
      preparation,
      menuSnapshot: createFreshMenuSnapshot(),
      merchant,
      now: payloadPreparedAt,
      maxMenuSnapshotAgeMs: 60_000,
      returnUrl: "https://sandbox.invalid/webhooks/sumup",
    });
    const verifiedPaidPair = createVerifiedPaidPair(preparation);
    const payload = buildPreparedPosterPrepaidPayload({
      preparation,
      menuSnapshot: createFreshMenuSnapshot(),
      verifiedPaidPair,
      customer,
      confirmation: POSTER_PREPAID_SANDBOX_E2E_CONFIRMATION,
      now: payloadPreparedAt,
      maxMenuSnapshotAgeMs: 60_000,
    });

    expect(checkout.amountCents).toBe(preparation.totals.totalCents);
    expect(checkout.payload.amount).toBe(13.75);
    expect(payload.products).toEqual([
      {
        product_id: Number(item.productId),
        count: 1,
        price: preparation.totals.totalCents,
      },
    ]);
    expect(payload.payment).toEqual({
      type: 1,
      sum: preparation.totals.totalCents,
      currency: "EUR",
    });
  });

  it("requires fresh matching menu, verified payment and explicit confirmation", () => {
    const preparation = prepare();
    const verifiedPaidPair = createVerifiedPaidPair(preparation);
    const baseInput = {
      preparation,
      menuSnapshot: createFreshMenuSnapshot(),
      verifiedPaidPair,
      customer,
      confirmation: POSTER_PREPAID_SANDBOX_E2E_CONFIRMATION,
      now: payloadPreparedAt,
      maxMenuSnapshotAgeMs: 60_000,
    };

    expect(() =>
      buildPreparedPosterPrepaidPayload({
        ...baseInput,
        confirmation: "missing-confirmation",
      }),
    ).toThrow("confirmation is required");
    expect(() =>
      buildPreparedPosterPrepaidPayload({
        ...baseInput,
        menuSnapshot: createFreshMenuSnapshot({
          capturedAt: "2026-09-22T11:00:00.000Z",
        }),
      }),
    ).toThrow("not fresh");
    expect(() =>
      buildPreparedSumUpCheckout({
        preparation,
        menuSnapshot: createFreshMenuSnapshot({
          capturedAt: "2026-09-22T11:00:00.000Z",
        }),
        merchant,
        now: payloadPreparedAt,
        maxMenuSnapshotAgeMs: 60_000,
      }),
    ).toThrow("not fresh");
    expect(() =>
      buildPreparedPosterPrepaidPayload({
        ...baseInput,
        menuSnapshot: createFreshMenuSnapshot({
          items: [
            {
              ...createFreshMenuSnapshot().items[0]!,
              spots: [
                {
                  spotId: item.spotId,
                  priceCents: item.unitPriceCents + 1,
                  visible: true,
                },
              ],
            },
          ],
        }),
      }),
    ).toThrow("spot price does not match");

    const pendingPayment = createSumUpPayment({
      order: preparation.order,
      checkoutId: "pending-checkout",
      checkoutReference: "pending-reference",
      merchantCode: merchant.merchantCode,
      amountCents: preparation.totals.totalCents,
      currency: "EUR",
      now: createdAt,
    });
    expect(() =>
      buildPreparedPosterPrepaidPayload({
        ...baseInput,
        verifiedPaidPair: {
          order: preparation.order,
          payment: pendingPayment,
        },
      }),
    ).toThrow("does not match the local preparation");
  });

  it("does not call network, SumUp creation or Poster submission boundaries", () => {
    const ports: PosterPrepaidSandboxE2eRunnerPorts = {
      menuSnapshot: {
        readFreshMenuSnapshot: vi.fn(async () => createFreshMenuSnapshot()),
      },
      verifiedPayment: {
        readVerifiedPaidPair: vi.fn(async () => undefined),
      },
      submitter: {
        submitOnce: vi.fn(async () => {
          throw new Error("Poster submission must not run during preparation");
        }),
      },
    };

    const preparation = prepare();
    buildPreparedSumUpCheckout({
      preparation,
      menuSnapshot: createFreshMenuSnapshot(),
      merchant,
      now: payloadPreparedAt,
      maxMenuSnapshotAgeMs: 60_000,
    });

    expect(ports.menuSnapshot.readFreshMenuSnapshot).not.toHaveBeenCalled();
    expect(ports.verifiedPayment.readVerifiedPaidPair).not.toHaveBeenCalled();
    expect(ports.submitter.submitOnce).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cannot obtain paid or submitted state through preparation", () => {
    const preparation = prepare();

    expect(preparation.order.status).toBe("awaiting_payment");
    expect(() =>
      buildPreparedPosterPrepaidPayload({
        preparation,
        menuSnapshot: createFreshMenuSnapshot(),
        verifiedPaidPair: {
          order: preparation.order,
          payment: createSumUpPayment({
            order: preparation.order,
            checkoutId: "pending-checkout",
            checkoutReference: "pending-reference",
            merchantCode: merchant.merchantCode,
            amountCents: preparation.totals.totalCents,
            currency: "EUR",
            now: createdAt,
          }),
        },
        customer,
        confirmation: POSTER_PREPAID_SANDBOX_E2E_CONFIRMATION,
        now: payloadPreparedAt,
        maxMenuSnapshotAgeMs: 60_000,
      }),
    ).toThrow(PosterPrepaidSandboxE2ePreparationError);
    expect(preparation.order.status).toBe("awaiting_payment");
  });
});
