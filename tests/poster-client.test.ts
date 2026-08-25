import { describe, expect, it, vi } from "vitest";

import { PosterClient } from "../src/integrations/poster/client.js";

describe("PosterClient", () => {
  it("maps Poster menu prices from strings to integer cents", async () => {
    let requestedUrl: string | URL | Request | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = input;
      return Response.json({
        response: [
          {
            product_id: "5",
            product_name: "Test Roll",
            menu_category_id: "2",
            category_name: "Rolls",
            hidden: "0",
            spots: [
              { spot_id: "1", price: "1299", visible: "1" },
            ],
          },
        ],
      });
    });
    const client = new PosterClient("local-test-token", fetcher);

    await expect(client.getMenuItems()).resolves.toEqual([
      {
        id: "5",
        name: "Test Roll",
        categoryId: "2",
        categoryName: "Rolls",
        hidden: false,
        spots: [{ spotId: "1", priceCents: 1_299, visible: true }],
      },
    ]);

    expect(requestedUrl).toBeInstanceOf(URL);
    if (!(requestedUrl instanceof URL)) {
      throw new Error("Expected Poster client to request a URL");
    }
    expect(requestedUrl.pathname).toBe("/api/menu.getProducts");
  });

  it("maps safe account settings without exposing owner details", async () => {
    const client = new PosterClient(
      "local-test-token",
      vi.fn(async () =>
        Response.json({
          response: {
            COMPANY_ID: "sushi-planet-bot",
            timezones: "Europe/Dublin",
            currency: {
              currency_code_iso: "EUR",
              currency_symbol: "€",
            },
            email: "must-not-be-mapped@example.test",
          },
        }),
      ),
    );

    await expect(client.getAccountSummary()).resolves.toEqual({
      companyId: "sushi-planet-bot",
      currencyIso: "EUR",
      currencySymbol: "€",
      timezone: "Europe/Dublin",
    });
  });

  it("returns a sanitized Poster error", async () => {
    const token = "secret-token-that-must-not-appear";
    const client = new PosterClient(
      token,
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: 10, message: "Access denied" },
            request_url: `https://joinposter.com/api/menu.getProducts?token=${token}`,
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    const request = client.getMenuItems();
    await expect(request).rejects.toMatchObject({
      name: "PosterApiError",
      code: 10,
      message: "Poster request menu.getProducts failed: Access denied",
      diagnostic: {
        status: 403,
        contentType: "application/json",
        truncated: false,
      },
    });
    await expect(request).rejects.not.toThrow(token);

    try {
      await request;
    } catch (error) {
      expect(error).toMatchObject({
        diagnostic: {
          body: expect.not.stringContaining(token),
        },
      });
    }
  });

  it("preserves a bounded diagnostic for non-JSON errors", async () => {
    const client = new PosterClient(
      "local-test-token",
      vi.fn(async () =>
        new Response("upstream rejected the request", {
          status: 422,
          headers: { "Content-Type": "text/plain" },
        }),
      ),
    );

    await expect(client.getMenuItems()).rejects.toMatchObject({
      name: "PosterApiError",
      code: null,
      message: "Poster request menu.getProducts returned invalid JSON",
      diagnostic: {
        status: 422,
        contentType: "text/plain",
        body: "upstream rejected the request",
        truncated: false,
      },
    });
  });

  it("sanitizes credentials and query strings reflected in an API message", async () => {
    const token = "reflected-secret-token";
    const client = new PosterClient(
      token,
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 10,
              message:
                `Rejected https://joinposter.com/api/test?token=${token}&source=test`,
            },
          },
          { status: 403 },
        ),
      ),
    );

    const request = client.getMenuItems();
    await expect(request).rejects.toThrow(
      "Poster request menu.getProducts failed: Rejected https://joinposter.com/api/test[QUERY_REDACTED]",
    );
    await expect(request).rejects.not.toThrow(token);
    await expect(request).rejects.not.toThrow("?");
  });

  it("rejects malformed prices instead of guessing", async () => {
    const client = new PosterClient(
      "local-test-token",
      vi.fn(async () =>
        Response.json({
          response: [
            {
              product_id: "5",
              product_name: "Test Roll",
              menu_category_id: "2",
              spots: [{ spot_id: "1", price: "12.99", visible: "1" }],
            },
          ],
        }),
      ),
    );

    await expect(client.getMenuItems()).rejects.toThrow(
      "price must be a non-negative integer",
    );
  });
});
