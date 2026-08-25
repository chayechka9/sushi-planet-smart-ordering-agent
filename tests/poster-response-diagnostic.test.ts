import { describe, expect, it } from "vitest";

import {
  capturePosterResponseDiagnostic,
  createPosterResponseDiagnostic,
} from "../src/integrations/poster/response-diagnostic.js";

describe("Poster response diagnostics", () => {
  it("captures a 422 response while removing credentials, customer data, and query strings", async () => {
    const token = "secret-token-that-must-not-appear";
    const phone = "+353000000000";
    const response = new Response(
      JSON.stringify({
        error: "validation_failed",
        message: `Phone ${phone} is invalid for Poster API Test`,
        token,
        request_url:
          `https://joinposter.com/api/incomingOrders.createIncomingOrder?token=${token}&format=json`,
      }),
      {
        status: 422,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );

    const diagnostic = await capturePosterResponseDiagnostic(response, {
      sensitiveValues: [token, phone, "Poster API Test"],
    });

    expect(diagnostic).toMatchObject({
      status: 422,
      contentType: "application/json; charset=utf-8",
      truncated: false,
    });
    expect(diagnostic.body).toContain("validation_failed");
    expect(diagnostic.body).toContain("[QUERY_REDACTED]");
    expect(diagnostic.body).not.toContain(token);
    expect(diagnostic.body).not.toContain(phone);
    expect(diagnostic.body).not.toContain("Poster API Test");
    expect(diagnostic.body).not.toContain("?");
  });

  it("redacts common secret fields, bare token parameters, email, and phone", () => {
    const diagnostic = createPosterResponseDiagnostic({
      status: 400,
      contentType: "text/plain\r\nX-Unsafe: value",
      bodyText:
        'token=one-secret; {"access_token":"two-secret"} test@example.test +353871234567',
    });

    expect(diagnostic.contentType).toBe(
      "text/plain X-Unsafe: value",
    );
    expect(diagnostic.body).not.toContain("one-secret");
    expect(diagnostic.body).not.toContain("two-secret");
    expect(diagnostic.body).not.toContain("test@example.test");
    expect(diagnostic.body).not.toContain("+353871234567");
  });

  it("limits the sanitized body", () => {
    const diagnostic = createPosterResponseDiagnostic({
      status: 503,
      contentType: null,
      bodyText: "x".repeat(500),
      maxBodyChars: 80,
    });

    expect(diagnostic.contentType).toBeNull();
    expect(diagnostic.truncated).toBe(true);
    expect(diagnostic.body).toHaveLength(80);
    expect(diagnostic.body).toMatch(/…\[truncated\]$/u);
  });

  it("rejects invalid diagnostic metadata", () => {
    expect(() =>
      createPosterResponseDiagnostic({
        status: 0,
        contentType: "application/json",
        bodyText: "{}",
      }),
    ).toThrow("valid HTTP status");

    expect(() =>
      createPosterResponseDiagnostic({
        status: 422,
        contentType: "application/json",
        bodyText: "{}",
        maxBodyChars: 1,
      }),
    ).toThrow("body limit");

    expect(() =>
      createPosterResponseDiagnostic({
        status: 422,
        contentType: "application/json",
        bodyText: "{}",
        maxBodyChars: 2_001,
      }),
    ).toThrow("body limit");
  });
});
