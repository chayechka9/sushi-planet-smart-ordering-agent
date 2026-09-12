import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AIConversationLayerErrorCode,
  type AIConversationLayerResponse,
  type ConversationClarificationReason,
} from "../application/ai-conversation-layer.js";
import {
  LocalConversationAgentService,
  type ConversationAgentCommand,
  type LocalConversationCheckoutFlow,
} from "../application/local-conversation-agent.js";
import { createOpenAIConversationRuntime } from "../composition/openai-conversation-runtime.js";
import {
  loadOpenAIRuntimeConfig,
  OpenAIRuntimeConfigurationError,
} from "../config/openai.js";
import { createOrder } from "../domain/order.js";
import type { OpenAIResponsesFetch } from "../integrations/openai/responses-http-transport.js";
import { SqliteConversationStateStore } from "../storage/sqlite/conversation-state-store.js";

const confirmationFlag = "--confirm-one-request";
const fixedNow = new Date("2026-09-12T00:00:00.000Z");

export type OpenAISmokeErrorCode =
  | "confirmation_required"
  | "runtime_disabled"
  | "configuration_error"
  | "execution_failed"
  | "temporary_state_cleanup_failed"
  | AIConversationLayerErrorCode;

export type OpenAISmokeSummary =
  | {
      status: "success";
      commandType: ConversationAgentCommand["type"];
      providerRequestAttempted: boolean;
    }
  | {
      status: "success";
      clarificationReason: ConversationClarificationReason;
      providerRequestAttempted: boolean;
    }
  | {
      status: "error";
      errorCode: OpenAISmokeErrorCode;
      providerRequestAttempted: boolean;
    };

export interface OpenAISmokeRunnerOptions {
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  fetcher?: OpenAIResponsesFetch;
  temporaryDirectoryParent?: string;
  checkoutFlow?: Pick<LocalConversationCheckoutFlow, "prepareCheckoutLink">;
}

/**
 * Isolated one-shot runner for a separately authorized provider smoke check.
 * It never retries and always removes its temporary SQLite state.
 */
export async function runOpenAISmoke(
  options: OpenAISmokeRunnerOptions,
): Promise<OpenAISmokeSummary> {
  if (
    options.args.length !== 1 ||
    options.args[0] !== confirmationFlag
  ) {
    return {
      status: "error",
      errorCode: "confirmation_required",
      providerRequestAttempted: false,
    };
  }

  try {
    if (!loadOpenAIRuntimeConfig(options.environment).enabled) {
      return {
        status: "error",
        errorCode: "runtime_disabled",
        providerRequestAttempted: false,
      };
    }
  } catch {
    return {
      status: "error",
      errorCode: "configuration_error",
      providerRequestAttempted: false,
    };
  }

  let providerRequestAttempted = false;
  let temporaryDirectory: string | undefined;
  let stateStore: SqliteConversationStateStore | undefined;
  let cleanupSucceeded = true;
  let summary: OpenAISmokeSummary = {
    status: "error",
    errorCode: "execution_failed",
    providerRequestAttempted: false,
  };

  try {
    temporaryDirectory = mkdtempSync(
      join(options.temporaryDirectoryParent ?? tmpdir(), "sushi-openai-smoke-"),
    );
    stateStore = new SqliteConversationStateStore(
      join(temporaryDirectory, "conversation.sqlite"),
    );

    const fetcher: OpenAIResponsesFetch = async (input, init) => {
      if (providerRequestAttempted) {
        throw new Error("OpenAI smoke request limit reached");
      }
      providerRequestAttempted = true;
      return options.fetcher === undefined
        ? globalThis.fetch(input, init)
        : options.fetcher(input, init);
    };
    const checkoutFlow = options.checkoutFlow ?? {
      prepareCheckoutLink: async () => {
        throw new Error("Checkout is disabled in the OpenAI smoke runner");
      },
    };
    const conversationAgent = new LocalConversationAgentService({
      stateStore,
      menuProvider: { getMenuSnapshot: () => [] },
      deliveryFeePolicy: {
        getDeliveryFeeCents: () => {
          throw new Error("Delivery is disabled in the OpenAI smoke runner");
        },
      },
      checkoutFlow,
      checkoutMerchant: {
        merchantCode: "synthetic-openai-smoke",
        country: "IE",
        defaultCurrency: "EUR",
        sandbox: true,
      },
      createOrder: () =>
        createOrder({
          createId: () => "ord_openai_smoke_synthetic",
          now: () => fixedNow,
        }),
      now: () => fixedNow,
    });
    const runtime = createOpenAIConversationRuntime(
      { conversationAgent, stateStore },
      { environment: options.environment, fetcher },
    );

    if (!runtime.enabled) {
      summary = {
        status: "error",
        errorCode: "runtime_disabled",
        providerRequestAttempted,
      };
    } else {
      const response = await runtime.service.handle({
        channel: "synthetic-openai-smoke",
        userId: "synthetic-openai-smoke-user",
        conversationId: "synthetic-openai-smoke-conversation",
        messageId: "synthetic-openai-smoke-message",
        text: "покажи меню",
      });
      summary = summarizeResponse(response, providerRequestAttempted);
    }
  } catch (error) {
    summary = {
      status: "error",
      errorCode:
        error instanceof OpenAIRuntimeConfigurationError
          ? "configuration_error"
          : "execution_failed",
      providerRequestAttempted,
    };
  } finally {
    if (stateStore !== undefined) {
      try {
        stateStore.close();
      } catch {
        cleanupSucceeded = false;
      }
    }
    if (temporaryDirectory !== undefined) {
      try {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      } catch {
        cleanupSucceeded = false;
      }
    }
  }

  return cleanupSucceeded
    ? summary
    : {
        status: "error",
        errorCode: "temporary_state_cleanup_failed",
        providerRequestAttempted,
      };
}

function summarizeResponse(
  response: AIConversationLayerResponse,
  providerRequestAttempted: boolean,
): OpenAISmokeSummary {
  switch (response.kind) {
    case "command_applied":
      return {
        status: "success",
        commandType: response.command.type,
        providerRequestAttempted,
      };
    case "needs_clarification":
      return {
        status: "success",
        clarificationReason: response.reason,
        providerRequestAttempted,
      };
    case "error":
      return {
        status: "error",
        errorCode: response.code,
        providerRequestAttempted,
      };
  }
}
