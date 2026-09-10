import { POSTER_CREATE_INCOMING_ORDER_ENDPOINT } from "./dry-run.js";
import type {
  PosterOrderSubmission,
  PosterOrderSubmissionIdentity,
  PosterOrderSubmissionReceipt,
  PosterOrderSubmitter,
  PosterSandboxOrderSubmission,
} from "./submitter.js";

export interface PosterSandboxPostRequest {
  method: "POST";
  endpoint: typeof POSTER_CREATE_INCOMING_ORDER_ENDPOINT;
  headers: {
    "Content-Type": "application/json";
  };
  body: string;
}

export interface PosterSandboxPostResponse {
  ok: boolean;
  status: number;
  contentType: string | null;
  bodyText: string;
}

/**
 * Explicit write boundary for one separately authorized sandbox attempt.
 * No production or default HTTP implementation exists in this project.
 */
export interface PosterSandboxPostTransport {
  isEnabled(): boolean;
  post(request: PosterSandboxPostRequest): Promise<PosterSandboxPostResponse>;
}

type PosterSandboxFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface PosterSandboxHttpTransportOptions {
  token: string;
  enabled?: boolean;
  fetcher?: PosterSandboxFetch;
}

export type PosterSandboxSubmissionResult =
  | ({ outcome: "submitted" } & PosterOrderSubmissionReceipt)
  | {
      outcome: "uncertain";
      diagnostic: PosterSandboxSubmissionDiagnostic;
    };

export interface PosterSandboxSubmissionDiagnostic {
  stage:
    | "attempt_in_progress"
    | "identity_mismatch"
    | "network"
    | "http_response"
    | "response_contract";
  httpStatus: number | null;
  contentType: string | null;
}

export interface PosterSandboxOrderSubmitter {
  submitOnce(
    submission: PosterSandboxOrderSubmission,
  ): Promise<PosterSandboxSubmissionResult>;
}

export class PosterSandboxTransportDisabledError extends Error {
  constructor() {
    super("Poster sandbox POST transport is disabled");
    this.name = "PosterSandboxTransportDisabledError";
  }
}

export class PosterSandboxTransportError extends Error {
  constructor() {
    super("Poster sandbox HTTP transport failed");
    this.name = "PosterSandboxTransportError";
  }
}

/**
 * Token-aware HTTP transport kept behind an explicit runtime gate. Constructing
 * it does not perform I/O; `enabled: true` must be supplied for a POST.
 */
export class PosterSandboxHttpPostTransport
  implements PosterSandboxPostTransport
{
  private readonly enabled: boolean;
  private readonly fetcher: PosterSandboxFetch;

  constructor(private readonly options: PosterSandboxHttpTransportOptions) {
    if (options.token.trim().length === 0) {
      throw new PosterSandboxTransportDisabledError();
    }
    this.enabled = options.enabled === true;
    this.fetcher = options.fetcher ?? fetch;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async post(
    request: PosterSandboxPostRequest,
  ): Promise<PosterSandboxPostResponse> {
    if (!this.enabled) {
      throw new PosterSandboxTransportDisabledError();
    }
    if (
      request.method !== "POST" ||
      request.endpoint !== POSTER_CREATE_INCOMING_ORDER_ENDPOINT
    ) {
      throw new PosterSandboxTransportDisabledError();
    }

    const url = new URL(request.endpoint);
    url.searchParams.set("token", this.options.token);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    } catch {
      throw new PosterSandboxTransportError();
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch {
      throw new PosterSandboxTransportError();
    }
    return {
      ok: response.ok,
      status: response.status,
      contentType: readSafeContentType(response.headers.get("content-type")),
      bodyText,
    };
  }
}

export class PosterSandboxSubmissionUncertainError extends Error {
  constructor() {
    super("Poster sandbox submission result is uncertain; retry is blocked");
    this.name = "PosterSandboxSubmissionUncertainError";
  }
}

/**
 * One-shot sandbox submitter around an injected transport.
 *
 * It never reads configuration, owns no credentials, performs no retry, and
 * cannot make an HTTP request unless a caller explicitly supplies a transport.
 */
export class InjectedPosterSandboxSubmitter
  implements PosterSandboxOrderSubmitter, PosterOrderSubmitter
{
  private attempted = false;
  private attemptedIdentity: PosterOrderSubmissionIdentity | undefined;
  private completedResult: PosterSandboxSubmissionResult | undefined;

  constructor(private readonly transport?: PosterSandboxPostTransport) {}

  isEnabled(): boolean {
    return this.transport?.isEnabled() === true;
  }

  async submitOnce(
    submission: PosterSandboxOrderSubmission,
  ): Promise<PosterSandboxSubmissionResult> {
    if (this.transport === undefined || !this.transport.isEnabled()) {
      throw new PosterSandboxTransportDisabledError();
    }
    if (this.attempted) {
      if (!matchesIdentity(this.attemptedIdentity, submission)) {
        return uncertain("identity_mismatch");
      }
      return this.completedResult ?? uncertain("attempt_in_progress");
    }
    if (!hasSafeSubmissionShape(submission)) {
      throw new PosterSandboxTransportDisabledError();
    }

    this.attempted = true;
    this.attemptedIdentity = {
      correlationId: submission.correlationId,
      payloadFingerprint: submission.payloadFingerprint,
    };
    let response: PosterSandboxPostResponse;
    try {
      response = await this.transport.post({
        method: "POST",
        endpoint: POSTER_CREATE_INCOMING_ORDER_ENDPOINT,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission.payload),
      });
    } catch {
      return this.finish(uncertain("network"));
    }

    if (!response.ok || response.status !== 200) {
      return this.finish(
        uncertain("http_response", response.status, response.contentType),
      );
    }

    const posterOrderId = parseConfirmedPosterOrderId(response.bodyText);
    if (posterOrderId === undefined) {
      return this.finish(
        uncertain("response_contract", response.status, response.contentType),
      );
    }

    return this.finish({ outcome: "submitted", posterOrderId });
  }

  async submitOrder(
    submission: PosterOrderSubmission,
  ): Promise<PosterOrderSubmissionReceipt> {
    const result = await this.submitOnce(submission);
    if (result.outcome === "uncertain") {
      throw new PosterSandboxSubmissionUncertainError();
    }
    return { posterOrderId: result.posterOrderId };
  }

  private finish(
    result: PosterSandboxSubmissionResult,
  ): PosterSandboxSubmissionResult {
    this.completedResult = result;
    return result;
  }
}

function hasSafeSubmissionShape(
  submission: PosterSandboxOrderSubmission,
): boolean {
  const payload = submission.payload;
  if ("payment" in payload) {
    return payload.comment === submission.correlationId;
  }

  return (
    Object.keys(payload).sort().join(",") === "phone,products,spot_id" &&
    payload.products.length === 1 &&
    Object.keys(payload.products[0]).sort().join(",") === "count,product_id"
  );
}

function parseConfirmedPosterOrderId(bodyText: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(payload) || !isRecord(payload.response)) {
    return undefined;
  }
  const value = payload.response.incoming_order_id;
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim().length === 0
  ) {
    return undefined;
  }
  return String(value).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesIdentity(
  attempted: PosterOrderSubmissionIdentity | undefined,
  current: PosterOrderSubmissionIdentity,
): boolean {
  return (
    attempted !== undefined &&
    attempted.correlationId === current.correlationId &&
    attempted.payloadFingerprint === current.payloadFingerprint
  );
}

function uncertain(
  stage: PosterSandboxSubmissionDiagnostic["stage"],
  httpStatus: number | null = null,
  contentType: string | null = null,
): Extract<PosterSandboxSubmissionResult, { outcome: "uncertain" }> {
  return {
    outcome: "uncertain",
    diagnostic: { stage, httpStatus, contentType },
  };
}

function readSafeContentType(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value.replace(/[\r\n]+/gu, " ").trim().slice(0, 200);
}
