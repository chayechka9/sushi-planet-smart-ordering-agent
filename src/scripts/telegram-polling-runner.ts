import { resolve } from "node:path";

import { AIConversationLayerService } from "../application/ai-conversation-layer.js";
import { LocalConversationAgentService } from "../application/local-conversation-agent.js";
import { createTelegramPollingRuntime } from "../composition/telegram-polling-runtime.js";
import {
  loadTelegramRuntimeConfig,
  TelegramRuntimeConfigurationError,
} from "../config/telegram.js";
import { createOrder } from "../domain/order.js";
import {
  TelegramApiTransportError,
  type TelegramApiTransport,
  type TelegramTransportFailureCode,
} from "../integrations/telegram/api-transport.js";
import { DeterministicTelegramInterpreter } from "../integrations/telegram/deterministic-interpreter.js";
import type { TelegramPollResult } from "../integrations/telegram/polling-adapter.js";
import {
  defaultLocalMenuSnapshotPath,
  ValidatedLocalMenuSnapshotProvider,
} from "../menu/local-menu-snapshot.js";
import { SqliteConversationStateStore } from "../storage/sqlite/conversation-state-store.js";

export const TELEGRAM_POLLING_CONFIRMATION = "--confirm-telegram-polling";

export type TelegramPollingRunnerEvent =
  | { status: "started" }
  | {
      status: "batch";
      received: number;
      replied: number;
      ignored: number;
      processingFailed: number;
      sendFailed: number;
    };

export type TelegramPollingRunnerSummary =
  | { status: "stopped" }
  | {
      status: "error";
      errorCode:
        | "confirmation_required"
        | "runtime_disabled"
        | "invalid_configuration";
    }
  | {
      status: "error";
      errorCode: "polling_failed";
      diagnosticReason: TelegramTransportFailureCode;
    };

export interface TelegramPollingRunnerOptions {
  argv: readonly string[];
  environment?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  databasePath?: string;
  menuSnapshotPath?: string;
  transport?: TelegramApiTransport;
  onEvent?: (event: TelegramPollingRunnerEvent) => void | Promise<void>;
}

/**
 * Runs only the deterministic Telegram conversation path. It does not import
 * or compose OpenAI, SumUp or Poster and emits only aggregate status events.
 */
export async function runTelegramPolling(
  options: TelegramPollingRunnerOptions,
): Promise<TelegramPollingRunnerSummary> {
  if (!hasExactConfirmation(options.argv)) {
    return { status: "error", errorCode: "confirmation_required" };
  }

  const environment = options.environment ?? process.env;
  try {
    const config = loadTelegramRuntimeConfig(environment);
    if (!config.enabled) {
      return { status: "error", errorCode: "runtime_disabled" };
    }
  } catch (error) {
    if (error instanceof TelegramRuntimeConfigurationError) {
      return { status: "error", errorCode: "invalid_configuration" };
    }
    return { status: "error", errorCode: "invalid_configuration" };
  }

  let stateStore: SqliteConversationStateStore | undefined;
  try {
    stateStore = new SqliteConversationStateStore(
      options.databasePath ??
        resolve(process.cwd(), "telegram-conversations.sqlite"),
    );
    const conversationAgent = new LocalConversationAgentService({
      stateStore,
      menuProvider: new ValidatedLocalMenuSnapshotProvider(
        options.menuSnapshotPath ?? defaultLocalMenuSnapshotPath(),
      ),
      deliveryFeePolicy: {
        getDeliveryFeeCents: () => {
          throw new Error("Delivery is unavailable in Telegram test mode");
        },
      },
      checkoutFlow: {
        prepareCheckoutLink: async () => {
          throw new Error("Checkout is unavailable in Telegram test mode");
        },
      },
      checkoutMerchant: {
        merchantCode: "telegram-test-mode-disabled",
        country: "IE",
        defaultCurrency: "EUR",
        sandbox: true,
      },
      createOrder,
    });
    const conversation = new AIConversationLayerService({
      interpreter: new DeterministicTelegramInterpreter(),
      conversationAgent,
      stateStore,
    });
    const runtime = createTelegramPollingRuntime(
      { conversation, stateStore },
      {
        environment,
        ...(options.transport === undefined
          ? {}
          : { transport: options.transport }),
      },
    );
    if (!runtime.enabled) {
      return { status: "error", errorCode: "runtime_disabled" };
    }

    await options.onEvent?.({ status: "started" });
    await runtime.adapter.run(options.signal, async (result) => {
      await options.onEvent?.(summarizeBatch(result));
    });
    return { status: "stopped" };
  } catch (error) {
    if (options.signal.aborted) return { status: "stopped" };
    return {
      status: "error",
      errorCode: "polling_failed",
      diagnosticReason:
        error instanceof TelegramApiTransportError
          ? error.code
          : "internal_failure",
    };
  } finally {
    stateStore?.close();
  }
}

function hasExactConfirmation(argv: readonly string[]): boolean {
  return argv.length === 1 && argv[0] === TELEGRAM_POLLING_CONFIRMATION;
}

function summarizeBatch(result: TelegramPollResult): TelegramPollingRunnerEvent {
  let replied = 0;
  let ignored = 0;
  let processingFailed = 0;
  let sendFailed = 0;
  for (const outcome of result.outcomes) {
    switch (outcome.kind) {
      case "replied":
        replied += 1;
        break;
      case "ignored":
        ignored += 1;
        break;
      case "processing_failed":
        processingFailed += 1;
        break;
      case "send_failed":
        sendFailed += 1;
        break;
    }
  }
  return {
    status: "batch",
    received: result.outcomes.length,
    replied,
    ignored,
    processingFailed,
    sendFailed,
  };
}

export interface TelegramShutdownSignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function installTelegramShutdownHandlers(
  source: TelegramShutdownSignalSource,
  controller: AbortController,
): () => void {
  const stop = () => controller.abort();
  source.once("SIGINT", stop);
  source.once("SIGTERM", stop);
  return () => {
    source.off("SIGINT", stop);
    source.off("SIGTERM", stop);
  };
}
