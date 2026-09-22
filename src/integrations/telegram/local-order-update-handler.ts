import {
  createAIConversationContext,
  validateAIConversationInterpretation,
  type AIConversationInterpreter,
  type AIConversationInterpretation,
  type AIConversationLayerErrorCode,
} from "../../application/ai-conversation-layer.js";
import type {
  ConversationAgentCommand,
  ConversationAgentResponse,
  LocalConversationStateStore,
} from "../../application/local-conversation-agent.js";
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
  aiFallback?: {
    interpreter: AIConversationInterpreter;
  };
  orderFlow: Pick<LocalOrderFlowService, "handle">;
  pickupCheckoutPreparation?: Pick<
    LocalOrderFlowService,
    "preparePickupCheckout"
  >;
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
 * The deterministic interpreter always runs first. An explicitly injected AI
 * fallback may interpret only unsupported plain text; every result is checked
 * by the existing action validator before the local order flow remains
 * authoritative for state, totals and next steps.
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
    const prior = state?.processedMessages.find(
      (processed) => processed.messageId === identity.messageId,
    );
    if (prior !== undefined) {
      if (
        prior.command?.type === "request_staff" &&
        prior.response.kind === "staff_handoff_registered"
      ) {
        return {
          updateId: update.updateId,
          kind: "reply",
          chatId: message.chatId,
          text: renderTelegramResponse({
            kind: "command_applied",
            command: prior.command,
            response: prior.response,
          }),
        };
      }
      if (
        this.dependencies.pickupCheckoutPreparation !== undefined &&
        state?.checkout !== undefined &&
        state.fulfilmentChoice === "pickup" &&
        prior.command !== undefined &&
        state.processedMessages.some(
          (processed) =>
            processed.messageId === checkoutPreparationId(identity.messageId) &&
            processed.command?.type === "prepare_checkout" &&
            processed.response.kind === "checkout_ready",
        )
      ) {
        let preparation: LocalOrderFlowResult;
        try {
          preparation = await this.dependencies.pickupCheckoutPreparation
            .preparePickupCheckout({
              conversationId: identity.conversationId,
              preparationId: checkoutPreparationId(identity.messageId),
              identity: { channel: "telegram", userId: identity.userId },
            });
        } catch {
          return this.safeErrorReply(
            update.updateId,
            message.chatId,
            "conversation_unavailable",
          );
        }
        return this.renderPickupCheckoutResult(
          update.updateId,
          message.chatId,
          prior.command,
          prior.response,
          preparation,
        );
      }
      return {
        updateId: update.updateId,
        kind: "ignored",
        reason: "duplicate",
      };
    }

    const context = createAIConversationContext(
      {
        channel: "telegram",
        userId: identity.userId,
        conversationId: identity.conversationId,
      },
      state,
    );
    let interpreted: unknown;
    try {
      interpreted = await this.dependencies.interpreter.interpret(
        context,
        message.text,
      );
    } catch {
      return this.safeErrorReply(
        update.updateId,
        message.chatId,
        "interpreter_unavailable",
      );
    }

    let interpretation = validateAIConversationInterpretation(interpreted);
    if (interpretation === undefined) {
      return this.safeErrorReply(
        update.updateId,
        message.chatId,
        "invalid_interpreter_result",
      );
    }
    const aiFallback = this.dependencies.aiFallback;
    if (
      aiFallback !== undefined &&
      this.shouldUseAIFallback(message.text, interpretation)
    ) {
      try {
        interpreted = await aiFallback.interpreter.interpret(
          context,
          message.text,
        );
      } catch {
        return this.safeErrorReply(
          update.updateId,
          message.chatId,
          "interpreter_unavailable",
        );
      }
      interpretation = validateAIConversationInterpretation(interpreted);
      if (interpretation === undefined) {
        return this.safeErrorReply(
          update.updateId,
          message.chatId,
          "invalid_interpreter_result",
        );
      }
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
    if (
      result.status === "accepted" &&
      result.nextStep.kind === "payment_boundary_ready" &&
      result.summary.fulfilment === "pickup" &&
      this.dependencies.pickupCheckoutPreparation !== undefined
    ) {
      let preparation: LocalOrderFlowResult;
      try {
        preparation = await this.dependencies.pickupCheckoutPreparation
          .preparePickupCheckout({
            conversationId: identity.conversationId,
            preparationId: checkoutPreparationId(identity.messageId),
            identity: { channel: "telegram", userId: identity.userId },
          });
      } catch {
        return this.safeErrorReply(
          update.updateId,
          message.chatId,
          "conversation_unavailable",
        );
      }
      return this.renderPickupCheckoutResult(
        update.updateId,
        message.chatId,
        result.action,
        result.response,
        preparation,
      );
    }
    return this.renderFlowResult(update.updateId, message.chatId, result);
  }

  private shouldUseAIFallback(
    text: string,
    interpretation: AIConversationInterpretation,
  ): boolean {
    return (
      !text.trimStart().startsWith("/") &&
      interpretation.kind === "needs_clarification" &&
      interpretation.reason === "unsupported"
    );
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

  private renderPickupCheckoutResult(
    updateId: number,
    chatId: number,
    sourceAction: ConversationAgentCommand,
    sourceResponse: ConversationAgentResponse,
    preparation: LocalOrderFlowResult,
  ): TelegramLocalOrderUpdateResult {
    if (
      preparation.status === "rejected" ||
      preparation.response.kind !== "checkout_ready"
    ) {
      return this.safeErrorReply(
        updateId,
        chatId,
        preparation.status === "rejected"
          ? mapFlowRejection(preparation.reason)
          : "conversation_unavailable",
        preparation.nextStep,
      );
    }

    const baseReply = renderTelegramResponse({
      kind: "command_applied",
      command: sourceAction,
      response: sourceResponse,
    });
    return {
      updateId,
      kind: "reply",
      chatId,
      text: limitTelegramText(
        `${baseReply}\nЗаказ подготовлен к следующему шагу оплаты. Оплата не выполнена.`,
      ),
      nextStep: preparation.nextStep,
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

function checkoutPreparationId(messageId: string): string {
  return `${messageId}:pickup-checkout`;
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
