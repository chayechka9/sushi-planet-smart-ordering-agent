import { createHash } from "node:crypto";

import {
  buildPreparedSumUpCheckout,
  preparePosterPrepaidSandboxE2e,
  type PosterPrepaidSandboxE2eItemInput,
  type PosterPrepaidSandboxMenuSnapshot,
} from "./prepare-poster-prepaid-sandbox-e2e.js";
import {
  createSumUpPayment,
  type PaymentRecord,
} from "../domain/payment.js";
import type { Order } from "../domain/order.js";
import type {
  CreatedSumUpHostedCheckout,
} from "../integrations/sumup/create-checkout.js";
import type { SumUpMerchantSummary } from "../integrations/sumup/client.js";
import type { SumUpHostedCheckoutPreparation } from "../integrations/sumup/hosted-checkout.js";

export const POSTER_PREPAID_SANDBOX_CHECKOUT_CONFIRMATION =
  "--confirm-one-poster-prepaid-e2e-checkout" as const;

const POSTER_PREPAID_SANDBOX_LIFECYCLE =
  "poster_prepaid_sandbox_e2e" as const;

export interface CreatePosterPrepaidSandboxE2eCheckoutInput {
  confirmation?: string;
  item: PosterPrepaidSandboxE2eItemInput;
  menuSnapshot: PosterPrepaidSandboxMenuSnapshot;
  merchant: SumUpMerchantSummary;
  returnUrl: string;
  now: Date;
  maxMenuSnapshotAgeMs: number;
  createOrderId?: () => string;
}

export interface PosterPrepaidSandboxCheckoutAttempt {
  lifecycle: typeof POSTER_PREPAID_SANDBOX_LIFECYCLE;
  orderId: string;
  correlationId: string;
  preparationFingerprint: string;
  amountCents: number;
  currency: "EUR";
  checkoutLimit: 1;
  paymentAttemptLimit: 1;
  startedAt: string;
}

export interface PosterPrepaidSandboxCreatedCheckoutState {
  attempt: PosterPrepaidSandboxCheckoutAttempt;
  order: Order;
  payment: PaymentRecord;
  spotId: string;
  menuCapturedAt: string;
  hostedCheckoutUrl: string;
  checkoutCount: 1;
  paymentAttemptLimit: 1;
  posterSubmitted: false;
}

export interface PosterPrepaidSandboxCheckoutCreatorPort {
  createOnce(
    checkout: SumUpHostedCheckoutPreparation,
  ): Promise<CreatedSumUpHostedCheckout>;
}

export interface PosterPrepaidSandboxCheckoutLifecyclePort {
  beginAttempt(
    attempt: PosterPrepaidSandboxCheckoutAttempt,
  ): void | Promise<void>;
  saveCreatedCheckout(
    state: PosterPrepaidSandboxCreatedCheckoutState,
  ): void | Promise<void>;
}

export interface CreatePosterPrepaidSandboxE2eCheckoutDependencies {
  checkoutCreator: PosterPrepaidSandboxCheckoutCreatorPort;
  lifecycle: PosterPrepaidSandboxCheckoutLifecyclePort;
}

export type CreatePosterPrepaidSandboxE2eCheckoutResult =
  | {
      outcome: "disabled";
      checkoutCount: 0;
      paymentAttemptLimit: 1;
      posterSubmitted: false;
      retry: false;
    }
  | {
      outcome: "created";
      checkoutCount: 1;
      paymentAttemptLimit: 1;
      amountCents: number;
      currency: "EUR";
      orderStatus: "awaiting_payment";
      paymentStatus: "pending";
      posterSubmitted: false;
      retry: false;
    };

export class PosterPrepaidSandboxCheckoutRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosterPrepaidSandboxCheckoutRunnerError";
  }
}

/**
 * Creates one pending sandbox checkout through injected ports only.
 * The attempt is durably claimed before the provider call, so an ambiguous
 * result remains non-retryable. Poster submission and payment verification are
 * deliberately absent from this boundary.
 */
export async function createPosterPrepaidSandboxE2eCheckout(
  input: CreatePosterPrepaidSandboxE2eCheckoutInput,
  dependencies: CreatePosterPrepaidSandboxE2eCheckoutDependencies,
): Promise<CreatePosterPrepaidSandboxE2eCheckoutResult> {
  if (input.confirmation !== POSTER_PREPAID_SANDBOX_CHECKOUT_CONFIRMATION) {
    return {
      outcome: "disabled",
      checkoutCount: 0,
      paymentAttemptLimit: 1,
      posterSubmitted: false,
      retry: false,
    };
  }

  const menuCapturedAtMs = Date.parse(input.menuSnapshot.capturedAt);
  if (
    !Number.isFinite(menuCapturedAtMs) ||
    new Date(menuCapturedAtMs).toISOString() !== input.menuSnapshot.capturedAt
  ) {
    throw new PosterPrepaidSandboxCheckoutRunnerError(
      "Poster menu snapshot timestamp must be exact ISO UTC",
    );
  }

  const preparation = preparePosterPrepaidSandboxE2e(
    { items: [input.item] },
    {
      now: () => input.now,
      ...(input.createOrderId === undefined
        ? {}
        : { createOrderId: input.createOrderId }),
    },
  );
  const checkoutPreparation = buildPreparedSumUpCheckout({
    preparation,
    menuSnapshot: input.menuSnapshot,
    merchant: input.merchant,
    now: input.now,
    maxMenuSnapshotAgeMs: input.maxMenuSnapshotAgeMs,
    returnUrl: input.returnUrl,
  });
  const correlationId = `poster-prepaid-sandbox:${preparation.order.id}`;
  const attempt: PosterPrepaidSandboxCheckoutAttempt = {
    lifecycle: POSTER_PREPAID_SANDBOX_LIFECYCLE,
    orderId: preparation.order.id,
    correlationId,
    preparationFingerprint: fingerprintPreparation({
      orderId: preparation.order.id,
      item: preparation.item,
      totalCents: preparation.totals.totalCents,
      paymentAttempt: preparation.paymentAttempt,
    }),
    amountCents: preparation.totals.totalCents,
    currency: preparation.totals.currency,
    checkoutLimit: 1,
    paymentAttemptLimit: 1,
    startedAt: input.now.toISOString(),
  };

  await dependencies.lifecycle.beginAttempt(attempt);

  let checkoutCount = 0;
  checkoutCount += 1;
  if (checkoutCount !== 1) {
    throw new PosterPrepaidSandboxCheckoutRunnerError(
      "Poster prepaid sandbox checkout limit exceeded",
    );
  }

  const checkout = await dependencies.checkoutCreator.createOnce(
    checkoutPreparation,
  );
  assertCreatedCheckoutMatches(checkoutPreparation, checkout);

  const payment = createSumUpPayment({
    order: preparation.order,
    checkoutId: checkout.checkoutId,
    checkoutReference: checkout.checkoutReference,
    merchantCode: checkout.merchantCode,
    amountCents: checkout.amountCents,
    currency: checkout.currency,
    now: input.now,
  });

  await dependencies.lifecycle.saveCreatedCheckout({
    attempt,
    order: preparation.order,
    payment,
    spotId: preparation.item.spotId,
    menuCapturedAt: input.menuSnapshot.capturedAt,
    hostedCheckoutUrl: checkout.hostedCheckoutUrl,
    checkoutCount: 1,
    paymentAttemptLimit: 1,
    posterSubmitted: false,
  });

  return {
    outcome: "created",
    checkoutCount: 1,
    paymentAttemptLimit: 1,
    amountCents: preparation.totals.totalCents,
    currency: "EUR",
    orderStatus: "awaiting_payment",
    paymentStatus: "pending",
    posterSubmitted: false,
    retry: false,
  };
}

export function fingerprintPreparation(input: {
  orderId: string;
  item: PosterPrepaidSandboxE2eItemInput;
  totalCents: number;
  paymentAttempt: 1;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        lifecycle: POSTER_PREPAID_SANDBOX_LIFECYCLE,
        orderId: input.orderId,
        productId: input.item.productId,
        spotId: input.item.spotId,
        name: input.item.name,
        unitPriceCents: input.item.unitPriceCents,
        currency: input.item.currency,
        quantity: input.item.quantity,
        fulfilment: input.item.fulfilment,
        totalCents: input.totalCents,
        paymentAttempt: input.paymentAttempt,
      }),
      "utf8",
    )
    .digest("hex");
}

function assertCreatedCheckoutMatches(
  preparation: SumUpHostedCheckoutPreparation,
  checkout: CreatedSumUpHostedCheckout,
): void {
  if (
    checkout.checkoutReference !== preparation.checkoutReference ||
    checkout.merchantCode !== preparation.payload.merchant_code ||
    checkout.amountCents !== preparation.amountCents ||
    checkout.currency !== "EUR" ||
    checkout.status !== "PENDING"
  ) {
    throw new PosterPrepaidSandboxCheckoutRunnerError(
      "Created checkout does not match the prepared Poster E2E order",
    );
  }
}
