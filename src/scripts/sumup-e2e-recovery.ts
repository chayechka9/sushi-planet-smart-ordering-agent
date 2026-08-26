import { isDeepStrictEqual } from "node:util";

import type {
  SumUpCheckoutVerifier,
} from "../application/process-sumup-webhook.js";
import type { PaymentRecord } from "../domain/payment.js";
import type { Order } from "../domain/order.js";
import type { SumUpE2eRecoveryState } from "./sumup-e2e-local-state.js";

export interface SumUpE2eRecoveryRepository {
  findOrderById(orderId: string): Order | undefined;
  findByCheckoutId(checkoutId: string): PaymentRecord | undefined;
}

export interface SumUpE2eRecoveryVerificationResult {
  verified: true;
  checkoutStatus: "PAID";
  transactionStatus: "SUCCESSFUL";
  bindingMatched: true;
  localOrderStatus: Order["status"];
  localPaymentStatus: PaymentRecord["status"];
  localStateChanged: false;
}

export async function verifyRecoveredSumUpE2eCheckout(options: {
  state: SumUpE2eRecoveryState;
  repository: SumUpE2eRecoveryRepository;
  verifier: SumUpCheckoutVerifier;
}): Promise<SumUpE2eRecoveryVerificationResult> {
  const orderBefore = options.repository.findOrderById(options.state.orderId);
  const paymentBefore = options.repository.findByCheckoutId(
    options.state.paymentId,
  );
  if (orderBefore === undefined || paymentBefore === undefined) {
    throw new Error("Sandbox E2E recovery pair is unavailable");
  }
  if (
    paymentBefore.orderId !== options.state.orderId ||
    paymentBefore.checkoutId !== options.state.checkoutId ||
    paymentBefore.checkoutReference !== options.state.checkoutReference
  ) {
    throw new Error("Sandbox E2E recovery locators do not match SQLite");
  }

  const verified = await options.verifier.verifyCheckout(
    options.state.checkoutId,
  );
  const successfulTransactions = verified.transactions.filter(
    (transaction) => transaction.status === "SUCCESSFUL",
  );
  if (
    verified.status !== "PAID" ||
    verified.checkoutId !== paymentBefore.checkoutId ||
    verified.checkoutReference !== paymentBefore.checkoutReference ||
    verified.merchantCode !== paymentBefore.merchantCode ||
    verified.currency !== paymentBefore.currency ||
    verified.amountCents !== paymentBefore.amountCents ||
    successfulTransactions.length !== 1 ||
    successfulTransactions[0]?.currency !== paymentBefore.currency ||
    successfulTransactions[0]?.amountCents !== paymentBefore.amountCents
  ) {
    throw new Error("Verified SumUp checkout does not match SQLite");
  }

  const orderAfter = options.repository.findOrderById(options.state.orderId);
  const paymentAfter = options.repository.findByCheckoutId(
    options.state.paymentId,
  );
  if (
    !isDeepStrictEqual(orderAfter, orderBefore) ||
    !isDeepStrictEqual(paymentAfter, paymentBefore)
  ) {
    throw new Error("Read-only SumUp recovery changed local state");
  }

  return {
    verified: true,
    checkoutStatus: "PAID",
    transactionStatus: "SUCCESSFUL",
    bindingMatched: true,
    localOrderStatus: orderBefore.status,
    localPaymentStatus: paymentBefore.status,
    localStateChanged: false,
  };
}
