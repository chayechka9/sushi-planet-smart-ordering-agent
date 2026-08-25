import type { PaymentRecord } from "../../domain/payment.js";

export const SUMUP_CHECKOUT_STATUS_CHANGED =
  "CHECKOUT_STATUS_CHANGED" as const;

export interface SumUpCheckoutStatusChangedWebhook {
  event_type: typeof SUMUP_CHECKOUT_STATUS_CHANGED;
  id: string;
}

export type SumUpWebhookEvent =
  | {
      kind: "checkout_status_changed";
      checkoutId: string;
    }
  | {
      kind: "ignored";
      eventType: string;
    };

export type SumUpWebhookDecision =
  | { action: "ignored"; eventType: string }
  | { action: "unknown_checkout"; checkoutId: string }
  | { action: "verification_required"; checkoutId: string; orderId: string }
  | { action: "already_processed"; checkoutId: string; orderId: string };

export interface SumUpWebhookPaymentLookup {
  findByCheckoutId(checkoutId: string): PaymentRecord | undefined;
}

export class SumUpWebhookContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SumUpWebhookContractError";
  }
}

/**
 * Parses only the documented notification fields. Unknown event types are
 * acknowledged as ignored so future SumUp events do not trigger payment work.
 */
export function parseSumUpWebhook(body: unknown): SumUpWebhookEvent {
  const record = asRecord(body);
  const eventType = asNonEmptyString(record.event_type, "event_type");

  if (eventType !== SUMUP_CHECKOUT_STATUS_CHANGED) {
    return { kind: "ignored", eventType };
  }

  return {
    kind: "checkout_status_changed",
    checkoutId: asNonEmptyString(record.id, "id"),
  };
}

/**
 * Decides local webhook handling without I/O or state mutation.
 * A notification can request authenticated verification, but can never mark a
 * payment or order as paid by itself.
 */
export function decideSumUpWebhookHandling(
  body: unknown,
  payments: SumUpWebhookPaymentLookup,
): SumUpWebhookDecision {
  const event = parseSumUpWebhook(body);
  if (event.kind === "ignored") {
    return { action: "ignored", eventType: event.eventType };
  }

  const payment = payments.findByCheckoutId(event.checkoutId);
  if (payment === undefined) {
    return { action: "unknown_checkout", checkoutId: event.checkoutId };
  }

  if (payment.status === "paid") {
    return {
      action: "already_processed",
      checkoutId: payment.checkoutId,
      orderId: payment.orderId,
    };
  }

  return {
    action: "verification_required",
    checkoutId: payment.checkoutId,
    orderId: payment.orderId,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SumUpWebhookContractError("Webhook body must be an object");
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SumUpWebhookContractError(
      `Webhook ${field} must be a non-empty string`,
    );
  }
  return value.trim();
}
