import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  POSTER_PREPAID_SANDBOX_CHECKOUT_CONFIRMATION,
  createPosterPrepaidSandboxE2eCheckout,
} from "../src/application/create-poster-prepaid-sandbox-e2e-checkout.js";
import { SumUpSandboxCheckoutVerifier } from "../src/integrations/sumup/checkout-verifier.js";
import { SqliteOrderPaymentRepository } from "../src/storage/sqlite/order-payment-repository.js";
import {
  FilePosterPrepaidSandboxCheckoutLifecycle,
  FilePosterPrepaidSandboxRecoveryClaim,
  FilePosterPrepaidSandboxVerificationClaim,
  readPosterPrepaidSandboxE2eAttempt,
  readPosterPrepaidSandboxE2eRecoveryState,
  resolvePosterPrepaidSandboxE2ePaths,
} from "../src/scripts/poster-prepaid-sandbox-e2e-local-state.js";
import {
  POSTER_PREPAID_SANDBOX_RECOVERY_CONFIRMATION,
  recoverPosterPrepaidSandboxPaid,
  type RecoverPosterPrepaidSandboxPaidInput,
} from "../src/scripts/poster-prepaid-sandbox-e2e-recovery.js";
import { recoverPosterPrepaidSandboxE2ePaid } from "../src/scripts/recover-poster-prepaid-sandbox-e2e-paid.js";
import { resolveSumUpE2eRecoveryPaths } from "../src/scripts/sumup-e2e-local-state.js";

const createdAt = new Date("2026-09-23T12:00:00.000Z");
const paidAt = new Date("2026-09-23T12:05:00.000Z");
const merchant = {
  merchantCode: "synthetic-sandbox-merchant",
  country: "IE",
  defaultCurrency: "EUR",
  sandbox: true,
};
const product = {
  productId: "1",
  spotId: "1",
  name: "Synthetic Menu Item",
  unitPriceCents: 1_000,
  currency: "EUR" as const,
  quantity: 1 as const,
  fulfilment: "pickup" as const,
};

const directories: string[] = [];
const repositories: SqliteOrderPaymentRepository[] = [];
let globalFetch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Global fetch is forbidden in recovery tests");
  });
});

afterEach(() => {
  for (const repository of repositories.splice(0).reverse()) repository.close();
  for (const directory of directories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
  expect(globalFetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

async function fixture(withVerificationAttempt = true) {
  const directory = mkdtempSync(join(tmpdir(), "poster-prepaid-recovery-"));
  directories.push(directory);
  const paths = resolvePosterPrepaidSandboxE2ePaths(directory);
  await createPosterPrepaidSandboxE2eCheckout({
    confirmation: POSTER_PREPAID_SANDBOX_CHECKOUT_CONFIRMATION,
    item: product,
    menuSnapshot: {
      source: "poster_menu_read_only",
      capturedAt: "2026-09-23T11:59:00.000Z",
      currency: "EUR",
      items: [{
        id: product.productId,
        name: product.name,
        categoryId: "1",
        categoryName: "Synthetic",
        hidden: false,
        spots: [{ spotId: product.spotId, priceCents: 1_000, visible: true }],
      }],
    },
    merchant,
    returnUrl: "https://sandbox.invalid/webhooks/sumup",
    now: createdAt,
    maxMenuSnapshotAgeMs: 30 * 60_000,
    createOrderId: () => "ord_synthetic_poster_recovery",
  }, {
    checkoutCreator: { createOnce: async (checkout) => ({
      checkoutId: "synthetic-checkout",
      checkoutReference: checkout.checkoutReference,
      merchantCode: merchant.merchantCode,
      amountCents: 1_000,
      currency: "EUR",
      status: "PENDING",
      hostedCheckoutUrl: "https://checkout.invalid/synthetic",
    }) },
    lifecycle: new FilePosterPrepaidSandboxCheckoutLifecycle(paths),
  });
  if (withVerificationAttempt) {
    new FilePosterPrepaidSandboxVerificationClaim(paths).claim();
  }
  const state = readPosterPrepaidSandboxE2eRecoveryState(paths.recoveryStatePath);
  const attempt = readPosterPrepaidSandboxE2eAttempt(paths.attemptMarkerPath);
  const repository = new SqliteOrderPaymentRepository(paths.databasePath);
  repositories.push(repository);
  return { directory, paths, state, attempt, repository, merchantCode: merchant.merchantCode };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

interface HttpVariant {
  checkoutStatus?: "PAID" | "PENDING";
  checkoutReference?: string;
  checkoutAmount?: number;
  checkoutCurrency?: string;
  checkoutMerchant?: string;
  checkoutTransactions?: Array<{ id: string; status: string }>;
  transactionStatus?: string;
  transactionAmount?: number;
  transactionCurrency?: string;
  transactionMerchant?: string;
  networkFailure?: boolean;
  httpFailure?: boolean;
  invalidJson?: boolean;
}

function fakeHttp(f: Fixture, variant: HttpVariant = {}) {
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (variant.networkFailure) throw new Error("synthetic network failure");
    if (variant.httpFailure) return new Response(null, { status: 503 });
    if (variant.invalidJson) return new Response("not json", { status: 200 });
    if (path.includes("/checkouts/")) {
      return Response.json({
        id: f.state.checkoutId,
        checkout_reference: variant.checkoutReference ?? f.state.checkoutReference,
        merchant_code: variant.checkoutMerchant ?? merchant.merchantCode,
        amount: variant.checkoutAmount ?? 10,
        currency: variant.checkoutCurrency ?? "EUR",
        status: variant.checkoutStatus ?? "PAID",
        transactions: variant.checkoutTransactions ?? [
          { id: "synthetic-transaction", status: "SUCCESSFUL" },
        ],
      });
    }
    return Response.json({
      id: "synthetic-transaction",
      merchant_code: variant.transactionMerchant ?? merchant.merchantCode,
      amount: variant.transactionAmount ?? 10,
      currency: variant.transactionCurrency ?? "EUR",
      status: variant.transactionStatus ?? "SUCCESSFUL",
    });
  });
  return {
    fetcher,
    verifier: new SumUpSandboxCheckoutVerifier({
      apiKey: "synthetic-key", merchant, fetcher,
    }),
  };
}

function input(f: Fixture, verifier: SumUpSandboxCheckoutVerifier): RecoverPosterPrepaidSandboxPaidInput {
  return {
    paths: f.paths,
    state: f.state,
    attempt: f.attempt,
    repository: f.repository,
    merchantCode: f.merchantCode,
    confirmation: POSTER_PREPAID_SANDBOX_RECOVERY_CONFIRMATION,
    verifier,
    recoveryClaim: new FilePosterPrepaidSandboxRecoveryClaim(f.paths),
    now: () => paidAt,
  };
}

function expectStillPending(f: Fixture) {
  expect(f.repository.findOrderById(f.state.orderId)?.status).toBe("awaiting_payment");
  expect(f.repository.findByCheckoutId(f.state.checkoutId)?.status).toBe("pending");
  expect(f.repository.findPosterHandoffByOrderId(f.state.orderId)).toBeUndefined();
}

describe("Poster prepaid sandbox paid recovery", () => {
  it("recovers only the exact pending SQLite pair after PAID and one SUCCESSFUL transaction", async () => {
    const f = await fixture();
    const { verifier, fetcher } = fakeHttp(f);
    const before = f.repository.findByCheckoutId(f.state.checkoutId);

    await expect(recoverPosterPrepaidSandboxPaid(input(f, verifier)))
      .resolves.toEqual({ outcome: "paid", posterPostCount: 0 });

    const order = f.repository.findOrderById(f.state.orderId);
    const payment = f.repository.findByCheckoutId(f.state.checkoutId);
    expect(order?.status).toBe("paid");
    expect(payment).toMatchObject({
      orderId: f.state.orderId,
      checkoutId: before?.checkoutId,
      status: "paid",
      successfulTransactionId: "synthetic-transaction",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(existsSync(f.paths.recoveryAttemptPath)).toBe(true);
    expect(f.repository.findPosterHandoffByOrderId(f.state.orderId)).toBeUndefined();
  });

  it("is idempotent after paid and restart, without another GET or timestamp change", async () => {
    const f = await fixture();
    await recoverPosterPrepaidSandboxPaid(input(f, fakeHttp(f).verifier));
    const order = f.repository.findOrderById(f.state.orderId);
    const payment = f.repository.findByCheckoutId(f.state.checkoutId);
    f.repository.close();
    repositories.splice(repositories.indexOf(f.repository), 1);
    const reopened = new SqliteOrderPaymentRepository(f.paths.databasePath);
    repositories.push(reopened);
    const restarted = { ...f, repository: reopened };
    const second = fakeHttp(restarted);

    await expect(recoverPosterPrepaidSandboxPaid(input(restarted, second.verifier)))
      .resolves.toEqual({ outcome: "duplicate", posterPostCount: 0 });
    expect(second.fetcher).not.toHaveBeenCalled();
    expect(reopened.findOrderById(f.state.orderId)).toEqual(order);
    expect(reopened.findByCheckoutId(f.state.checkoutId)).toEqual(payment);
    expect(reopened.findPosterHandoffByOrderId(f.state.orderId)).toBeUndefined();
  });

  it("keeps the CLI disabled before any file or network mutation", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const orderBefore = f.repository.findOrderById(f.state.orderId);
    const paymentBefore = f.repository.findByCheckoutId(f.state.checkoutId);
    await recoverPosterPrepaidSandboxE2ePaid([]);
    await recoverPosterPrepaidSandboxE2ePaid([
      POSTER_PREPAID_SANDBOX_RECOVERY_CONFIRMATION, "extra",
    ]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(existsSync(f.paths.recoveryAttemptPath)).toBe(false);
    expect(f.repository.findOrderById(f.state.orderId)).toEqual(orderBefore);
    expect(f.repository.findByCheckoutId(f.state.checkoutId)).toEqual(paymentBefore);
    expectStillPending(f);
  });

  it.each([
    { name: "non-PAID checkout", variant: { checkoutStatus: "PENDING" as const }, gets: 1 },
    { name: "missing transaction", variant: { checkoutTransactions: [] }, gets: 1 },
    { name: "failed transaction", variant: { transactionStatus: "FAILED" }, gets: 2 },
    { name: "checkout amount mismatch", variant: { checkoutAmount: 10.01 }, gets: 2 },
    { name: "checkout currency mismatch", variant: { checkoutCurrency: "USD" }, gets: 1 },
    { name: "checkout merchant mismatch", variant: { checkoutMerchant: "foreign" }, gets: 1 },
    { name: "checkout reference mismatch", variant: { checkoutReference: "foreign" }, gets: 2 },
    { name: "transaction amount mismatch", variant: { transactionAmount: 10.01 }, gets: 2 },
    { name: "transaction currency mismatch", variant: { transactionCurrency: "USD" }, gets: 2 },
    { name: "transaction merchant mismatch", variant: { transactionMerchant: "foreign" }, gets: 2 },
  ])("rejects $name with marker and without paid or Poster submit", async ({ variant, gets }) => {
    const f = await fixture();
    const { verifier, fetcher } = fakeHttp(f, variant);
    await expect(recoverPosterPrepaidSandboxPaid(input(f, verifier))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(gets);
    expect(existsSync(f.paths.recoveryAttemptPath)).toBe(true);
    const second = fakeHttp(f);
    await expect(recoverPosterPrepaidSandboxPaid(input(f, second.verifier)))
      .rejects.toThrow();
    expect(second.fetcher).not.toHaveBeenCalled();
    expectStillPending(f);
  });

  it.each([
    { name: "unknown lifecycle", change: (f: Fixture) => ({
      ...f, state: { ...f.state, lifecycle: "unknown" as "poster_prepaid_sandbox_e2e" },
    }) },
    { name: "stale recovery menu", change: (f: Fixture) => ({
      ...f, state: { ...f.state, menuCapturedAt: "2026-09-23T11:00:00.000Z" },
    }) },
    { name: "bad recovery locator", change: (f: Fixture) => ({
      ...f, state: { ...f.state, databasePath: "foreign-database" },
    }) },
    { name: "unknown checkout", change: (f: Fixture) => ({
      ...f, state: { ...f.state, checkoutId: "foreign-checkout" },
    }) },
    { name: "wrong local amount", change: (f: Fixture) => ({
      ...f, state: { ...f.state, amountCents: 1_001 },
    }) },
    { name: "wrong local reference", change: (f: Fixture) => ({
      ...f, state: { ...f.state, checkoutReference: "foreign-reference" },
    }) },
  ])("rejects $name before provider reads or paid", async ({ change }) => {
    const f = await fixture();
    const { verifier, fetcher } = fakeHttp(f);
    await expect(recoverPosterPrepaidSandboxPaid(input(change(f), verifier)))
      .rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(f.paths.recoveryAttemptPath)).toBe(true);
    const second = fakeHttp(f);
    await expect(recoverPosterPrepaidSandboxPaid(input(f, second.verifier)))
      .rejects.toThrow();
    expect(second.fetcher).not.toHaveBeenCalled();
    expectStillPending(f);
  });

  it.each([
    { name: "network error", variant: { networkFailure: true } },
    { name: "HTTP error", variant: { httpFailure: true } },
    { name: "invalid response", variant: { invalidJson: true } },
  ])("keeps the one-shot marker after $name and blocks another verification", async ({ variant }) => {
    const f = await fixture();
    const first = fakeHttp(f, variant);
    await expect(recoverPosterPrepaidSandboxPaid(input(f, first.verifier)))
      .rejects.toThrow();
    expect(first.fetcher).toHaveBeenCalledOnce();
    const second = fakeHttp(f);
    await expect(recoverPosterPrepaidSandboxPaid(input(f, second.verifier)))
      .rejects.toThrow();
    expect(second.fetcher).not.toHaveBeenCalled();
    expect(existsSync(f.paths.recoveryAttemptPath)).toBe(true);
    expectStillPending(f);
  });

  it("requires a prior webhook verification claim", async () => {
    const f = await fixture(false);
    const first = fakeHttp(f);
    await expect(recoverPosterPrepaidSandboxPaid(input(f, first.verifier)))
      .rejects.toThrow();
    expect(first.fetcher).not.toHaveBeenCalled();
    expect(existsSync(f.paths.recoveryAttemptPath)).toBe(true);
    expectStillPending(f);
  });

  it("recovers the Poster-prepaid SQLite pair without touching generic SumUp SQLite", async () => {
    const f = await fixture();
    const genericPaths = resolveSumUpE2eRecoveryPaths(f.directory);
    mkdirSync(genericPaths.directoryPath);
    const generic = new SqliteOrderPaymentRepository(genericPaths.databasePath);
    repositories.push(generic);
    const order = f.repository.findOrderById(f.state.orderId);
    const payment = f.repository.findByCheckoutId(f.state.checkoutId);
    if (order === undefined || payment === undefined) throw new Error("fixture missing");
    generic.createOrderWithPayment(order, payment);
    const http = fakeHttp(f);
    await expect(recoverPosterPrepaidSandboxPaid(input(f, http.verifier)))
      .resolves.toEqual({ outcome: "paid", posterPostCount: 0 });
    expect(http.fetcher).toHaveBeenCalledTimes(2);
    expect(f.repository.findByCheckoutId(f.state.checkoutId)?.status).toBe("paid");
    expect(generic.findByCheckoutId(f.state.checkoutId)?.status).toBe("pending");
    expect(generic.findOrderById(f.state.orderId)?.status).toBe("awaiting_payment");
    expect(f.repository.findPosterHandoffByOrderId(f.state.orderId)).toBeUndefined();
  });
});
