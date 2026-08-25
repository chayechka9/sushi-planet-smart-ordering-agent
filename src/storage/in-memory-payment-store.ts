import type { PaymentRecord } from "../domain/payment.js";

export interface PaymentStore {
  create(payment: PaymentRecord): void;
  save(payment: PaymentRecord): void;
  findByCheckoutId(checkoutId: string): PaymentRecord | undefined;
  findByOrderId(orderId: string): PaymentRecord | undefined;
}

export class PaymentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentStoreError";
  }
}

/**
 * Development-only store. Production must replace this with durable storage
 * and atomic order/payment updates.
 */
export class InMemoryPaymentStore implements PaymentStore {
  private readonly byCheckoutId = new Map<string, PaymentRecord>();
  private readonly checkoutIdByOrderId = new Map<string, string>();
  private readonly checkoutIdByReference = new Map<string, string>();

  create(payment: PaymentRecord): void {
    if (this.byCheckoutId.has(payment.checkoutId)) {
      throw new PaymentStoreError("Checkout ID is already stored");
    }
    if (this.checkoutIdByOrderId.has(payment.orderId)) {
      throw new PaymentStoreError("Order already has a stored payment");
    }
    if (this.checkoutIdByReference.has(payment.checkoutReference)) {
      throw new PaymentStoreError("Checkout reference is already stored");
    }

    const stored = structuredClone(payment);
    this.byCheckoutId.set(stored.checkoutId, stored);
    this.checkoutIdByOrderId.set(stored.orderId, stored.checkoutId);
    this.checkoutIdByReference.set(
      stored.checkoutReference,
      stored.checkoutId,
    );
  }

  save(payment: PaymentRecord): void {
    const existing = this.byCheckoutId.get(payment.checkoutId);
    if (existing === undefined) {
      throw new PaymentStoreError("Cannot update an unknown payment");
    }
    if (
      existing.orderId !== payment.orderId ||
      existing.checkoutReference !== payment.checkoutReference ||
      existing.merchantCode !== payment.merchantCode ||
      existing.amountCents !== payment.amountCents ||
      existing.currency !== payment.currency
    ) {
      throw new PaymentStoreError("Payment identity cannot be changed");
    }

    this.byCheckoutId.set(payment.checkoutId, structuredClone(payment));
  }

  findByCheckoutId(checkoutId: string): PaymentRecord | undefined {
    const payment = this.byCheckoutId.get(checkoutId);
    return payment === undefined ? undefined : structuredClone(payment);
  }

  findByOrderId(orderId: string): PaymentRecord | undefined {
    const checkoutId = this.checkoutIdByOrderId.get(orderId);
    return checkoutId === undefined
      ? undefined
      : this.findByCheckoutId(checkoutId);
  }
}
