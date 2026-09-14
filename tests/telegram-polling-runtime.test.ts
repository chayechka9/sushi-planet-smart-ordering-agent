import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { createTelegramPollingRuntime } from "../src/composition/telegram-polling-runtime.js";
import { TelegramRuntimeConfigurationError } from "../src/config/telegram.js";
import type { TelegramApiTransport } from "../src/integrations/telegram/api-transport.js";

const syntheticToken = "synthetic-runtime-token-never-send";
let globalFetch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  globalFetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Real Telegram network access is forbidden"));
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  globalFetch.mockRestore();
});

function dependencies() {
  return {
    conversation: { handle: vi.fn() },
    stateStore: { findByConversationId: vi.fn() },
  };
}

function fakeTransport(): TelegramApiTransport {
  return {
    getUpdates: vi.fn(async () => []),
    sendMessage: vi.fn(async () => undefined),
  };
}

describe("Telegram polling runtime composition", () => {
  it("is disabled by default and a token alone cannot enable it", () => {
    expect(
      createTelegramPollingRuntime(dependencies(), { environment: {} }),
    ).toEqual({ enabled: false });
    expect(
      createTelegramPollingRuntime(dependencies(), {
        environment: { TELEGRAM_BOT_TOKEN: syntheticToken },
      }),
    ).toEqual({ enabled: false });
  });

  it("returns a safe configuration error when enabled without a token", () => {
    let caught: unknown;
    try {
      createTelegramPollingRuntime(dependencies(), {
        environment: { TELEGRAM_RUNTIME_ENABLED: "true" },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TelegramRuntimeConfigurationError);
    expect(caught).toMatchObject({ code: "invalid_configuration" });
    expect(String(caught)).not.toContain("TELEGRAM_BOT_TOKEN");
  });

  it("composes an injected transport without starting polling", () => {
    const transport = fakeTransport();
    const runtime = createTelegramPollingRuntime(dependencies(), {
      environment: {
        TELEGRAM_RUNTIME_ENABLED: "true",
        TELEGRAM_BOT_TOKEN: syntheticToken,
      },
      transport,
    });

    expect(runtime.enabled).toBe(true);
    expect(transport.getUpdates).not.toHaveBeenCalled();
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it("leaves the ordinary server health-only without Telegram wiring", async () => {
    const serverSource = readFileSync(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    );
    expect(serverSource.toLowerCase()).not.toContain("telegram");
    expect(serverSource.toLowerCase()).not.toContain("polling");

    const app = createApp();
    await app.ready();
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
