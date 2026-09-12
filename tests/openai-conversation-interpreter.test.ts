import { describe, expect, it } from "vitest";

import {
  loadOpenAIConfig,
  type OpenAIConfig,
} from "../src/config/openai.js";
import {
  assertOpenAIStrictSchemaContract,
  OpenAIConversationInterpreter,
  openAIConversationSchema,
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

function strictCommandOutput(command: Record<string, unknown>): string {
  return JSON.stringify({
    kind: "command",
    command: {
      type: command.type,
      menuItemId: null,
      quantity: null,
      firstName: null,
      lastName: null,
      phone: null,
      address: null,
      ...command,
    },
    reason: null,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowsNull(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Array.isArray(value.type)) return value.type.includes("null");
  return (
    Array.isArray(value.anyOf) &&
    value.anyOf.some(
      (alternative) => isRecord(alternative) && alternative.type === "null",
    )
  );
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
  it("passes the recursive local strict-schema contract", () => {
    expect(() =>
      assertOpenAIStrictSchemaContract(openAIConversationSchema),
    ).not.toThrow();

    const rootProperties = openAIConversationSchema.properties;
    expect(isRecord(rootProperties)).toBe(true);
    if (!isRecord(rootProperties)) throw new Error("Expected root properties");
    const commandUnion = rootProperties.command;
    expect(isRecord(commandUnion) && Array.isArray(commandUnion.anyOf)).toBe(
      true,
    );
    if (!isRecord(commandUnion) || !Array.isArray(commandUnion.anyOf)) {
      throw new Error("Expected command union");
    }
    const commandObject = commandUnion.anyOf.find(
      (alternative) => isRecord(alternative) && alternative.type === "object",
    );
    if (!isRecord(commandObject) || !isRecord(commandObject.properties)) {
      throw new Error("Expected command object properties");
    }
    for (const property of [
      "menuItemId",
      "quantity",
      "firstName",
      "lastName",
      "phone",
      "address",
    ]) {
      expect(allowsNull(commandObject.properties[property])).toBe(true);
    }
  });

  it.each([
    {
      label: "missing required property",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: [],
      },
    },
    {
      label: "enabled additional properties",
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {},
        required: [],
      },
    },
    {
      label: "missing object type",
      schema: {
        additionalProperties: false,
        properties: {},
        required: [],
      },
    },
    {
      label: "invalid nullable type",
      schema: { type: ["string"] },
    },
  ])("rejects a local schema with $label", ({ schema }) => {
    expect(() => assertOpenAIStrictSchemaContract(schema)).toThrow();
  });

  it("sends only safe context and text and returns a structured command", async () => {
    let capturedRequest: OpenAIConversationResponseRequest | undefined;
    let capturedKey = "";
    const interpreter = new OpenAIConversationInterpreter(
      config(),
      transportFor(
        {
          output_text: strictCommandOutput({
            type: "add_item",
            menuItemId: "synthetic-roll",
            quantity: 2,
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
    expect(capturedRequest?.store).toBe(false);
    expect(capturedRequest?.reasoning).toEqual({ effort: "high" });
    expect(capturedRequest?.text.format.schema).toBe(openAIConversationSchema);
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

  it("normalizes a strict clarification envelope", async () => {
    const interpreter = new OpenAIConversationInterpreter(
      config(),
      transportFor({
        output_text: JSON.stringify({
          kind: "needs_clarification",
          command: null,
          reason: "ambiguous",
        }),
      }),
    );

    await expect(interpreter.interpret(context, "что-нибудь")).resolves.toEqual({
      kind: "needs_clarification",
      reason: "ambiguous",
    });
  });

  it.each([
    "not-json",
    JSON.stringify({ kind: "unknown" }),
    JSON.stringify({
      kind: "command",
      command: { type: "show_cart" },
    }),
    strictCommandOutput({
      type: "add_item",
      menuItemId: "synthetic-roll",
      priceCents: 1250,
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
        output_text: strictCommandOutput({
          type: "add_item",
          menuItemId: "synthetic-roll",
          [field]: field === "available" ? true : 1250,
        }),
      }),
    );

    await expect(interpreter.interpret(context, "сделай заказ")).resolves.toEqual({
      kind: "needs_clarification",
      reason: "unsupported",
    });
  });
});
