import { describe, expect, it } from "vitest";

import { loadSumUpSandboxConfig } from "../src/config/sumup.js";

describe("loadSumUpSandboxConfig", () => {
  it("loads and trims sandbox credentials", () => {
    expect(
      loadSumUpSandboxConfig({
        SUMUP_SANDBOX_MERCHANT_CODE: "  MTEST123  ",
        SUMUP_SANDBOX_API_KEY: "  local-test-key  ",
      }),
    ).toEqual({
      merchantCode: "MTEST123",
      apiKey: "local-test-key",
    });
  });

  it("rejects a missing sandbox merchant code", () => {
    expect(() =>
      loadSumUpSandboxConfig({
        SUMUP_SANDBOX_API_KEY: "local-test-key",
      }),
    ).toThrow("SUMUP_SANDBOX_MERCHANT_CODE is required");
  });

  it("rejects a missing sandbox API key", () => {
    expect(() =>
      loadSumUpSandboxConfig({
        SUMUP_SANDBOX_MERCHANT_CODE: "MTEST123",
      }),
    ).toThrow("SUMUP_SANDBOX_API_KEY is required");
  });
});
