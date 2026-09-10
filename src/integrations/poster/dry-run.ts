import {
  buildPosterIncomingOrderPayload,
  buildPosterMinimalIncomingOrderPayload,
  type BuildPosterIncomingOrderPayloadInput,
  type BuildPosterMinimalIncomingOrderPayloadInput,
} from "./order-payload.js";

export const POSTER_CREATE_INCOMING_ORDER_ENDPOINT =
  "https://joinposter.com/api/incomingOrders.createIncomingOrder" as const;

export interface PosterCreateIncomingOrderDryRun {
  mode: "dry-run";
  method: "POST";
  endpoint: typeof POSTER_CREATE_INCOMING_ORDER_ENDPOINT;
  headers: {
    "Content-Type": "application/json";
  };
  body: string;
}

/**
 * Prepares the exact non-authenticated request shape without performing I/O.
 *
 * The real Poster token belongs in the URL query string, but this dry-run API
 * deliberately has no token parameter and returns an endpoint without a query.
 */
export function preparePosterCreateIncomingOrderDryRun(
  input: BuildPosterIncomingOrderPayloadInput,
): PosterCreateIncomingOrderDryRun {
  const payload = buildPosterIncomingOrderPayload(input);

  return {
    mode: "dry-run",
    method: "POST",
    endpoint: POSTER_CREATE_INCOMING_ORDER_ENDPOINT,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  };
}

/** Prepares the historical minimum without credentials or network I/O. */
export function preparePosterMinimalCreateIncomingOrderDryRun(
  input: BuildPosterMinimalIncomingOrderPayloadInput,
): PosterCreateIncomingOrderDryRun {
  const payload = buildPosterMinimalIncomingOrderPayload(input);

  return {
    mode: "dry-run",
    method: "POST",
    endpoint: POSTER_CREATE_INCOMING_ORDER_ENDPOINT,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  };
}
