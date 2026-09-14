export interface TelegramEnabledRuntimeConfig {
  enabled: true;
  botToken: string;
}

export type TelegramRuntimeConfig =
  | { enabled: false }
  | TelegramEnabledRuntimeConfig;

export class TelegramRuntimeConfigurationError extends Error {
  readonly code = "invalid_configuration";

  constructor() {
    super("Telegram runtime configuration is invalid");
    this.name = "TelegramRuntimeConfigurationError";
  }
}

/**
 * Checks the explicit runtime gate before reading credentials. A token alone
 * never enables Telegram network access.
 */
export function loadTelegramRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TelegramRuntimeConfig {
  const enabledSetting =
    environment.TELEGRAM_RUNTIME_ENABLED?.trim().toLowerCase() ?? "";

  if (enabledSetting === "" || enabledSetting === "false") {
    return { enabled: false };
  }
  if (enabledSetting !== "true") {
    throw new TelegramRuntimeConfigurationError();
  }

  const botToken = environment.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  if (botToken.length === 0) {
    throw new TelegramRuntimeConfigurationError();
  }

  return { enabled: true, botToken };
}
