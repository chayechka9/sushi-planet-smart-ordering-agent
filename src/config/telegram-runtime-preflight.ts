import { loadOpenAIRuntimeConfig } from "./openai.js";
import { loadTelegramRuntimeConfig } from "./telegram.js";

export type TelegramRuntimePreflightDiagnostic =
  | "telegram_runtime_disabled"
  | "telegram_configuration_invalid"
  | "ai_configuration_invalid";

export type TelegramRuntimePreflightResult =
  | {
      status: "ready";
      aiFallback: "disabled" | "enabled";
    }
  | {
      status: "blocked";
      diagnostic: TelegramRuntimePreflightDiagnostic;
    };

/**
 * Checks only local configuration shape and presence. The result deliberately
 * contains no token, key, model, environment value or customer data.
 */
export function preflightTelegramRuntimeConfiguration(
  environment: NodeJS.ProcessEnv,
): TelegramRuntimePreflightResult {
  try {
    const telegram = loadTelegramRuntimeConfig(environment);
    if (!telegram.enabled) {
      return { status: "blocked", diagnostic: "telegram_runtime_disabled" };
    }
  } catch {
    return {
      status: "blocked",
      diagnostic: "telegram_configuration_invalid",
    };
  }

  try {
    const ai = loadOpenAIRuntimeConfig(environment);
    return {
      status: "ready",
      aiFallback: ai.enabled ? "enabled" : "disabled",
    };
  } catch {
    return { status: "blocked", diagnostic: "ai_configuration_invalid" };
  }
}
