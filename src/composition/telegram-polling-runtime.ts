import { loadTelegramRuntimeConfig } from "../config/telegram.js";
import {
  TelegramBotApiHttpTransport,
  type TelegramApiTransport,
  type TelegramBotApiHttpTransportOptions,
} from "../integrations/telegram/api-transport.js";
import {
  TelegramLongPollingAdapter,
  type TelegramUpdateHandler,
} from "../integrations/telegram/polling-adapter.js";

export interface TelegramPollingRuntimeDependencies {
  updateHandler: TelegramUpdateHandler;
}

export interface TelegramPollingRuntimeOptions
  extends TelegramBotApiHttpTransportOptions {
  environment?: NodeJS.ProcessEnv;
  timeoutSeconds?: number;
  transport?: TelegramApiTransport;
}

export type TelegramPollingRuntime =
  | { enabled: false }
  | { enabled: true; adapter: TelegramLongPollingAdapter };

/**
 * Explicit opt-in composition. Construction never starts polling and this
 * module is deliberately not imported by the ordinary server bootstrap.
 */
export function createTelegramPollingRuntime(
  dependencies: TelegramPollingRuntimeDependencies,
  options: TelegramPollingRuntimeOptions = {},
): TelegramPollingRuntime {
  const config = loadTelegramRuntimeConfig(options.environment ?? process.env);
  if (!config.enabled) return { enabled: false };

  const transportOptions: TelegramBotApiHttpTransportOptions = {};
  if (options.fetcher !== undefined) transportOptions.fetcher = options.fetcher;
  if (options.requestTimeoutMs !== undefined) {
    transportOptions.requestTimeoutMs = options.requestTimeoutMs;
  }
  const transport =
    options.transport ?? new TelegramBotApiHttpTransport(config, transportOptions);
  const adapterOptions =
    options.timeoutSeconds === undefined
      ? {}
      : { timeoutSeconds: options.timeoutSeconds };

  return {
    enabled: true,
    adapter: new TelegramLongPollingAdapter(
      { updateHandler: dependencies.updateHandler, transport },
      adapterOptions,
    ),
  };
}
