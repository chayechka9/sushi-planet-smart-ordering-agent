import {
  ConversationAgentError,
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

    const context = this.readSafeContext(normalized);
    if (context === undefined) {
      return { kind: "error", code: "conversation_unavailable" };
    }

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

  private readSafeContext(
    input: NormalizedAIConversationLayerInput,
  ): AIConversationContext | undefined {
    let state: LocalConversationState | undefined;
    try {
      state = this.dependencies.stateStore.findByConversationId(
        input.conversationId,
      );
    } catch {
      return undefined;
    }

    // Do not expose another user's state to the interpreter. The existing
    // deterministic service still performs the authoritative identity check.
    if (
      state === undefined ||
      state.identity.channel !== input.channel ||
      state.identity.userId !== input.userId
    ) {
      return emptyContext(input);
    }

    return contextFromState(input, state);
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
  const text = nonEmptyString(input.text);
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

function emptyContext(
  input: NormalizedAIConversationLayerInput,
): AIConversationContext {
  return {
    conversationId: input.conversationId,
    identity: { channel: input.channel, userId: input.userId },
    conversation: {
      status: "new",
      cart: [],
      fulfilment: null,
      customerFields: {
        firstName: false,
        lastName: false,
        phone: false,
        deliveryAddress: false,
      },
      checkoutCreated: false,
    },
  };
}

function contextFromState(
  input: NormalizedAIConversationLayerInput,
  state: LocalConversationState,
): AIConversationContext {
  return {
    conversationId: input.conversationId,
    identity: { channel: input.channel, userId: input.userId },
    conversation: {
      status: state.status,
      cart: state.order.items.map((item) => ({
        menuItemId: item.menuItemId,
        quantity: item.quantity,
      })),
      fulfilment: state.fulfilmentChoice,
      customerFields: {
        firstName: state.customer.firstName !== undefined,
        lastName: state.customer.lastName !== undefined,
        phone: state.customer.phone !== undefined,
        deliveryAddress: state.customer.deliveryAddress !== undefined,
      },
      checkoutCreated: state.checkout !== undefined,
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
  const command = parseCommand(value.command);
  return command === undefined
    ? undefined
    : { kind: "command", command };
}

function parseCommand(value: unknown): ConversationAgentCommand | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;

  switch (value.type) {
    case "show_menu":
    case "show_cart":
    case "choose_pickup":
    case "choose_delivery":
    case "review_order":
    case "prepare_checkout":
    case "customer_reports_payment":
      return hasExactKeys(value, ["type"])
        ? { type: value.type }
        : undefined;
    case "add_item": {
      if (
        !hasNoUnexpectedKeys(value, ["type", "menuItemId", "quantity"]) ||
        !isNonEmptyString(value.menuItemId)
      ) {
        return undefined;
      }
      if (value.quantity !== undefined && !isPositiveInteger(value.quantity)) {
        return undefined;
      }
      return {
        type: "add_item",
        menuItemId: value.menuItemId.trim(),
        ...(value.quantity === undefined ? {} : { quantity: value.quantity }),
      };
    }
    case "remove_item":
      return hasExactKeys(value, ["type", "menuItemId"]) &&
        isNonEmptyString(value.menuItemId)
        ? { type: "remove_item", menuItemId: value.menuItemId.trim() }
        : undefined;
    case "set_quantity":
      return hasExactKeys(value, ["type", "menuItemId", "quantity"]) &&
        isNonEmptyString(value.menuItemId) &&
        isPositiveInteger(value.quantity)
        ? {
            type: "set_quantity",
            menuItemId: value.menuItemId.trim(),
            quantity: value.quantity,
          }
        : undefined;
    case "set_customer":
      if (
        !hasNoUnexpectedKeys(value, ["type", "firstName", "lastName", "phone"]) ||
        !optionalNonEmptyString(value.firstName) ||
        !optionalNonEmptyString(value.lastName) ||
        !optionalNonEmptyString(value.phone)
      ) {
        return undefined;
      }
      return {
        type: "set_customer",
        ...(value.firstName === undefined
          ? {}
          : { firstName: value.firstName.trim() }),
        ...(value.lastName === undefined
          ? {}
          : { lastName: value.lastName.trim() }),
        ...(value.phone === undefined ? {} : { phone: value.phone.trim() }),
      };
    case "set_delivery_address": {
      if (
        !hasExactKeys(value, ["type", "address"]) ||
        !isRecord(value.address) ||
        !hasExactKeys(value.address, ["line1", "city", "postalCode"]) ||
        !isNonEmptyString(value.address.line1) ||
        !isNonEmptyString(value.address.city) ||
        !isNonEmptyString(value.address.postalCode)
      ) {
        return undefined;
      }
      return {
        type: "set_delivery_address",
        address: {
          line1: value.address.line1.trim(),
          city: value.address.city.trim(),
          postalCode: value.address.postalCode.trim(),
        },
      };
    }
    default:
      return undefined;
  }
}

function mapConversationError(error: unknown): AIConversationLayerErrorCode {
  if (error instanceof ConversationAgentError) {
    switch (error.code) {
      case "invalid_identity":
        return "invalid_identity";
      case "message_conflict":
        return "message_conflict";
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

function hasNoUnexpectedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
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

function optionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
