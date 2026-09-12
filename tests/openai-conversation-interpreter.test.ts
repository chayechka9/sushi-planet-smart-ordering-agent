import { describe, expect, it } from "vitest";

import {
  loadOpenAIConfig,
  type OpenAIConfig,
} from "../src/config/openai.js";
import {
  OpenAIConversationInterpreter,
  type OpenAIConversationResponseRequest,
  type OpenAIConversationResponseTransport,
} from "../src/integrations/openai/conversation-interpreter.js";
import type { AIConversationContext } from "../src/application/ai-conversation-layer.js";

const context: AIConversationContext = {
  conversationId: "synthetic-conversation",
  identity: { channel: "synthetic-channel", userId: "synthetic-user" },
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
};

function config(overrides: Partial<OpenAIConfig> = {}): OpenAIConfig {
  return {
    apiKey: "synthetic-openai-key",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    ...overrides,
  };
}

function transportFor(
  response: unknown,
  inspect?: (request: OpenAIConversationResponseRequest, apiKey: string) => void,
): OpenAIConversationResponseTransport {
  return {
    async createResponse(request, apiKey) {
      inspect?.(request, apiKey);
      return response;
    },
  };
}

describe("loadOpenAIConfig", () => {
  it("uses the required key and safe default model/reasoning settings", () => {
    expect(
      loadOpenAIConfig({ OPENAI_API_KEY: "  synthetic-key  " }),
    ).toEqual({
      apiKey: "synthetic-key",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
    });
  });

  it("allows model and reasoning settings to be configured", () => {
    expect(
      loadOpenAIConfig({
        OPENAI_API_KEY: "synthetic-key",
        OPENAI_MODEL: "  gpt-test  ",
        OPENAI_REASONING_EFFORT: "medium",
      }),
    ).toMatchObject({ model: "gpt-test", reasoningEffort: "medium" });
  });

  it("rejects a missing API key without making a request", () => {
    expect(() => loadOpenAIConfig({})).toThrow("OPENAI_API_KEY is required");
  });
});

describe("OpenAIConversationInterpreter", () => {
  it("sends only safe context and text and returns a structured command", async () => {
    let capturedRequest: OpenAIConversationResponseRequest | undefined;
    let capturedKey = "";
    const interpreter = new OpenAIConversationInterpreter(
      config(),
      transportFor(
        {
          output_text: JSON.stringify({
            kind: "command",
            command: {
              type: "add_item",
              menuItemId: "synthetic-roll",
              quantity: 2,
            },
          }),
        },
        (request, apiKey) => {
          capturedRequest = request;
          capturedKey = apiKey;
        },
      ),
    );

    await expect(interpreter.interpret(context, "добавь ролл")).resolves.toEqual({
      kind: "command",
      command: {
        type: "add_item",
        menuItemId: "synthetic-roll",
        quantity: 2,
      },
    });
    expect(capturedKey).toBe("synthetic-openai-key");
    expect(capturedRequest?.model).toBe("gpt-5.6-luna");
    expect(capturedRequest?.reasoning).toEqual({ effort: "high" });
    const input = JSON.parse(capturedRequest?.input ?? "null") as {
      context: AIConversationContext;
      text: string;
    };
    expect(input).toEqual({ context, text: "добавь ролл" });
    expect(capturedRequest?.input).not.toContain("unitPriceCents");
    expect(capturedRequest?.input).not.toContain("available");
    expect(capturedRequest?.input).not.toContain("totalCents");
    expect(capturedRequest?.input).not.toContain("deliveryFeeCents");
    expect(capturedRequest?.input).not.toContain("paymentStatus");
    expect(capturedRequest?.input).not.toContain("posterOrderId");
  });

  it.each([
    "not-json",
    JSON.stringify({ kind: "unknown" }),
    JSON.stringify({
      kind: "command",
      command: {
        type: "add_item",
        menuItemId: "synthetic-roll",
        priceCents: 1250,
      },
    }),
  ])("turns malformed or unknown model output into clarification: %s", async (output) => {
    const interpreter = new OpenAIConversationInterpreter(
      config(),
      transportFor({ output_text: output }),
    );

    await expect(interpreter.interpret(context, "непонятно")).resolves.toEqual({
      kind: "needs_clarification",
      reason: "unsupported",
    });
  });

  it.each([
    "priceCents",
    "totalCents",
    "available",
    "deliveryFeeCents",
    "paymentStatus",
    "orderStatus",
    "posterOrderId",
  ])("rejects authoritative field %s from model output", async (field) => {
    const interpreter = new OpenAIConversationInterpreter(
      config(),
      transportFor({
        output_text: JSON.stringify({
          kind: "command",
          command: {
            type: "add_item",
            menuItemId: "synthetic-roll",
            [field]: field === "available" ? true : 1250,
          },
        }),
      }),
    );

    await expect(interpreter.interpret(context, "сделай заказ")).resolves.toEqual({
      kind: "needs_clarification",
      reason: "unsupported",
    });
  });
});
