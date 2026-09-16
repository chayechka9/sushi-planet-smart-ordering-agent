import { createOpenAIInterpreterRuntime } from "../composition/openai-conversation-runtime.js";
import {
  preflightTelegramRuntimeConfiguration,
  type TelegramRuntimePreflightDiagnostic,
} from "../config/telegram-runtime-preflight.js";
import {
  runTelegramPolling,
  TELEGRAM_POLLING_CONFIRMATION,
  type TelegramPollingRunnerEvent,
  type TelegramPollingRunnerOptions,
  type TelegramPollingRunnerSummary,
} from "./telegram-polling-runner.js";

export const TELEGRAM_RUNTIME_CONFIRMATION = "--confirm-telegram-runtime";

export type TelegramRuntimeEvent =
  | {
      status: "preflight_ready";
      aiFallback: "disabled" | "enabled";
    }
  | TelegramPollingRunnerEvent;

export type TelegramRuntimeSummary =
  | { status: "error"; errorCode: "confirmation_required" }
  | {
      status: "error";
      errorCode: "preflight_failed";
      diagnosticReason: TelegramRuntimePreflightDiagnostic;
    }
  | TelegramPollingRunnerSummary;

type TelegramPollingStarter = (
  options: TelegramPollingRunnerOptions,
) => Promise<TelegramPollingRunnerSummary>;

export interface TelegramRuntimeOptions {
  argv: readonly string[];
  environment?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onEvent?: (event: TelegramRuntimeEvent) => void | Promise<void>;
  startPolling?: TelegramPollingStarter;
}

/**
 * Explicit Telegram runtime boundary. It performs a sanitized local preflight
 * before constructing the optional AI interpreter or delegating to the one
 * existing polling runner.
 */
export async function runTelegramRuntime(
  options: TelegramRuntimeOptions,
): Promise<TelegramRuntimeSummary> {
  if (!hasExactConfirmation(options.argv)) {
    return { status: "error", errorCode: "confirmation_required" };
  }

  const environment = options.environment ?? process.env;
  const preflight = preflightTelegramRuntimeConfiguration(environment);
  if (preflight.status === "blocked") {
    return {
      status: "error",
      errorCode: "preflight_failed",
      diagnosticReason: preflight.diagnostic,
    };
  }

  await options.onEvent?.({
    status: "preflight_ready",
    aiFallback: preflight.aiFallback,
  });

  const aiRuntime = createOpenAIInterpreterRuntime({ environment });
  const startPolling = options.startPolling ?? runTelegramPolling;
  return startPolling({
    argv: [TELEGRAM_POLLING_CONFIRMATION],
    environment,
    signal: options.signal,
    ...(aiRuntime.enabled
      ? { aiFallback: { interpreter: aiRuntime.interpreter } }
      : {}),
    ...(options.onEvent === undefined
      ? {}
      : { onEvent: options.onEvent }),
  });
}

function hasExactConfirmation(argv: readonly string[]): boolean {
  return argv.length === 1 && argv[0] === TELEGRAM_RUNTIME_CONFIRMATION;
}
