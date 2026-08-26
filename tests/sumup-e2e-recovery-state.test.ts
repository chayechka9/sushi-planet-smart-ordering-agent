import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SumUpCheckoutVerificationError } from "../src/integrations/sumup/checkout-verifier.js";
import {
  cleanupSumUpE2eRecovery,
  ensurePrivateRecoveryDirectory,
  readSumUpE2eRecoveryState,
  resolveSumUpE2eRecoveryPaths,
  writePrivateJson,
  writeSumUpE2eRecoveryState,
  type SumUpE2eRecoveryPaths,
  type SumUpE2eRecoveryState,
} from "../src/scripts/sumup-e2e-local-state.js";
import { observeSandboxWebhookService } from "../src/scripts/sumup-e2e-webhook-observability.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createRecovery(): {
  paths: SumUpE2eRecoveryPaths;
  state: SumUpE2eRecoveryState;
} {
  const directory = mkdtempSync(join(tmpdir(), "sumup-recovery-test-"));
  temporaryDirectories.push(directory);
  const paths = resolveSumUpE2eRecoveryPaths(directory);
  ensurePrivateRecoveryDirectory(paths.directoryPath);
  return {
    paths,
    state: {
      orderId: "private-order-id",
      paymentId: "private-checkout-id",
      checkoutId: "private-checkout-id",
      checkoutReference: "private-checkout-reference",
      databasePath: paths.databasePath,
    },
  };
}

function writeRecoveryFiles(
  paths: SumUpE2eRecoveryPaths,
  state: SumUpE2eRecoveryState,
): void {
  writeSumUpE2eRecoveryState(paths.statePath, state);
  for (const path of [
    paths.databasePath,
    paths.preflightPath,
    paths.attemptMarkerPath,
    paths.hostedCheckoutUrlPath,
    `${paths.databasePath}-shm`,
    `${paths.databasePath}-wal`,
  ]) {
    writePrivateJson(path, { local: true });
  }
}

describe("SumUp sandbox E2E recovery lifecycle", () => {
  it("stores only owner-readable technical locators", () => {
    const { paths, state } = createRecovery();
    writeSumUpE2eRecoveryState(paths.statePath, {
      ...state,
      hostedCheckoutUrl: "https://private.invalid/checkout",
      apiKey: "private-api-key",
      phone: "private-phone",
      responseBody: "private-response-body",
    } as SumUpE2eRecoveryState);

    const stored = JSON.parse(readFileSync(paths.statePath, "utf8")) as object;
    expect(Object.keys(stored).sort()).toEqual([
      "checkoutId",
      "checkoutReference",
      "databasePath",
      "orderId",
      "paymentId",
    ]);
    expect(readSumUpE2eRecoveryState(paths.statePath)).toEqual(state);
    expect(statSync(paths.directoryPath).mode & 0o077).toBe(0);
    expect(statSync(paths.statePath).mode & 0o077).toBe(0);

    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("private.invalid");
    expect(serialized).not.toContain("private-api-key");
    expect(serialized).not.toContain("private-phone");
    expect(serialized).not.toContain("private-response-body");
  });

  it("preserves recovery state and SQLite after verification_failed", async () => {
    const { paths, state } = createRecovery();
    writeSumUpE2eRecoveryState(paths.statePath, state);
    writePrivateJson(paths.databasePath, { local: true });
    const records: object[] = [];
    const observed = observeSandboxWebhookService(
      {
        process: vi.fn(async () => {
          throw new SumUpCheckoutVerificationError("private-error");
        }),
      },
      (record) => records.push(record),
    );

    await expect(observed.process({ private: true })).rejects.toThrow();

    expect(records).toEqual([
      { event: "webhook_received" },
      { event: "verification_failed" },
    ]);
    expect(existsSync(paths.statePath)).toBe(true);
    expect(existsSync(paths.databasePath)).toBe(true);
  });

  it("preserves recovery state after paid until duplicate is verified", async () => {
    const { paths, state } = createRecovery();
    writeRecoveryFiles(paths, state);
    const records: object[] = [];
    const observed = observeSandboxWebhookService(
      {
        process: vi.fn(async () => ({ outcome: "paid" as const })),
      },
      (record) => records.push(record),
    );

    await expect(observed.process({ private: true })).resolves.toEqual({
      outcome: "paid",
    });

    expect(records).toEqual([
      { event: "webhook_received" },
      { event: "paid" },
    ]);
    expect(existsSync(paths.statePath)).toBe(true);
    expect(existsSync(paths.databasePath)).toBe(true);
  });

  it.each([
    { paid: false, duplicateVerified: false },
    { paid: true, duplicateVerified: false },
    { paid: false, duplicateVerified: true },
  ])("refuses automatic cleanup without paid and duplicate proof", (proof) => {
    const { paths, state } = createRecovery();
    writeRecoveryFiles(paths, state);

    expect(() =>
      cleanupSumUpE2eRecovery(paths, state, "verified", proof),
    ).toThrow("requires paid and duplicate verification");
    expect(existsSync(paths.statePath)).toBe(true);
    expect(existsSync(paths.databasePath)).toBe(true);
  });

  it("cleans exact recovery files after paid and duplicate proof", () => {
    const { paths, state } = createRecovery();
    writeRecoveryFiles(paths, state);

    const result = cleanupSumUpE2eRecovery(paths, state, "verified", {
      paid: true,
      duplicateVerified: true,
    });

    expect(result).toEqual({ cleaned: true, mode: "verified" });
    expect(existsSync(paths.statePath)).toBe(false);
    expect(existsSync(paths.databasePath)).toBe(false);
    expect(existsSync(paths.hostedCheckoutUrlPath)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it("allows a separate explicit cleanup without completion proof", () => {
    const { paths, state } = createRecovery();
    writeRecoveryFiles(paths, state);

    const result = cleanupSumUpE2eRecovery(paths, state, "explicit");

    expect(result).toEqual({ cleaned: true, mode: "explicit" });
    expect(existsSync(paths.statePath)).toBe(false);
    expect(existsSync(paths.databasePath)).toBe(false);
  });
});
