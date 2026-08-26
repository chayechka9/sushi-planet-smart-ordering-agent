import { describe, expect, it, vi } from "vitest";

import {
  createSumUpHostedCheckout,
  SumUpCheckoutCreationError,
  type CreateSumUpHostedCheckoutOptions,
} from "../src/integrations/sumup/create-checkout.js";
import type { SumUpHostedCheckoutPreparation } from "../src/integrations/sumup/hosted-checkout.js";

const apiKey = "test-only-api-key";
const checkoutId = "checkout-test-created";
const checkoutReference = "sumup-ord_sumup_e2e_test-1";
const merchantCode = "merchant-sandbox-test";
const hostedCheckoutUrl = "https://checkout.invalid/hosted/test";

type Fetcher = NonNullable<CreateSumUpHostedCheckoutOptions["fetcher"]>;

function preparedCheckout(): SumUpHostedCheckoutPreparation {
  return {
    checkoutReference,
    amountCents: 100,
    payload: {
      checkout_reference: checkoutReference,
      amount: 1,
      currency: "EUR",
      merchant_code: merchantCode,
      return_url: "https://sandbox-tunnel.invalid/webhooks/sumup",
      hosted_checkout: { enabled: true },
    },
  };
}

function responsePayload(
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: checkoutId,
    checkout_reference: checkoutReference,
    merchant_code: merchantCode,
    amount: 1,
    currency: "EUR",
    status: "PENDING",
    hosted_checkout_url: hostedCheckoutUrl,
    customer: { phone: "must-not-be-mapped" },
    ...changes,
  };
}

async function captureError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }
  throw new Error("Expected operation to fail");
}

describe("createSumUpHostedCheckout", () => {
  it("performs exactly one authenticated checkout POST and maps only required fields", async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(Response.json(responsePayload(), { status: 201 }));

    await expect(
      createSumUpHostedCheckout({
        apiKey,
        checkout: preparedCheckout(),
        fetcher,
      }),
    ).resolves.toEqual({
      checkoutId,
      checkoutReference,
      merchantCode,
      amountCents: 100,
      currency: "EUR",
      status: "PENDING",
      hostedCheckoutUrl,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(input).toBe("https://api.sumup.com/v0.1/checkouts");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${apiKey}`,
    );
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(init?.body).toBe(JSON.stringify(preparedCheckout().payload));
  });

  it.each([
    {
      name: "checkout reference mismatch",
      changes: { checkout_reference: "sumup-other" },
      message: "different checkout reference",
    },
    {
      name: "merchant mismatch",
      changes: { merchant_code: "merchant-other" },
      message: "different checkout merchant",
    },
    {
      name: "amount mismatch",
      changes: { amount: 2 },
      message: "different checkout amount",
    },
    {
      name: "non-EUR currency",
      changes: { currency: "GBP" },
      message: "currency must be EUR",
    },
    {
      name: "non-pending status",
      changes: { status: "PAID" },
      message: "must be pending",
    },
    {
      name: "unsafe hosted URL",
      changes: { hosted_checkout_url: "http://checkout.invalid/test" },
      message: "hosted checkout URL must be valid HTTPS",
    },
  ])("rejects $name", async ({ changes, message }) => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(
        Response.json(responsePayload(changes), { status: 201 }),
      );

    await expect(
      createSumUpHostedCheckout({
        apiKey,
        checkout: preparedCheckout(),
        fetcher,
      }),
    ).rejects.toThrow(message);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "HTTP failure",
      fetcher: () =>
        vi.fn<Fetcher>().mockResolvedValueOnce(
          Response.json(
            {
              detail: `private-${apiKey}`,
              hosted_checkout_url: hostedCheckoutUrl,
              phone: "private-phone-marker",
            },
            { status: 403 },
          ),
        ),
      status: 403,
    },
    {
      name: "network failure",
      fetcher: () =>
        vi
          .fn<Fetcher>()
          .mockRejectedValueOnce(new Error(`private-${apiKey}`)),
      status: null,
    },
    {
      name: "invalid JSON",
      fetcher: () =>
        vi
          .fn<Fetcher>()
          .mockResolvedValueOnce(
            new Response(`private-${apiKey}-${hostedCheckoutUrl}`, {
              status: 201,
            }),
          ),
      status: 201,
    },
  ])("keeps $name diagnostics safe", async ({ fetcher: buildFetcher, status }) => {
    const error = await captureError(
      createSumUpHostedCheckout({
        apiKey,
        checkout: preparedCheckout(),
        fetcher: buildFetcher(),
      }),
    );
    const diagnostic = `${error.name}: ${error.message}`;

    expect(error).toBeInstanceOf(SumUpCheckoutCreationError);
    expect(error).toMatchObject({ status });
    expect(diagnostic).not.toContain(apiKey);
    expect(diagnostic).not.toContain(hostedCheckoutUrl);
    expect(diagnostic).not.toContain("private-phone-marker");
  });
});
