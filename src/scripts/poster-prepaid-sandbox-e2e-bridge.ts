import { calculateOrderTotals, type Order } from "../domain/order.js";
import type { PaymentRecord } from "../domain/payment.js";
import {
  fingerprintPreparation,
  type PosterPrepaidSandboxCheckoutAttempt,
} from "../application/create-poster-prepaid-sandbox-e2e-checkout.js";
import {
  assertFreshMatchingMenuSnapshot,
  POSTER_PREPAID_SANDBOX_E2E_CONFIRMATION,
  type PosterPrepaidSandboxMenuSnapshot,
} from "../application/prepare-poster-prepaid-sandbox-e2e.js";
import {
  ProcessSumUpWebhookService,
  type SumUpCheckoutVerifier,
  type SumUpWebhookOrderPaymentRepository,
  type SumUpWebhookProcessingResult,
} from "../application/process-sumup-webhook.js";
import {
  SubmitPaidOrderToPosterService,
  type PosterHandoffRepository,
  type PosterHandoffResult,
} from "../application/submit-paid-order-to-poster.js";
import type { PosterAccountSummary } from "../integrations/poster/client.js";
import type { PosterOrderCustomer } from "../integrations/poster/order-payload.js";
import type { PosterOrderSubmitter } from "../integrations/poster/submitter.js";
import { parseSumUpWebhook } from "../integrations/sumup/webhook.js";
import type {
  PosterPrepaidSandboxE2ePaths,
  PosterPrepaidSandboxE2eRecoveryState,
} from "./poster-prepaid-sandbox-e2e-local-state.js";

export const POSTER_PREPAID_SANDBOX_WEBHOOK_CONFIRMATION =
  "--confirm-poster-prepaid-sandbox-webhook" as const;
export const POSTER_PREPAID_SANDBOX_MAX_MENU_AGE_MS = 30 * 60 * 1_000;
export const POSTER_PREPAID_TEST_ACCOUNT = "sushi-planet-bot" as const;

export interface PosterPrepaidSandboxBridgeRepository
  extends SumUpWebhookOrderPaymentRepository, PosterHandoffRepository {}

export interface PosterPrepaidSandboxRecoveryContext {
  paths: PosterPrepaidSandboxE2ePaths;
  state: PosterPrepaidSandboxE2eRecoveryState;
  attempt: PosterPrepaidSandboxCheckoutAttempt;
  repository: PosterPrepaidSandboxBridgeRepository;
  merchantCode: string;
}

export interface PosterPrepaidSandboxVerificationClaim {
  claim(): void;
}

export class PosterPrepaidSandboxBridgeError extends Error {
  constructor() {
    super("Poster prepaid sandbox lifecycle does not match its stored order");
    this.name = "PosterPrepaidSandboxBridgeError";
  }
}

export function assertPosterPrepaidPendingMenuFresh(
  state: PosterPrepaidSandboxE2eRecoveryState,
  now: Date,
): void {
  const age = now.getTime() - Date.parse(state.menuCapturedAt);
  if (!Number.isFinite(age) || age < 0 || age > POSTER_PREPAID_SANDBOX_MAX_MENU_AGE_MS) {
    throw new PosterPrepaidSandboxBridgeError();
  }
}

/** Validates the private locator against its single SQLite pair without network I/O. */
export function assertPosterPrepaidSandboxRecovery(
  context: PosterPrepaidSandboxRecoveryContext,
): { order: Order; payment: PaymentRecord } {
  const { paths, state, attempt, repository } = context;
  const merchantCode = context.merchantCode.trim();
  const order = repository.findOrderById(state.orderId);
  const payment = repository.findByCheckoutId(state.checkoutId);
  const byOrder = repository.findByOrderId(state.orderId);
  const item = order?.items[0];
  const menuAt = Date.parse(state.menuCapturedAt);
  const startedAt = Date.parse(attempt.startedAt);
  if (
    state.databasePath !== paths.databasePath ||
    state.lifecycle !== "poster_prepaid_sandbox_e2e" ||
    attempt.lifecycle !== state.lifecycle ||
    attempt.orderId !== state.orderId ||
    state.correlationId !== `poster-prepaid-sandbox:${state.orderId}` ||
    attempt.correlationId !== state.correlationId ||
    attempt.preparationFingerprint !== state.preparationFingerprint ||
    attempt.amountCents !== state.amountCents ||
    attempt.currency !== state.currency ||
    attempt.checkoutLimit !== 1 ||
    attempt.paymentAttemptLimit !== 1 ||
    state.checkoutCount !== 1 ||
    state.paymentAttemptLimit !== 1 ||
    state.posterSubmitted !== false ||
    !Number.isFinite(menuAt) ||
    !Number.isFinite(startedAt) ||
    menuAt > startedAt ||
    startedAt - menuAt > POSTER_PREPAID_SANDBOX_MAX_MENU_AGE_MS ||
    !/^\d+$/u.test(state.spotId) ||
    !Number.isSafeInteger(Number(state.spotId)) ||
    Number(state.spotId) < 1 ||
    merchantCode.length === 0 ||
    order === undefined ||
    payment === undefined ||
    byOrder === undefined ||
    item === undefined ||
    order.id !== state.orderId ||
    order.createdAt !== attempt.startedAt ||
    order.fulfilment?.type !== "pickup" ||
    order.items.length !== 1 ||
    !/^\d+$/u.test(item.menuItemId) ||
    !Number.isSafeInteger(Number(item.menuItemId)) ||
    Number(item.menuItemId) < 1 ||
    item.name.trim().length === 0 ||
    item.quantity !== 1 ||
    item.unitPriceCents !== state.amountCents ||
    payment.orderId !== state.orderId ||
    payment.provider !== "sumup" ||
    payment.checkoutId !== state.checkoutId ||
    payment.checkoutId !== state.paymentId ||
    byOrder.checkoutId !== payment.checkoutId ||
    payment.checkoutReference !== state.checkoutReference ||
    payment.checkoutReference !== `sumup-${state.orderId}-1` ||
    payment.merchantCode !== merchantCode ||
    payment.amountCents !== state.amountCents ||
    payment.currency !== "EUR" ||
    state.currency !== "EUR" ||
    payment.createdAt !== attempt.startedAt
  ) {
    throw new PosterPrepaidSandboxBridgeError();
  }

  let total: ReturnType<typeof calculateOrderTotals>;
  try {
    total = calculateOrderTotals(order);
  } catch {
    throw new PosterPrepaidSandboxBridgeError();
  }
  if (
    total.totalCents !== state.amountCents ||
    total.currency !== "EUR" ||
    state.preparationFingerprint !== fingerprintPreparation({
      orderId: order.id,
      item: {
        productId: item.menuItemId,
        spotId: state.spotId,
        name: item.name,
        unitPriceCents: item.unitPriceCents,
        currency: "EUR",
        quantity: 1,
        fulfilment: "pickup",
      },
      totalCents: total.totalCents,
      paymentAttempt: 1,
    }) ||
    (order.status === "awaiting_payment"
      ? payment.status !== "pending" ||
        payment.paidAt !== null ||
        payment.successfulTransactionId !== null
      : (order.status !== "paid" && order.status !== "submitted_to_poster") ||
        payment.status !== "paid" ||
        payment.paidAt === null ||
        payment.paidAt.trim().length === 0 ||
        payment.successfulTransactionId === null ||
        payment.successfulTransactionId.trim().length === 0)
  ) {
    throw new PosterPrepaidSandboxBridgeError();
  }
  return { order, payment };
}

/** Reuses the existing authenticated verifier and atomic reconciliation. */
export class PosterPrepaidSandboxWebhookBridge {
  private readonly service: ProcessSumUpWebhookService;

  constructor(
    private readonly context: PosterPrepaidSandboxRecoveryContext,
    verifier: SumUpCheckoutVerifier,
    private readonly verificationClaim: PosterPrepaidSandboxVerificationClaim,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.service = new ProcessSumUpWebhookService({
      repository: context.repository,
      verifier,
      now,
    });
  }

  async process(body: unknown): Promise<SumUpWebhookProcessingResult> {
    const event = parseSumUpWebhook(body);
    if (event.kind === "ignored") {
      return this.service.process(body);
    }
    if (event.kind === "checkout_status_changed" &&
        event.checkoutId !== this.context.state.checkoutId) {
      return { outcome: "unknown_checkout" };
    }
    const pair = assertPosterPrepaidSandboxRecovery(this.context);
    if (pair.payment.status === "pending") {
      assertPosterPrepaidPendingMenuFresh(this.context.state, this.now());
      this.verificationClaim.claim();
    }
    const result = await this.service.process(body);
    assertPosterPrepaidSandboxRecovery(this.context);
    return result;
  }
}

/** Requires a fresh menu and the paid pair before the durable one-shot handoff. */
export async function submitPosterPrepaidSandboxPaidOrder(input:
  PosterPrepaidSandboxRecoveryContext & {
    confirmation: string;
    account: PosterAccountSummary;
    menuSnapshot: PosterPrepaidSandboxMenuSnapshot;
    customer: PosterOrderCustomer;
    submitter: PosterOrderSubmitter;
    now: Date;
  },
): Promise<PosterHandoffResult> {
  if (input.confirmation !== POSTER_PREPAID_SANDBOX_E2E_CONFIRMATION) {
    throw new PosterPrepaidSandboxBridgeError();
  }
  const pair = assertPosterPrepaidSandboxRecovery(input);
  const service = new SubmitPaidOrderToPosterService({
    repository: input.repository,
    submitter: input.submitter,
    now: () => input.now,
  });
  const submission = {
    orderId: input.state.orderId,
    spotId: input.state.spotId,
    customer: input.customer,
    comment: `poster-handoff:${input.state.orderId}`,
  };
  if (input.repository.findPosterHandoffByOrderId(input.state.orderId)) {
    return service.submit(submission);
  }
  if (pair.order.status !== "paid" || pair.payment.status !== "paid") {
    throw new PosterPrepaidSandboxBridgeError();
  }
  if (
    input.account.companyId !== POSTER_PREPAID_TEST_ACCOUNT ||
    input.account.currencyIso !== "EUR"
  ) {
    throw new PosterPrepaidSandboxBridgeError();
  }
  const item = pair.order.items[0];
  if (item === undefined) throw new PosterPrepaidSandboxBridgeError();
  assertFreshMatchingMenuSnapshot(
    {
      productId: item.menuItemId,
      spotId: input.state.spotId,
      name: item.name,
      unitPriceCents: item.unitPriceCents,
      currency: "EUR",
      quantity: 1,
      fulfilment: "pickup",
    },
    input.menuSnapshot,
    input.now,
    POSTER_PREPAID_SANDBOX_MAX_MENU_AGE_MS,
  );
  return service.submit(submission);
}
