import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ValidatedLocalMenuSnapshotProvider } from "../src/menu/local-menu-snapshot.js";
import {
  POSTER_MENU_REFRESH_CONFIRMATION,
  refreshTelegramMenuSnapshot,
} from "../src/scripts/telegram-menu-refresh.js";

const syntheticToken = "synthetic-poster-token-never-send";
const temporaryDirectories: string[] = [];
let globalFetch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  globalFetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("External network access is forbidden"));
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  globalFetch.mockRestore();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporarySnapshotPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "telegram-menu-refresh-"));
  temporaryDirectories.push(directory);
  return join(directory, ".telegram-menu-snapshot.json");
}

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    POSTER_ACCOUNT: "synthetic-test-account",
    POSTER_TOKEN: syntheticToken,
    POSTER_MENU_SPOT_ID: "synthetic-spot",
  };
}

describe("controlled Telegram menu snapshot refresh", () => {
  it("requires the exact confirmation before configuration, network or writes", async () => {
    const snapshotPath = temporarySnapshotPath();
    const fetcher = vi.fn();

    for (const argv of [
      [],
      [POSTER_MENU_REFRESH_CONFIRMATION, "unexpected"],
    ]) {
      await expect(
        refreshTelegramMenuSnapshot({
          argv,
          environment: validEnvironment(),
          snapshotPath,
          fetcher,
        }),
      ).resolves.toEqual({
        status: "error",
        errorCode: "confirmation_required",
      });
    }

    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it("requires all local settings without network or writes", async () => {
    const snapshotPath = temporarySnapshotPath();
    const fetcher = vi.fn();

    for (const environment of [
      {},
      { POSTER_ACCOUNT: "synthetic-test-account" },
      {
        POSTER_ACCOUNT: "synthetic-test-account",
        POSTER_TOKEN: syntheticToken,
      },
    ]) {
      await expect(
        refreshTelegramMenuSnapshot({
          argv: [POSTER_MENU_REFRESH_CONFIRMATION],
          environment,
          snapshotPath,
          fetcher,
        }),
      ).resolves.toEqual({
        status: "error",
        errorCode: "invalid_configuration",
      });
    }

    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it("stores only a normalized selected-spot snapshot after two read-only GETs", async () => {
    const snapshotPath = temporarySnapshotPath();
    const requestedPaths: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (!(input instanceof URL)) throw new Error("Expected URL input");
      requestedPaths.push(input.pathname);
      if (input.pathname.endsWith("settings.getAllSettings")) {
        return Response.json({
          response: {
            COMPANY_ID: "synthetic-test-account",
            timezones: "Europe/Dublin",
            currency: {
              currency_code_iso: "EUR",
              currency_symbol: "€",
            },
          },
        });
      }
      return Response.json({
        response: [
          {
            product_id: "synthetic-fixture-item",
            product_name: "Synthetic Fixture Item",
            menu_category_id: "synthetic-category",
            category_name: "Synthetic Category",
            hidden: "0",
            spots: [
              { spot_id: "other-spot", price: "999", visible: "1" },
              { spot_id: "synthetic-spot", price: "123", visible: "1" },
            ],
            raw_forbidden_field: "must not persist",
          },
        ],
      });
    });

    await expect(
      refreshTelegramMenuSnapshot({
        argv: [POSTER_MENU_REFRESH_CONFIRMATION],
        environment: validEnvironment(),
        snapshotPath,
        fetcher,
        now: () => new Date("2026-09-14T12:00:00.000Z"),
      }),
    ).resolves.toEqual({ status: "success", itemCount: 1 });

    expect(requestedPaths).toEqual([
      "/api/settings.getAllSettings",
      "/api/menu.getProducts",
    ]);
    expect(
      new ValidatedLocalMenuSnapshotProvider(snapshotPath).getMenuSnapshot(),
    ).toEqual([
      {
        id: "synthetic-fixture-item",
        name: "Synthetic Fixture Item",
        unitPriceCents: 123,
        available: true,
      },
    ]);
    const persisted = readFileSync(snapshotPath, "utf8");
    expect(persisted).not.toContain("raw_forbidden_field");
    expect(persisted).not.toContain("Synthetic Category");
    expect(persisted).not.toContain(syntheticToken);
  });

  it("does not replace a snapshot when the confirmed refresh is invalid", async () => {
    const snapshotPath = temporarySnapshotPath();
    const previous = "previous-local-snapshot";
    const client = {
      getAccountSummary: vi.fn(async () => ({
        companyId: "synthetic-test-account",
        currencyIso: "EUR",
        currencySymbol: "€",
        timezone: "Europe/Dublin",
      })),
      getMenuItems: vi.fn(async () => []),
    };
    writeFileSync(snapshotPath, previous, "utf8");

    await expect(
      refreshTelegramMenuSnapshot({
        argv: [POSTER_MENU_REFRESH_CONFIRMATION],
        environment: validEnvironment(),
        snapshotPath,
        client,
      }),
    ).resolves.toEqual({ status: "error", errorCode: "refresh_failed" });

    expect(readFileSync(snapshotPath, "utf8")).toBe(previous);
  });

  it("keeps the refresh CLI separate from polling and the health server", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    const wrapper = readFileSync(
      new URL("../src/scripts/run-telegram-menu-refresh.ts", import.meta.url),
      "utf8",
    );
    const server = readFileSync(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    );
    const gitignore = readFileSync(
      new URL("../.gitignore", import.meta.url),
      "utf8",
    );

    expect(packageJson.scripts["telegram:menu:refresh"]).toBe(
      "tsx src/scripts/run-telegram-menu-refresh.ts",
    );
    expect(wrapper).toContain('import "dotenv/config";');
    expect(wrapper).toContain("refreshTelegramMenuSnapshot");
    expect(gitignore).toContain("/.telegram-menu-snapshot.json");
    expect(server.toLowerCase()).not.toContain("telegram");
    expect(server.toLowerCase()).not.toContain("poster");
  });
});
