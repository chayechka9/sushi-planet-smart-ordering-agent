import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { MenuItemSnapshot } from "../src/domain/order.js";
import {
  MAX_TELEGRAM_MENU_SNAPSHOT_AGE_MS,
  ValidatedLocalMenuSnapshotProvider,
  writeLocalMenuSnapshotAtomically,
} from "../src/menu/local-menu-snapshot.js";

const temporaryDirectories: string[] = [];
const syntheticMenu: readonly MenuItemSnapshot[] = [
  {
    id: "synthetic-fixture-item",
    name: "Synthetic Fixture Item",
    unitPriceCents: 123,
    available: true,
  },
];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporarySnapshotPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "local-menu-snapshot-"));
  temporaryDirectories.push(directory);
  return join(directory, ".telegram-menu-snapshot.json");
}

describe("ValidatedLocalMenuSnapshotProvider", () => {
  it("returns an unavailable menu when the snapshot is missing", () => {
    const snapshotPath = temporarySnapshotPath();

    expect(
      new ValidatedLocalMenuSnapshotProvider(snapshotPath).getMenuSnapshot(),
    ).toEqual([]);
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it.each(["", "not-json", "{}"])(
    "returns an unavailable menu for invalid local content %#",
    (content) => {
      const snapshotPath = temporarySnapshotPath();
      writeFileSync(snapshotPath, content, "utf8");

      expect(
        new ValidatedLocalMenuSnapshotProvider(snapshotPath).getMenuSnapshot(),
      ).toEqual([]);
    },
  );

  it("reads a valid allowlisted snapshot", () => {
    const snapshotPath = temporarySnapshotPath();
    writeLocalMenuSnapshotAtomically(
      snapshotPath,
      syntheticMenu,
      new Date("2026-09-14T12:00:00.000Z"),
    );

    expect(
      new ValidatedLocalMenuSnapshotProvider(
        snapshotPath,
        () => new Date("2026-09-14T12:00:00.000Z"),
      ).getMenuSnapshot(),
    ).toEqual(syntheticMenu);
    expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual({
      schemaVersion: 1,
      capturedAt: "2026-09-14T12:00:00.000Z",
      items: syntheticMenu,
    });
  });

  it("uses a snapshot only within its 30-minute freshness window", () => {
    const snapshotPath = temporarySnapshotPath();
    const capturedAt = new Date("2026-09-14T12:00:00.000Z");
    writeLocalMenuSnapshotAtomically(snapshotPath, syntheticMenu, capturedAt);

    const at = (offsetMs: number) =>
      new ValidatedLocalMenuSnapshotProvider(
        snapshotPath,
        () => new Date(capturedAt.getTime() + offsetMs),
      ).getMenuSnapshot();

    expect(at(0)).toEqual(syntheticMenu);
    expect(at(MAX_TELEGRAM_MENU_SNAPSHOT_AGE_MS)).toEqual(syntheticMenu);
    expect(at(MAX_TELEGRAM_MENU_SNAPSHOT_AGE_MS + 1)).toEqual([]);
    expect(at(-1)).toEqual([]);
  });

  it("rejects extra fields instead of retaining raw provider data", () => {
    const snapshotPath = temporarySnapshotPath();
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        capturedAt: "2026-09-14T12:00:00.000Z",
        items: syntheticMenu,
        rawResponse: { forbidden: true },
      }),
      "utf8",
    );

    expect(
      new ValidatedLocalMenuSnapshotProvider(snapshotPath).getMenuSnapshot(),
    ).toEqual([]);
  });

  it("preserves the previous snapshot when replacement validation fails", () => {
    const snapshotPath = temporarySnapshotPath();
    writeLocalMenuSnapshotAtomically(snapshotPath, syntheticMenu);
    const previous = readFileSync(snapshotPath, "utf8");

    expect(() => writeLocalMenuSnapshotAtomically(snapshotPath, [])).toThrow();
    expect(readFileSync(snapshotPath, "utf8")).toBe(previous);
    expect(
      readdirSync(join(snapshotPath, "..")).filter((name) =>
        name.includes(".tmp-"),
      ),
    ).toEqual([]);
  });
});
