import {
  validateAIConversationInterpretation,
  type AIConversationContext,
  type AIConversationInterpreter,
  type AIConversationInterpretation,
} from "../../application/ai-conversation-layer.js";
import type {
  OpenAIConfig,
  OpenAIReasoningEffort,
} from "../../config/openai.js";

export interface OpenAIConversationResponseRequest {
  model: string;
  reasoning: {
    effort: OpenAIReasoningEffort;
  };
  instructions: string;
  input: string;
  text: {
    format: {
      type: "json_schema";
      name: "conversation_interpretation";
      strict: true;
      schema: Record<string, unknown>;
    };
  };
}

/** Injected boundary for an OpenAI Responses API client or test transport. */
export interface OpenAIConversationResponseTransport {
  createResponse(
    request: OpenAIConversationResponseRequest,
    apiKey: string,
  ): Promise<unknown>;
}

const conversationSchema: Record<string, unknown> = {
  type: "object",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "command"],
      properties: {
        kind: { const: "command" },
        command: {
          type: "object",
          additionalProperties: false,
          required: ["type"],
          properties: {
            type: {
              type: "string",
              enum: [
                "show_menu",
                "show_cart",
                "add_item",
                "remove_item",
                "set_quantity",
                "choose_pickup",
                "choose_delivery",
                "set_customer",
                "set_delivery_address",
                "review_order",
                "prepare_checkout",
                "customer_reports_payment",
              ],
            },
            menuItemId: { type: "string" },
            quantity: { type: "integer", minimum: 1 },
            firstName: { type: "string" },
            lastName: { type: "string" },
            phone: { type: "string" },
            address: {
              type: "object",
              additionalProperties: false,
              required: ["line1", "city", "postalCode"],
              properties: {
                line1: { type: "string" },
                city: { type: "string" },
                postalCode: { type: "string" },
              },
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { const: "needs_clarification" },
        reason: {
          type: "string",
          enum: ["ambiguous", "unsupported", "missing_information"],
        },
      },
    },
  ],
};

const instructions = [
  "Interpret the client message into one existing conversation command or needs_clarification.",
  "Return only the JSON schema object.",
  "Never provide or infer prices, availability, totals, delivery fees, payment or order status, or Poster fields.",
  "The deterministic conversation core is the only authority for those values and for payment success.",
].join(" ");

/**
 * Provider-specific adapter. It only builds a safe Responses request and
 * validates the returned JSON through the provider-neutral runtime allowlist.
 */
export class OpenAIConversationInterpreter
  implements AIConversationInterpreter
{
  constructor(
    private readonly config: OpenAIConfig,
    private readonly transport: OpenAIConversationResponseTransport,
  ) {}

  async interpret(
    context: AIConversationContext,
    text: string,
  ): Promise<AIConversationInterpretation> {
    const response = await this.transport.createResponse(
      {
        model: this.config.model,
        reasoning: { effort: this.config.reasoningEffort },
        instructions,
        input: JSON.stringify({ context, text }),
        text: {
          format: {
            type: "json_schema",
            name: "conversation_interpretation",
            strict: true,
            schema: conversationSchema,
          },
        },
      },
      this.config.apiKey,
    );

    const outputText = extractOutputText(response);
    if (outputText === undefined) {
      return { kind: "needs_clarification", reason: "unsupported" };
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(outputText);
    } catch {
      return { kind: "needs_clarification", reason: "unsupported" };
    }

    return (
      validateAIConversationInterpretation(decoded) ?? {
        kind: "needs_clarification",
        reason: "unsupported",
      }
    );
  }
}

function extractOutputText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.output_text === "string" && value.output_text.trim()) {
    return value.output_text;
  }

  if (!Array.isArray(value.output)) return undefined;
  const texts: string[] = [];
  for (const item of value.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (
        isRecord(content) &&
        content.type === "output_text" &&
        typeof content.text === "string" &&
        content.text.trim()
      ) {
        texts.push(content.text);
      }
    }
  }
  return texts.length === 1 ? texts[0] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
