import {
  calculateOrderTotals,
  type Order,
} from "../../domain/order.js";
import type { SumUpMerchantSummary } from "./client.js";

export const SUMUP_CREATE_CHECKOUT_ENDPOINT =
  "https://api.sumup.com/v0.1/checkouts" as const;

export interface SumUpHostedCheckoutPayload {
  checkout_reference: string;
  amount: number;
  currency: "EUR";
  merchant_code: string;
  return_url?: string;
  hosted_checkout: {
    enabled: true;
  };
}

export interface BuildSumUpHostedCheckoutInput {
  order: Order;
  paymentAttempt: number;
  merchant: SumUpMerchantSummary;
  returnUrl?: string;
}

export interface SumUpHostedCheckoutPreparation {
  checkoutReference: string;
  amountCents: number;
  payload: SumUpHostedCheckoutPayload;
}

export class SumUpCheckoutPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SumUpCheckoutPreparationError";
  }
}

/**
 * Builds a deterministic Hosted Checkout payload without credentials or I/O.
 *
 * A stable order ID plus an explicit payment-attempt number makes the
 * reference repeatable for the same attempt and distinct for a new attempt.
 * Money remains integer cents locally and is converted only at the SumUp API
 * boundary, whose documented amount field uses major currency units.
 */
export function buildSumUpHostedCheckout(
  input: BuildSumUpHostedCheckoutInput,
): SumUpHostedCheckoutPreparation {
  assertSandboxEuroMerchant(input.merchant);

  if (input.order.status !== "awaiting_payment") {
    throw new SumUpCheckoutPreparationError(
      "SumUp checkout requires an order awaiting payment",
    );
  }

  if (!Number.isSafeInteger(input.paymentAttempt) || input.paymentAttempt < 1) {
    throw new SumUpCheckoutPreparationError(
      "Payment attempt must be a positive integer",
    );
  }

  const orderId = input.order.id.trim();
  if (orderId.length === 0) {
    throw new SumUpCheckoutPreparationError("Order ID must not be empty");
  }

  const checkoutReference = `sumup-${orderId}-${input.paymentAttempt}`;
  if (checkoutReference.length > 90) {
    throw new SumUpCheckoutPreparationError(
      "SumUp checkout reference must not exceed 90 characters",
    );
  }

  const { totalCents, currency } = calculateOrderTotals(input.order);
  if (totalCents < 1) {
    throw new SumUpCheckoutPreparationError(
      "SumUp checkout amount must be positive",
    );
  }

  const amount = totalCents / 100;
  if (Math.round(amount * 100) !== totalCents) {
    throw new SumUpCheckoutPreparationError(
      "SumUp checkout amount cannot be represented exactly in cents",
    );
  }

  const returnUrl =
    input.returnUrl === undefined
      ? undefined
      : normalizeHttpsReturnUrl(input.returnUrl);

  return {
    checkoutReference,
    amountCents: totalCents,
    payload: {
      checkout_reference: checkoutReference,
      amount,
      currency,
      merchant_code: input.merchant.merchantCode.trim(),
      ...(returnUrl === undefined ? {} : { return_url: returnUrl }),
      hosted_checkout: {
        enabled: true,
      },
    },
  };
}

function normalizeHttpsReturnUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SumUpCheckoutPreparationError(
      "SumUp return URL must be a valid HTTPS URL",
    );
  }

  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new SumUpCheckoutPreparationError(
      "SumUp return URL must be a valid HTTPS URL without credentials or fragment",
    );
  }

  return url.href;
}

function assertSandboxEuroMerchant(merchant: SumUpMerchantSummary): void {
  if (merchant.merchantCode.trim().length === 0) {
    throw new SumUpCheckoutPreparationError(
      "SumUp merchant code must not be empty",
    );
  }

  if (!merchant.sandbox) {
    throw new SumUpCheckoutPreparationError(
      "SumUp Hosted Checkout preparation requires a sandbox merchant",
    );
  }

  if (merchant.defaultCurrency !== "EUR") {
    throw new SumUpCheckoutPreparationError(
      "SumUp sandbox merchant currency must be EUR",
    );
  }
}
