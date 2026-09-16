import { createHash } from "node:crypto";

import {
  ConversationAgentError,
  parseConversationAgentCommand,
  type ConversationAgentCommand,
  type ConversationAgentResponse,
  type ConversationStatus,
  type LocalConversationAgentService,
  type LocalConversationState,
  type LocalConversationStateStore,
} from "./local-conversation-agent.js";

export type ConversationClarificationReason =
  | "ambiguous"
  | "unsupported"
  | "missing_information";

/**
 * Deliberately excludes prices, availability, totals, delivery fees, raw
 * customer data, payment details and Poster data. The deterministic core
 * remains the only source of those values.
 */
export interface AIConversationContext {
  conversationId: string;
  identity: {
    channel: string;
    userId: string;
  };
  conversation: {
    status: ConversationStatus | "new";
    cart: readonly {
      menuItemId: string;
      quantity: number;
    }[];
    fulfilment: "pickup" | "delivery" | null;
    customerFields: {
      firstName: boolean;
      lastName: boolean;
      phone: boolean;
      deliveryAddress: boolean;
    };
    checkoutCreated: boolean;
  };
}

export type AIConversationInterpretation =
  | {
      kind: "command";
      command: ConversationAgentCommand;
    }
  | {
      kind: "needs_clarification";
      reason: ConversationClarificationReason;
    };

/** Provider-neutral boundary. Implementations must not perform application I/O. */
export interface AIConversationInterpreter {
  interpret(
    context: AIConversationContext,
    text: string,
  ): Promise<AIConversationInterpretation>;
}

export interface AIConversationLayerInput {
  channel: string;
  userId: string;
  conversationId: string;
  messageId: string;
  text: string;
}

export type AIConversationLayerErrorCode =
  | "invalid_input"
  | "invalid_interpreter_result"
  | "interpreter_unavailable"
  | "invalid_identity"
  | "message_conflict"
  | "delivery_unavailable"
  | "conversation_unavailable"
  | "conversation_rejected";

export type AIConversationLayerResponse =
  | {
      kind: "command_applied";
      command: ConversationAgentCommand;
      response: ConversationAgentResponse;
    }
  | {
      kind: "needs_clarification";
      reason: ConversationClarificationReason;
    }
  | {
      kind: "error";
      code: AIConversationLayerErrorCode;
    };

export interface AIConversationLayerDependencies {
  interpreter: AIConversationInterpreter;
  conversationAgent: Pick<LocalConversationAgentService, "handle">;
  stateStore: Pick<
    LocalConversationStateStore,
    "findByConversationId"
  >;
}

/**
 * Orchestrates free-form interpretation into the existing deterministic
 * command API. It has no order, payment, checkout, Poster or provider
 * dependency and cannot make those decisions itself.
 */
export class AIConversationLayerService {
  constructor(
    private readonly dependencies: AIConversationLayerDependencies,
  ) {}

  async handle(
    input: AIConversationLayerInput,
  ): Promise<AIConversationLayerResponse> {
    const normalized = normalizeInput(input);
    if (normalized === undefined) {
      return { kind: "error", code: "invalid_input" };
    }

    const sourceMessageFingerprint = fingerprintSourceMessage(normalized.text);
    let state: LocalConversationState | undefined;
    try {
      state = this.dependencies.stateStore.findByConversationId(
        normalized.conversationId,
      );
    } catch {
      return { kind: "error", code: "conversation_unavailable" };
    }

    if (
      state !== undefined &&
      (state.identity.channel !== normalized.channel ||
        state.identity.userId !== normalized.userId)
    ) {
      return { kind: "error", code: "invalid_identity" };
    }

    const prior = state?.processedMessages.find(
      (message) => message.messageId === normalized.messageId,
    );
    if (prior !== undefined) {
      if (
        prior.sourceMessageFingerprint !== sourceMessageFingerprint ||
        prior.command === undefined
      ) {
        return { kind: "error", code: "message_conflict" };
      }
      return {
        kind: "command_applied",
        command: structuredClone(prior.command),
        response: structuredClone(prior.response),
      };
    }

    const context = createAIConversationContext(normalized, state);

    let interpreted: unknown;
    try {
      interpreted = await this.dependencies.interpreter.interpret(
        context,
        normalized.text,
      );
    } catch {
      return { kind: "error", code: "interpreter_unavailable" };
    }

    const interpretation = validateAIConversationInterpretation(interpreted);
    if (interpretation === undefined) {
      return { kind: "error", code: "invalid_interpreter_result" };
    }
    if (interpretation.kind === "needs_clarification") {
      return interpretation;
    }

    try {
      const response = await this.dependencies.conversationAgent.handle({
        conversationId: normalized.conversationId,
        messageId: normalized.messageId,
        command: interpretation.command,
        identity: {
          channel: normalized.channel,
          userId: normalized.userId,
        },
        sourceMessageFingerprint,
      });
      return {
        kind: "command_applied",
        command: interpretation.command,
        response,
      };
    } catch (error) {
      return {
        kind: "error",
        code: mapConversationError(error),
      };
    }
  }
}

interface NormalizedAIConversationLayerInput
  extends AIConversationLayerInput {
  channel: string;
  userId: string;
  conversationId: string;
  messageId: string;
  text: string;
}

function normalizeInput(
  input: unknown,
): NormalizedAIConversationLayerInput | undefined {
  if (!isRecord(input)) return undefined;
  const channel = nonEmptyString(input.channel);
  const userId = nonEmptyString(input.userId);
  const conversationId = nonEmptyString(input.conversationId);
  const messageId = nonEmptyString(input.messageId);
  const text = normalizeClientText(input.text);
  if (
    channel === undefined ||
    userId === undefined ||
    conversationId === undefined ||
    messageId === undefined ||
    text === undefined
  ) {
    return undefined;
  }
  return { channel, userId, conversationId, messageId, text };
}

export function createAIConversationContext(
  input: Pick<
    NormalizedAIConversationLayerInput,
    "channel" | "userId" | "conversationId"
  >,
  state?: LocalConversationState,
): AIConversationContext {
  return {
    conversationId: input.conversationId,
    identity: { channel: input.channel, userId: input.userId },
    conversation: {
      status: state?.status ?? "new",
      cart: (state?.order.items ?? []).map((item) => ({
        menuItemId: item.menuItemId,
        quantity: item.quantity,
      })),
      fulfilment: state?.fulfilmentChoice ?? null,
      customerFields: {
        firstName: state?.customer.firstName !== undefined,
        lastName: state?.customer.lastName !== undefined,
        phone: state?.customer.phone !== undefined,
        deliveryAddress: state?.customer.deliveryAddress !== undefined,
      },
      checkoutCreated: state?.checkout !== undefined,
    },
  };
}

export function validateAIConversationInterpretation(
  value: unknown,
): AIConversationInterpretation | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return undefined;
  }

  if (value.kind === "needs_clarification") {
    if (
      !hasExactKeys(value, ["kind", "reason"]) ||
      !isClarificationReason(value.reason)
    ) {
      return undefined;
    }
    return { kind: value.kind, reason: value.reason };
  }

  if (value.kind !== "command" || !hasExactKeys(value, ["kind", "command"])) {
    return undefined;
  }
  const command = parseConversationAgentCommand(value.command);
  return command === undefined
    ? undefined
    : { kind: "command", command };
}

function mapConversationError(error: unknown): AIConversationLayerErrorCode {
  if (error instanceof ConversationAgentError) {
    switch (error.code) {
      case "invalid_identity":
        return "invalid_identity";
      case "message_conflict":
        return "message_conflict";
      case "delivery_unavailable":
        return "delivery_unavailable";
      default:
        return "conversation_rejected";
    }
  }
  return "conversation_unavailable";
}

function isClarificationReason(
  value: unknown,
): value is ConversationClarificationReason {
  return (
    value === "ambiguous" ||
    value === "unsupported" ||
    value === "missing_information"
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return (
    Object.keys(value).length === allowed.size &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value.trim() : undefined;
}

function normalizeClientText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  return normalized.length === 0 ? undefined : normalized;
}

function fingerprintSourceMessage(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
