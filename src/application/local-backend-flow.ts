import {
  ProcessSumUpWebhookService,
  type SumUpCheckoutVerifier,
  type SumUpWebhookOrderPaymentRepository,
  type SumUpWebhookProcessingOutcome,
} from "./process-sumup-webhook.js";
import {
  SubmitPaidOrderToPosterService,
  type PosterHandoffOutcome,
  type PosterHandoffRepository,
  type SubmitPaidOrderToPosterInput,
} from "./submit-paid-order-to-poster.js";
import {
  createSumUpPayment,
  type PaymentRecord,
} from "../domain/payment.js";
import type { Order } from "../domain/order.js";
import type { PosterOrderSubmitter } from "../integrations/poster/submitter.js";
import type { CreatedSumUpHostedCheckout } from "../integrations/sumup/create-checkout.js";
import type { SumUpMerchantSummary } from "../integrations/sumup/client.js";
import {
  buildSumUpHostedCheckout,
  type SumUpHostedCheckoutPreparation,
} from "../integrations/sumup/hosted-checkout.js";
import { decideSumUpWebhookHandling } from "../integrations/sumup/webhook.js";

export interface LocalBackendFlowRepository
  extends SumUpWebhookOrderPaymentRepository,
    PosterHandoffRepository {
  createOrderWithPayment(order: Order, payment: PaymentRecord): void;
}

export interface LocalBackendCheckoutCreator {
  createCheckout(
    checkout: SumUpHostedCheckoutPreparation,
  ): Promise<CreatedSumUpHostedCheckout>;
}

export interface PrepareLocalCheckoutLinkInput {
  order: Order;
  paymentAttempt: number;
  merchant: SumUpMerchantSummary;
  returnUrl?: string;
}

export interface PreparedLocalCheckoutLink {
  orderId: string;
  checkoutId: string;
  checkoutReference: string;
  checkoutLink: string;
}

export interface ProcessLocalPaymentWebhookInput {
  body: unknown;
  posterHandoff: SubmitPaidOrderToPosterInput;
}

export type LocalPaymentWebhookResult =
  | {
      paymentOutcome: Exclude<SumUpWebhookProcessingOutcome, "paid">;
    }
  | {
      paymentOutcome: "paid";
      posterOutcome: PosterHandoffOutcome;
    };

export interface LocalBackendFlowDependencies {
  repository: LocalBackendFlowRepository;
  checkoutCreator: LocalBackendCheckoutCreator;
  checkoutVerifier: SumUpCheckoutVerifier;
  posterSubmitter: PosterOrderSubmitter;
  now?: () => Date;
}

export class LocalBackendFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalBackendFlowError";
  }
}

/**
 * Composes the existing checkout, verified webhook and durable Poster handoff
 * components. All provider boundaries are injected; this service performs no
 * direct HTTP, configuration lookup or server registration.
 */
export class LocalBackendFlowService {
  private readonly webhookService: ProcessSumUpWebhookService;
  private readonly posterHandoffService: SubmitPaidOrderToPosterService;
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: LocalBackendFlowDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.webhookService = new ProcessSumUpWebhookService({
      repository: dependencies.repository,
      verifier: dependencies.checkoutVerifier,
      now: this.now,
    });
    this.posterHandoffService = new SubmitPaidOrderToPosterService({
      repository: dependencies.repository,
      submitter: dependencies.posterSubmitter,
      now: this.now,
    });
  }

  async prepareCheckoutLink(
    input: PrepareLocalCheckoutLinkInput,
  ): Promise<PreparedLocalCheckoutLink> {
    const preparation = buildSumUpHostedCheckout(input);
    const checkout = await this.dependencies.checkoutCreator.createCheckout(
      preparation,
    );
    assertCreatedCheckoutMatchesPreparation(checkout, preparation);

    const payment = createSumUpPayment({
      order: input.order,
      checkoutId: checkout.checkoutId,
      checkoutReference: checkout.checkoutReference,
      merchantCode: checkout.merchantCode,
      amountCents: checkout.amountCents,
      currency: checkout.currency,
      now: this.now(),
    });
    this.dependencies.repository.createOrderWithPayment(input.order, payment);

    return {
      orderId: input.order.id,
      checkoutId: checkout.checkoutId,
      checkoutReference: checkout.checkoutReference,
      checkoutLink: checkout.hostedCheckoutUrl,
    };
  }

  async processPaymentWebhook(
    input: ProcessLocalPaymentWebhookInput,
  ): Promise<LocalPaymentWebhookResult> {
    const decision = decideSumUpWebhookHandling(
      input.body,
      this.dependencies.repository,
    );

    if (
      (decision.action === "verification_required" ||
        decision.action === "already_processed") &&
      decision.orderId !== input.posterHandoff.orderId
    ) {
      throw new LocalBackendFlowError(
        "Webhook payment does not match the Poster handoff order",
      );
    }

    const paymentResult = await this.webhookService.process(input.body);
    if (paymentResult.outcome !== "paid") {
      return { paymentOutcome: paymentResult.outcome };
    }

    if (decision.action !== "verification_required") {
      throw new LocalBackendFlowError(
        "A newly paid webhook must have a linked local order",
      );
    }

    const posterResult = await this.posterHandoffService.submit(
      input.posterHandoff,
    );
    return {
      paymentOutcome: "paid",
      posterOutcome: posterResult.outcome,
    };
  }
}

function assertCreatedCheckoutMatchesPreparation(
  checkout: CreatedSumUpHostedCheckout,
  preparation: SumUpHostedCheckoutPreparation,
): void {
  if (
    checkout.checkoutReference !== preparation.checkoutReference ||
    checkout.merchantCode !== preparation.payload.merchant_code ||
    checkout.amountCents !== preparation.amountCents ||
    checkout.currency !== "EUR" ||
    checkout.status !== "PENDING"
  ) {
    throw new LocalBackendFlowError(
      "Created checkout does not match its local preparation",
    );
  }

  if (
    checkout.checkoutId.length === 0 ||
    checkout.checkoutId.trim() !== checkout.checkoutId ||
    checkout.hostedCheckoutUrl.length === 0 ||
    checkout.hostedCheckoutUrl.trim() !== checkout.hostedCheckoutUrl
  ) {
    throw new LocalBackendFlowError(
      "Created checkout identifiers must be non-empty exact strings",
    );
  }
}
