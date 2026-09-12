export type OpenAIReasoningEffort = "low" | "medium" | "high";

export interface OpenAIConfig {
  apiKey: string;
  model: string;
  reasoningEffort: OpenAIReasoningEffort;
}

export type OpenAIRuntimeConfig =
  | { enabled: false }
  | { enabled: true; openAI: OpenAIConfig };

export class OpenAIRuntimeConfigurationError extends Error {
  readonly code = "invalid_configuration";

  constructor() {
    super("OpenAI conversation runtime configuration is invalid");
    this.name = "OpenAIRuntimeConfigurationError";
  }
}

/**
 * Loads the explicit runtime gate before credentials. A key alone never opts
 * the process into provider access.
 */
export function loadOpenAIRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): OpenAIRuntimeConfig {
  const enabledSetting =
    environment.OPENAI_RUNTIME_ENABLED?.trim().toLowerCase() ?? "";

  if (enabledSetting === "" || enabledSetting === "false") {
    return { enabled: false };
  }
  if (enabledSetting !== "true") {
    throw new OpenAIRuntimeConfigurationError();
  }

  try {
    return { enabled: true, openAI: loadOpenAIConfig(environment) };
  } catch {
    throw new OpenAIRuntimeConfigurationError();
  }
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
