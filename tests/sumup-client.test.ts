import { describe, expect, it, vi } from "vitest";

import { SumUpClient } from "../src/integrations/sumup/client.js";

describe("SumUpClient", () => {
  it("performs one authenticated read-only Get Merchant request", async () => {
    const apiKey = "local-test-api-key";
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({
          merchant_code: "MTEST123",
          country: "IE",
          default_currency: "EUR",
          sandbox: true,
          alias: "must-not-be-mapped",
          business_profile: {
            email: "must-not-be-mapped@example.test",
            phone_number: "+353000000000",
          },
        }),
    );
    const client = new SumUpClient(apiKey, fetcher);

    await expect(client.getMerchantSummary("MTEST123")).resolves.toEqual({
      merchantCode: "MTEST123",
      country: "IE",
      defaultCurrency: "EUR",
      sandbox: true,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(input).toBeInstanceOf(URL);
    if (!(input instanceof URL)) {
      throw new Error("Expected SumUp client to request a URL");
    }
    expect(input.href).toBe(
      "https://api.sumup.com/v1/merchants/MTEST123",
    );
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${apiKey}`,
    );
  });

  it("does not expose the API key or response body in HTTP errors", async () => {
    const apiKey = "secret-that-must-not-appear";
    const client = new SumUpClient(
      apiKey,
      vi.fn(async () =>
        Response.json(
          {
            detail: `Rejected ${apiKey}`,
            email: "private@example.test",
          },
          { status: 403 },
        ),
      ),
    );

    const request = client.getMerchantSummary("MTEST123");
    await expect(request).rejects.toMatchObject({
      name: "SumUpApiError",
      status: 403,
      message: "SumUp Get Merchant failed with HTTP 403",
    });
    await expect(request).rejects.not.toThrow(apiKey);
    await expect(request).rejects.not.toThrow("private@example.test");
  });

  it("rejects a merchant mismatch without exposing either identifier", async () => {
    const client = new SumUpClient(
      "local-test-api-key",
      vi.fn(async () =>
        Response.json({
          merchant_code: "MOTHER456",
          country: "IE",
          default_currency: "EUR",
          sandbox: true,
        }),
      ),
    );

    await expect(client.getMerchantSummary("MTEST123")).rejects.toThrow(
      "returned a different merchant",
    );
  });

  it("rejects malformed sandbox metadata instead of guessing", async () => {
    const client = new SumUpClient(
      "local-test-api-key",
      vi.fn(async () =>
        Response.json({
          merchant_code: "MTEST123",
          country: "IE",
          default_currency: "EUR",
          sandbox: "true",
        }),
      ),
    );

    await expect(client.getMerchantSummary("MTEST123")).rejects.toThrow(
      "sandbox flag must be a boolean",
    );
  });
});
