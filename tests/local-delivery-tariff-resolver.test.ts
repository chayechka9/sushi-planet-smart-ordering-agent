import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DeliveryTariffUnavailableError,
  LocalDeliveryTariffResolver,
  normalizeDeliveryDistrict,
  normalizeEircode,
} from "../src/delivery/local-delivery-tariff-resolver.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryTariffPath(document: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "local-delivery-tariffs-"));
  temporaryDirectories.push(directory);
  const tariffPath = join(directory, "tariffs.json");
  writeFileSync(tariffPath, JSON.stringify(document), "utf8");
  return tariffPath;
}

function resolverFor(tariffs: readonly unknown[]): LocalDeliveryTariffResolver {
  return new LocalDeliveryTariffResolver(
    temporaryTariffPath({ schemaVersion: 1, tariffs }),
  );
}

const address = {
  line1: "Address fixture",
  city: "District Fixture",
  postalCode: "EIR CODE FIXTURE",
};

function expectUnavailable(
  action: () => unknown,
  reason: DeliveryTariffUnavailableError["reason"],
): void {
  try {
    action();
    throw new Error("Expected delivery tariff lookup to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DeliveryTariffUnavailableError);
    expect((error as DeliveryTariffUnavailableError).reason).toBe(reason);
  }
}

describe("LocalDeliveryTariffResolver", () => {
  it("normalizes district spacing/case and Eircode spacing/case", () => {
    expect(normalizeDeliveryDistrict("  DISTRICT   Fixture  ")).toBe(
      "district fixture",
    );
    expect(normalizeEircode("  eir code fixture  ")).toBe("EIRCODEFIXTURE");
  });

  it("returns a fee only for one exact normalized district and Eircode match", () => {
    const resolver = resolverFor([
      {
        district: "  DISTRICT   FIXTURE ",
        eircode: "eircode fixture",
        feeCents: 275,
      },
    ]);

    expect(resolver.getDeliveryFeeCents(address)).toBe(275);
    expectUnavailable(
      () =>
        resolver.getDeliveryFeeCents({
          ...address,
          city: "District Fixture Extended",
        }),
      "unknown_zone",
    );
  });

  it("rejects an unknown zone", () => {
    const resolver = resolverFor([
      { district: "Other District Fixture", feeCents: 275 },
    ]);

    expectUnavailable(
      () => resolver.getDeliveryFeeCents(address),
      "unknown_zone",
    );
  });

  it("rejects an empty tariff table", () => {
    expectUnavailable(
      () => resolverFor([]).getDeliveryFeeCents(address),
      "empty_configuration",
    );
  });

  it.each([-1, 1.5, "275", Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid tariff fee %#",
    (feeCents) => {
      const resolver = resolverFor([
        { district: "District Fixture", feeCents },
      ]);

      expectUnavailable(
        () => resolver.getDeliveryFeeCents(address),
        "invalid_configuration",
      );
    },
  );

  it("rejects an address matched by more than one allowed rule", () => {
    const resolver = resolverFor([
      { district: "District Fixture", feeCents: 275 },
      { eircode: "EIR CODE FIXTURE", feeCents: 325 },
    ]);

    expectUnavailable(
      () => resolver.getDeliveryFeeCents(address),
      "ambiguous_match",
    );
  });

  it("rejects missing and malformed local configuration", () => {
    const missingDirectory = mkdtempSync(
      join(tmpdir(), "missing-local-delivery-tariffs-"),
    );
    temporaryDirectories.push(missingDirectory);
    expectUnavailable(
      () =>
        new LocalDeliveryTariffResolver(
          join(missingDirectory, "missing.json"),
        ).getDeliveryFeeCents(address),
      "configuration_unavailable",
    );

    expectUnavailable(
      () =>
        new LocalDeliveryTariffResolver(
          temporaryTariffPath({ schemaVersion: 1, tariffs: [], extra: true }),
        ).getDeliveryFeeCents(address),
      "invalid_configuration",
    );
  });
});
