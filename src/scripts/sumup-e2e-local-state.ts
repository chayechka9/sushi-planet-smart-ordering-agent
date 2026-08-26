import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import type { SumUpMerchantSummary } from "../integrations/sumup/client.js";

const DEFAULT_RECOVERY_DIRECTORY = ".sumup-e2e";

export interface SumUpE2eRecoveryState {
  orderId: string;
  paymentId: string;
  checkoutId: string;
  checkoutReference: string;
  databasePath: string;
}

export interface SumUpE2eRecoveryPaths {
  directoryPath: string;
  statePath: string;
  databasePath: string;
  preflightPath: string;
  attemptMarkerPath: string;
  hostedCheckoutUrlPath: string;
}

export interface SumUpE2eCleanupProof {
  paid: boolean;
  duplicateVerified: boolean;
}

export type SumUpE2eCleanupMode = "verified" | "explicit";

export interface SumUpE2eCleanupResult {
  cleaned: true;
  mode: SumUpE2eCleanupMode;
}

export function resolveSumUpE2eRecoveryPaths(
  workingDirectory: string = process.cwd(),
): SumUpE2eRecoveryPaths {
  const directoryPath = resolve(workingDirectory, DEFAULT_RECOVERY_DIRECTORY);

  return {
    directoryPath,
    statePath: resolve(directoryPath, "recovery.json"),
    databasePath: resolve(directoryPath, "orders.sqlite"),
    preflightPath: resolve(directoryPath, "merchant-preflight.json"),
    attemptMarkerPath: resolve(directoryPath, "attempt.json"),
    hostedCheckoutUrlPath: resolve(directoryPath, "hosted-checkout.json"),
  };
}

export function ensurePrivateRecoveryDirectory(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  chmodSync(directoryPath, 0o700);
  const mode = statSync(directoryPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error("Sandbox E2E recovery directory must be owner-only");
  }
}

export function requireEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim() ?? "";
  if (value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function requireLocalPort(environment: NodeJS.ProcessEnv): number {
  const value = Number(requireEnvironmentValue(environment, "SUMUP_E2E_PORT"));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("SUMUP_E2E_PORT must be a valid port");
  }
  return value;
}

export function writePrivateJson(path: string, value: unknown): void {
  if (!existsSync(dirname(path))) {
    throw new Error("Private sandbox E2E directory is unavailable");
  }
  writeFileSync(path, JSON.stringify(value), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error("Private sandbox E2E file must be owner-only");
  }
}

export function writeSumUpE2eRecoveryState(
  path: string,
  state: SumUpE2eRecoveryState,
): void {
  writePrivateJson(path, {
    orderId: requireString(state.orderId, "state order ID"),
    paymentId: requireString(state.paymentId, "state payment ID"),
    checkoutId: requireString(state.checkoutId, "state checkout ID"),
    checkoutReference: requireString(
      state.checkoutReference,
      "state checkout reference",
    ),
    databasePath: requireString(state.databasePath, "state database path"),
  });
}

export function readMerchantPreflight(path: string): SumUpMerchantSummary {
  const record = readPrivateRecord(path, "merchant preflight");
  return {
    merchantCode: requireString(record.merchantCode, "merchant code"),
    country: requireString(record.country, "merchant country"),
    defaultCurrency: requireString(
      record.defaultCurrency,
      "merchant currency",
    ),
    sandbox: requireBoolean(record.sandbox, "merchant sandbox flag"),
  };
}

export function readSumUpE2eRecoveryState(
  path: string,
): SumUpE2eRecoveryState {
  const record = readPrivateRecord(path, "sandbox E2E recovery state");
  const allowedKeys = new Set([
    "orderId",
    "paymentId",
    "checkoutId",
    "checkoutReference",
    "databasePath",
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error("Sandbox E2E recovery state contains unsupported fields");
  }

  const checkoutId = requireString(record.checkoutId, "state checkout ID");
  const paymentId = requireString(record.paymentId, "state payment ID");
  if (paymentId !== checkoutId) {
    throw new Error("Sandbox E2E payment locator does not match checkout");
  }

  return {
    orderId: requireString(record.orderId, "state order ID"),
    paymentId,
    checkoutId,
    checkoutReference: requireString(
      record.checkoutReference,
      "state checkout reference",
    ),
    databasePath: requireString(record.databasePath, "state database path"),
  };
}

export function cleanupSumUpE2eRecovery(
  paths: SumUpE2eRecoveryPaths,
  state: SumUpE2eRecoveryState | undefined,
  mode: SumUpE2eCleanupMode,
  proof: SumUpE2eCleanupProof = { paid: false, duplicateVerified: false },
): SumUpE2eCleanupResult {
  if (state !== undefined && state.databasePath !== paths.databasePath) {
    throw new Error("Sandbox E2E recovery database path does not match");
  }
  if (
    mode === "verified" &&
    (state === undefined || !proof.paid || !proof.duplicateVerified)
  ) {
    throw new Error(
      "Sandbox E2E automatic cleanup requires paid and duplicate verification",
    );
  }
  const databasePath = state?.databasePath ?? paths.databasePath;

  for (const path of [
    paths.hostedCheckoutUrlPath,
    paths.preflightPath,
    paths.attemptMarkerPath,
    `${databasePath}-shm`,
    `${databasePath}-wal`,
    databasePath,
    paths.statePath,
  ]) {
    removeExactFile(path);
  }

  return { cleaned: true, mode };
}

function readPrivateRecord(path: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`Local ${label} is unavailable or invalid`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Local ${label} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Local ${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Local ${label} must be a boolean`);
  }
  return value;
}

function removeExactFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const entry = lstatSync(path);
  if (!entry.isFile()) {
    throw new Error("Sandbox E2E cleanup target must be a regular file");
  }
  unlinkSync(path);
}
