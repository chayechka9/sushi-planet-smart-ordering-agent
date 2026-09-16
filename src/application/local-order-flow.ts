import {
  ConversationAgentError,
  parseConversationAgentCommand,
  type ConversationAgentCommand,
  type ConversationAgentErrorCode,
  type ConversationAgentResponse,
  type ConversationIdentity,
  type ConversationMissingField,
  type ConversationOrderView,
  type LocalConversationAgentService,
} from "./local-conversation-agent.js";

export interface LocalOrderFlowInput {
  conversationId: string;
  actionId: string;
  action: unknown;
  identity?: ConversationIdentity;
}

export type LocalOrderNextStep =
  | {
      kind: "collecting_order";
      missingFields: readonly ConversationMissingField[];
    }
  | {
      kind: "payment_boundary_ready";
      orderId: string;
      amountCents: number;
      currency: "EUR";
      fulfilment: "pickup" | "delivery";
    }
  | {
      kind: "awaiting_verified_payment";
      orderId: string;
    }
  | {
      kind: "backend_processing";
      orderId: string;
    };

export type LocalOrderFlowRejectionReason =
  | "invalid_action"
  | "external_step_not_allowed"
  | ConversationAgentErrorCode
  | "flow_unavailable";

export type LocalOrderFlowResult =
  | {
      status: "accepted";
      action: ConversationAgentCommand;
      response: ConversationAgentResponse;
      summary: ConversationOrderView;
      nextStep: LocalOrderNextStep;
    }
  | {
      status: "rejected";
      reason: LocalOrderFlowRejectionReason;
      summary?: ConversationOrderView;
      nextStep?: LocalOrderNextStep;
    };

export interface LocalOrderFlowDependencies {
  conversationAgent: Pick<
    LocalConversationAgentService,
    "handle" | "inspect"
  >;
}

/**
 * Connects already-normalized local actions to the deterministic conversation
 * core and projects its current order state into a side-effect-free next step.
 * It never prepares a checkout, records a payment or invokes a provider.
 */
export class LocalOrderFlowService {
  constructor(private readonly dependencies: LocalOrderFlowDependencies) {}

  async handle(input: LocalOrderFlowInput): Promise<LocalOrderFlowResult> {
    const action = parseConversationAgentCommand(input.action);
    if (action === undefined) {
      return this.rejected(input.conversationId, "invalid_action");
    }
    if (
      action.type === "prepare_checkout" ||
      action.type === "customer_reports_payment"
    ) {
      return this.rejected(
        input.conversationId,
        "external_step_not_allowed",
      );
    }

    let response: ConversationAgentResponse;
    try {
      response = await this.dependencies.conversationAgent.handle({
        conversationId: input.conversationId,
        messageId: input.actionId,
        command: action,
        ...(input.identity === undefined ? {} : { identity: input.identity }),
      });
    } catch (error) {
      return this.rejected(
        input.conversationId,
        error instanceof ConversationAgentError
          ? error.code
          : "flow_unavailable",
      );
    }

    const summary = this.inspect(input.conversationId);
    if (summary === undefined) {
      return { status: "rejected", reason: "flow_unavailable" };
    }
    return {
      status: "accepted",
      action,
      response,
      summary,
      nextStep: determineNextStep(summary),
    };
  }

  private rejected(
    conversationId: string,
    reason: LocalOrderFlowRejectionReason,
  ): LocalOrderFlowResult {
    const summary = this.inspect(conversationId);
    return {
      status: "rejected",
      reason,
      ...(summary === undefined
        ? {}
        : { summary, nextStep: determineNextStep(summary) }),
    };
  }

  private inspect(conversationId: string): ConversationOrderView | undefined {
    try {
      return this.dependencies.conversationAgent.inspect(conversationId);
    } catch {
      return undefined;
    }
  }
}

function determineNextStep(summary: ConversationOrderView): LocalOrderNextStep {
  if (summary.status === "draft") {
    if (
      summary.missingFields.length === 0 &&
      summary.totalIsFinal &&
      summary.fulfilment !== null
    ) {
      return {
        kind: "payment_boundary_ready",
        orderId: summary.orderId,
        amountCents: summary.totals.totalCents,
        currency: summary.totals.currency,
        fulfilment: summary.fulfilment,
      };
    }
    return {
      kind: "collecting_order",
      missingFields: [...summary.missingFields],
    };
  }
  if (summary.status === "awaiting_payment") {
    return { kind: "awaiting_verified_payment", orderId: summary.orderId };
  }
  return { kind: "backend_processing", orderId: summary.orderId };
}
