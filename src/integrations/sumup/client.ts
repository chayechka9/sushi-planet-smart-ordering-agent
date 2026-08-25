const SUMUP_API_BASE_URL = "https://api.sumup.com/";

type SumUpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SumUpMerchantSummary {
  merchantCode: string;
  country: string;
  defaultCurrency: string;
  sandbox: boolean;
}

export class SumUpApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "SumUpApiError";
  }
}

export class SumUpClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: SumUpFetch = fetch,
  ) {
    if (apiKey.trim().length === 0) {
      throw new SumUpApiError("SumUp API key must not be empty");
    }
  }

  /**
   * Performs the documented read-only Get Merchant request exactly once.
   */
  async getMerchantSummary(
    merchantCode: string,
  ): Promise<SumUpMerchantSummary> {
    const normalizedMerchantCode = merchantCode.trim();
    if (normalizedMerchantCode.length === 0) {
      throw new SumUpApiError("SumUp merchant code must not be empty");
    }

    const url = new URL(
      `v1/merchants/${encodeURIComponent(normalizedMerchantCode)}`,
      SUMUP_API_BASE_URL,
    );

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
      throw new SumUpApiError("SumUp Get Merchant request failed");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await response.text()) as unknown;
    } catch {
      throw new SumUpApiError(
        "SumUp Get Merchant returned invalid JSON",
        response.status,
      );
    }

    if (!response.ok) {
      throw new SumUpApiError(
        `SumUp Get Merchant failed with HTTP ${response.status}`,
        response.status,
      );
    }

    const merchant = asRecord(payload, "SumUp merchant response");
    const returnedMerchantCode = asString(
      merchant.merchant_code,
      "SumUp merchant code",
    );

    if (returnedMerchantCode !== normalizedMerchantCode) {
      throw new SumUpApiError(
        "SumUp Get Merchant returned a different merchant",
      );
    }

    return {
      merchantCode: returnedMerchantCode,
      country: asString(merchant.country, "SumUp merchant country"),
      defaultCurrency: asString(
        merchant.default_currency,
        "SumUp merchant currency",
      ),
      sandbox: asBoolean(merchant.sandbox, "SumUp merchant sandbox flag"),
    };
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SumUpApiError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SumUpApiError(`${label} must be a non-empty string`);
  }
  return value;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new SumUpApiError(`${label} must be a boolean`);
  }
  return value;
}
