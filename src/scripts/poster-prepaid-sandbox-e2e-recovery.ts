import type { VerifiedSumUpCheckout } from "../domain/payment.js";
import type { SumUpCheckoutVerifier } from "../application/process-sumup-webhook.js";
import {
  assertPosterPrepaidSandboxRecovery,
  type PosterPrepaidSandboxRecoveryContext,
} from "./poster-prepaid-sandbox-e2e-bridge.js";
import { assertPosterPrepaidSandboxVerificationAttempt } from "./poster-prepaid-sandbox-e2e-local-state.js";

export const POSTER_PREPAID_SANDBOX_RECOVERY_CONFIRMATION =
  "--confirm-one-poster-prepaid-paid-recovery" as const;

export interface PosterPrepaidSandboxRecoveryClaim {
  claim(): void;
}

export interface RecoverPosterPrepaidSandboxPaidInput
  extends PosterPrepaidSandboxRecoveryContext {
  confirmation: string;
  verifier: SumUpCheckoutVerifier;
  recoveryClaim: PosterPrepaidSandboxRecoveryClaim;
  now?: () => Date;
}

export type PosterPrepaidSandboxPaidRecoveryResult =
  | { outcome: "disabled"; posterPostCount: 0 }
  | { outcome: "paid" | "duplicate"; posterPostCount: 0 };

export class PosterPrepaidSandboxPaidRecoveryError extends Error {
  constructor() {
    super("Poster prepaid sandbox paid recovery did not match its lifecycle");
    this.name = "PosterPrepaidSandboxPaidRecoveryError";
  }
}

/** One separately claimed verification, followed by the existing atomic pair reconciliation. */
export async function recoverPosterPrepaidSandboxPaid(
  input: RecoverPosterPrepaidSandboxPaidInput,
): Promise<PosterPrepaidSandboxPaidRecoveryResult> {
  if (input.confirmation !== POSTER_PREPAID_SANDBOX_RECOVERY_CONFIRMATION) {
    return { outcome: "disabled", posterPostCount: 0 };
  }

  const initialOrder = input.repository.findOrderById(input.state.orderId);
  const initialPayment = input.repository.findByCheckoutId(input.state.checkoutId);
  if (
    (initialOrder?.status === "paid" || initialOrder?.status === "submitted_to_poster") &&
    initialPayment?.status === "paid"
  ) {
    assertPosterPrepaidSandboxRecovery(input);
    assertPosterPrepaidSandboxVerificationAttempt(input.paths.verificationAttemptPath);
    return { outcome: "duplicate", posterPostCount: 0 };
  }

  // Claim before any validation or provider request. Every failure remains one-shot.
  input.recoveryClaim.claim();
  assertPosterPrepaidSandboxVerificationAttempt(input.paths.verificationAttemptPath);
  const pair = assertPosterPrepaidSandboxRecovery(input);
  if (
    pair.order.status !== "awaiting_payment" ||
    pair.payment.status !== "pending" ||
    input.repository.findPosterHandoffByOrderId(input.state.orderId) !== undefined
  ) {
    throw new PosterPrepaidSandboxPaidRecoveryError();
  }

  const verified = await input.verifier.verifyCheckout(input.state.checkoutId);
  assertVerifiedCheckoutMatchesRecovery(input, verified);
  // A concurrent webhook may have changed the pair while the provider was read.
  assertPosterPrepaidSandboxRecovery(input);

  const reconciliation = input.repository.reconcileVerifiedSumUpCheckout(
    verified,
    input.now?.() ?? new Date(),
  );
  if (
    (reconciliation.outcome !== "paid" && reconciliation.outcome !== "duplicate") ||
    reconciliation.order.id !== input.state.orderId ||
    reconciliation.payment.checkoutId !== input.state.checkoutId ||
    reconciliation.payment.status !== "paid"
  ) {
    throw new PosterPrepaidSandboxPaidRecoveryError();
  }
  assertPosterPrepaidSandboxRecovery(input);
  return { outcome: reconciliation.outcome, posterPostCount: 0 };
}

function assertVerifiedCheckoutMatchesRecovery(
  input: PosterPrepaidSandboxRecoveryContext,
  verified: VerifiedSumUpCheckout,
): void {
  const transactions = Array.isArray(verified.transactions)
    ? verified.transactions.filter((transaction) => transaction.status === "SUCCESSFUL")
    : [];
  const transaction = transactions[0];
  if (
    verified.status !== "PAID" ||
    verified.checkoutId !== input.state.checkoutId ||
    verified.checkoutReference !== input.state.checkoutReference ||
    verified.merchantCode !== input.merchantCode ||
    verified.currency !== "EUR" ||
    verified.amountCents !== input.state.amountCents ||
    transactions.length !== 1 ||
    transaction === undefined ||
    typeof transaction.id !== "string" ||
    transaction.id.trim().length === 0 ||
    transaction.id.trim() !== transaction.id ||
    transaction.amountCents !== input.state.amountCents ||
    transaction.currency !== "EUR"
  ) {
    throw new PosterPrepaidSandboxPaidRecoveryError();
  }
}
