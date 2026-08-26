import { readFileSync, writeFileSync } from "node:fs";

import type { SumUpMerchantSummary } from "../integrations/sumup/client.js";

export interface SumUpE2eLocalState {
  orderId: string;
  checkoutId: string;
  checkoutReference: string;
  merchantCode: string;
  amountCents: number;
  currency: "EUR";
  hostedCheckoutUrl: string;
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
  writeFileSync(path, JSON.stringify(value), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
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

export function readSumUpE2eLocalState(path: string): SumUpE2eLocalState {
  const record = readPrivateRecord(path, "sandbox E2E state");
  const currency = requireString(record.currency, "state currency");
  if (currency !== "EUR") {
    throw new Error("Sandbox E2E state currency must be EUR");
  }

  const amountCents = record.amountCents;
  if (!Number.isSafeInteger(amountCents) || Number(amountCents) < 1) {
    throw new Error("Sandbox E2E state amount must be positive integer cents");
  }

  return {
    orderId: requireString(record.orderId, "state order ID"),
    checkoutId: requireString(record.checkoutId, "state checkout ID"),
    checkoutReference: requireString(
      record.checkoutReference,
      "state checkout reference",
    ),
    merchantCode: requireString(record.merchantCode, "state merchant code"),
    amountCents: Number(amountCents),
    currency,
    hostedCheckoutUrl: requireHttpsUrl(
      record.hostedCheckoutUrl,
      "state hosted checkout URL",
    ),
  };
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

function requireHttpsUrl(value: unknown, label: string): string {
  const exact = requireString(value, label);
  let url: URL;
  try {
    url = new URL(exact);
  } catch {
    throw new Error(`Local ${label} must be valid HTTPS`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Local ${label} must use HTTPS`);
  }
  return url.href;
}
