import {
  addItem,
  calculateOrderTotals,
  createOrder,
  markAwaitingPayment,
  setPickup,
  type Order,
  type OrderTotals,
} from "../domain/order.js";
import type { PaymentRecord } from "../domain/payment.js";
import type { PosterMenuItem } from "../integrations/poster/client.js";
import {
  buildPosterIncomingOrderPayload,
  type PosterCreateIncomingOrderPayload,
  type PosterOrderCustomer,
} from "../integrations/poster/order-payload.js";
import type { PosterSandboxOrderSubmitter } from "../integrations/poster/sandbox-submitter.js";
import type { SumUpMerchantSummary } from "../integrations/sumup/client.js";
import {
  buildSumUpHostedCheckout,
  type SumUpHostedCheckoutPreparation,
} from "../integrations/sumup/hosted-checkout.js";

export const POSTER_PREPAID_SANDBOX_E2E_CONFIRMATION =
  "--confirm-one-poster-prepaid-sandbox-order" as const;

export interface PosterPrepaidSandboxE2eItemInput {
  productId: string;
  spotId: string;
  name: string;
  unitPriceCents: number;
  currency: "EUR";
  quantity: 1;
  fulfilment: "pickup";
}

export interface PreparePosterPrepaidSandboxE2eInput {
  items: readonly PosterPrepaidSandboxE2eItemInput[];
}

export interface PreparePosterPrepaidSandboxE2eDependencies {
  createOrderId?: () => string;
  now?: () => Date;
}

export interface PosterPrepaidSandboxE2ePreparation {
  order: Order;
  item: PosterPrepaidSandboxE2eItemInput;
  totals: OrderTotals;
  paymentAttempt: 1;
}

export interface PosterPrepaidSandboxMenuSnapshot {
  source: "poster_menu_read_only";
  capturedAt: string;
  currency: "EUR";
  items: readonly PosterMenuItem[];
}

export interface PosterPrepaidSandboxVerifiedPaidPair {
  order: Order;
  payment: PaymentRecord;
}

export interface PosterPrepaidSandboxMenuSnapshotPort {
  readFreshMenuSnapshot(): Promise<PosterPrepaidSandboxMenuSnapshot>;
}

export interface PosterPrepaidSandboxVerifiedPaymentPort {
  readVerifiedPaidPair(
    orderId: string,
  ): Promise<PosterPrepaidSandboxVerifiedPaidPair | undefined>;
}

/**
 * Contracts for a future separately authorized external runner.
 * This module does not implement that runner or call any of these ports.
 */
export interface PosterPrepaidSandboxE2eRunnerPorts {
  menuSnapshot: PosterPrepaidSandboxMenuSnapshotPort;
  verifiedPayment: PosterPrepaidSandboxVerifiedPaymentPort;
  submitter: PosterSandboxOrderSubmitter;
}

export interface BuildPreparedSumUpCheckoutInput {
  preparation: PosterPrepaidSandboxE2ePreparation;
  menuSnapshot: PosterPrepaidSandboxMenuSnapshot;
  merchant: SumUpMerchantSummary;
  now: Date;
  maxMenuSnapshotAgeMs: number;
  returnUrl?: string;
}

export interface BuildPreparedPosterPrepaidPayloadInput {
  preparation: PosterPrepaidSandboxE2ePreparation;
  menuSnapshot: PosterPrepaidSandboxMenuSnapshot;
  verifiedPaidPair: PosterPrepaidSandboxVerifiedPaidPair;
  customer: PosterOrderCustomer;
  confirmation: string;
  now: Date;
  maxMenuSnapshotAgeMs: number;
}

export class PosterPrepaidSandboxE2ePreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosterPrepaidSandboxE2ePreparationError";
  }
}

/**
 * Builds only local order state for a future sandbox checkout and Poster test.
 * It performs no checkout creation, payment transition, persistence, network
 * request or Poster submission.
 */
export function preparePosterPrepaidSandboxE2e(
  input: PreparePosterPrepaidSandboxE2eInput,
  dependencies: PreparePosterPrepaidSandboxE2eDependencies = {},
): PosterPrepaidSandboxE2ePreparation {
  if (input.items.length !== 1) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      "Poster prepaid sandbox preparation requires exactly one product",
    );
  }

  const inputItem = input.items[0];
  if (inputItem === undefined) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      "Poster prepaid sandbox product is missing",
    );
  }

  const item = validateItem(inputItem);
  const timestamp = (dependencies.now ?? (() => new Date()))();
  let order = createOrder({
    ...(dependencies.createOrderId === undefined
      ? {}
      : { createId: dependencies.createOrderId }),
    now: () => timestamp,
  });
  order = addItem(
    order,
    {
      id: item.productId,
      name: item.name,
      unitPriceCents: item.unitPriceCents,
      available: true,
    },
    item.quantity,
    timestamp,
  );
  order = setPickup(order, timestamp);
  order = markAwaitingPayment(order, timestamp);

  const totals = calculateOrderTotals(order);
  if (
    totals.currency !== item.currency ||
    totals.totalCents !== item.unitPriceCents
  ) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      "Prepared amount must come from the order core",
    );
  }

  return {
    order,
    item,
    totals,
    paymentAttempt: 1,
  };
}

/** Pure reuse of the existing SumUp request builder; no checkout is created. */
export function buildPreparedSumUpCheckout(
  input: BuildPreparedSumUpCheckoutInput,
): SumUpHostedCheckoutPreparation {
  assertFreshMatchingMenuSnapshot(
    input.preparation.item,
    input.menuSnapshot,
    input.now,
    input.maxMenuSnapshotAgeMs,
  );
  return buildSumUpHostedCheckout({
    order: input.preparation.order,
    paymentAttempt: input.preparation.paymentAttempt,
    merchant: input.merchant,
    ...(input.returnUrl === undefined ? {} : { returnUrl: input.returnUrl }),
  });
}

/**
 * Builds the existing standard prepaid Poster payload only from a fresh menu
 * snapshot and an already verified paid pair. It does not submit the payload
 * or change either local record.
 */
export function buildPreparedPosterPrepaidPayload(
  input: BuildPreparedPosterPrepaidPayloadInput,
): PosterCreateIncomingOrderPayload {
  if (input.confirmation !== POSTER_PREPAID_SANDBOX_E2E_CONFIRMATION) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      "Explicit one-shot Poster sandbox confirmation is required",
    );
  }

  assertFreshMatchingMenuSnapshot(
    input.preparation.item,
    input.menuSnapshot,
    input.now,
    input.maxMenuSnapshotAgeMs,
  );
  assertPaidPairMatchesPreparation(
    input.preparation,
    input.verifiedPaidPair,
  );

  return buildPosterIncomingOrderPayload({
    order: input.verifiedPaidPair.order,
    payment: input.verifiedPaidPair.payment,
    spotId: input.preparation.item.spotId,
    customer: input.customer,
    comment: `poster-handoff:${input.preparation.order.id}`,
  });
}

function validateItem(
  item: PosterPrepaidSandboxE2eItemInput,
): PosterPrepaidSandboxE2eItemInput {
  const productId = requirePosterId("Poster product ID", item.productId);
  const spotId = requirePosterId("Poster spot ID", item.spotId);
  const name = requireText("Poster product name", item.name);

  if (!Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 1) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      "Poster product price must be positive integer cents",
    );
  }
  if (item.currency !== "EUR") {
    throw new PosterPrepaidSandboxE2ePreparationError(
      "Poster prepaid sandbox currency must be EUR",
    );
  }
  if (item.quantity !== 1) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      "Poster prepaid sandbox quantity must be exactly one",
    );
  }
  if (item.fulfilment !== "pickup") {
    throw new PosterPrepaidSandboxE2ePreparationError(
      "Poster prepaid sandbox fulfilment must be pickup",
    );
  }

  return {
    productId,
    spotId,
    name,
    unitPriceCents: item.unitPriceCents,
    currency: "EUR",
    quantity: 1,
    fulfilment: "pickup",
  };
}

export function assertFreshMatchingMenuSnapshot(
  item: PosterPrepaidSandboxE2eItemInput,
  snapshot: PosterPrepaidSandboxMenuSnapshot,
  now: Date,
  maxAgeMs: number,
): void {
  if (
    snapshot.source !== "poster_menu_read_only" ||
    snapshot.currency !== "EUR"
  ) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      "A read-only EUR Poster menu snapshot is required",
    );
  }
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      "Poster menu snapshot maximum age must be positive milliseconds",
    );
  }

  const capturedAtMs = Date.parse(snapshot.capturedAt);
  const nowMs = now.getTime();
  if (
    !Number.isFinite(capturedAtMs) ||
    !Number.isFinite(nowMs) ||
    capturedAtMs > nowMs ||
    nowMs - capturedAtMs > maxAgeMs
  ) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      "Poster menu snapshot is not fresh",
    );
  }

  const matchingProducts = snapshot.items.filter(
    (product) => product.id.trim() === item.productId,
  );
  const product = matchingProducts[0];
  if (
    matchingProducts.length !== 1 ||
    product === undefined ||
    product.hidden ||
    product.name.trim() !== item.name
  ) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      "Prepared product does not match the fresh Poster menu snapshot",
    );
  }

  const matchingSpots = product.spots.filter(
    (spot) => spot.spotId.trim() === item.spotId,
  );
  const spot = matchingSpots[0];
  if (
    matchingSpots.length !== 1 ||
    spot === undefined ||
    !spot.visible ||
    spot.priceCents !== item.unitPriceCents
  ) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      "Prepared spot price does not match the fresh Poster menu snapshot",
    );
  }
}

function assertPaidPairMatchesPreparation(
  preparation: PosterPrepaidSandboxE2ePreparation,
  pair: PosterPrepaidSandboxVerifiedPaidPair,
): void {
  const [item] = pair.order.items;
  const totals = calculateOrderTotals(pair.order);
  if (
    pair.order.id !== preparation.order.id ||
    pair.order.status !== "paid" ||
    pair.order.fulfilment?.type !== "pickup" ||
    pair.order.items.length !== 1 ||
    item === undefined ||
    item.menuItemId !== preparation.item.productId ||
    item.name !== preparation.item.name ||
    item.unitPriceCents !== preparation.item.unitPriceCents ||
    item.quantity !== 1 ||
    totals.currency !== preparation.totals.currency ||
    totals.totalCents !== preparation.totals.totalCents
  ) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      "Verified paid order does not match the local preparation",
    );
  }
}

function requireText(label: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      `${label} must not be empty`,
    );
  }
  return trimmed;
}

function requirePosterId(label: string, value: string): string {
  const trimmed = requireText(label, value);
  if (!/^\d+$/u.test(trimmed)) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      `${label} must contain only digits`,
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new PosterPrepaidSandboxE2ePreparationError(
      `${label} must be a positive safe integer`,
    );
  }
  return trimmed;
}
