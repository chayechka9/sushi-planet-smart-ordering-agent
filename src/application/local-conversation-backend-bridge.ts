import type {
  LocalPaymentWebhookResult,
  ProcessLocalPaymentWebhookInput,
} from "./local-backend-flow.js";
import type {
  ConversationBackendStatus,
  ConversationStatus,
  LocalConversationState,
  LocalConversationStateStore,
} from "./local-conversation-agent.js";
import type { PaymentRecord } from "../domain/payment.js";
import type { Order } from "../domain/order.js";
import {
  decideSumUpWebhookHandling,
  type SumUpWebhookPaymentLookup,
} from "../integrations/sumup/webhook.js";

export type ConversationBackendEvent =
  | "payment_pending"
  | "payment_not_confirmed"
  | "payment_confirmed"
  | "order_submission_pending"
  | "order_submission_uncertain"
  | "order_submitted"
  | "already_processed"
  | "ignored"
  | "unknown_payment"
  | "unknown_order"
  | "processing_error";

export interface ConversationBackendEventResult {
  events: readonly ConversationBackendEvent[];
  status: ConversationBackendStatus | null;
}

export interface ProcessConversationBackendEventInput {
  body: unknown;
  spotId: string;
  comment?: string;
}

export interface LocalConversationPaymentFlow {
  processPaymentWebhook(
    input: ProcessLocalPaymentWebhookInput,
  ): Promise<LocalPaymentWebhookResult>;
}

interface ConversationPosterHandoffState {
  status: "submitting" | "submitted" | "uncertain";
}

export interface LocalConversationBackendRepository
  extends SumUpWebhookPaymentLookup {
  findOrderById(orderId: string): Order | undefined;
  findByOrderId(orderId: string): PaymentRecord | undefined;
  findPosterHandoffByOrderId(
    orderId: string,
  ): ConversationPosterHandoffState | undefined;
}

export interface LocalConversationBackendBridgeDependencies {
  backendFlow: LocalConversationPaymentFlow;
  repository: LocalConversationBackendRepository;
  stateStore: LocalConversationStateStore;
  now?: () => Date;
}

interface AuthoritativeConversationState {
  order: Order;
  status: ConversationBackendStatus;
}

/**
 * Delivers safe local status events after the existing backend flow has made
 * every payment and Poster decision. This bridge cannot verify a checkout,
 * mark an order paid, or submit to Poster by itself.
 */
export class LocalConversationBackendBridge {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: LocalConversationBackendBridgeDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async process(
    input: ProcessConversationBackendEventInput,
  ): Promise<ConversationBackendEventResult> {
    let decision: ReturnType<typeof decideSumUpWebhookHandling>;
    try {
      decision = decideSumUpWebhookHandling(
        input.body,
        this.dependencies.repository,
      );
    } catch {
      return withoutConversation("processing_error");
    }

    if (decision.action === "ignored") {
      return withoutConversation("ignored");
    }
    if (decision.action === "unknown_checkout") {
      return withoutConversation("unknown_payment");
    }

    const state = this.findConversation(decision.orderId);
    if (
      state === undefined ||
      state.order.id !== decision.orderId ||
      state.checkout?.orderId !== decision.orderId
    ) {
      return withoutConversation("unknown_order");
    }

    const posterHandoff = buildPosterHandoffInput(state, input);
    if (posterHandoff === undefined) {
      return {
        events: ["processing_error"],
        status: { ...state.backendStatus },
      };
    }

    let result: LocalPaymentWebhookResult;
    try {
      result = await this.dependencies.backendFlow.processPaymentWebhook({
        body: input.body,
        posterHandoff,
      });
    } catch {
      return this.handleBackendFailure(state);
    }

    return this.handleBackendResult(state, result);
  }

  private handleBackendResult(
    state: LocalConversationState,
    result: LocalPaymentWebhookResult,
  ): ConversationBackendEventResult {
    switch (result.paymentOutcome) {
      case "ignored":
        return withoutConversation("ignored");
      case "unknown_checkout":
        return withoutConversation("unknown_payment");
      case "pending":
        return this.synchronize(state, ["payment_pending"], {
          payment: "awaiting_payment",
          orderSubmission: "not_started",
        });
      case "not_paid":
        return this.synchronize(state, ["payment_not_confirmed"], {
          payment: "payment_not_confirmed",
          orderSubmission: "not_started",
        });
      case "duplicate":
        return this.synchronize(state, ["already_processed"]);
      case "paid": {
        const events: ConversationBackendEvent[] = ["payment_confirmed"];
        let expectedOrderSubmission: ConversationBackendStatus["orderSubmission"];
        switch (result.posterOutcome) {
          case "submitted":
          case "duplicate":
            events.push("order_submitted");
            expectedOrderSubmission = "order_submitted";
            break;
          case "in_progress":
            events.push("order_submission_pending");
            expectedOrderSubmission = "submission_pending";
            break;
          case "uncertain":
            events.push("order_submission_uncertain");
            expectedOrderSubmission = "submission_uncertain";
            break;
        }
        return this.synchronize(state, events, {
          payment: "payment_confirmed",
          orderSubmission: expectedOrderSubmission,
        });
      }
    }
  }

  private handleBackendFailure(
    state: LocalConversationState,
  ): ConversationBackendEventResult {
    const authoritative = this.readAuthoritativeState(state.order.id);
    if (
      authoritative === undefined ||
      authoritative.status.payment !== "payment_confirmed"
    ) {
      return {
        events: ["processing_error"],
        status: { ...state.backendStatus },
      };
    }

    const events: ConversationBackendEvent[] = [];
    if (state.backendStatus.payment !== "payment_confirmed") {
      events.push("payment_confirmed");
    }
    switch (authoritative.status.orderSubmission) {
      case "not_started":
        events.push("processing_error");
        break;
      case "submission_pending":
        events.push("order_submission_pending");
        break;
      case "submission_uncertain":
        events.push("order_submission_uncertain");
        break;
      case "order_submitted":
        events.push("order_submitted");
        break;
    }

    return this.saveSynchronizedState(state, authoritative, events);
  }

  private synchronize(
    state: LocalConversationState,
    events: readonly ConversationBackendEvent[],
    expected?: ConversationBackendStatus,
  ): ConversationBackendEventResult {
    const authoritative = this.readAuthoritativeState(state.order.id);
    if (
      authoritative === undefined ||
      (expected !== undefined &&
        (authoritative.status.payment !== expected.payment ||
          authoritative.status.orderSubmission !== expected.orderSubmission))
    ) {
      return {
        events: ["processing_error"],
        status: { ...state.backendStatus },
      };
    }
    return this.saveSynchronizedState(state, authoritative, events);
  }

  private saveSynchronizedState(
    state: LocalConversationState,
    authoritative: AuthoritativeConversationState,
    events: readonly ConversationBackendEvent[],
  ): ConversationBackendEventResult {
    try {
      this.dependencies.stateStore.save({
        ...state,
        order: authoritative.order,
        backendStatus: authoritative.status,
        status: toConversationStatus(authoritative.status),
        updatedAt: this.now().toISOString(),
      });
    } catch {
      return {
        events: ["processing_error"],
        status: { ...state.backendStatus },
      };
    }
    return {
      events,
      status: { ...authoritative.status },
    };
  }

  private readAuthoritativeState(
    orderId: string,
  ): AuthoritativeConversationState | undefined {
    try {
      const order = this.dependencies.repository.findOrderById(orderId);
      const payment = this.dependencies.repository.findByOrderId(orderId);
      if (
        order === undefined ||
        payment === undefined ||
        payment.orderId !== order.id
      ) {
        return undefined;
      }

      let paymentStatus: ConversationBackendStatus["payment"];
      if (isConfirmedPaidPair(order, payment)) {
        paymentStatus = "payment_confirmed";
      } else if (
        order.status === "awaiting_payment" &&
        payment.status === "pending"
      ) {
        paymentStatus = "awaiting_payment";
      } else if (
        order.status === "awaiting_payment" &&
        (payment.status === "failed" || payment.status === "expired")
      ) {
        paymentStatus = "payment_not_confirmed";
      } else {
        return undefined;
      }

      const handoff =
        this.dependencies.repository.findPosterHandoffByOrderId(orderId);
      let orderSubmission: ConversationBackendStatus["orderSubmission"];
      if (handoff === undefined) {
        orderSubmission = "not_started";
      } else {
        switch (handoff.status) {
          case "submitting":
            orderSubmission = "submission_pending";
            break;
          case "uncertain":
            orderSubmission = "submission_uncertain";
            break;
          case "submitted":
            orderSubmission = "order_submitted";
            break;
        }
      }

      if (
        paymentStatus !== "payment_confirmed" &&
        orderSubmission !== "not_started"
      ) {
        return undefined;
      }
      if (
        (order.status === "submitted_to_poster") !==
        (orderSubmission === "order_submitted")
      ) {
        return undefined;
      }

      return {
        order,
        status: { payment: paymentStatus, orderSubmission },
      };
    } catch {
      return undefined;
    }
  }

  private findConversation(orderId: string): LocalConversationState | undefined {
    try {
      return this.dependencies.stateStore.findByOrderId(orderId);
    } catch {
      return undefined;
    }
  }
}

function toConversationStatus(
  status: ConversationBackendStatus,
): ConversationStatus {
  switch (status.orderSubmission) {
    case "order_submitted":
      return "order_submitted";
    case "submission_uncertain":
      return "submission_uncertain";
    case "submission_pending":
      return "submission_pending";
    case "not_started":
      switch (status.payment) {
        case "payment_confirmed":
          return "payment_confirmed";
        case "payment_not_confirmed":
          return "payment_not_confirmed";
        case "awaiting_payment":
          return "awaiting_payment";
        case "not_requested":
          return "collecting_order";
      }
  }
}

function isConfirmedPaidPair(order: Order, payment: PaymentRecord): boolean {
  return (
    (order.status === "paid" || order.status === "submitted_to_poster") &&
    payment.status === "paid" &&
    payment.successfulTransactionId !== null &&
    payment.successfulTransactionId.trim().length > 0 &&
    payment.paidAt !== null &&
    payment.paidAt.trim().length > 0
  );
}

function buildPosterHandoffInput(
  state: LocalConversationState,
  input: ProcessConversationBackendEventInput,
): ProcessLocalPaymentWebhookInput["posterHandoff"] | undefined {
  const firstName = state.customer.firstName;
  const phone = state.customer.phone;
  if (firstName === undefined || phone === undefined) return undefined;
  return {
    orderId: state.order.id,
    spotId: input.spotId,
    customer: {
      firstName,
      phone,
      ...(state.customer.lastName === undefined
        ? {}
        : { lastName: state.customer.lastName }),
    },
    ...(input.comment === undefined ? {} : { comment: input.comment }),
  };
}

function withoutConversation(
  event: ConversationBackendEvent,
): ConversationBackendEventResult {
  return { events: [event], status: null };
}
