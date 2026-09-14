import type { TelegramEnabledRuntimeConfig } from "../../config/telegram.js";

export interface TelegramUpdateEnvelope {
  updateId: number;
  payload: unknown;
}

export interface TelegramGetUpdatesInput {
  offset?: number;
  timeoutSeconds: number;
  signal?: AbortSignal;
}

export interface TelegramSendMessageInput {
  chatId: number;
  text: string;
  signal?: AbortSignal;
}

/** Injectable Telegram boundary used by the polling adapter and local fakes. */
export interface TelegramApiTransport {
  getUpdates(
    input: TelegramGetUpdatesInput,
  ): Promise<readonly TelegramUpdateEnvelope[]>;
  sendMessage(input: TelegramSendMessageInput): Promise<void>;
}

export type TelegramFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TelegramBotApiHttpTransportOptions {
  fetcher?: TelegramFetch;
  requestTimeoutMs?: number;
}

export type TelegramTransportFailureCode =
  | "timeout"
  | "http_failure"
  | "network_failure"
  | "invalid_response"
  | "internal_failure";

export class TelegramApiTransportError extends Error {
  constructor(readonly code: TelegramTransportFailureCode) {
    super("Telegram API request failed");
    this.name = "TelegramApiTransportError";
  }
}

/**
 * Token-aware HTTP transport. It can only be constructed from an explicitly
 * enabled runtime config and performs no request until a method is called.
 */
export class TelegramBotApiHttpTransport implements TelegramApiTransport {
  private readonly fetcher: TelegramFetch;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly config: TelegramEnabledRuntimeConfig,
    options: TelegramBotApiHttpTransportOptions = {},
  ) {
    if (config.enabled !== true || config.botToken.trim().length === 0) {
      throw new TelegramApiTransportError("internal_failure");
    }
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 35_000;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1
    ) {
      throw new TelegramApiTransportError("internal_failure");
    }
  }

  async getUpdates(
    input: TelegramGetUpdatesInput,
  ): Promise<readonly TelegramUpdateEnvelope[]> {
    assertTimeoutSeconds(input.timeoutSeconds);
    if (
      input.offset !== undefined &&
      (!Number.isSafeInteger(input.offset) || input.offset < 0)
    ) {
      throw new TelegramApiTransportError("internal_failure");
    }

    const body: Record<string, unknown> = {
      timeout: input.timeoutSeconds,
      allowed_updates: ["message"],
    };
    if (input.offset !== undefined) body.offset = input.offset;

    const result = await this.request("getUpdates", body, input.signal);
    if (!Array.isArray(result)) {
      throw new TelegramApiTransportError("invalid_response");
    }

    return result.map((value) => {
      if (!isRecord(value)) {
        throw new TelegramApiTransportError("invalid_response");
      }
      const updateId = value.update_id;
      if (!Number.isSafeInteger(updateId) || (updateId as number) < 0) {
        throw new TelegramApiTransportError("invalid_response");
      }
      return { updateId: updateId as number, payload: value };
    });
  }

  async sendMessage(input: TelegramSendMessageInput): Promise<void> {
    if (
      !Number.isSafeInteger(input.chatId) ||
      input.chatId === 0 ||
      input.text.trim().length === 0 ||
      input.text.length > 4_096
    ) {
      throw new TelegramApiTransportError("internal_failure");
    }
    await this.request(
      "sendMessage",
      { chat_id: input.chatId, text: input.text },
      input.signal,
    );
  }

  private async request(
    method: "getUpdates" | "sendMessage",
    body: Record<string, unknown>,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromExternal = () => controller.abort();
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    if (externalSignal?.aborted) controller.abort();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);

    try {
      const response = await this.fetcher(
        `https://api.telegram.org/bot${this.config.botToken}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          redirect: "manual",
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new TelegramApiTransportError("http_failure");
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (timedOut) throw new TelegramApiTransportError("timeout");
        throw new TelegramApiTransportError("invalid_response");
      }
      if (!isRecord(payload) || payload.ok !== true || !("result" in payload)) {
        throw new TelegramApiTransportError("invalid_response");
      }
      return payload.result;
    } catch (error) {
      if (error instanceof TelegramApiTransportError) throw error;
      throw new TelegramApiTransportError(
        timedOut ? "timeout" : "network_failure",
      );
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  }
}

function assertTimeoutSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 50) {
    throw new TelegramApiTransportError("internal_failure");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
