import {
  createPosterResponseDiagnostic,
  type PosterResponseDiagnostic,
} from "./response-diagnostic.js";

const POSTER_API_BASE_URL = "https://joinposter.com/api/";

type PosterFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface PosterAccountSummary {
  companyId: string;
  currencyIso: string;
  currencySymbol: string;
  timezone: string;
}

export interface PosterSpotPrice {
  spotId: string;
  priceCents: number;
  visible: boolean;
}

export interface PosterMenuItem {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  hidden: boolean;
  spots: PosterSpotPrice[];
}

export class PosterApiError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
    readonly diagnostic: PosterResponseDiagnostic | null = null,
  ) {
    super(message);
    this.name = "PosterApiError";
  }
}

export class PosterClient {
  constructor(
    private readonly token: string,
    private readonly fetcher: PosterFetch = fetch,
  ) {
    if (token.trim().length === 0) {
      throw new PosterApiError("Poster token must not be empty");
    }
  }

  async getAccountSummary(): Promise<PosterAccountSummary> {
    const response = asRecord(
      await this.request("settings.getAllSettings"),
      "Poster account settings",
    );
    const currency = asRecord(response.currency, "Poster account currency");

    return {
      companyId: asString(response.COMPANY_ID, "Poster company ID"),
      currencyIso: asString(currency.currency_code_iso, "Poster currency ISO"),
      currencySymbol: asString(
        currency.currency_symbol,
        "Poster currency symbol",
      ),
      timezone: asString(response.timezones, "Poster timezone"),
    };
  }

  async getMenuItems(): Promise<PosterMenuItem[]> {
    const response = await this.request("menu.getProducts");

    if (!Array.isArray(response)) {
      throw new PosterApiError("Poster menu response must be an array");
    }

    return response.map((item, index) => parseMenuItem(item, index));
  }

  /**
   * Returns unparsed incoming-order rows for a separately controlled read-only
   * inspection. Raw field mapping remains intentionally outside this client
   * until a fresh sandbox response confirms the contract.
   */
  async getOwnIncomingOrders(): Promise<readonly unknown[]> {
    const response = await this.request(
      "incomingOrders.getOwnIncomingOrders",
    );
    if (!Array.isArray(response)) {
      throw new PosterApiError(
        "Poster incoming orders response must be an array",
      );
    }
    return response;
  }

  private async request(method: string): Promise<unknown> {
    const url = new URL(method, POSTER_API_BASE_URL);
    url.searchParams.set("token", this.token);

    let response: Response;
    try {
      response = await this.fetcher(url);
    } catch {
      throw new PosterApiError(`Poster request ${method} failed`);
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch {
      throw new PosterApiError(
        `Poster request ${method} response could not be read`,
      );
    }

    const diagnostic = createPosterResponseDiagnostic({
      status: response.status,
      contentType: response.headers.get("content-type"),
      bodyText,
      sensitiveValues: [this.token],
    });

    let payload: unknown;
    try {
      payload = JSON.parse(bodyText) as unknown;
    } catch {
      throw new PosterApiError(
        `Poster request ${method} returned invalid JSON`,
        null,
        diagnostic,
      );
    }

    const envelope = asRecord(payload, "Poster response");
    if (!response.ok || "error" in envelope) {
      const error = isRecord(envelope.error) ? envelope.error : {};
      const code = parseOptionalInteger(error.code);
      const rawApiMessage =
        typeof error.message === "string" ? error.message : "unknown error";
      const apiMessage = createPosterResponseDiagnostic({
        status: response.status,
        contentType: null,
        bodyText: rawApiMessage,
        sensitiveValues: [this.token],
        maxBodyChars: 500,
      }).body;
      throw new PosterApiError(
        `Poster request ${method} failed: ${apiMessage}`,
        code,
        diagnostic,
      );
    }

    if (!("response" in envelope)) {
      throw new PosterApiError(
        `Poster request ${method} did not include a response`,
      );
    }

    return envelope.response;
  }
}

function parseMenuItem(value: unknown, index: number): PosterMenuItem {
  const item = asRecord(value, `Poster menu item ${index}`);
  const spotsValue = item.spots;
  const spots = Array.isArray(spotsValue)
    ? spotsValue.map((spot, spotIndex) =>
        parseSpot(spot, `${index}.${spotIndex}`),
      )
    : [];

  return {
    id: asString(item.product_id, `Poster menu item ${index} ID`),
    name: asString(item.product_name, `Poster menu item ${index} name`),
    categoryId: asString(
      item.menu_category_id,
      `Poster menu item ${index} category ID`,
    ),
    categoryName:
      typeof item.category_name === "string" ? item.category_name : "",
    hidden: item.hidden === "1" || item.hidden === 1,
    spots,
  };
}

function parseSpot(value: unknown, path: string): PosterSpotPrice {
  const spot = asRecord(value, `Poster spot ${path}`);
  return {
    spotId: asString(spot.spot_id, `Poster spot ${path} ID`),
    priceCents: asNonNegativeInteger(
      spot.price,
      `Poster spot ${path} price`,
    ),
    visible: spot.visible === "1" || spot.visible === 1,
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PosterApiError(`${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PosterApiError(`${label} must be a non-empty string`);
  }
  return value;
}

function asNonNegativeInteger(value: unknown, label: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PosterApiError(`${label} must be a non-negative integer`);
  }

  return parsed;
}

function parseOptionalInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}
