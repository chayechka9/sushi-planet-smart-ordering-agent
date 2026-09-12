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
  store: false;
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

const commandPropertyNames = [
  "type",
  "menuItemId",
  "quantity",
  "firstName",
  "lastName",
  "phone",
  "address",
] as const;

export const openAIConversationSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "command", "reason"],
  properties: {
    kind: {
      type: "string",
      enum: ["command", "needs_clarification"],
    },
    command: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: commandPropertyNames,
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
            menuItemId: { type: ["string", "null"] },
            quantity: { type: ["integer", "null"], minimum: 1 },
            firstName: { type: ["string", "null"] },
            lastName: { type: ["string", "null"] },
            phone: { type: ["string", "null"] },
            address: {
              anyOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["line1", "city", "postalCode"],
                  properties: {
                    line1: { type: "string" },
                    city: { type: "string" },
                    postalCode: { type: "string" },
                  },
                },
                { type: "null" },
              ],
            },
          },
        },
        { type: "null" },
      ],
    },
    reason: {
      type: ["string", "null"],
      enum: ["ambiguous", "unsupported", "missing_information", null],
    },
  },
};

assertOpenAIStrictSchemaContract(openAIConversationSchema);

const instructions = [
  "Interpret the client message into one existing conversation command or needs_clarification.",
  "Return only the JSON schema object.",
  "Use null for every irrelevant command argument and for the unused command or reason branch.",
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
        store: false,
        reasoning: { effort: this.config.reasoningEffort },
        instructions,
        input: JSON.stringify({ context, text }),
        text: {
          format: {
            type: "json_schema",
            name: "conversation_interpretation",
            strict: true,
            schema: openAIConversationSchema,
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

    const normalized = normalizeStrictModelOutput(decoded);
    return (
      validateAIConversationInterpretation(normalized) ?? {
        kind: "needs_clarification",
        reason: "unsupported",
      }
    );
  }
}

export function assertOpenAIStrictSchemaContract(schema: unknown): void {
  inspectSchemaNode(schema, "$");
}

function inspectSchemaNode(value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new Error(`Structured Outputs schema node ${path} must be an object`);
  }
  if ("nullable" in value) {
    throw new Error(`Structured Outputs schema node ${path} uses nullable`);
  }

  const type = value.type;
  if (Array.isArray(type)) {
    if (
      type.length !== 2 ||
      type.filter((entry) => entry === "null").length !== 1 ||
      type.some((entry) => typeof entry !== "string")
    ) {
      throw new Error(
        `Structured Outputs schema node ${path} has invalid nullable type`,
      );
    }
    if (Array.isArray(value.enum) && !value.enum.includes(null)) {
      throw new Error(
        `Structured Outputs schema node ${path} omits null from enum`,
      );
    }
  }

  const isObjectType =
    type === "object" || (Array.isArray(type) && type.includes("object"));
  const usesObjectKeywords =
    "properties" in value ||
    "required" in value ||
    "additionalProperties" in value;
  if (usesObjectKeywords && !isObjectType) {
    throw new Error(
      `Structured Outputs object ${path} must declare object type`,
    );
  }

  if (isObjectType) {
    if (value.additionalProperties !== false) {
      throw new Error(
        `Structured Outputs object ${path} must disable additional properties`,
      );
    }
    if (!isRecord(value.properties) || !Array.isArray(value.required)) {
      throw new Error(
        `Structured Outputs object ${path} must define properties and required`,
      );
    }
    const propertyNames = Object.keys(value.properties);
    const required = value.required;
    if (
      required.some((entry) => typeof entry !== "string") ||
      new Set(required).size !== required.length ||
      propertyNames.length !== required.length ||
      propertyNames.some((property) => !required.includes(property))
    ) {
      throw new Error(
        `Structured Outputs object ${path} must require every property exactly once`,
      );
    }
    for (const [property, child] of Object.entries(value.properties)) {
      inspectSchemaNode(child, `${path}.properties.${property}`);
    }
  }

  for (const alternativeKey of ["anyOf", "oneOf", "allOf"] as const) {
    const alternatives = value[alternativeKey];
    if (alternatives === undefined) continue;
    if (!Array.isArray(alternatives) || alternatives.length === 0) {
      throw new Error(
        `Structured Outputs schema node ${path}.${alternativeKey} is invalid`,
      );
    }
    const nullAlternatives = alternatives.filter(isNullSchema);
    if (
      nullAlternatives.length > 0 &&
      (alternatives.length !== 2 || nullAlternatives.length !== 1)
    ) {
      throw new Error(
        `Structured Outputs schema node ${path}.${alternativeKey} has invalid nullable alternatives`,
      );
    }
    alternatives.forEach((alternative, index) =>
      inspectSchemaNode(alternative, `${path}.${alternativeKey}[${index}]`),
    );
  }

  if (value.items !== undefined) {
    inspectSchemaNode(value.items, `${path}.items`);
  }
}

function normalizeStrictModelOutput(value: unknown): unknown {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "command", "reason"])) {
    return undefined;
  }
  if (value.kind === "needs_clarification") {
    return value.command === null
      ? { kind: value.kind, reason: value.reason }
      : undefined;
  }
  if (
    value.kind !== "command" ||
    value.reason !== null ||
    !isRecord(value.command) ||
    !hasExactKeys(value.command, commandPropertyNames)
  ) {
    return undefined;
  }

  const command = { ...value.command };
  for (const property of commandPropertyNames) {
    if (property !== "type" && command[property] === null) {
      delete command[property];
    }
  }
  return { kind: value.kind, command };
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return (
    Object.keys(value).length === allowed.size &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isNullSchema(value: unknown): boolean {
  return isRecord(value) && value.type === "null";
}

function extractOutputText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.output_text === "string" && value.output_text.trim()) {
    return value.output_text;
  }

  if (!Array.isArray(value.output)) return undefined;
  const texts: string[] = [];
  for (const item of value.output) {
    if (
      !isRecord(item) ||
      item.type !== "message" ||
      !Array.isArray(item.content)
    ) {
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
