export const POSTER_RESPONSE_BODY_LIMIT = 2_000;

const MAX_CONTENT_TYPE_LENGTH = 200;
const TRUNCATION_SUFFIX = "…[truncated]";

export interface PosterResponseLike {
  status: number;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}

export interface PosterResponseDiagnosticOptions {
  sensitiveValues?: readonly string[];
  maxBodyChars?: number;
}

export interface PosterResponseDiagnosticInput
  extends PosterResponseDiagnosticOptions {
  status: number;
  contentType: string | null;
  bodyText: string;
}

export interface PosterResponseDiagnostic {
  status: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

/**
 * Reads an already received response. It never performs a request.
 */
export async function capturePosterResponseDiagnostic(
  response: PosterResponseLike,
  options: PosterResponseDiagnosticOptions = {},
): Promise<PosterResponseDiagnostic> {
  return createPosterResponseDiagnostic({
    status: response.status,
    contentType: response.headers.get("content-type"),
    bodyText: await response.text(),
    ...options,
  });
}

/**
 * Produces a bounded diagnostic record without request URLs, query strings, or
 * values that the caller identifies as sensitive.
 */
export function createPosterResponseDiagnostic(
  input: PosterResponseDiagnosticInput,
): PosterResponseDiagnostic {
  assertHttpStatus(input.status);

  const maxBodyChars = input.maxBodyChars ?? POSTER_RESPONSE_BODY_LIMIT;
  if (
    !Number.isSafeInteger(maxBodyChars) ||
    maxBodyChars < TRUNCATION_SUFFIX.length ||
    maxBodyChars > POSTER_RESPONSE_BODY_LIMIT
  ) {
    throw new TypeError(
      `Poster diagnostic body limit must be an integer from ${TRUNCATION_SUFFIX.length} to ${POSTER_RESPONSE_BODY_LIMIT}`,
    );
  }

  if (typeof input.bodyText !== "string") {
    throw new TypeError("Poster diagnostic body must be a string");
  }

  const sanitizedBody = sanitizeBody(
    input.bodyText,
    input.sensitiveValues ?? [],
  );
  const truncated = sanitizedBody.length > maxBodyChars;
  const body = truncated
    ? `${sanitizedBody.slice(0, maxBodyChars - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`
    : sanitizedBody;

  return {
    status: input.status,
    contentType: sanitizeContentType(input.contentType),
    body,
    truncated,
  };
}

function sanitizeBody(
  bodyText: string,
  sensitiveValues: readonly string[],
): string {
  let sanitized = bodyText;

  // Remove the whole query component from any URL before handling individual
  // values. This also covers tokens reflected in an error's request URL.
  sanitized = sanitized.replace(
    /https?:\/\/[^\s"'<>?]+\?[^\s"'<>]*/giu,
    (url) => `${url.slice(0, url.indexOf("?"))}[QUERY_REDACTED]`,
  );

  // Redact common credential fields even when the caller did not know the
  // value returned by Poster.
  sanitized = sanitized.replace(
    /("(?:access_token|authorization|api[_-]?key|secret|token)"\s*:\s*)(?:"(?:\\.|[^"\\])*"|[^,}\]\s]+)/giu,
    "$1\"[REDACTED]\"",
  );
  sanitized = sanitized.replace(
    /((?:^|[?&;\s])(?:access_token|authorization|api[_-]?key|secret|token)=)[^&;\s"'<>]*/giu,
    "$1[REDACTED]",
  );

  for (const value of expandSensitiveValues(sensitiveValues)) {
    if (value.length > 0) {
      sanitized = sanitized.split(value).join("[REDACTED]");
    }
  }

  // Customer details may be echoed by validation errors. These patterns are
  // intentionally conservative; callers should still pass all known fixture
  // values through sensitiveValues.
  sanitized = sanitized.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    "[REDACTED_EMAIL]",
  );
  sanitized = sanitized.replace(
    /(?:^|(?<=\s|["'(:,]))\+[1-9]\d{6,14}\b/gu,
    "[REDACTED_PHONE]",
  );

  return sanitized;
}

function expandSensitiveValues(values: readonly string[]): string[] {
  const expanded = new Set(values);

  for (const value of values) {
    // Poster may normalize an E.164 phone by removing its leading plus sign
    // before echoing it in phone or first_name.
    if (/^\+[1-9]\d{6,14}$/u.test(value)) {
      expanded.add(value.slice(1));
    }
  }

  return [...expanded].sort((left, right) => right.length - left.length);
}

function sanitizeContentType(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const sanitized = value.replace(/[\r\n]+/gu, " ").trim();
  return sanitized.length === 0
    ? null
    : sanitized.slice(0, MAX_CONTENT_TYPE_LENGTH);
}

function assertHttpStatus(status: number): void {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    throw new TypeError("Poster diagnostic status must be a valid HTTP status");
  }
}
