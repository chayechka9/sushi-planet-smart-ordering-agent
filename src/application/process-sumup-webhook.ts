import type {
  PaymentReconciliationResult,
  VerifiedSumUpCheckout,
} from "../domain/payment.js";
import {
  decideSumUpWebhookHandling,
  type SumUpWebhookPaymentLookup,
} from "../integrations/sumup/webhook.js";

export interface SumUpCheckoutVerifier {
  verifyCheckout(checkoutId: string): Promise<VerifiedSumUpCheckout>;
}

export interface SumUpWebhookOrderPaymentRepository
  extends SumUpWebhookPaymentLookup {
  reconcileVerifiedSumUpCheckout(
    checkout: VerifiedSumUpCheckout,
    now?: Date,
  ): PaymentReconciliationResult;
}

export type SumUpWebhookProcessingOutcome =
  | "ignored"
  | "unknown_checkout"
  | "pending"
  | "not_paid"
  | "paid"
  | "duplicate";

export interface SumUpWebhookProcessingResult {
  outcome: SumUpWebhookProcessingOutcome;
}

export interface ProcessSumUpWebhookDependencies {
  repository: SumUpWebhookOrderPaymentRepository;
  verifier: SumUpCheckoutVerifier;
  now?: () => Date;
}

export class SumUpWebhookProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SumUpWebhookProcessingError";
  }
}

/**
 * Coordinates local webhook handling. The verifier is an injected boundary;
 * this service has no credentials, HTTP client, environment access, or fetch.
 */
export class ProcessSumUpWebhookService {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: ProcessSumUpWebhookDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async process(body: unknown): Promise<SumUpWebhookProcessingResult> {
    const decision = decideSumUpWebhookHandling(
      body,
      this.dependencies.repository,
    );

    switch (decision.action) {
      case "ignored":
        return { outcome: "ignored" };
      case "unknown_checkout":
        return { outcome: "unknown_checkout" };
      case "already_processed":
        return { outcome: "duplicate" };
      case "verification_required": {
        const checkout = await this.dependencies.verifier.verifyCheckout(
          decision.checkoutId,
        );

        if (checkout.checkoutId !== decision.checkoutId) {
          throw new SumUpWebhookProcessingError(
            "Verifier returned a different checkout",
          );
        }

        const reconciliation =
          this.dependencies.repository.reconcileVerifiedSumUpCheckout(
            checkout,
            this.now(),
          );

        if (reconciliation.outcome === "not_paid") {
          return {
            outcome: checkout.status === "PENDING" ? "pending" : "not_paid",
          };
        }

        return { outcome: reconciliation.outcome };
      }
    }
  }
}
