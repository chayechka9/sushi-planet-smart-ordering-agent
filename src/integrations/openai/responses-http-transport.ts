import type {
  OpenAIConversationResponseRequest,
  OpenAIConversationResponseTransport,
} from "./conversation-interpreter.js";

const responsesEndpoint = "https://api.openai.com/v1/responses";
const defaultTimeoutMs = 20_000;

export type OpenAIResponsesFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type OpenAIResponsesTransportErrorCode =
  | "invalid_configuration"
  | "http_error"
  | "network_error"
  | "timeout"
  | "invalid_json";

export class OpenAIResponsesTransportError extends Error {
  constructor(readonly code: OpenAIResponsesTransportErrorCode) {
    super(errorMessage(code));
    this.name = "OpenAIResponsesTransportError";
  }
}

export interface OpenAIResponsesHttpTransportOptions {
  fetcher?: OpenAIResponsesFetch;
  timeoutMs?: number;
}

/**
 * Network-only Responses API transport. Runtime composition remains responsible
 * for injecting it into the OpenAI interpreter.
 */
export class OpenAIResponsesHttpTransport
  implements OpenAIConversationResponseTransport
{
  private readonly fetcher: OpenAIResponsesFetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAIResponsesHttpTransportOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new OpenAIResponsesTransportError("invalid_configuration");
    }
  }

  async createResponse(
    request: OpenAIConversationResponseRequest,
    apiKey: string,
  ): Promise<unknown> {
    const normalizedApiKey = apiKey.trim();
    if (normalizedApiKey.length === 0) {
      throw new OpenAIResponsesTransportError("invalid_configuration");
    }

    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new OpenAIResponsesTransportError("timeout"));
      }, this.timeoutMs);
    });

    try {
      const fetchResponse = Promise.resolve()
        .then(() =>
          this.fetcher(responsesEndpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${normalizedApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: request.model,
              reasoning: request.reasoning,
              instructions: request.instructions,
              input: request.input,
              text: request.text,
              store: false,
            } satisfies OpenAIConversationResponseRequest),
            signal: controller.signal,
          }),
        )
        .catch(() => {
          throw new OpenAIResponsesTransportError(
            controller.signal.aborted ? "timeout" : "network_error",
          );
        });
      const response = await Promise.race([fetchResponse, timeout]);

      if (!response.ok) {
        throw new OpenAIResponsesTransportError("http_error");
      }

      return await Promise.race([
        Promise.resolve()
          .then(() => response.json())
          .catch(() => {
            throw new OpenAIResponsesTransportError(
              controller.signal.aborted ? "timeout" : "invalid_json",
            );
          }),
        timeout,
      ]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }
}

function errorMessage(code: OpenAIResponsesTransportErrorCode): string {
  switch (code) {
    case "invalid_configuration":
      return "OpenAI Responses transport configuration is invalid";
    case "http_error":
      return "OpenAI Responses request was rejected";
    case "network_error":
      return "OpenAI Responses network request failed";
    case "timeout":
      return "OpenAI Responses request timed out";
    case "invalid_json":
      return "OpenAI Responses response was not valid JSON";
  }
}
