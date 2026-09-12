export type OpenAIReasoningEffort = "low" | "medium" | "high";

export interface OpenAIConfig {
  apiKey: string;
  model: string;
  reasoningEffort: OpenAIReasoningEffort;
}

export function loadOpenAIConfig(
  environment: NodeJS.ProcessEnv = process.env,
): OpenAIConfig {
  const apiKey = environment.OPENAI_API_KEY?.trim() ?? "";
  const model = environment.OPENAI_MODEL?.trim() || "gpt-5.6-luna";
  const reasoningEffort =
    environment.OPENAI_REASONING_EFFORT?.trim() || "high";

  if (apiKey.length === 0) {
    throw new Error("OPENAI_API_KEY is required");
  }

  if (!isReasoningEffort(reasoningEffort)) {
    throw new Error(
      "OPENAI_REASONING_EFFORT must be low, medium, or high",
    );
  }

  return { apiKey, model, reasoningEffort };
}

function isReasoningEffort(value: string): value is OpenAIReasoningEffort {
  return value === "low" || value === "medium" || value === "high";
}
