import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  PosterPrepaidSandboxCheckoutAttempt,
  PosterPrepaidSandboxCheckoutLifecyclePort,
  PosterPrepaidSandboxCreatedCheckoutState,
} from "../application/create-poster-prepaid-sandbox-e2e-checkout.js";
import { SqliteOrderPaymentRepository } from "../storage/sqlite/order-payment-repository.js";
import {
  ensurePrivateRecoveryDirectory,
  writePrivateJson,
} from "./sumup-e2e-local-state.js";

const DEFAULT_POSTER_PREPAID_E2E_DIRECTORY = ".poster-prepaid-e2e";

export interface PosterPrepaidSandboxE2ePaths {
  directoryPath: string;
  attemptMarkerPath: string;
  verificationAttemptPath: string;
  recoveryStatePath: string;
  hostedCheckoutUrlPath: string;
  databasePath: string;
}

export interface PosterPrepaidSandboxE2eRecoveryState {
  lifecycle: "poster_prepaid_sandbox_e2e";
  orderId: string;
  paymentId: string;
  checkoutId: string;
  checkoutReference: string;
  databasePath: string;
  spotId: string;
  menuCapturedAt: string;
  correlationId: string;
  preparationFingerprint: string;
  amountCents: number;
  currency: "EUR";
  checkoutCount: 1;
  paymentAttemptLimit: 1;
  posterSubmitted: false;
}

export function resolvePosterPrepaidSandboxE2ePaths(
  workingDirectory: string = process.cwd(),
): PosterPrepaidSandboxE2ePaths {
  const directoryPath = resolve(
    workingDirectory,
    DEFAULT_POSTER_PREPAID_E2E_DIRECTORY,
  );
  return {
    directoryPath,
    attemptMarkerPath: resolve(directoryPath, "attempt.json"),
    verificationAttemptPath: resolve(directoryPath, "verification-attempt.json"),
    recoveryStatePath: resolve(directoryPath, "recovery.json"),
    hostedCheckoutUrlPath: resolve(directoryPath, "hosted-checkout.json"),
    databasePath: resolve(directoryPath, "orders.sqlite"),
  };
}

export function readPosterPrepaidSandboxE2eRecoveryState(
  path: string,
): PosterPrepaidSandboxE2eRecoveryState {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Poster prepaid sandbox recovery state is unavailable");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Poster prepaid sandbox recovery state is invalid");
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "lifecycle",
    "orderId",
    "paymentId",
    "checkoutId",
    "checkoutReference",
    "databasePath",
    "spotId",
    "menuCapturedAt",
    "correlationId",
    "preparationFingerprint",
    "amountCents",
    "currency",
    "checkoutCount",
    "paymentAttemptLimit",
    "posterSubmitted",
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error("Poster prepaid sandbox recovery state has unsafe fields");
  }

  const paymentId = requireString(record.paymentId, "payment ID");
  const checkoutId = requireString(record.checkoutId, "checkout ID");
  const amountCents = record.amountCents;
  if (
    record.lifecycle !== "poster_prepaid_sandbox_e2e" ||
    paymentId !== checkoutId ||
    !Number.isSafeInteger(amountCents) ||
    (amountCents as number) < 1 ||
    record.currency !== "EUR" ||
    record.checkoutCount !== 1 ||
    record.paymentAttemptLimit !== 1 ||
    record.posterSubmitted !== false
  ) {
    throw new Error("Poster prepaid sandbox recovery state is invalid");
  }

  return {
    lifecycle: "poster_prepaid_sandbox_e2e",
    orderId: requireString(record.orderId, "order ID"),
    paymentId,
    checkoutId,
    checkoutReference: requireString(
      record.checkoutReference,
      "checkout reference",
    ),
    databasePath: requireString(record.databasePath, "database path"),
    spotId: requireString(record.spotId, "spot ID"),
    menuCapturedAt: requireIsoTimestamp(record.menuCapturedAt),
    correlationId: requireString(record.correlationId, "correlation ID"),
    preparationFingerprint: requireFingerprint(record.preparationFingerprint),
    amountCents: amountCents as number,
    currency: "EUR",
    checkoutCount: 1,
    paymentAttemptLimit: 1,
    posterSubmitted: false,
  };
}

export function readPosterPrepaidSandboxE2eAttempt(
  path: string,
): PosterPrepaidSandboxCheckoutAttempt {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Poster prepaid sandbox attempt is unavailable");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Poster prepaid sandbox attempt is invalid");
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "lifecycle", "orderId", "correlationId", "preparationFingerprint",
    "amountCents", "currency", "checkoutLimit", "paymentAttemptLimit",
    "startedAt",
  ]);
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    record.lifecycle !== "poster_prepaid_sandbox_e2e" ||
    record.currency !== "EUR" ||
    record.checkoutLimit !== 1 ||
    record.paymentAttemptLimit !== 1 ||
    !Number.isSafeInteger(record.amountCents) ||
    (record.amountCents as number) < 1
  ) {
    throw new Error("Poster prepaid sandbox attempt is invalid");
  }
  return {
    lifecycle: "poster_prepaid_sandbox_e2e",
    orderId: requireString(record.orderId, "order ID"),
    correlationId: requireString(record.correlationId, "correlation ID"),
    preparationFingerprint: requireFingerprint(record.preparationFingerprint),
    amountCents: record.amountCents as number,
    currency: "EUR",
    checkoutLimit: 1,
    paymentAttemptLimit: 1,
    startedAt: requireIsoTimestamp(record.startedAt),
  };
}

export class FilePosterPrepaidSandboxCheckoutLifecycle
  implements PosterPrepaidSandboxCheckoutLifecyclePort
{
  constructor(private readonly paths: PosterPrepaidSandboxE2ePaths) {}

  beginAttempt(attempt: PosterPrepaidSandboxCheckoutAttempt): void {
    ensurePrivateRecoveryDirectory(this.paths.directoryPath);
    if (this.hasAnyLifecycleArtifact()) {
      throw new Error("Poster prepaid sandbox checkout attempt already exists");
    }
    writePrivateJson(this.paths.attemptMarkerPath, attempt);
  }

  saveCreatedCheckout(state: PosterPrepaidSandboxCreatedCheckoutState): void {
    if (!existsSync(this.paths.attemptMarkerPath)) {
      throw new Error("Poster prepaid sandbox checkout attempt marker is missing");
    }
    if (
      state.attempt.checkoutLimit !== 1 ||
      state.attempt.paymentAttemptLimit !== 1 ||
      state.checkoutCount !== 1 ||
      state.paymentAttemptLimit !== 1 ||
      state.order.status !== "awaiting_payment" ||
      state.payment.status !== "pending" ||
      state.posterSubmitted
    ) {
      throw new Error("Poster prepaid sandbox checkout state is unsafe");
    }

    const menuCapturedAt = requireIsoTimestamp(state.menuCapturedAt);

    const repository = new SqliteOrderPaymentRepository(
      this.paths.databasePath,
    );
    try {
      repository.createOrderWithPayment(state.order, state.payment);
    } finally {
      repository.close();
    }

    const recovery: PosterPrepaidSandboxE2eRecoveryState = {
      lifecycle: state.attempt.lifecycle,
      orderId: state.order.id,
      paymentId: state.payment.checkoutId,
      checkoutId: state.payment.checkoutId,
      checkoutReference: state.payment.checkoutReference,
      databasePath: this.paths.databasePath,
      spotId: state.spotId,
      menuCapturedAt,
      correlationId: state.attempt.correlationId,
      preparationFingerprint: state.attempt.preparationFingerprint,
      amountCents: state.payment.amountCents,
      currency: state.payment.currency,
      checkoutCount: 1,
      paymentAttemptLimit: 1,
      posterSubmitted: false,
    };
    writePrivateJson(this.paths.recoveryStatePath, recovery);
    writePrivateJson(this.paths.hostedCheckoutUrlPath, {
      hostedCheckoutUrl: state.hostedCheckoutUrl,
    });
  }

  private hasAnyLifecycleArtifact(): boolean {
    return [
      this.paths.attemptMarkerPath,
      this.paths.verificationAttemptPath,
      this.paths.recoveryStatePath,
      this.paths.hostedCheckoutUrlPath,
      this.paths.databasePath,
      `${this.paths.databasePath}-shm`,
      `${this.paths.databasePath}-wal`,
    ].some((path) => existsSync(path));
  }
}

/** Durable one-shot marker claimed before the first authenticated verification. */
export class FilePosterPrepaidSandboxVerificationClaim {
  constructor(private readonly paths: PosterPrepaidSandboxE2ePaths) {}

  claim(): void {
    writePrivateJson(this.paths.verificationAttemptPath, {
      lifecycle: "poster_prepaid_sandbox_e2e",
      verificationLimit: 1,
    });
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Poster prepaid sandbox ${label} is invalid`);
  }
  return value.trim();
}

function requireFingerprint(value: unknown): string {
  const fingerprint = requireString(value, "preparation fingerprint");
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new Error("Poster prepaid sandbox preparation fingerprint is invalid");
  }
  return fingerprint;
}

function requireIsoTimestamp(value: unknown): string {
  const timestamp = requireString(value, "menu timestamp");
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error("Poster prepaid sandbox menu timestamp is invalid");
  }
  return timestamp;
}
