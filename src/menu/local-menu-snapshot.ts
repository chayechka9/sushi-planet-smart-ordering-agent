import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import type { LocalConversationMenuProvider } from "../application/local-conversation-agent.js";
import type { MenuItemSnapshot } from "../domain/order.js";

const SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 1_000_000;

export const LOCAL_MENU_SNAPSHOT_FILENAME = ".telegram-menu-snapshot.json";

interface LocalMenuSnapshotDocument {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  capturedAt: string;
  items: MenuItemSnapshot[];
}

export function defaultLocalMenuSnapshotPath(): string {
  return resolve(process.cwd(), LOCAL_MENU_SNAPSHOT_FILENAME);
}

/**
 * Reads only the allowlisted, normalized local snapshot shape. Missing, empty
 * and invalid files deliberately produce an unavailable (empty) menu.
 */
export class ValidatedLocalMenuSnapshotProvider
  implements LocalConversationMenuProvider
{
  constructor(private readonly snapshotPath: string) {}

  getMenuSnapshot(): readonly MenuItemSnapshot[] {
    try {
      const raw = readFileSync(this.snapshotPath);
      if (raw.byteLength === 0 || raw.byteLength > MAX_SNAPSHOT_BYTES) return [];
      return parseLocalMenuSnapshot(raw.toString("utf8")).items;
    } catch {
      return [];
    }
  }
}

export function writeLocalMenuSnapshotAtomically(
  snapshotPath: string,
  items: readonly MenuItemSnapshot[],
  capturedAt: Date = new Date(),
): void {
  const document = validateSnapshotDocument({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    capturedAt: capturedAt.toISOString(),
    items: items.map((item) => ({ ...item })),
  });
  if (document.items.length === 0) {
    throw new Error("Local menu snapshot must not be empty");
  }

  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES) {
    throw new Error("Local menu snapshot is too large");
  }

  const parentDirectory = dirname(snapshotPath);
  mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${snapshotPath}.tmp-${process.pid}-${Date.now()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, snapshotPath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

function parseLocalMenuSnapshot(raw: string): LocalMenuSnapshotDocument {
  if (raw.trim().length === 0) {
    throw new Error("Local menu snapshot must not be empty");
  }
  return validateSnapshotDocument(JSON.parse(raw) as unknown);
}

function validateSnapshotDocument(value: unknown): LocalMenuSnapshotDocument {
  const record = asExactRecord(value, ["schemaVersion", "capturedAt", "items"]);
  if (record.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Unsupported local menu snapshot schema");
  }
  if (
    typeof record.capturedAt !== "string" ||
    !isValidIsoTimestamp(record.capturedAt)
  ) {
    throw new Error("Invalid local menu snapshot timestamp");
  }
  if (!Array.isArray(record.items) || record.items.length === 0) {
    throw new Error("Local menu snapshot must contain items");
  }

  const ids = new Set<string>();
  const items = record.items.map((value) => {
    const item = asExactRecord(value, [
      "id",
      "name",
      "unitPriceCents",
      "available",
    ]);
    const id = asNormalizedText(item.id, "item ID");
    const name = asNormalizedText(item.name, "item name");
    if (ids.has(id)) throw new Error("Duplicate local menu item ID");
    ids.add(id);
    if (
      !Number.isSafeInteger(item.unitPriceCents) ||
      (item.unitPriceCents as number) < 0
    ) {
      throw new Error("Invalid local menu item price");
    }
    if (typeof item.available !== "boolean") {
      throw new Error("Invalid local menu item availability");
    }
    return {
      id,
      name,
      unitPriceCents: item.unitPriceCents as number,
      available: item.available,
    };
  });

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    capturedAt: record.capturedAt,
    items,
  };
}

function asExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid local menu snapshot object");
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error("Unexpected local menu snapshot fields");
  }
  return record;
}

function asNormalizedText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Invalid local menu ${label}`);
  }
  return value;
}

function isValidIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}
