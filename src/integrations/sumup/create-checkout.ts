import {
  SUMUP_CREATE_CHECKOUT_ENDPOINT,
  type SumUpHostedCheckoutPreparation,
} from "./hosted-checkout.js";

type SumUpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CreateSumUpHostedCheckoutOptions {
  apiKey: string;
  checkout: SumUpHostedCheckoutPreparation;
  fetcher?: SumUpFetch;
}

export interface CreatedSumUpHostedCheckout {
  checkoutId: string;
  checkoutReference: string;
  merchantCode: string;
  amountCents: number;
  currency: "EUR";
  status: "PENDING";
  hostedCheckoutUrl: string;
}

export class SumUpCheckoutCreationError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "SumUpCheckoutCreationError";
  }
}

/** Performs exactly one authenticated checkout POST without retries. */
export async function createSumUpHostedCheckout(
  options: CreateSumUpHostedCheckoutOptions,
): Promise<CreatedSumUpHostedCheckout> {
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0) {
    throw new SumUpCheckoutCreationError("SumUp API key must not be empty");
  }

  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(SUMUP_CREATE_CHECKOUT_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(options.checkout.payload),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SumUpCheckoutCreationError(
      "SumUp checkout creation request failed",
    );
  }

  if (response.status !== 201) {
    throw new SumUpCheckoutCreationError(
      `SumUp checkout creation failed with HTTP ${response.status}`,
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    throw new SumUpCheckoutCreationError(
      "SumUp checkout creation returned invalid JSON",
      response.status,
    );
  }

  const checkout = asRecord(payload, "SumUp checkout response");
  const checkoutId = requireExactString(
    checkout.id,
    "SumUp checkout ID",
  );
  const checkoutReference = requireExactString(
    checkout.checkout_reference,
    "SumUp checkout reference",
  );
  if (checkoutReference !== options.checkout.checkoutReference) {
    throw new SumUpCheckoutCreationError(
      "SumUp returned a different checkout reference",
    );
  }

  const merchantCode = requireExactString(
    checkout.merchant_code,
    "SumUp checkout merchant",
  );
  if (merchantCode !== options.checkout.payload.merchant_code) {
    throw new SumUpCheckoutCreationError(
      "SumUp returned a different checkout merchant",
    );
  }

  if (checkout.currency !== "EUR") {
    throw new SumUpCheckoutCreationError(
      "SumUp checkout currency must be EUR",
    );
  }

  const amountCents = normalizeEuroCents(checkout.amount);
  if (amountCents !== options.checkout.amountCents) {
    throw new SumUpCheckoutCreationError(
      "SumUp returned a different checkout amount",
    );
  }

  if (checkout.status !== "PENDING") {
    throw new SumUpCheckoutCreationError(
      "New SumUp checkout must be pending",
    );
  }

  const hostedCheckoutUrl = normalizeHostedCheckoutUrl(
    checkout.hosted_checkout_url,
  );

  return {
    checkoutId,
    checkoutReference,
    merchantCode,
    amountCents,
    currency: "EUR",
    status: "PENDING",
    hostedCheckoutUrl,
  };
}

function normalizeEuroCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new SumUpCheckoutCreationError(
      "SumUp checkout amount must be a positive number",
    );
  }

  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents) || Math.abs(scaled - cents) > 1e-8) {
    throw new SumUpCheckoutCreationError(
      "SumUp checkout amount must have at most two decimal places",
    );
  }
  return cents;
}

function normalizeHostedCheckoutUrl(value: unknown): string {
  const exact = requireExactString(value, "SumUp hosted checkout URL");
  let url: URL;
  try {
    url = new URL(exact);
  } catch {
    throw new SumUpCheckoutCreationError(
      "SumUp hosted checkout URL must be valid HTTPS",
    );
  }

  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new SumUpCheckoutCreationError(
      "SumUp hosted checkout URL must be valid HTTPS without credentials or fragment",
    );
  }

  return url.href;
}

function requireExactString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new SumUpCheckoutCreationError(
      `${label} must be a non-empty exact string`,
    );
  }
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SumUpCheckoutCreationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
