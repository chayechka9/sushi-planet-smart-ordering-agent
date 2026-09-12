import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  OpenAIConversationResponseRequest,
} from "../src/integrations/openai/conversation-interpreter.js";
import {
  OpenAIResponsesHttpTransport,
  OpenAIResponsesTransportError,
  type OpenAIResponsesFetch,
} from "../src/integrations/openai/responses-http-transport.js";

const syntheticApiKey = "synthetic-openai-key-never-send";

const request: OpenAIConversationResponseRequest = {
  model: "gpt-5.6-luna",
  store: false,
  reasoning: { effort: "high" },
  instructions: "Return only the allowed structured command.",
  input: JSON.stringify({
    context: {
      conversationId: "synthetic-conversation",
      identity: { channel: "synthetic", userId: "synthetic-user" },
      conversation: {
        status: "new",
        cart: [],
        fulfilment: null,
        customerFields: {
          firstName: false,
          lastName: false,
          phone: false,
          deliveryAddress: false,
        },
        checkoutCreated: false,
      },
    },
    text: "покажи меню",
  }),
  text: {
    format: {
      type: "json_schema",
      name: "conversation_interpretation",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { kind: { type: "string" } },
        required: ["kind"],
      },
    },
  },
};

function responseWith(
  ok: boolean,
  payload: unknown,
  inspectJson?: () => void,
): Response {
  return {
    ok,
    async json() {
      inspectJson?.();
      return payload;
    },
  } as Response;
}

async function captureError(
  promise: Promise<unknown>,
): Promise<OpenAIResponsesTransportError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenAIResponsesTransportError);
    return error as OpenAIResponsesTransportError;
  }
  throw new Error("Expected transport to reject");
}

describe("OpenAIResponsesHttpTransport", () => {
  let globalFetch: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("real global fetch is forbidden"));
  });

  afterEach(() => {
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it("sends the complete request once to the exact Responses endpoint", async () => {
    const providerPayload = {
      id: "synthetic-response",
      output_text: '{"kind":"needs_clarification"}',
    };
    const fetcher = vi
      .fn<OpenAIResponsesFetch>()
      .mockResolvedValue(responseWith(true, providerPayload));
    const transport = new OpenAIResponsesHttpTransport({ fetcher });

    await expect(
      transport.createResponse(request, syntheticApiKey),
    ).resolves.toEqual(providerPayload);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${syntheticApiKey}`,
      "Content-Type": "application/json",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const body = String(init?.body);
    expect(JSON.parse(body)).toEqual(request);
    expect(JSON.parse(body)).toMatchObject({
      model: "gpt-5.6-luna",
      store: false,
      reasoning: { effort: "high" },
      instructions: request.instructions,
      input: request.input,
      text: request.text,
    });
    expect(body).not.toContain(syntheticApiKey);
  });

  it("maps non-2xx to a safe error without reading the provider body or retrying", async () => {
    const readProviderBody = vi.fn();
    const fetcher = vi
      .fn<OpenAIResponsesFetch>()
      .mockResolvedValue(
        responseWith(
          false,
          `${syntheticApiKey}: provider diagnostic`,
          readProviderBody,
        ),
      );
    const transport = new OpenAIResponsesHttpTransport({ fetcher });

    const error = await captureError(
      transport.createResponse(request, syntheticApiKey),
    );

    expect(error.code).toBe("http_error");
    expect(error.message).not.toContain(syntheticApiKey);
    expect(error.message).not.toContain("provider diagnostic");
    expect(readProviderBody).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps a network failure to a safe error without retrying", async () => {
    const fetcher = vi
      .fn<OpenAIResponsesFetch>()
      .mockRejectedValue(
        new Error(`${syntheticApiKey}: sensitive network diagnostic`),
      );
    const transport = new OpenAIResponsesHttpTransport({ fetcher });

    const error = await captureError(
      transport.createResponse(request, syntheticApiKey),
    );

    expect(error.code).toBe("network_error");
    expect(error.message).not.toContain(syntheticApiKey);
    expect(error.message).not.toContain("sensitive network diagnostic");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts and safely rejects when the bounded timeout expires", async () => {
    const fetcher = vi.fn<OpenAIResponsesFetch>().mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error(`${syntheticApiKey}: timeout diagnostic`)),
            { once: true },
          );
        }),
    );
    const transport = new OpenAIResponsesHttpTransport({
      fetcher,
      timeoutMs: 5,
    });

    const error = await captureError(
      transport.createResponse(request, syntheticApiKey),
    );

    expect(error.code).toBe("timeout");
    expect(error.message).not.toContain(syntheticApiKey);
    expect(error.message).not.toContain("timeout diagnostic");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps invalid JSON to a safe error without exposing parser details", async () => {
    const fetcher = vi
      .fn<OpenAIResponsesFetch>()
      .mockResolvedValue({
        ok: true,
        async json() {
          throw new Error(`${syntheticApiKey}: invalid provider JSON`);
        },
      } as unknown as Response);
    const transport = new OpenAIResponsesHttpTransport({ fetcher });

    const error = await captureError(
      transport.createResponse(request, syntheticApiKey),
    );

    expect(error.code).toBe("invalid_json");
    expect(error.message).not.toContain(syntheticApiKey);
    expect(error.message).not.toContain("invalid provider JSON");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing key before any fetch", async () => {
    const fetcher = vi.fn<OpenAIResponsesFetch>();
    const transport = new OpenAIResponsesHttpTransport({ fetcher });

    const error = await captureError(transport.createResponse(request, "  "));

    expect(error.code).toBe("invalid_configuration");
    expect(error.message).not.toContain(syntheticApiKey);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
