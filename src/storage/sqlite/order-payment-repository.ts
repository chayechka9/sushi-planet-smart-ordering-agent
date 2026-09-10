import { DatabaseSync } from "node:sqlite";

import {
  PaymentDomainError,
  reconcileVerifiedSumUpCheckout,
  type PaymentRecord,
  type PaymentReconciliationResult,
  type PaymentStatus,
  type VerifiedSumUpCheckout,
} from "../../domain/payment.js";
import {
  calculateOrderTotals,
  markSubmittedToPoster,
  type CartItem,
  type Fulfilment,
  type Order,
  type OrderStatus,
} from "../../domain/order.js";
import { applySqliteMigrations } from "./migrations.js";

interface OrderRow {
  id: unknown;
  status: unknown;
  payload_json: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface PaymentRow {
  provider: unknown;
  order_id: unknown;
  checkout_id: unknown;
  checkout_reference: unknown;
  merchant_code: unknown;
  amount_cents: unknown;
  currency: unknown;
  status: unknown;
  successful_transaction_id: unknown;
  created_at: unknown;
  updated_at: unknown;
  paid_at: unknown;
}

interface PosterHandoffRow {
  order_id: unknown;
  correlation_id: unknown;
  payload_fingerprint: unknown;
  status: unknown;
  poster_order_id: unknown;
  created_at: unknown;
  updated_at: unknown;
  submitted_at: unknown;
}

export type PosterHandoffStatus =
  | "submitting"
  | "submitted"
  | "uncertain";

export interface PosterHandoffIdentity {
  correlationId: string;
  payloadFingerprint: string;
}

export interface PosterHandoffRecord extends PosterHandoffIdentity {
  orderId: string;
  status: PosterHandoffStatus;
  posterOrderId: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
}

export type PosterHandoffClaimOutcome =
  | "claimed"
  | "duplicate"
  | "in_progress"
  | "uncertain";

export interface PosterHandoffClaimResult {
  outcome: PosterHandoffClaimOutcome;
}

export interface PosterHandoffRecoveryCompletionResult {
  outcome: "confirmed" | "duplicate";
  order: Order;
}

export class SqliteOrderPaymentRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqliteOrderPaymentRepositoryError";
  }
}

export interface SqliteOrderPaymentRepositoryOptions {
  readOnly?: boolean;
}

/**
 * File-backed local storage for an order, its SumUp payment and Poster handoff.
 * Successful transitions update their related records atomically.
 */
export class SqliteOrderPaymentRepository {
  private readonly database: DatabaseSync;
  private readonly readOnly: boolean;
  private closed = false;

  constructor(
    databasePath: string,
    options: SqliteOrderPaymentRepositoryOptions = {},
  ) {
    if (databasePath.trim().length === 0) {
      throw new SqliteOrderPaymentRepositoryError(
        "SQLite database path must not be empty",
      );
    }

    this.readOnly = options.readOnly ?? false;
    this.database = new DatabaseSync(databasePath, {
      readOnly: this.readOnly,
    });

    try {
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA busy_timeout = 5000");
      if (!this.readOnly) {
        this.database.exec("PRAGMA synchronous = FULL");
        applySqliteMigrations(this.database);
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  createOrderWithPayment(order: Order, payment: PaymentRecord): void {
    this.assertWritable();
    assertInitialPair(order, payment);

    this.runInTransaction(() => {
      this.database
        .prepare(
          `INSERT INTO orders (
             id, status, payload_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          order.id,
          order.status,
          JSON.stringify(order),
          order.createdAt,
          order.updatedAt,
        );

      this.database
        .prepare(
          `INSERT INTO payments (
             provider,
             order_id,
             checkout_id,
             checkout_reference,
             merchant_code,
             amount_cents,
             currency,
             status,
             successful_transaction_id,
             created_at,
             updated_at,
             paid_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          payment.provider,
          payment.orderId,
          payment.checkoutId,
          payment.checkoutReference,
          payment.merchantCode,
          payment.amountCents,
          payment.currency,
          payment.status,
          payment.successfulTransactionId,
          payment.createdAt,
          payment.updatedAt,
          payment.paidAt,
        );
    });
  }

  findOrderById(orderId: string): Order | undefined {
    const row = this.database
      .prepare(
        `SELECT id, status, payload_json, created_at, updated_at
         FROM orders
         WHERE id = ?`,
      )
      .get(orderId) as unknown as OrderRow | undefined;

    return row === undefined ? undefined : readOrder(row);
  }

  findByCheckoutId(checkoutId: string): PaymentRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT
           provider,
           order_id,
           checkout_id,
           checkout_reference,
           merchant_code,
           amount_cents,
           currency,
           status,
           successful_transaction_id,
           created_at,
           updated_at,
           paid_at
         FROM payments
         WHERE checkout_id = ?`,
      )
      .get(checkoutId) as unknown as PaymentRow | undefined;

    return row === undefined ? undefined : readPayment(row);
  }

  findByOrderId(orderId: string): PaymentRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT
           provider,
           order_id,
           checkout_id,
           checkout_reference,
           merchant_code,
           amount_cents,
           currency,
           status,
           successful_transaction_id,
           created_at,
           updated_at,
           paid_at
         FROM payments
         WHERE order_id = ?`,
      )
      .get(orderId) as unknown as PaymentRow | undefined;

    return row === undefined ? undefined : readPayment(row);
  }

  findPosterHandoffByOrderId(
    orderId: string,
  ): PosterHandoffRecord | undefined {
    const row = this.database
      .prepare(
         `SELECT
           order_id,
           correlation_id,
           payload_fingerprint,
           status,
           poster_order_id,
           created_at,
           updated_at,
           submitted_at
         FROM poster_handoffs
         WHERE order_id = ?`,
      )
      .get(orderId) as unknown as PosterHandoffRow | undefined;

    return row === undefined ? undefined : readPosterHandoff(row);
  }

  claimPosterHandoff(
    orderId: string,
    identity: PosterHandoffIdentity,
    now: Date = new Date(),
  ): PosterHandoffClaimResult {
    this.assertWritable();
    const normalizedIdentity = normalizePosterHandoffIdentity(identity);
    return this.runInTransaction(() => {
      const existing = this.findPosterHandoffByOrderId(orderId);
      if (existing !== undefined) {
        assertMatchingPosterHandoffIdentity(existing, normalizedIdentity);
        return { outcome: mapPosterHandoffClaimOutcome(existing.status) };
      }

      const order = this.findOrderById(orderId);
      const payment = this.findByOrderId(orderId);
      assertPaidPosterHandoffPair(order, payment);

      const timestamp = now.toISOString();
      this.database
        .prepare(
          `INSERT INTO poster_handoffs (
             order_id,
             correlation_id,
             payload_fingerprint,
             status,
             poster_order_id,
             created_at,
             updated_at,
             submitted_at
           ) VALUES (?, ?, ?, 'submitting', NULL, ?, ?, NULL)`,
        )
        .run(
          orderId,
          normalizedIdentity.correlationId,
          normalizedIdentity.payloadFingerprint,
          timestamp,
          timestamp,
        );

      return { outcome: "claimed" };
    });
  }

  markPosterHandoffUncertain(
    orderId: string,
    identity: PosterHandoffIdentity,
    now: Date = new Date(),
  ): void {
    this.assertWritable();
    const normalizedIdentity = normalizePosterHandoffIdentity(identity);
    this.runInTransaction(() => {
      const update = this.database
        .prepare(
          `UPDATE poster_handoffs
           SET status = 'uncertain', updated_at = ?
           WHERE
             order_id = ?
             AND correlation_id = ?
             AND payload_fingerprint = ?
             AND status = 'submitting'`,
        )
        .run(
          now.toISOString(),
          orderId,
          normalizedIdentity.correlationId,
          normalizedIdentity.payloadFingerprint,
        );

      if (update.changes !== 1) {
        throw new SqliteOrderPaymentRepositoryError(
          "Poster handoff is not awaiting a submission result",
        );
      }
    });
  }

  completePosterHandoff(
    orderId: string,
    identity: PosterHandoffIdentity,
    posterOrderId: string,
    now: Date = new Date(),
  ): Order {
    this.assertWritable();
    const normalizedIdentity = normalizePosterHandoffIdentity(identity);
    const normalizedPosterOrderId = posterOrderId.trim();
    if (normalizedPosterOrderId.length === 0) {
      throw new SqliteOrderPaymentRepositoryError(
        "Poster order ID must not be empty",
      );
    }

    return this.runInTransaction(() => {
      return this.finishPosterHandoff(
        orderId,
        normalizedIdentity,
        normalizedPosterOrderId,
        ["submitting"],
        now,
      );
    });
  }

  confirmRecoveredPosterHandoff(
    orderId: string,
    identity: PosterHandoffIdentity,
    posterOrderId: string,
    now: Date = new Date(),
  ): PosterHandoffRecoveryCompletionResult {
    this.assertWritable();
    const normalizedIdentity = normalizePosterHandoffIdentity(identity);
    const normalizedPosterOrderId = posterOrderId.trim();
    if (normalizedPosterOrderId.length === 0) {
      throw new SqliteOrderPaymentRepositoryError(
        "Poster order ID must not be empty",
      );
    }

    return this.runInTransaction(() => {
      const handoff = this.findPosterHandoffByOrderId(orderId);
      if (handoff === undefined) {
        throw new SqliteOrderPaymentRepositoryError(
          "Poster handoff does not exist",
        );
      }
      assertMatchingPosterHandoffIdentity(handoff, normalizedIdentity);

      if (handoff.status === "submitted") {
        const order = this.findOrderById(orderId);
        if (
          order?.status !== "submitted_to_poster" ||
          handoff.posterOrderId !== normalizedPosterOrderId
        ) {
          throw new SqliteOrderPaymentRepositoryError(
            "Submitted Poster handoff does not match local state",
          );
        }
        return { outcome: "duplicate", order };
      }

      return {
        outcome: "confirmed",
        order: this.finishPosterHandoff(
          orderId,
          normalizedIdentity,
          normalizedPosterOrderId,
          ["submitting", "uncertain"],
          now,
        ),
      };
    });
  }

  private finishPosterHandoff(
    orderId: string,
    identity: PosterHandoffIdentity,
    posterOrderId: string,
    allowedStatuses: readonly PosterHandoffStatus[],
    now: Date,
  ): Order {
    const handoff = this.findPosterHandoffByOrderId(orderId);
    if (handoff === undefined || !allowedStatuses.includes(handoff.status)) {
      throw new SqliteOrderPaymentRepositoryError(
        "Poster handoff is not awaiting completion",
      );
    }
    assertMatchingPosterHandoffIdentity(handoff, identity);

    const order = this.findOrderById(orderId);
    const payment = this.findByOrderId(orderId);
    assertPaidPosterHandoffPair(order, payment);

    const submittedOrder = markSubmittedToPoster(order, now);
    const orderUpdate = this.database
      .prepare(
        `UPDATE orders
         SET status = ?, payload_json = ?, updated_at = ?
         WHERE id = ? AND status = 'paid'`,
      )
      .run(
        submittedOrder.status,
        JSON.stringify(submittedOrder),
        submittedOrder.updatedAt,
        orderId,
      );
    if (orderUpdate.changes !== 1) {
      throw new SqliteOrderPaymentRepositoryError(
        "Order status changed during Poster handoff",
      );
    }

    const timestamp = now.toISOString();
    const handoffUpdate = this.database
      .prepare(
        `UPDATE poster_handoffs
         SET
           status = 'submitted',
           poster_order_id = ?,
           updated_at = ?,
           submitted_at = ?
         WHERE
           order_id = ?
           AND correlation_id = ?
           AND payload_fingerprint = ?
           AND status = ?`,
      )
      .run(
        posterOrderId,
        timestamp,
        timestamp,
        orderId,
        identity.correlationId,
        identity.payloadFingerprint,
        handoff.status,
      );
    if (handoffUpdate.changes !== 1) {
      throw new SqliteOrderPaymentRepositoryError(
        "Poster handoff state changed during completion",
      );
    }

    return submittedOrder;
  }

  reconcileVerifiedSumUpCheckout(
    checkout: VerifiedSumUpCheckout,
    now: Date = new Date(),
  ): PaymentReconciliationResult {
    this.assertWritable();
    return this.runInTransaction(() => {
      const payment = this.findByCheckoutId(checkout.checkoutId);
      if (payment === undefined) {
        throw new SqliteOrderPaymentRepositoryError(
          "Cannot reconcile an unknown checkout",
        );
      }

      const order = this.findOrderById(payment.orderId);
      if (order === undefined) {
        throw new SqliteOrderPaymentRepositoryError(
          "Stored payment has no linked order",
        );
      }

      const result = reconcileVerifiedSumUpCheckout(
        order,
        payment,
        checkout,
        now,
      );

      if (result.outcome === "duplicate") {
        return result;
      }

      if (result.outcome === "paid") {
        const orderUpdate = this.database
          .prepare(
            `UPDATE orders
             SET status = ?, payload_json = ?, updated_at = ?
             WHERE id = ? AND status = ?`,
          )
          .run(
            result.order.status,
            JSON.stringify(result.order),
            result.order.updatedAt,
            order.id,
            order.status,
          );

        if (orderUpdate.changes !== 1) {
          throw new SqliteOrderPaymentRepositoryError(
            "Order status changed during payment reconciliation",
          );
        }
      }

      const paymentUpdate = this.database
        .prepare(
          `UPDATE payments
           SET
             status = ?,
             successful_transaction_id = ?,
             updated_at = ?,
             paid_at = ?
           WHERE
             checkout_id = ?
             AND status = ?
             AND successful_transaction_id IS ?`,
        )
        .run(
          result.payment.status,
          result.payment.successfulTransactionId,
          result.payment.updatedAt,
          result.payment.paidAt,
          payment.checkoutId,
          payment.status,
          payment.successfulTransactionId,
        );

      if (paymentUpdate.changes !== 1) {
        throw new SqliteOrderPaymentRepositoryError(
          "Payment status changed during reconciliation",
        );
      }

      return result;
    });
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }

  private assertWritable(): void {
    if (this.readOnly) {
      throw new SqliteOrderPaymentRepositoryError(
        "SQLite repository is read-only",
      );
    }
  }

  private runInTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");

    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original domain, constraint, or storage error.
      }

      if (
        error instanceof PaymentDomainError ||
        error instanceof SqliteOrderPaymentRepositoryError
      ) {
        throw error;
      }

      if (isSqliteConstraintError(error)) {
        throw new SqliteOrderPaymentRepositoryError(
          "Stored order, payment or Poster identity must be unique and valid",
        );
      }

      throw error;
    }
  }
}

function assertInitialPair(order: Order, payment: PaymentRecord): void {
  if (order.id !== payment.orderId) {
    throw new SqliteOrderPaymentRepositoryError(
      "Payment is linked to a different order",
    );
  }
  if (order.status !== "awaiting_payment") {
    throw new SqliteOrderPaymentRepositoryError(
      "Stored order must be awaiting payment",
    );
  }
  if (
    payment.provider !== "sumup" ||
    payment.status !== "pending" ||
    payment.successfulTransactionId !== null ||
    payment.paidAt !== null
  ) {
    throw new SqliteOrderPaymentRepositoryError(
      "Stored payment must be a pending SumUp payment",
    );
  }

  const totals = calculateOrderTotals(order);
  if (
    payment.amountCents !== totals.totalCents ||
    payment.currency !== totals.currency
  ) {
    throw new SqliteOrderPaymentRepositoryError(
      "Stored payment amount does not match the order",
    );
  }
}

function readOrder(row: OrderRow): Order {
  const id = requireString(row.id, "Stored order ID");
  const status = requireOrderStatus(row.status);
  const createdAt = requireString(row.created_at, "Stored order created_at");
  const updatedAt = requireString(row.updated_at, "Stored order updated_at");
  const payload = requireString(row.payload_json, "Stored order payload");

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new SqliteOrderPaymentRepositoryError(
      "Stored order payload is invalid JSON",
    );
  }

  if (!isRecord(parsed)) {
    throw new SqliteOrderPaymentRepositoryError(
      "Stored order payload must be an object",
    );
  }

  const order: Order = {
    id: requireString(parsed.id, "Stored order payload ID"),
    status: requireOrderStatus(parsed.status),
    items: requireCartItems(parsed.items),
    fulfilment: requireFulfilment(parsed.fulfilment),
    createdAt: requireString(
      parsed.createdAt,
      "Stored order payload createdAt",
    ),
    updatedAt: requireString(
      parsed.updatedAt,
      "Stored order payload updatedAt",
    ),
  };

  if (
    order.id !== id ||
    order.status !== status ||
    order.createdAt !== createdAt ||
    order.updatedAt !== updatedAt
  ) {
    throw new SqliteOrderPaymentRepositoryError(
      "Stored order columns do not match the payload",
    );
  }

  calculateOrderTotals(order);
  return order;
}

function readPayment(row: PaymentRow): PaymentRecord {
  if (row.provider !== "sumup") {
    throw new SqliteOrderPaymentRepositoryError(
      "Stored payment provider is invalid",
    );
  }
  if (row.currency !== "EUR") {
    throw new SqliteOrderPaymentRepositoryError(
      "Stored payment currency is invalid",
    );
  }

  return {
    provider: row.provider,
    orderId: requireString(row.order_id, "Stored payment order ID"),
    checkoutId: requireString(row.checkout_id, "Stored checkout ID"),
    checkoutReference: requireString(
      row.checkout_reference,
      "Stored checkout reference",
    ),
    merchantCode: requireString(
      row.merchant_code,
      "Stored merchant code",
    ),
    amountCents: requirePositiveInteger(
      row.amount_cents,
      "Stored payment amount",
    ),
    currency: row.currency,
    status: requirePaymentStatus(row.status),
    successfulTransactionId: requireNullableString(
      row.successful_transaction_id,
      "Stored successful transaction ID",
    ),
    createdAt: requireString(
      row.created_at,
      "Stored payment created_at",
    ),
    updatedAt: requireString(
      row.updated_at,
      "Stored payment updated_at",
    ),
    paidAt: requireNullableString(row.paid_at, "Stored payment paid_at"),
  };
}

function readPosterHandoff(row: PosterHandoffRow): PosterHandoffRecord {
  return {
    orderId: requireString(row.order_id, "Stored Poster handoff order ID"),
    correlationId: requireString(
      row.correlation_id,
      "Stored Poster handoff correlation ID",
    ),
    payloadFingerprint: requirePosterPayloadFingerprint(
      row.payload_fingerprint,
    ),
    status: requirePosterHandoffStatus(row.status),
    posterOrderId: requireNullableString(
      row.poster_order_id,
      "Stored Poster order ID",
    ),
    createdAt: requireString(
      row.created_at,
      "Stored Poster handoff created_at",
    ),
    updatedAt: requireString(
      row.updated_at,
      "Stored Poster handoff updated_at",
    ),
    submittedAt: requireNullableString(
      row.submitted_at,
      "Stored Poster handoff submitted_at",
    ),
  };
}

function normalizePosterHandoffIdentity(
  identity: PosterHandoffIdentity,
): PosterHandoffIdentity {
  const correlationId = requireString(
    identity.correlationId,
    "Poster handoff correlation ID",
  ).trim();
  const payloadFingerprint = requirePosterPayloadFingerprint(
    identity.payloadFingerprint,
  );
  return { correlationId, payloadFingerprint };
}

function assertMatchingPosterHandoffIdentity(
  handoff: PosterHandoffRecord,
  identity: PosterHandoffIdentity,
): void {
  if (
    handoff.correlationId !== identity.correlationId ||
    handoff.payloadFingerprint !== identity.payloadFingerprint
  ) {
    throw new SqliteOrderPaymentRepositoryError(
      "Poster handoff identity does not match stored state",
    );
  }
}

function assertPaidPosterHandoffPair(
  order: Order | undefined,
  payment: PaymentRecord | undefined,
): asserts order is Order {
  if (order === undefined || payment === undefined) {
    throw new SqliteOrderPaymentRepositoryError(
      "Poster handoff requires a stored order and payment",
    );
  }
  if (
    order.status !== "paid" ||
    payment.provider !== "sumup" ||
    payment.orderId !== order.id ||
    payment.status !== "paid" ||
    payment.successfulTransactionId === null ||
    payment.successfulTransactionId.trim().length === 0 ||
    payment.checkoutReference.trim().length === 0 ||
    payment.paidAt === null ||
    payment.paidAt.trim().length === 0
  ) {
    throw new SqliteOrderPaymentRepositoryError(
      "Poster handoff requires a locally confirmed paid order",
    );
  }

  const totals = calculateOrderTotals(order);
  if (
    payment.amountCents !== totals.totalCents ||
    payment.currency !== "EUR"
  ) {
    throw new SqliteOrderPaymentRepositoryError(
      "Poster handoff payment does not match the order",
    );
  }
}

function mapPosterHandoffClaimOutcome(
  status: PosterHandoffStatus,
): Exclude<PosterHandoffClaimOutcome, "claimed"> {
  switch (status) {
    case "submitting":
      return "in_progress";
    case "submitted":
      return "duplicate";
    case "uncertain":
      return "uncertain";
  }
}

function requireCartItems(value: unknown): CartItem[] {
  if (!Array.isArray(value)) {
    throw new SqliteOrderPaymentRepositoryError(
      "Stored order items must be an array",
    );
  }

  return value.map((item) => {
    if (!isRecord(item)) {
      throw new SqliteOrderPaymentRepositoryError(
        "Stored cart item must be an object",
      );
    }

    return {
      menuItemId: requireString(item.menuItemId, "Stored menu item ID"),
      name: requireString(item.name, "Stored menu item name"),
      unitPriceCents: requireNonNegativeInteger(
        item.unitPriceCents,
        "Stored unit price",
      ),
      quantity: requirePositiveInteger(
        item.quantity,
        "Stored item quantity",
      ),
    };
  });
}

function requireFulfilment(value: unknown): Fulfilment | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new SqliteOrderPaymentRepositoryError(
      "Stored fulfilment must be an object or null",
    );
  }
  if (value.type === "pickup") {
    return { type: "pickup" };
  }
  if (value.type !== "delivery" || !isRecord(value.address)) {
    throw new SqliteOrderPaymentRepositoryError(
      "Stored fulfilment is invalid",
    );
  }

  return {
    type: "delivery",
    address: {
      line1: requireString(value.address.line1, "Stored address line"),
      city: requireString(value.address.city, "Stored address city"),
      postalCode: requireString(
        value.address.postalCode,
        "Stored address postal code",
      ),
    },
    deliveryFeeCents: requireNonNegativeInteger(
      value.deliveryFeeCents,
      "Stored delivery fee",
    ),
  };
}

function requireOrderStatus(value: unknown): OrderStatus {
  if (
    value === "draft" ||
    value === "awaiting_payment" ||
    value === "paid" ||
    value === "submitted_to_poster" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new SqliteOrderPaymentRepositoryError(
    "Stored order status is invalid",
  );
}

function requirePaymentStatus(value: unknown): PaymentStatus {
  if (
    value === "pending" ||
    value === "paid" ||
    value === "failed" ||
    value === "expired"
  ) {
    return value;
  }
  throw new SqliteOrderPaymentRepositoryError(
    "Stored payment status is invalid",
  );
}

function requirePosterHandoffStatus(value: unknown): PosterHandoffStatus {
  if (
    value === "submitting" ||
    value === "submitted" ||
    value === "uncertain"
  ) {
    return value;
  }
  throw new SqliteOrderPaymentRepositoryError(
    "Stored Poster handoff status is invalid",
  );
}

function requirePosterPayloadFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new SqliteOrderPaymentRepositoryError(
      "Stored Poster payload fingerprint is invalid",
    );
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SqliteOrderPaymentRepositoryError(
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function requireNullableString(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : requireString(value, label);
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new SqliteOrderPaymentRepositoryError(
      `${label} must be a positive integer`,
    );
  }
  return value as number;
}

function requireNonNegativeInteger(
  value: unknown,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SqliteOrderPaymentRepositoryError(
      `${label} must be a non-negative integer`,
    );
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSqliteConstraintError(
  error: unknown,
): error is { code: string; errcode?: number } {
  return (
    isRecord(error) &&
    typeof error.code === "string" &&
    (error.code.startsWith("ERR_SQLITE_CONSTRAINT") ||
      (error.code === "ERR_SQLITE_ERROR" &&
        typeof error.errcode === "number" &&
        (error.errcode & 0xff) === 19))
  );
}
