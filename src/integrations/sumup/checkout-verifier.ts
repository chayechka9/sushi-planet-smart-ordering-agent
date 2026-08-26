import type { VerifiedSumUpCheckout } from "../../domain/payment.js";
import type { SumUpMerchantSummary } from "./client.js";

const SUMUP_API_BASE_URL = "https://api.sumup.com/";

type SumUpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SumUpSandboxCheckoutVerifierOptions {
  apiKey: string;
  merchant: SumUpMerchantSummary;
  fetcher?: SumUpFetch;
}

export class SumUpCheckoutVerificationError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "SumUpCheckoutVerificationError";
  }
}

/**
 * Authenticates two read-only SumUp reads: the checkout first, followed by the
 * single successful transaction linked from that checkout. It returns only the
 * normalized fields consumed by payment reconciliation.
 */
export class SumUpSandboxCheckoutVerifier {
  private readonly apiKey: string;
  private readonly merchantCode: string;
  private readonly fetcher: SumUpFetch;

  constructor(options: SumUpSandboxCheckoutVerifierOptions) {
    this.apiKey = requireConfiguredValue(options.apiKey, "API key");
    this.merchantCode = requireConfiguredValue(
      options.merchant.merchantCode,
      "merchant code",
    );
    this.fetcher = options.fetcher ?? fetch;

    if (!options.merchant.sandbox) {
      throw new SumUpCheckoutVerificationError(
        "SumUp checkout verification requires a sandbox merchant",
      );
    }

    if (options.merchant.defaultCurrency !== "EUR") {
      throw new SumUpCheckoutVerificationError(
        "SumUp sandbox merchant currency must be EUR",
      );
    }
  }

  async verifyCheckout(checkoutId: string): Promise<VerifiedSumUpCheckout> {
    const requestedCheckoutId = requireExactIdentifier(
      checkoutId,
      "Requested checkout ID",
    );
    const checkoutUrl = new URL(
      `v0.1/checkouts/${encodeURIComponent(requestedCheckoutId)}`,
      SUMUP_API_BASE_URL,
    );
    const checkoutPayload = asRecord(
      await this.getJson(checkoutUrl, "checkout"),
      "SumUp checkout response",
    );

    const returnedCheckoutId = requireExactIdentifier(
      checkoutPayload.id,
      "SumUp checkout ID",
    );
    if (returnedCheckoutId !== requestedCheckoutId) {
      throw new SumUpCheckoutVerificationError(
        "SumUp returned a different checkout",
      );
    }

    const checkoutReference = requireExactIdentifier(
      checkoutPayload.checkout_reference,
      "SumUp checkout reference",
    );
    const checkoutMerchantCode = requireExactIdentifier(
      checkoutPayload.merchant_code,
      "SumUp checkout merchant",
    );
    if (checkoutMerchantCode !== this.merchantCode) {
      throw new SumUpCheckoutVerificationError(
        "SumUp checkout belongs to a different merchant",
      );
    }

    requireEuroCurrency(checkoutPayload.currency, "SumUp checkout");
    const checkoutAmountCents = normalizeEuroCents(
      checkoutPayload.amount,
      "SumUp checkout amount",
    );
    if (checkoutPayload.status !== "PAID") {
      throw new SumUpCheckoutVerificationError(
        "SumUp checkout is not paid",
      );
    }

    const successfulTransactionId = readSuccessfulTransactionId(
      checkoutPayload.transactions,
    );
    const transactionUrl = new URL("v0.1/me/transactions", SUMUP_API_BASE_URL);
    transactionUrl.searchParams.set("id", successfulTransactionId);
    const transactionPayload = asRecord(
      await this.getJson(transactionUrl, "transaction"),
      "SumUp transaction response",
    );

    const returnedTransactionId = requireExactIdentifier(
      transactionPayload.id,
      "SumUp transaction ID",
    );
    if (returnedTransactionId !== successfulTransactionId) {
      throw new SumUpCheckoutVerificationError(
        "SumUp returned a different transaction",
      );
    }

    if (transactionPayload.status !== "SUCCESSFUL") {
      throw new SumUpCheckoutVerificationError(
        "SumUp transaction is not successful",
      );
    }

    const transactionMerchantCode = requireExactIdentifier(
      transactionPayload.merchant_code,
      "SumUp transaction merchant",
    );
    if (transactionMerchantCode !== this.merchantCode) {
      throw new SumUpCheckoutVerificationError(
        "SumUp transaction belongs to a different merchant",
      );
    }

    requireEuroCurrency(transactionPayload.currency, "SumUp transaction");
    const transactionAmountCents = normalizeEuroCents(
      transactionPayload.amount,
      "SumUp transaction amount",
    );
    if (transactionAmountCents !== checkoutAmountCents) {
      throw new SumUpCheckoutVerificationError(
        "SumUp transaction amount does not match the checkout",
      );
    }

    return {
      checkoutId: returnedCheckoutId,
      checkoutReference,
      merchantCode: checkoutMerchantCode,
      amountCents: checkoutAmountCents,
      currency: "EUR",
      status: "PAID",
      transactions: [
        {
          id: returnedTransactionId,
          status: "SUCCESSFUL",
          amountCents: transactionAmountCents,
          currency: "EUR",
        },
      ],
    };
  }

  private async getJson(url: URL, resource: "checkout" | "transaction") {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new SumUpCheckoutVerificationError(
        `SumUp ${resource} verification request failed`,
      );
    }

    if (!response.ok) {
      throw new SumUpCheckoutVerificationError(
        `SumUp ${resource} verification failed with HTTP ${response.status}`,
        response.status,
      );
    }

    try {
      return JSON.parse(await response.text()) as unknown;
    } catch {
      throw new SumUpCheckoutVerificationError(
        `SumUp ${resource} verification returned invalid JSON`,
        response.status,
      );
    }
  }
}

function readSuccessfulTransactionId(value: unknown): string {
  if (!Array.isArray(value)) {
    throw new SumUpCheckoutVerificationError(
      "SumUp checkout transactions must be an array",
    );
  }

  const successfulTransactions = value.filter((item) => {
    const transaction = asRecord(item, "SumUp checkout transaction");
    return transaction.status === "SUCCESSFUL";
  });

  if (successfulTransactions.length !== 1) {
    throw new SumUpCheckoutVerificationError(
      "SumUp checkout must contain exactly one successful transaction",
    );
  }

  const transaction = successfulTransactions[0];
  if (transaction === undefined) {
    throw new SumUpCheckoutVerificationError(
      "SumUp successful transaction is missing",
    );
  }

  return requireExactIdentifier(
    transaction.id,
    "SumUp checkout transaction ID",
  );
}

function normalizeEuroCents(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new SumUpCheckoutVerificationError(
      `${label} must be a positive number`,
    );
  }

  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents) || Math.abs(scaled - cents) > 1e-8) {
    throw new SumUpCheckoutVerificationError(
      `${label} must have at most two decimal places`,
    );
  }

  return cents;
}

function requireEuroCurrency(value: unknown, label: string): asserts value is "EUR" {
  if (value !== "EUR") {
    throw new SumUpCheckoutVerificationError(`${label} currency must be EUR`);
  }
}

function requireConfiguredValue(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new SumUpCheckoutVerificationError(
      `SumUp ${label} must not be empty`,
    );
  }
  return normalized;
}

function requireExactIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new SumUpCheckoutVerificationError(
      `${label} must be a non-empty exact string`,
    );
  }
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SumUpCheckoutVerificationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
