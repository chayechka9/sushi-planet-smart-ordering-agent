import {
  calculateOrderTotals,
  markPaid,
  type Order,
} from "./order.js";

export type PaymentStatus = "pending" | "paid" | "failed" | "expired";

export interface PaymentRecord {
  provider: "sumup";
  orderId: string;
  checkoutId: string;
  checkoutReference: string;
  merchantCode: string;
  amountCents: number;
  currency: "EUR";
  status: PaymentStatus;
  successfulTransactionId: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
}

export interface CreateSumUpPaymentInput {
  order: Order;
  checkoutId: string;
  checkoutReference: string;
  merchantCode: string;
  amountCents: number;
  currency: "EUR";
  now?: Date;
}

export type VerifiedSumUpCheckoutStatus =
  | "PENDING"
  | "PAID"
  | "FAILED"
  | "EXPIRED";

export type VerifiedSumUpTransactionStatus =
  | "PENDING"
  | "SUCCESSFUL"
  | "FAILED"
  | "CANCELLED"
  | "REFUNDED";

export interface VerifiedSumUpTransaction {
  id: string;
  status: VerifiedSumUpTransactionStatus;
  amountCents: number;
  currency: "EUR";
}

/**
 * Normalized result of an authenticated SumUp checkout read.
 * A webhook payload is never sufficient to construct this value.
 */
export interface VerifiedSumUpCheckout {
  checkoutId: string;
  checkoutReference: string;
  merchantCode: string;
  amountCents: number;
  currency: "EUR";
  status: VerifiedSumUpCheckoutStatus;
  transactions: VerifiedSumUpTransaction[];
}

export interface PaymentReconciliationResult {
  outcome: "paid" | "duplicate" | "not_paid";
  order: Order;
  payment: PaymentRecord;
}

export class PaymentDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentDomainError";
  }
}

export function createSumUpPayment(
  input: CreateSumUpPaymentInput,
): PaymentRecord {
  if (input.order.status !== "awaiting_payment") {
    throw new PaymentDomainError(
      "Payment requires an order awaiting payment",
    );
  }

  assertNonEmpty("Checkout ID", input.checkoutId);
  assertNonEmpty("Checkout reference", input.checkoutReference);
  assertNonEmpty("Merchant code", input.merchantCode);
  assertPositiveCents("Payment amount", input.amountCents);

  const totals = calculateOrderTotals(input.order);
  if (
    totals.totalCents !== input.amountCents ||
    totals.currency !== input.currency
  ) {
    throw new PaymentDomainError("Payment amount does not match the order");
  }

  const timestamp = (input.now ?? new Date()).toISOString();
  return {
    provider: "sumup",
    orderId: input.order.id,
    checkoutId: input.checkoutId.trim(),
    checkoutReference: input.checkoutReference.trim(),
    merchantCode: input.merchantCode.trim(),
    amountCents: input.amountCents,
    currency: input.currency,
    status: "pending",
    successfulTransactionId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    paidAt: null,
  };
}

/**
 * Applies only an authenticated, normalized checkout read to local state.
 * Matching an unverified webhook body is deliberately not supported here.
 */
export function reconcileVerifiedSumUpCheckout(
  order: Order,
  payment: PaymentRecord,
  checkout: VerifiedSumUpCheckout,
  now: Date = new Date(),
): PaymentReconciliationResult {
  assertPaymentBinding(order, payment, checkout);

  const successfulTransactions = checkout.transactions.filter(
    (transaction) => transaction.status === "SUCCESSFUL",
  );

  if (checkout.status !== "PAID") {
    if (payment.status === "paid") {
      throw new PaymentDomainError(
        "A paid payment cannot regress to a non-paid checkout status",
      );
    }

    return {
      outcome: "not_paid",
      order,
      payment: {
        ...payment,
        status: mapCheckoutStatus(checkout.status),
        updatedAt: now.toISOString(),
      },
    };
  }

  if (successfulTransactions.length !== 1) {
    throw new PaymentDomainError(
      "Paid checkout must contain exactly one successful transaction",
    );
  }

  const transaction = successfulTransactions[0];
  if (transaction === undefined) {
    throw new PaymentDomainError("Successful transaction is missing");
  }

  assertNonEmpty("Successful transaction ID", transaction.id);
  if (
    transaction.amountCents !== payment.amountCents ||
    transaction.currency !== payment.currency
  ) {
    throw new PaymentDomainError(
      "Successful transaction amount does not match the payment",
    );
  }

  if (payment.status === "paid") {
    if (payment.successfulTransactionId !== transaction.id) {
      throw new PaymentDomainError(
        "Paid payment is linked to a different successful transaction",
      );
    }

    if (order.status !== "paid" && order.status !== "submitted_to_poster") {
      throw new PaymentDomainError(
        "Paid payment and order status are inconsistent",
      );
    }

    return { outcome: "duplicate", order, payment };
  }

  if (order.status !== "awaiting_payment") {
    throw new PaymentDomainError(
      "Only an order awaiting payment can be marked paid",
    );
  }

  const timestamp = now.toISOString();
  return {
    outcome: "paid",
    order: markPaid(order, now),
    payment: {
      ...payment,
      status: "paid",
      successfulTransactionId: transaction.id.trim(),
      updatedAt: timestamp,
      paidAt: timestamp,
    },
  };
}

function assertPaymentBinding(
  order: Order,
  payment: PaymentRecord,
  checkout: VerifiedSumUpCheckout,
): void {
  if (payment.orderId !== order.id) {
    throw new PaymentDomainError("Payment is linked to a different order");
  }

  if (
    checkout.checkoutId !== payment.checkoutId ||
    checkout.checkoutReference !== payment.checkoutReference ||
    checkout.merchantCode !== payment.merchantCode ||
    checkout.amountCents !== payment.amountCents ||
    checkout.currency !== payment.currency
  ) {
    throw new PaymentDomainError(
      "Verified checkout does not match the stored payment",
    );
  }
}

function mapCheckoutStatus(
  status: Exclude<VerifiedSumUpCheckoutStatus, "PAID">,
): Exclude<PaymentStatus, "paid"> {
  switch (status) {
    case "PENDING":
      return "pending";
    case "FAILED":
      return "failed";
    case "EXPIRED":
      return "expired";
  }
}

function assertNonEmpty(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new PaymentDomainError(`${label} must not be empty`);
  }
}

function assertPositiveCents(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PaymentDomainError(`${label} must be positive integer cents`);
  }
}
