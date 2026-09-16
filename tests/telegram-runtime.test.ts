import { existsSync, readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { preflightTelegramRuntimeConfiguration } from "../src/config/telegram-runtime-preflight.js";
import {
  TELEGRAM_POLLING_CONFIRMATION,
  type TelegramPollingRunnerOptions,
  type TelegramPollingRunnerSummary,
} from "../src/scripts/telegram-polling-runner.js";
import {
  runTelegramRuntime,
  TELEGRAM_RUNTIME_CONFIRMATION,
  type TelegramRuntimeEvent,
} from "../src/scripts/telegram-runtime.js";

const syntheticToken = "synthetic-telegram-token-never-send";
const syntheticApiKey = "synthetic-openai-key-never-send";
let globalFetch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  globalFetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("External network access is forbidden"));
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  globalFetch.mockRestore();
});

function enabledTelegramEnvironment(): NodeJS.ProcessEnv {
  return {
    TELEGRAM_RUNTIME_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: syntheticToken,
  };
}

function stoppedPollingStarter() {
  return vi.fn(
    async (
      _options: TelegramPollingRunnerOptions,
    ): Promise<TelegramPollingRunnerSummary> => ({ status: "stopped" }),
  );
}

describe("Telegram runtime configuration preflight", () => {
  it("accepts valid Telegram configuration with AI disabled by default", () => {
    expect(
      preflightTelegramRuntimeConfiguration(enabledTelegramEnvironment()),
    ).toEqual({ status: "ready", aiFallback: "disabled" });

    expect(
      preflightTelegramRuntimeConfiguration({
        ...enabledTelegramEnvironment(),
        OPENAI_API_KEY: syntheticApiKey,
      }),
    ).toEqual({ status: "ready", aiFallback: "disabled" });
  });

  it.each([
    [{}, "telegram_runtime_disabled"],
    [
      { TELEGRAM_BOT_TOKEN: syntheticToken },
      "telegram_runtime_disabled",
    ],
    [
      { TELEGRAM_RUNTIME_ENABLED: "true" },
      "telegram_configuration_invalid",
    ],
    [
      {
        TELEGRAM_RUNTIME_ENABLED: "invalid",
        TELEGRAM_BOT_TOKEN: syntheticToken,
      },
      "telegram_configuration_invalid",
    ],
  ] as const)("blocks missing or invalid Telegram config", (environment, diagnostic) => {
    expect(preflightTelegramRuntimeConfiguration(environment)).toEqual({
      status: "blocked",
      diagnostic,
    });
  });

  it.each([
    {
      ...enabledTelegramEnvironment(),
      OPENAI_RUNTIME_ENABLED: "true",
    },
    {
      ...enabledTelegramEnvironment(),
      OPENAI_RUNTIME_ENABLED: "true",
      OPENAI_API_KEY: syntheticApiKey,
      OPENAI_REASONING_EFFORT: "invalid",
    },
    {
      ...enabledTelegramEnvironment(),
      OPENAI_RUNTIME_ENABLED: "invalid",
      OPENAI_API_KEY: syntheticApiKey,
    },
  ])("blocks explicitly enabled but invalid AI config", (environment) => {
    expect(preflightTelegramRuntimeConfiguration(environment)).toEqual({
      status: "blocked",
      diagnostic: "ai_configuration_invalid",
    });
  });

  it("returns only allowlisted diagnostics without secret values", () => {
    const environment = {
      ...enabledTelegramEnvironment(),
      OPENAI_RUNTIME_ENABLED: "true",
      OPENAI_API_KEY: syntheticApiKey,
      OPENAI_REASONING_EFFORT: `invalid-${syntheticApiKey}`,
    };

    const output = JSON.stringify(
      preflightTelegramRuntimeConfiguration(environment),
    );

    expect(output).toBe(
      '{"status":"blocked","diagnostic":"ai_configuration_invalid"}',
    );
    expect(output).not.toContain(syntheticToken);
    expect(output).not.toContain(syntheticApiKey);
  });
});

describe("explicit Telegram runtime entrypoint", () => {
  it("requires the exact runtime confirmation before preflight or polling", async () => {
    const startPolling = stoppedPollingStarter();

    await expect(
      runTelegramRuntime({
        argv: [],
        environment: enabledTelegramEnvironment(),
        signal: new AbortController().signal,
        startPolling,
      }),
    ).resolves.toEqual({
      status: "error",
      errorCode: "confirmation_required",
    });

    expect(startPolling).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "telegram_runtime_disabled"],
    [
      { TELEGRAM_RUNTIME_ENABLED: "true" },
      "telegram_configuration_invalid",
    ],
    [
      {
        ...enabledTelegramEnvironment(),
        OPENAI_RUNTIME_ENABLED: "true",
      },
      "ai_configuration_invalid",
    ],
  ] as const)("does not delegate after failed preflight", async (environment, diagnosticReason) => {
    const startPolling = stoppedPollingStarter();

    await expect(
      runTelegramRuntime({
        argv: [TELEGRAM_RUNTIME_CONFIRMATION],
        environment,
        signal: new AbortController().signal,
        startPolling,
      }),
    ).resolves.toEqual({
      status: "error",
      errorCode: "preflight_failed",
      diagnosticReason,
    });

    expect(startPolling).not.toHaveBeenCalled();
  });

  it("delegates once with AI disabled unless explicitly enabled", async () => {
    const startPolling = stoppedPollingStarter();
    const events: TelegramRuntimeEvent[] = [];
    const signal = new AbortController().signal;

    await expect(
      runTelegramRuntime({
        argv: [TELEGRAM_RUNTIME_CONFIRMATION],
        environment: enabledTelegramEnvironment(),
        signal,
        startPolling,
        onEvent: (event) => {
          events.push(event);
        },
      }),
    ).resolves.toEqual({ status: "stopped" });

    expect(events).toEqual([
      { status: "preflight_ready", aiFallback: "disabled" },
    ]);
    expect(startPolling).toHaveBeenCalledOnce();
    expect(startPolling).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: [TELEGRAM_POLLING_CONFIRMATION],
        signal,
        environment: enabledTelegramEnvironment(),
      }),
    );
    expect(startPolling.mock.calls[0]?.[0]).not.toHaveProperty("aiFallback");
  });

  it("constructs but does not invoke an explicitly enabled AI interpreter", async () => {
    const startPolling = stoppedPollingStarter();
    const events: TelegramRuntimeEvent[] = [];

    await expect(
      runTelegramRuntime({
        argv: [TELEGRAM_RUNTIME_CONFIRMATION],
        environment: {
          ...enabledTelegramEnvironment(),
          OPENAI_RUNTIME_ENABLED: "true",
          OPENAI_API_KEY: syntheticApiKey,
        },
        signal: new AbortController().signal,
        startPolling,
        onEvent: (event) => {
          events.push(event);
        },
      }),
    ).resolves.toEqual({ status: "stopped" });

    expect(events).toEqual([
      { status: "preflight_ready", aiFallback: "enabled" },
    ]);
    expect(startPolling).toHaveBeenCalledOnce();
    expect(startPolling.mock.calls[0]?.[0].aiFallback?.interpreter).toEqual(
      expect.objectContaining({ interpret: expect.any(Function) }),
    );
  });

  it("keeps diagnostics and runtime output free of secret values", async () => {
    const startPolling = stoppedPollingStarter();
    const events: TelegramRuntimeEvent[] = [];
    const result = await runTelegramRuntime({
      argv: [TELEGRAM_RUNTIME_CONFIRMATION],
      environment: {
        ...enabledTelegramEnvironment(),
        OPENAI_RUNTIME_ENABLED: "true",
        OPENAI_API_KEY: syntheticApiKey,
        OPENAI_REASONING_EFFORT: `invalid-${syntheticApiKey}`,
      },
      signal: new AbortController().signal,
      startPolling,
      onEvent: (event) => {
        events.push(event);
      },
    });
    const output = JSON.stringify({ events, result });

    expect(startPolling).not.toHaveBeenCalled();
    expect(output).not.toContain(syntheticToken);
    expect(output).not.toContain(syntheticApiKey);
  });

  it("exposes one explicit command and keeps server.ts health-only", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    const wrapperPath = new URL(
      "../src/scripts/run-telegram-runtime.ts",
      import.meta.url,
    );
    const oldWrapperPath = new URL(
      "../src/scripts/run-telegram-polling.ts",
      import.meta.url,
    );
    const wrapper = readFileSync(wrapperPath, "utf8");
    const server = readFileSync(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    );

    expect(packageJson.scripts["telegram:runtime"]).toBe(
      "tsx src/scripts/run-telegram-runtime.ts",
    );
    expect(packageJson.scripts["telegram:poll"]).toBeUndefined();
    expect(existsSync(oldWrapperPath)).toBe(false);
    expect(wrapper).toContain('import "dotenv/config";');
    expect(wrapper).toContain("runTelegramRuntime");
    expect(server.toLowerCase()).not.toContain("telegram");
    expect(server.toLowerCase()).not.toContain("polling");
  });
});
