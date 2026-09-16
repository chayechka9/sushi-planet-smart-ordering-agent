import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { LocalDeliveryFeePolicy } from "../application/local-conversation-agent.js";
import type { DeliveryAddress } from "../domain/order.js";

const TARIFF_SCHEMA_VERSION = 1;
const MAX_TARIFF_FILE_BYTES = 100_000;
const MAX_DISTRICT_LENGTH = 100;
const MAX_EIRCODE_LENGTH = 16;

export const LOCAL_DELIVERY_TARIFF_FILENAME =
  ".telegram-delivery-tariffs.json";

export type DeliveryTariffUnavailableReason =
  | "configuration_unavailable"
  | "empty_configuration"
  | "invalid_configuration"
  | "unknown_zone"
  | "ambiguous_match";

export class DeliveryTariffUnavailableError extends Error {
  constructor(readonly reason: DeliveryTariffUnavailableReason) {
    super("Delivery tariff is unavailable");
    this.name = "DeliveryTariffUnavailableError";
  }
}

interface NormalizedDeliveryTariff {
  district?: string;
  eircode?: string;
  feeCents: number;
}

interface LocalDeliveryTariffDocument {
  schemaVersion: typeof TARIFF_SCHEMA_VERSION;
  tariffs: readonly NormalizedDeliveryTariff[];
}

export function defaultLocalDeliveryTariffPath(): string {
  return resolve(process.cwd(), LOCAL_DELIVERY_TARIFF_FILENAME);
}

/**
 * Reads only a local allowlisted tariff document. It never guesses a fee:
 * exactly one normalized district/Eircode rule must match the address.
 */
export class LocalDeliveryTariffResolver implements LocalDeliveryFeePolicy {
  constructor(private readonly tariffPath: string) {}

  getDeliveryFeeCents(address: DeliveryAddress): number {
    const document = this.readDocument();
    if (document.tariffs.length === 0) {
      throw new DeliveryTariffUnavailableError("empty_configuration");
    }

    const district = normalizeDeliveryDistrict(address.city);
    const eircode = normalizeEircode(address.postalCode);
    if (district === undefined || eircode === undefined) {
      throw new DeliveryTariffUnavailableError("unknown_zone");
    }

    const matches = document.tariffs.filter(
      (tariff) =>
        (tariff.district === undefined || tariff.district === district) &&
        (tariff.eircode === undefined || tariff.eircode === eircode),
    );
    if (matches.length === 0) {
      throw new DeliveryTariffUnavailableError("unknown_zone");
    }
    if (matches.length !== 1) {
      throw new DeliveryTariffUnavailableError("ambiguous_match");
    }
    return matches[0]!.feeCents;
  }

  private readDocument(): LocalDeliveryTariffDocument {
    let raw: Buffer;
    try {
      raw = readFileSync(this.tariffPath);
    } catch {
      throw new DeliveryTariffUnavailableError("configuration_unavailable");
    }
    if (raw.byteLength === 0 || raw.byteLength > MAX_TARIFF_FILE_BYTES) {
      throw new DeliveryTariffUnavailableError("invalid_configuration");
    }
    try {
      return parseTariffDocument(raw.toString("utf8"));
    } catch (error) {
      if (error instanceof DeliveryTariffUnavailableError) throw error;
      throw new DeliveryTariffUnavailableError("invalid_configuration");
    }
  }
}

export function normalizeDeliveryDistrict(value: string): string | undefined {
  const normalized = value
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
  return isSafeNormalizedText(normalized, MAX_DISTRICT_LENGTH)
    ? normalized
    : undefined;
}

export function normalizeEircode(value: string): string | undefined {
  const normalized = value
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, "")
    .toUpperCase();
  return isSafeNormalizedText(normalized, MAX_EIRCODE_LENGTH) &&
    /^[A-Z0-9]+$/u.test(normalized)
    ? normalized
    : undefined;
}

function parseTariffDocument(raw: string): LocalDeliveryTariffDocument {
  const record = asExactRecord(JSON.parse(raw) as unknown, [
    "schemaVersion",
    "tariffs",
  ]);
  if (record.schemaVersion !== TARIFF_SCHEMA_VERSION) {
    throw new Error("Unsupported delivery tariff schema");
  }
  if (!Array.isArray(record.tariffs)) {
    throw new Error("Invalid delivery tariff table");
  }

  return {
    schemaVersion: TARIFF_SCHEMA_VERSION,
    tariffs: record.tariffs.map(parseTariff),
  };
}

function parseTariff(value: unknown): NormalizedDeliveryTariff {
  if (!isRecord(value)) throw new Error("Invalid delivery tariff entry");
  const hasDistrict = Object.hasOwn(value, "district");
  const hasEircode = Object.hasOwn(value, "eircode");
  if (!hasDistrict && !hasEircode) {
    throw new Error("Delivery tariff must identify a zone");
  }
  const expectedKeys = [
    ...(hasDistrict ? ["district"] : []),
    ...(hasEircode ? ["eircode"] : []),
    "feeCents",
  ];
  const record = asExactRecord(value, expectedKeys);
  const district = hasDistrict
    ? normalizeConfiguredDistrict(record.district)
    : undefined;
  const eircode = hasEircode
    ? normalizeConfiguredEircode(record.eircode)
    : undefined;
  if (
    !Number.isSafeInteger(record.feeCents) ||
    (record.feeCents as number) < 0
  ) {
    throw new Error("Invalid delivery tariff fee");
  }
  return {
    ...(district === undefined ? {} : { district }),
    ...(eircode === undefined ? {} : { eircode }),
    feeCents: record.feeCents as number,
  };
}

function normalizeConfiguredDistrict(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid delivery tariff district");
  }
  const normalized = normalizeDeliveryDistrict(value);
  if (normalized === undefined) {
    throw new Error("Invalid delivery tariff district");
  }
  return normalized;
}

function normalizeConfiguredEircode(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid delivery tariff Eircode");
  }
  const normalized = normalizeEircode(value);
  if (normalized === undefined) {
    throw new Error("Invalid delivery tariff Eircode");
  }
  return normalized;
}

function asExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid delivery tariff object");
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error("Unexpected delivery tariff fields");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNormalizedText(value: string, maximumLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
