import {
  createAIConversationContext,
  validateAIConversationInterpretation,
  type AIConversationLayerErrorCode,
} from "../../application/ai-conversation-layer.js";
import type { LocalConversationStateStore } from "../../application/local-conversation-agent.js";
import type {
  LocalOrderFlowResult,
  LocalOrderFlowService,
  LocalOrderNextStep,
} from "../../application/local-order-flow.js";
import type { TelegramUpdateEnvelope } from "./api-transport.js";
import type { DeterministicTelegramInterpreter } from "./deterministic-interpreter.js";
import {
  limitTelegramText,
  parseTelegramPrivateTextMessage,
  renderTelegramResponse,
  telegramIdentity,
} from "./polling-adapter.js";

export interface TelegramLocalOrderUpdateHandlerDependencies {
  interpreter: Pick<DeterministicTelegramInterpreter, "interpret">;
  orderFlow: Pick<LocalOrderFlowService, "handle">;
  stateStore: Pick<LocalConversationStateStore, "findByConversationId">;
}

export type TelegramLocalOrderUpdateResult =
  | {
      updateId: number;
      kind: "reply";
      chatId: number;
      text: string;
      nextStep?: LocalOrderNextStep;
    }
  | {
      updateId: number;
      kind: "ignored";
      reason: "unsupported" | "duplicate";
    }
  | { updateId: number; kind: "processing_failed" };

/**
 * Handles one already-received Telegram update without polling or sending it.
 * The deterministic interpreter may only select an existing command; the
 * local order flow remains authoritative for state, totals and next steps.
 */
export class TelegramLocalOrderUpdateHandler {
  constructor(
    private readonly dependencies: TelegramLocalOrderUpdateHandlerDependencies,
  ) {}

  async handle(
    update: TelegramUpdateEnvelope,
  ): Promise<TelegramLocalOrderUpdateResult> {
    const message = parseTelegramPrivateTextMessage(update.payload);
    if (message === undefined) {
      return {
        updateId: update.updateId,
        kind: "ignored",
        reason: "unsupported",
      };
    }

    const identity = telegramIdentity(message);
    let state;
    try {
      state = this.dependencies.stateStore.findByConversationId(
        identity.conversationId,
      );
    } catch {
      return { updateId: update.updateId, kind: "processing_failed" };
    }
    if (
      state !== undefined &&
      (state.identity.channel !== "telegram" ||
        state.identity.userId !== identity.userId)
    ) {
      return { updateId: update.updateId, kind: "processing_failed" };
    }
    if (
      state?.processedMessages.some(
        (processed) => processed.messageId === identity.messageId,
      )
    ) {
      return {
        updateId: update.updateId,
        kind: "ignored",
        reason: "duplicate",
      };
    }

    let interpreted: unknown;
    try {
      interpreted = await this.dependencies.interpreter.interpret(
        createAIConversationContext(
          {
            channel: "telegram",
            userId: identity.userId,
            conversationId: identity.conversationId,
          },
          state,
        ),
        message.text,
      );
    } catch {
      return this.safeErrorReply(
        update.updateId,
        message.chatId,
        "interpreter_unavailable",
      );
    }

    const interpretation = validateAIConversationInterpretation(interpreted);
    if (interpretation === undefined) {
      return this.safeErrorReply(
        update.updateId,
        message.chatId,
        "invalid_interpreter_result",
      );
    }
    if (interpretation.kind === "needs_clarification") {
      return {
        updateId: update.updateId,
        kind: "reply",
        chatId: message.chatId,
        text: renderTelegramResponse(interpretation),
      };
    }

    let result: LocalOrderFlowResult;
    try {
      result = await this.dependencies.orderFlow.handle({
        conversationId: identity.conversationId,
        actionId: identity.messageId,
        action: interpretation.command,
        identity: { channel: "telegram", userId: identity.userId },
      });
    } catch {
      return this.safeErrorReply(
        update.updateId,
        message.chatId,
        "conversation_unavailable",
      );
    }
    return this.renderFlowResult(update.updateId, message.chatId, result);
  }

  private renderFlowResult(
    updateId: number,
    chatId: number,
    result: LocalOrderFlowResult,
  ): TelegramLocalOrderUpdateResult {
    if (result.status === "rejected") {
      return this.safeErrorReply(
        updateId,
        chatId,
        mapFlowRejection(result.reason),
        result.nextStep,
      );
    }

    const baseReply = renderTelegramResponse({
      kind: "command_applied",
      command: result.action,
      response: result.response,
    });
    const text = result.nextStep.kind === "payment_boundary_ready"
      ? limitTelegramText(
          `${baseReply}\nЗаказ готов к переходу к оплате. Checkout не создан.`,
        )
      : baseReply;
    return {
      updateId,
      kind: "reply",
      chatId,
      text,
      nextStep: result.nextStep,
    };
  }

  private safeErrorReply(
    updateId: number,
    chatId: number,
    code: AIConversationLayerErrorCode,
    nextStep?: LocalOrderNextStep,
  ): TelegramLocalOrderUpdateResult {
    return {
      updateId,
      kind: "reply",
      chatId,
      text: renderTelegramResponse({ kind: "error", code }),
      ...(nextStep === undefined ? {} : { nextStep }),
    };
  }
}

function mapFlowRejection(
  reason: Extract<LocalOrderFlowResult, { status: "rejected" }>["reason"],
): AIConversationLayerErrorCode {
  switch (reason) {
    case "invalid_identity":
      return "invalid_identity";
    case "message_conflict":
      return "message_conflict";
    case "delivery_unavailable":
      return "delivery_unavailable";
    case "flow_unavailable":
      return "conversation_unavailable";
    default:
      return "conversation_rejected";
  }
}
