import { describe, expect, it, vi } from "vitest";

import {
  SumUpCheckoutVerificationError,
  SumUpSandboxCheckoutVerifier,
  type SumUpSandboxCheckoutVerifierOptions,
} from "../src/integrations/sumup/checkout-verifier.js";

const apiKey = "test-only-api-key";
const checkoutId = "checkout-test-001";
const checkoutReference = "sumup-order-test-001-1";
const merchantCode = "merchant-sandbox-test";
const transactionId = "transaction-test-001";

type Fetcher = NonNullable<SumUpSandboxCheckoutVerifierOptions["fetcher"]>;

function checkoutResponse(
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: checkoutId,
    checkout_reference: checkoutReference,
    merchant_code: merchantCode,
    amount: 10.99,
    currency: "EUR",
    status: "PAID",
    transactions: [
      {
        id: transactionId,
        status: "SUCCESSFUL",
        extra_checkout_transaction_data: "must-not-be-mapped",
      },
    ],
    hosted_checkout_url: "https://private.invalid/checkout",
    customer: { phone: "must-not-be-mapped" },
    ...changes,
  };
}

function transactionResponse(
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: transactionId,
    status: "SUCCESSFUL",
    merchant_code: merchantCode,
    amount: 10.99,
    currency: "EUR",
    product_summary: "must-not-be-mapped",
    card: { last_4_digits: "must-not-be-mapped" },
    ...changes,
  };
}

function createFetcher(
  checkout: unknown = checkoutResponse(),
  transaction: unknown = transactionResponse(),
) {
  return vi
    .fn<Fetcher>()
    .mockResolvedValueOnce(Response.json(checkout))
    .mockResolvedValueOnce(Response.json(transaction));
}

function createVerifier(
  fetcher: Fetcher,
  merchantChanges: Partial<
    SumUpSandboxCheckoutVerifierOptions["merchant"]
  > = {},
): SumUpSandboxCheckoutVerifier {
  return new SumUpSandboxCheckoutVerifier({
    apiKey,
    merchant: {
      merchantCode,
      country: "IE",
      defaultCurrency: "EUR",
      sandbox: true,
      ...merchantChanges,
    },
    fetcher,
  });
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

describe("SumUpSandboxCheckoutVerifier", () => {
  it("reads checkout then linked transaction and returns only normalized reconciliation data", async () => {
    const fetcher = createFetcher();
    const verifier = createVerifier(fetcher);

    await expect(verifier.verifyCheckout(checkoutId)).resolves.toEqual({
      checkoutId,
      checkoutReference,
      merchantCode,
      amountCents: 1_099,
      currency: "EUR",
      status: "PAID",
      transactions: [
        {
          id: transactionId,
          status: "SUCCESSFUL",
          amountCents: 1_099,
          currency: "EUR",
        },
      ],
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [checkoutInput, checkoutInit] = fetcher.mock.calls[0] ?? [];
    const [transactionInput, transactionInit] = fetcher.mock.calls[1] ?? [];
    expect(checkoutInput).toBeInstanceOf(URL);
    expect(transactionInput).toBeInstanceOf(URL);
    if (!(checkoutInput instanceof URL) || !(transactionInput instanceof URL)) {
      throw new Error("Expected verifier requests to use URL instances");
    }

    expect(checkoutInput.href).toBe(
      `https://api.sumup.com/v0.1/checkouts/${checkoutId}`,
    );
    expect(transactionInput.href).toBe(
      `https://api.sumup.com/v2.1/merchants/${merchantCode}/transactions?id=${transactionId}`,
    );
    for (const init of [checkoutInit, transactionInit]) {
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("accept")).toBe(
        "application/json",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${apiKey}`,
      );
    }
  });

  it("normalizes exact one- and two-decimal EUR amounts to integer cents", async () => {
    const verifier = createVerifier(
      createFetcher(
        checkoutResponse({ amount: 10.1 }),
        transactionResponse({ amount: 10.1 }),
      ),
    );

    await expect(verifier.verifyCheckout(checkoutId)).resolves.toMatchObject({
      amountCents: 1_010,
      transactions: [{ amountCents: 1_010 }],
    });
  });

  it.each([
    {
      name: "different checkout ID",
      changes: { id: "checkout-other" },
      message: "returned a different checkout",
    },
    {
      name: "empty checkout reference",
      changes: { checkout_reference: "" },
      message: "checkout reference must be a non-empty exact string",
    },
    {
      name: "different merchant",
      changes: { merchant_code: "merchant-other" },
      message: "checkout belongs to a different merchant",
    },
    {
      name: "non-EUR checkout",
      changes: { currency: "GBP" },
      message: "checkout currency must be EUR",
    },
    {
      name: "fractional cent checkout amount",
      changes: { amount: 10.999 },
      message: "checkout amount must have at most two decimal places",
    },
    {
      name: "non-paid checkout",
      changes: { status: "PENDING" },
      message: "checkout is not paid",
    },
  ])("rejects a $name before reading a transaction", async ({ changes, message }) => {
    const fetcher = createFetcher(checkoutResponse(changes));
    const verifier = createVerifier(fetcher);

    await expect(verifier.verifyCheckout(checkoutId)).rejects.toThrow(message);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { transactions: [], label: "no successful transaction" },
    {
      transactions: [
        { id: transactionId, status: "SUCCESSFUL" },
        { id: "transaction-test-002", status: "SUCCESSFUL" },
      ],
      label: "multiple successful transactions",
    },
  ])("rejects $label", async ({ transactions }) => {
    const fetcher = createFetcher(checkoutResponse({ transactions }));
    const verifier = createVerifier(fetcher);

    await expect(verifier.verifyCheckout(checkoutId)).rejects.toThrow(
      "exactly one successful transaction",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "different transaction ID",
      changes: { id: "transaction-other" },
      message: "returned a different transaction",
    },
    {
      name: "non-successful transaction",
      changes: { status: "FAILED" },
      message: "transaction is not successful",
    },
    {
      name: "different transaction merchant",
      changes: { merchant_code: "merchant-other" },
      message: "transaction belongs to a different merchant",
    },
    {
      name: "non-EUR transaction",
      changes: { currency: "GBP" },
      message: "transaction currency must be EUR",
    },
    {
      name: "fractional cent transaction amount",
      changes: { amount: 10.999 },
      message: "transaction amount must have at most two decimal places",
    },
    {
      name: "transaction amount mismatch",
      changes: { amount: 9.99 },
      message: "transaction amount does not match the checkout",
    },
  ])("rejects a $name", async ({ changes, message }) => {
    const fetcher = createFetcher(
      checkoutResponse(),
      transactionResponse(changes),
    );
    const verifier = createVerifier(fetcher);

    await expect(verifier.verifyCheckout(checkoutId)).rejects.toThrow(message);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects non-sandbox or non-EUR merchant metadata without any request", () => {
    const fetcher = vi.fn<Fetcher>();

    expect(() => createVerifier(fetcher, { sandbox: false })).toThrow(
      "requires a sandbox merchant",
    );
    expect(() =>
      createVerifier(fetcher, { defaultCurrency: "GBP" }),
    ).toThrow("sandbox merchant currency must be EUR");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "checkout HTTP failure",
      fetcher: () =>
        vi.fn<Fetcher>().mockResolvedValueOnce(
          Response.json(
            {
              detail: `private-response-${apiKey}`,
              hosted_checkout_url: "https://private.invalid/checkout",
              phone: "private-phone-marker",
            },
            { status: 403 },
          ),
        ),
      status: 403,
    },
    {
      name: "checkout network failure",
      fetcher: () =>
        vi
          .fn<Fetcher>()
          .mockRejectedValueOnce(
            new Error(`private-network-${apiKey}-${checkoutId}`),
          ),
      status: null,
    },
    {
      name: "checkout invalid JSON",
      fetcher: () =>
        vi
          .fn<Fetcher>()
          .mockResolvedValueOnce(
            new Response(`private-json-${apiKey}-${checkoutId}`, {
              status: 200,
            }),
          ),
      status: 200,
    },
  ])("keeps $name diagnostics safe", async ({ fetcher: buildFetcher, status }) => {
    const verifier = createVerifier(buildFetcher());
    const error = await captureError(verifier.verifyCheckout(checkoutId));
    const diagnostic = `${error.name}: ${error.message}`;

    expect(error).toBeInstanceOf(SumUpCheckoutVerificationError);
    expect(error).toMatchObject({ status });
    expect(diagnostic).not.toContain(apiKey);
    expect(diagnostic).not.toContain(checkoutId);
    expect(diagnostic).not.toContain("private-response");
    expect(diagnostic).not.toContain("private-network");
    expect(diagnostic).not.toContain("private-json");
    expect(diagnostic).not.toContain("private.invalid");
    expect(diagnostic).not.toContain("private-phone-marker");
  });

  it.each([
    {
      name: "transaction HTTP failure",
      transactionResult: () =>
        Response.json(
          { detail: `private-transaction-${apiKey}-${transactionId}` },
          { status: 502 },
        ),
      status: 502,
    },
    {
      name: "transaction network failure",
      transactionResult: () =>
        new Error(`private-network-${apiKey}-${transactionId}`),
      status: null,
    },
    {
      name: "transaction invalid JSON",
      transactionResult: () =>
        new Response(`private-json-${apiKey}-${transactionId}`, {
          status: 200,
        }),
      status: 200,
    },
  ])(
    "keeps $name diagnostics safe",
    async ({ transactionResult, status }) => {
      const result = transactionResult();
      const fetcher = vi
        .fn<Fetcher>()
        .mockResolvedValueOnce(Response.json(checkoutResponse()));
      if (result instanceof Error) {
        fetcher.mockRejectedValueOnce(result);
      } else {
        fetcher.mockResolvedValueOnce(result);
      }

      const verifier = createVerifier(fetcher);
      const error = await captureError(verifier.verifyCheckout(checkoutId));
      const diagnostic = `${error.name}: ${error.message}`;

      expect(error).toMatchObject({
        name: "SumUpCheckoutVerificationError",
        status,
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(diagnostic).not.toContain(apiKey);
      expect(diagnostic).not.toContain(checkoutId);
      expect(diagnostic).not.toContain(transactionId);
      expect(diagnostic).not.toContain("private-transaction");
      expect(diagnostic).not.toContain("private-network");
      expect(diagnostic).not.toContain("private-json");
    },
  );
});
