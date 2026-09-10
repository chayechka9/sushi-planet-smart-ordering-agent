import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSumUpPayment,
  type PaymentRecord,
  type VerifiedSumUpCheckout,
} from "../src/domain/payment.js";
import {
  addItem,
  createOrder,
  markAwaitingPayment,
  setPickup,
  type Order,
} from "../src/domain/order.js";
import { decideSumUpWebhookHandling } from "../src/integrations/sumup/webhook.js";
import {
  SqliteOrderPaymentRepository,
  SqliteOrderPaymentRepositoryError,
} from "../src/storage/sqlite/order-payment-repository.js";

const createdAt = new Date("2026-08-25T20:00:00.000Z");
const paidAt = new Date("2026-08-25T20:05:00.000Z");

const repositories: SqliteOrderPaymentRepository[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0).reverse()) {
    repository.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "sushi-planet-storage-"));
  temporaryDirectories.push(directory);
  return join(directory, "orders.sqlite");
}

function openRepository(databasePath: string): SqliteOrderPaymentRepository {
  const repository = new SqliteOrderPaymentRepository(databasePath);
  repositories.push(repository);
  return repository;
}

function openReadOnlyRepository(
  databasePath: string,
): SqliteOrderPaymentRepository {
  const repository = new SqliteOrderPaymentRepository(databasePath, {
    readOnly: true,
  });
  repositories.push(repository);
  return repository;
}

function createPair(suffix: string): {
  order: Order;
  payment: PaymentRecord;
} {
  let order = createOrder({
    createId: () => `ord_storage_${suffix}`,
    now: () => createdAt,
  });
  order = addItem(
    order,
    {
      id: `test-product-${suffix}`,
      name: "Test Product",
      unitPriceCents: 1_000,
      available: true,
    },
    1,
    createdAt,
  );
  order = markAwaitingPayment(setPickup(order, createdAt), createdAt);

  return {
    order,
    payment: createSumUpPayment({
      order,
      checkoutId: `checkout-${suffix}`,
      checkoutReference: `sumup-${order.id}-1`,
      merchantCode: "MTEST123",
      amountCents: 1_000,
      currency: "EUR",
      now: createdAt,
    }),
  };
}

function createVerifiedCheckout(
  payment: PaymentRecord,
  transactionId = "transaction-test-1",
  changes: Partial<VerifiedSumUpCheckout> = {},
): VerifiedSumUpCheckout {
  return {
    checkoutId: payment.checkoutId,
    checkoutReference: payment.checkoutReference,
    merchantCode: payment.merchantCode,
    amountCents: payment.amountCents,
    currency: payment.currency,
    status: "PAID",
    transactions: [
      {
        id: transactionId,
        status: "SUCCESSFUL",
        amountCents: payment.amountCents,
        currency: payment.currency,
      },
    ],
    ...changes,
  };
}

describe("SQLite order/payment repository", () => {
  it("reads an existing pair without allowing recovery mutations", () => {
    const databasePath = createDatabasePath();
    const pair = createPair("read-only");
    const writableRepository = openRepository(databasePath);
    writableRepository.createOrderWithPayment(pair.order, pair.payment);
    writableRepository.close();

    const repository = openReadOnlyRepository(databasePath);
    expect(repository.findOrderById(pair.order.id)).toEqual(pair.order);
    expect(repository.findByCheckoutId(pair.payment.checkoutId)).toEqual(
      pair.payment,
    );
    expect(() =>
      repository.createOrderWithPayment(pair.order, pair.payment),
    ).toThrow("SQLite repository is read-only");
    expect(() =>
      repository.reconcileVerifiedSumUpCheckout(
        createVerifiedCheckout(pair.payment),
        paidAt,
      ),
    ).toThrow("SQLite repository is read-only");
    const identity = {
      correlationId: `poster-handoff:${pair.order.id}:aaaaaaaaaaaaaaaa`,
      payloadFingerprint: "a".repeat(64),
    };
    expect(() => repository.claimPosterHandoff(pair.order.id, identity)).toThrow(
      "SQLite repository is read-only",
    );
    expect(() =>
      repository.markPosterHandoffUncertain(pair.order.id, identity),
    ).toThrow("SQLite repository is read-only");
    expect(() =>
      repository.completePosterHandoff(
        pair.order.id,
        identity,
        "poster-order-test",
      ),
    ).toThrow("SQLite repository is read-only");
    expect(() =>
      repository.confirmRecoveredPosterHandoff(
        pair.order.id,
        identity,
        "poster-order-test",
      ),
    ).toThrow("SQLite repository is read-only");
    expect(repository.findOrderById(pair.order.id)).toEqual(pair.order);
    expect(repository.findByCheckoutId(pair.payment.checkoutId)).toEqual(
      pair.payment,
    );
  });

  it("migrates and restores an order/payment pair after reopening", () => {
    const databasePath = createDatabasePath();
    const pair = createPair("restart");
    const firstRepository = openRepository(databasePath);

    firstRepository.createOrderWithPayment(pair.order, pair.payment);
    firstRepository.close();

    const reopenedRepository = openRepository(databasePath);
    expect(reopenedRepository.findOrderById(pair.order.id)).toEqual(pair.order);
    expect(
      reopenedRepository.findByCheckoutId(pair.payment.checkoutId),
    ).toEqual(pair.payment);
    expect(reopenedRepository.findByOrderId(pair.order.id)).toEqual(
      pair.payment,
    );
  });

  it("upgrades an existing v1 database before creating a Poster handoff", () => {
    const databasePath = createDatabasePath();
    const pair = createPair("v1-upgrade");
    const initialRepository = openRepository(databasePath);
    initialRepository.createOrderWithPayment(pair.order, pair.payment);
    initialRepository.close();

    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
      DROP TABLE poster_handoffs;
      DELETE FROM schema_migrations WHERE version = 2;
    `);
    legacyDatabase.close();

    const upgradedRepository = openRepository(databasePath);
    expect(upgradedRepository.findOrderById(pair.order.id)).toEqual(pair.order);
    upgradedRepository.reconcileVerifiedSumUpCheckout(
      createVerifiedCheckout(pair.payment, "transaction-v1-upgrade"),
      paidAt,
    );
    const identity = {
      correlationId: `poster-handoff:${pair.order.id}:aaaaaaaaaaaaaaaa`,
      payloadFingerprint: "a".repeat(64),
    };
    expect(
      upgradedRepository.claimPosterHandoff(pair.order.id, identity, paidAt),
    ).toEqual({ outcome: "claimed" });
    expect(
      upgradedRepository.findPosterHandoffByOrderId(pair.order.id),
    ).toMatchObject({ status: "submitting", ...identity });
  });

  it("atomically marks order/payment paid and deduplicates after restart", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Network access is forbidden in storage tests");
    });
    const databasePath = createDatabasePath();
    const pair = createPair("paid-restart");
    const checkout = createVerifiedCheckout(pair.payment);
    const firstRepository = openRepository(databasePath);
    firstRepository.createOrderWithPayment(pair.order, pair.payment);

    const paid = firstRepository.reconcileVerifiedSumUpCheckout(
      checkout,
      paidAt,
    );

    expect(paid.outcome).toBe("paid");
    expect(paid.order.status).toBe("paid");
    expect(paid.payment).toMatchObject({
      status: "paid",
      successfulTransactionId: "transaction-test-1",
      paidAt: paidAt.toISOString(),
    });
    firstRepository.close();

    const reopenedRepository = openRepository(databasePath);
    expect(
      decideSumUpWebhookHandling(
        {
          event_type: "CHECKOUT_STATUS_CHANGED",
          id: pair.payment.checkoutId,
        },
        reopenedRepository,
      ),
    ).toMatchObject({ action: "already_processed" });

    const duplicate = reopenedRepository.reconcileVerifiedSumUpCheckout(
      checkout,
      new Date("2026-08-25T20:10:00.000Z"),
    );

    expect(duplicate.outcome).toBe("duplicate");
    expect(duplicate.order.updatedAt).toBe(paidAt.toISOString());
    expect(duplicate.payment.updatedAt).toBe(paidAt.toISOString());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps order and payment unchanged when verification fails", () => {
    const databasePath = createDatabasePath();
    const pair = createPair("mismatch");
    const repository = openRepository(databasePath);
    repository.createOrderWithPayment(pair.order, pair.payment);

    expect(() =>
      repository.reconcileVerifiedSumUpCheckout(
        createVerifiedCheckout(pair.payment, "transaction-mismatch", {
          merchantCode: "MOTHER",
        }),
        paidAt,
      ),
    ).toThrow("Verified checkout does not match the stored payment");

    expect(repository.findOrderById(pair.order.id)).toEqual(pair.order);
    expect(repository.findByCheckoutId(pair.payment.checkoutId)).toEqual(
      pair.payment,
    );
  });

  it("rolls back the order update when a transaction ID is already claimed", () => {
    const databasePath = createDatabasePath();
    const repository = openRepository(databasePath);
    const first = createPair("transaction-owner");
    const second = createPair("transaction-conflict");
    repository.createOrderWithPayment(first.order, first.payment);
    repository.createOrderWithPayment(second.order, second.payment);

    repository.reconcileVerifiedSumUpCheckout(
      createVerifiedCheckout(first.payment, "transaction-shared"),
      paidAt,
    );

    expect(() =>
      repository.reconcileVerifiedSumUpCheckout(
        createVerifiedCheckout(second.payment, "transaction-shared"),
        paidAt,
      ),
    ).toThrow(SqliteOrderPaymentRepositoryError);

    expect(repository.findOrderById(second.order.id)).toEqual(second.order);
    expect(repository.findByCheckoutId(second.payment.checkoutId)).toEqual(
      second.payment,
    );
  });

  it("rolls back a new order when its payment identity is not unique", () => {
    const databasePath = createDatabasePath();
    const repository = openRepository(databasePath);
    const first = createPair("unique-owner");
    const second = createPair("unique-conflict");
    repository.createOrderWithPayment(first.order, first.payment);

    expect(() =>
      repository.createOrderWithPayment(second.order, {
        ...second.payment,
        checkoutId: first.payment.checkoutId,
      }),
    ).toThrow(SqliteOrderPaymentRepositoryError);

    expect(repository.findOrderById(second.order.id)).toBeUndefined();
    expect(repository.findByOrderId(second.order.id)).toBeUndefined();
  });

  it("persists a verified non-paid status without changing the order", () => {
    const databasePath = createDatabasePath();
    const repository = openRepository(databasePath);
    const pair = createPair("failed");
    repository.createOrderWithPayment(pair.order, pair.payment);

    const result = repository.reconcileVerifiedSumUpCheckout(
      createVerifiedCheckout(pair.payment, "unused", {
        status: "FAILED",
        transactions: [],
      }),
      paidAt,
    );

    expect(result.outcome).toBe("not_paid");
    expect(repository.findOrderById(pair.order.id)).toEqual(pair.order);
    expect(repository.findByCheckoutId(pair.payment.checkoutId)).toEqual({
      ...pair.payment,
      status: "failed",
      updatedAt: paidAt.toISOString(),
    });
  });
});
