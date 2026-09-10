import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { POSTER_CREATE_INCOMING_ORDER_ENDPOINT } from "../src/integrations/poster/dry-run.js";
import {
  PosterClientSandboxOrderLookup,
  PosterSandboxInspectionError,
  PosterSandboxInspector,
  type PosterSandboxOrderSnapshot,
  type PosterSandboxReadOnlyOrderLookup,
} from "../src/integrations/poster/sandbox-inspector.js";
import {
  InjectedPosterSandboxSubmitter,
  PosterSandboxHttpPostTransport,
  PosterSandboxSubmissionUncertainError,
  PosterSandboxTransportDisabledError,
  PosterSandboxTransportError,
  type PosterSandboxPostTransport,
} from "../src/integrations/poster/sandbox-submitter.js";
import type { PosterOrderSubmission } from "../src/integrations/poster/submitter.js";

const orderId = "ord_poster_sandbox_local_001";
const correlationId = `poster-handoff:${orderId}`;
const payloadFingerprint = "a".repeat(64);
const secretToken = "poster-token-must-not-escape";
const privateBody = "private-response-body-must-not-escape";
const syntheticPhone = "+353000000000";
const syntheticFirstName = "Poster Sandbox Test";

function createSubmission(): PosterOrderSubmission {
  return {
    correlationId,
    payloadFingerprint,
    payload: {
      spot_id: 1,
      first_name: syntheticFirstName,
      last_name: "Synthetic",
      phone: syntheticPhone,
      comment: correlationId,
      products: [{ product_id: 1, count: 1, price: 1_000 }],
      payment: { type: 1, sum: 1_000, currency: "EUR" },
    },
  };
}

function createMinimalSubmission() {
  return {
    correlationId,
    payloadFingerprint,
    payload: {
      spot_id: 1,
      phone: syntheticPhone,
      products: [{ product_id: 1, count: 1 }] as [
        { product_id: number; count: number },
      ],
    },
  };
}

function createSnapshot(
  overrides: Partial<PosterSandboxOrderSnapshot> = {},
): PosterSandboxOrderSnapshot {
  return {
    posterOrderId: "poster-sandbox-order-1",
    correlationId,
    status: 0,
    spotId: 1,
    currency: "EUR",
    amountCents: 1_000,
    products: [{ productId: 1, quantity: 1, priceCents: 1_000 }],
    paymentType: 1,
    prepaymentCents: 1_000,
    firstName: syntheticFirstName,
    lastName: "Synthetic",
    phone: syntheticPhone,
    comment: correlationId,
    ...overrides,
  };
}

describe("Poster sandbox one-shot submitter", () => {
  it("is disabled without an explicitly injected POST transport", async () => {
    const submitter = new InjectedPosterSandboxSubmitter();

    expect(submitter.isEnabled()).toBe(false);
    await expect(submitter.submitOnce(createSubmission())).rejects.toBeInstanceOf(
      PosterSandboxTransportDisabledError,
    );
  });

  it("keeps the token-aware HTTP transport disabled by default", async () => {
    const fetcher = vi.fn(async () => Response.json({ response: {} }));
    const transport = new PosterSandboxHttpPostTransport({
      token: secretToken,
      fetcher,
    });
    const submitter = new InjectedPosterSandboxSubmitter(transport);

    expect(submitter.isEnabled()).toBe(false);
    await expect(submitter.submitOnce(createSubmission())).rejects.toBeInstanceOf(
      PosterSandboxTransportDisabledError,
    );
    await expect(
      transport.post({
        method: "POST",
        endpoint: POSTER_CREATE_INCOMING_ORDER_ENDPOINT,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createSubmission().payload),
      }),
    ).rejects.toBeInstanceOf(PosterSandboxTransportDisabledError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the confirmed endpoint only when the HTTP gate is explicit", async () => {
    let requestedUrl: string | URL | Request | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = input;
      return Response.json({ response: { incoming_order_id: 1 } });
    });
    const transport = new PosterSandboxHttpPostTransport({
      token: secretToken,
      enabled: true,
      fetcher,
    });
    const submitter = new InjectedPosterSandboxSubmitter(transport);

    await expect(submitter.submitOnce(createSubmission())).resolves.toEqual({
      outcome: "submitted",
      posterOrderId: "1",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(requestedUrl).toBeInstanceOf(URL);
    if (!(requestedUrl instanceof URL)) {
      throw new Error("Expected sandbox transport to request a URL");
    }
    expect(requestedUrl.origin + requestedUrl.pathname).toBe(
      POSTER_CREATE_INCOMING_ORDER_ENDPOINT,
    );
  });

  it("sanitizes an enabled HTTP transport failure", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error(`${secretToken} ${privateBody} ${syntheticPhone}`);
    });
    const transport = new PosterSandboxHttpPostTransport({
      token: secretToken,
      enabled: true,
      fetcher,
    });

    let caught: unknown;
    try {
      await transport.post({
        method: "POST",
        endpoint: POSTER_CREATE_INCOMING_ORDER_ENDPOINT,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createSubmission().payload),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PosterSandboxTransportError);
    expect(String(caught)).not.toContain(secretToken);
    expect(String(caught)).not.toContain(privateBody);
    expect(String(caught)).not.toContain(syntheticPhone);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("submits the confirmed payload exactly once and extracts the order ID", async () => {
    const transport: PosterSandboxPostTransport = {
      isEnabled: () => true,
      post: vi.fn(async () => ({
        ok: true,
        status: 200,
        contentType: "application/json; charset=utf-8",
        bodyText: JSON.stringify({ response: { incoming_order_id: 1 } }),
      })),
    };
    const submitter = new InjectedPosterSandboxSubmitter(transport);
    const submission = createSubmission();

    await expect(submitter.submitOnce(submission)).resolves.toEqual({
      outcome: "submitted",
      posterOrderId: "1",
    });
    expect(transport.post).toHaveBeenCalledOnce();
    expect(transport.post).toHaveBeenCalledWith({
      method: "POST",
      endpoint: POSTER_CREATE_INCOMING_ORDER_ENDPOINT,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission.payload),
    });

    await expect(submitter.submitOnce(submission)).resolves.toEqual({
      outcome: "submitted",
      posterOrderId: "1",
    });
    expect(transport.post).toHaveBeenCalledOnce();

    await expect(
      submitter.submitOnce({
        ...submission,
        payloadFingerprint: "b".repeat(64),
      }),
    ).resolves.toEqual({
      outcome: "uncertain",
      diagnostic: {
        stage: "identity_mismatch",
        httpStatus: null,
        contentType: null,
      },
    });
    expect(transport.post).toHaveBeenCalledOnce();

    const differentCorrelation = `${correlationId}-different`;
    await expect(
      submitter.submitOnce({
        ...submission,
        correlationId: differentCorrelation,
        payload: { ...submission.payload, comment: differentCorrelation },
      }),
    ).resolves.toEqual({
      outcome: "uncertain",
      diagnostic: {
        stage: "identity_mismatch",
        httpStatus: null,
        contentType: null,
      },
    });
    expect(transport.post).toHaveBeenCalledOnce();
  });

  it("accepts the exact historical minimum once without adding fields", async () => {
    const transport: PosterSandboxPostTransport = {
      isEnabled: () => true,
      post: vi.fn(async () => ({
        ok: true,
        status: 200,
        contentType: "application/json",
        bodyText: JSON.stringify({ response: { incoming_order_id: 2 } }),
      })),
    };
    const submitter = new InjectedPosterSandboxSubmitter(transport);
    const submission = createMinimalSubmission();

    await expect(submitter.submitOnce(submission)).resolves.toEqual({
      outcome: "submitted",
      posterOrderId: "2",
    });
    expect(transport.post).toHaveBeenCalledOnce();
    expect(transport.post).toHaveBeenCalledWith({
      method: "POST",
      endpoint: POSTER_CREATE_INCOMING_ORDER_ENDPOINT,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission.payload),
    });

    await expect(submitter.submitOnce(submission)).resolves.toEqual({
      outcome: "submitted",
      posterOrderId: "2",
    });
    expect(transport.post).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "network failure",
      diagnostic: {
        stage: "network",
        httpStatus: null,
        contentType: null,
      },
      post: async () => {
        throw new Error(
          `${secretToken} ${privateBody} ${syntheticPhone} synthetic-card-marker`,
        );
      },
    },
    {
      name: "HTTP 422",
      diagnostic: {
        stage: "http_response",
        httpStatus: 422,
        contentType: "application/json",
      },
      post: async () => ({
        ok: false,
        status: 422,
        contentType: "application/json",
        bodyText: `${privateBody} ${secretToken}`,
      }),
    },
    {
      name: "ambiguous response",
      diagnostic: {
        stage: "response_contract",
        httpStatus: 200,
        contentType: "application/json",
      },
      post: async () => ({
        ok: true,
        status: 200,
        contentType: "application/json",
        bodyText: JSON.stringify({ response: {} }),
      }),
    },
  ])(
    "returns safe uncertain diagnostics without retry after $name",
    async ({ post, diagnostic }) => {
      const transport: PosterSandboxPostTransport = {
        isEnabled: () => true,
        post: vi.fn(post),
      };
      const submitter = new InjectedPosterSandboxSubmitter(transport);

      const first = await submitter.submitOnce(createSubmission());
      expect(first).toEqual({ outcome: "uncertain", diagnostic });
      expect(JSON.stringify(first)).not.toContain(secretToken);
      expect(JSON.stringify(first)).not.toContain(privateBody);
      expect(JSON.stringify(first)).not.toContain(syntheticPhone);
      await expect(submitter.submitOnce(createSubmission())).resolves.toEqual(
        first,
      );
      expect(transport.post).toHaveBeenCalledOnce();
    },
  );

  it("treats a non-200 success envelope as uncertain", async () => {
    const transport: PosterSandboxPostTransport = {
      isEnabled: () => true,
      post: vi.fn(async () => ({
        ok: true,
        status: 201,
        contentType: "application/json",
        bodyText: JSON.stringify({ response: { incoming_order_id: 2 } }),
      })),
    };
    const submitter = new InjectedPosterSandboxSubmitter(transport);

    await expect(submitter.submitOnce(createSubmission())).resolves.toEqual({
      outcome: "uncertain",
      diagnostic: {
        stage: "http_response",
        httpStatus: 201,
        contentType: "application/json",
      },
    });
    expect(transport.post).toHaveBeenCalledOnce();
  });

  it("maps an uncertain attempt to a safe handoff error without private diagnostics", async () => {
    const transport: PosterSandboxPostTransport = {
      isEnabled: () => true,
      post: vi.fn(async () => {
        throw new Error(
          `${secretToken} ${privateBody} ${syntheticFirstName} ${syntheticPhone}`,
        );
      }),
    };
    const submitter = new InjectedPosterSandboxSubmitter(transport);

    let caught: unknown;
    try {
      await submitter.submitOrder(createSubmission());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PosterSandboxSubmissionUncertainError);
    const diagnostic = String(caught);
    expect(diagnostic).not.toContain(secretToken);
    expect(diagnostic).not.toContain(privateBody);
    expect(diagnostic).not.toContain(syntheticFirstName);
    expect(diagnostic).not.toContain(syntheticPhone);
    expect(diagnostic).not.toContain("synthetic-card-marker");
    expect(transport.post).toHaveBeenCalledOnce();
  });
});

describe("Poster sandbox read-only inspector", () => {
  it("confirms only a fully matching normalized read result", async () => {
    const lookup: PosterSandboxReadOnlyOrderLookup = {
      findByCorrelation: vi.fn(async () => createSnapshot()),
    };
    const submission = createSubmission();
    const inspector = new PosterSandboxInspector({
      expectedOrderId: orderId,
      expectedSubmission: submission,
      expectedStatus: 0,
      expectedPosterOrderId: "poster-sandbox-order-1",
      lookup,
    });

    await expect(
      inspector.inspectSubmission(orderId, submission),
    ).resolves.toEqual({
      outcome: "confirmed",
      orderId,
      posterOrderId: "poster-sandbox-order-1",
      correlationId,
      payloadFingerprint,
    });
    expect(lookup.findByCorrelation).toHaveBeenCalledOnce();
    expect(lookup.findByCorrelation).toHaveBeenCalledWith(correlationId);
  });

  it("bridges the existing read-only client through an injected raw decoder", async () => {
    const rawRows = [{ opaque: true }];
    const client = {
      getOwnIncomingOrders: vi.fn(async () => rawRows),
    };
    const decoder = vi.fn(() => createSnapshot());
    const lookup = new PosterClientSandboxOrderLookup(client, decoder);

    await expect(lookup.findByCorrelation(correlationId)).resolves.toEqual(
      createSnapshot(),
    );
    expect(client.getOwnIncomingOrders).toHaveBeenCalledOnce();
    expect(decoder).toHaveBeenCalledWith(rawRows, correlationId);
    expect(Object.keys(client)).toEqual(["getOwnIncomingOrders"]);
  });

  it.each([
    ["Poster order ID", { posterOrderId: "poster-sandbox-order-2" }],
    ["venue", { spotId: 2 }],
    ["status", { status: 1 }],
    ["currency", { currency: "USD" }],
    ["amount", { amountCents: 999 }],
    ["product", { products: [{ productId: 3, quantity: 1, priceCents: 1_000 }] }],
    ["quantity", { products: [{ productId: 1, quantity: 2, priceCents: 1_000 }] }],
    ["price", { products: [{ productId: 1, quantity: 1, priceCents: 999 }] }],
    ["prepayment", { prepaymentCents: 999 }],
    ["extra product", {
      products: [
        { productId: 1, quantity: 1, priceCents: 1_000 },
        { productId: 3, quantity: 1, priceCents: 300 },
      ],
    }],
    ["contact", { phone: "+353000000001" }],
    ["correlation", { correlationId: "different-reference" }],
  ] satisfies ReadonlyArray<
    readonly [string, Partial<PosterSandboxOrderSnapshot>]
  >)("keeps the result unknown on a $s mismatch", async (_name, overrides) => {
    const lookup: PosterSandboxReadOnlyOrderLookup = {
      findByCorrelation: vi.fn(async () => createSnapshot(overrides)),
    };
    const submission = createSubmission();
    const inspector = new PosterSandboxInspector({
      expectedOrderId: orderId,
      expectedSubmission: submission,
      expectedStatus: 0,
      expectedPosterOrderId: "poster-sandbox-order-1",
      lookup,
    });

    await expect(
      inspector.inspectSubmission(orderId, submission),
    ).resolves.toEqual({ outcome: "unknown" });
  });

  it("sanitizes read failures and has no mutation capability", async () => {
    const lookup: PosterSandboxReadOnlyOrderLookup = {
      findByCorrelation: vi.fn(async () => {
        throw new Error(
          `${secretToken} ${privateBody} ${syntheticFirstName} ${syntheticPhone}`,
        );
      }),
    };
    const submission = createSubmission();
    const inspector = new PosterSandboxInspector({
      expectedOrderId: orderId,
      expectedSubmission: submission,
      expectedStatus: 0,
      expectedPosterOrderId: "poster-sandbox-order-1",
      lookup,
    });

    let caught: unknown;
    try {
      await inspector.inspectSubmission(orderId, submission);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PosterSandboxInspectionError);
    const diagnostic = String(caught);
    expect(diagnostic).not.toContain(secretToken);
    expect(diagnostic).not.toContain(privateBody);
    expect(diagnostic).not.toContain(syntheticFirstName);
    expect(diagnostic).not.toContain(syntheticPhone);
    expect(Object.keys(lookup)).toEqual(["findByCorrelation"]);
  });
});

describe("ordinary server bootstrap isolation", () => {
  it("does not expose or invoke Poster submitter or inspector routes", async () => {
    const app = createApp();
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/poster/orders",
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
