import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  TelegramApiTransport,
  TelegramGetUpdatesInput,
  TelegramSendMessageInput,
  TelegramUpdateEnvelope,
} from "../src/integrations/telegram/api-transport.js";
import { DeterministicTelegramInterpreter } from "../src/integrations/telegram/deterministic-interpreter.js";
import {
  installTelegramShutdownHandlers,
  runTelegramPolling,
  TELEGRAM_POLLING_CONFIRMATION,
  type TelegramPollingRunnerEvent,
  type TelegramShutdownSignalSource,
} from "../src/scripts/telegram-polling-runner.js";
import { SqliteConversationStateStore } from "../src/storage/sqlite/conversation-state-store.js";

const syntheticToken = "synthetic-controlled-telegram-token-never-send";
const temporaryDirectories: string[] = [];
let globalFetch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  globalFetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Real Telegram network access is forbidden"));
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  globalFetch.mockRestore();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeTelegramTransport implements TelegramApiTransport {
  readonly getUpdates = vi.fn(
    async (_input: TelegramGetUpdatesInput) => this.updates,
  );
  readonly sendMessage = vi.fn(async (_input: TelegramSendMessageInput) => {
    if (this.failSend) throw new Error("synthetic send failure");
  });

  constructor(
    private readonly updates: readonly TelegramUpdateEnvelope[] = [],
    readonly failSend = false,
  ) {}
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "sushi-planet-telegram-runner-"));
  temporaryDirectories.push(directory);
  return join(directory, "conversation.sqlite");
}

function privateStartUpdate(): TelegramUpdateEnvelope {
  return {
    updateId: 700,
    payload: {
      update_id: 700,
      message: {
        message_id: 71,
        from: { id: 501, is_bot: false },
        chat: { id: 501, type: "private" },
        text: "/start",
      },
    },
  };
}

function enabledEnvironment(): NodeJS.ProcessEnv {
  return {
    TELEGRAM_RUNTIME_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: syntheticToken,
  };
}

describe("controlled Telegram polling runner", () => {
  it("requires the exact confirmation flag before any network or local state", async () => {
    const databasePath = temporaryDatabasePath();
    const controller = new AbortController();

    await expect(
      runTelegramPolling({
        argv: [],
        environment: enabledEnvironment(),
        signal: controller.signal,
        databasePath,
      }),
    ).resolves.toEqual({
      status: "error",
      errorCode: "confirmation_required",
    });
    await expect(
      runTelegramPolling({
        argv: [TELEGRAM_POLLING_CONFIRMATION, "unexpected"],
        environment: enabledEnvironment(),
        signal: controller.signal,
        databasePath,
      }),
    ).resolves.toEqual({
      status: "error",
      errorCode: "confirmation_required",
    });

    expect(existsSync(databasePath)).toBe(false);
  });

  it("requires the runtime opt-in and token without calling a transport", async () => {
    const transport = new FakeTelegramTransport();
    const controller = new AbortController();

    await expect(
      runTelegramPolling({
        argv: [TELEGRAM_POLLING_CONFIRMATION],
        environment: { TELEGRAM_BOT_TOKEN: syntheticToken },
        signal: controller.signal,
        databasePath: temporaryDatabasePath(),
        transport,
      }),
    ).resolves.toEqual({ status: "error", errorCode: "runtime_disabled" });
    await expect(
      runTelegramPolling({
        argv: [TELEGRAM_POLLING_CONFIRMATION],
        environment: { TELEGRAM_RUNTIME_ENABLED: "true" },
        signal: controller.signal,
        databasePath: temporaryDatabasePath(),
        transport,
      }),
    ).resolves.toEqual({
      status: "error",
      errorCode: "invalid_configuration",
    });

    expect(transport.getUpdates).not.toHaveBeenCalled();
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it("runs one deterministic batch and stops cleanly without OpenAI", async () => {
    const databasePath = temporaryDatabasePath();
    const transport = new FakeTelegramTransport([privateStartUpdate()]);
    const controller = new AbortController();
    const events: TelegramPollingRunnerEvent[] = [];

    const summary = await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: controller.signal,
      databasePath,
      transport,
      onEvent: (event) => {
        events.push(event);
        if (event.status === "batch") controller.abort();
      },
    });

    expect(summary).toEqual({ status: "stopped" });
    expect(events).toEqual([
      { status: "started" },
      {
        status: "batch",
        received: 1,
        replied: 1,
        ignored: 0,
        processingFailed: 0,
        sendFailed: 0,
      },
    ]);
    expect(transport.getUpdates).toHaveBeenCalledOnce();
    expect(transport.sendMessage).toHaveBeenCalledWith({
      chatId: 501,
      text: "Корзина:\nКорзина пуста.\nИтого: €0.00",
      signal: controller.signal,
    });

    const store = new SqliteConversationStateStore(databasePath, {
      readOnly: true,
    });
    try {
      expect(store.findByConversationId("telegram:chat:501")).toMatchObject({
        identity: { channel: "telegram", userId: "telegram:user:501" },
        processedMessages: [{ messageId: "telegram:message:71" }],
      });
    } finally {
      store.close();
    }

    const safeOutput = JSON.stringify([...events, summary]);
    expect(safeOutput).not.toContain(syntheticToken);
    expect(safeOutput).not.toContain("/start");
    expect(safeOutput).not.toContain("501");
  });

  it("reports send failure without retry and suppresses the same message after restart", async () => {
    const databasePath = temporaryDatabasePath();
    const firstTransport = new FakeTelegramTransport(
      [privateStartUpdate()],
      true,
    );
    const firstController = new AbortController();
    const firstEvents: TelegramPollingRunnerEvent[] = [];

    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: firstController.signal,
      databasePath,
      transport: firstTransport,
      onEvent: (event) => {
        firstEvents.push(event);
        if (event.status === "batch") firstController.abort();
      },
    });

    expect(firstTransport.sendMessage).toHaveBeenCalledOnce();
    expect(firstEvents.at(-1)).toEqual({
      status: "batch",
      received: 1,
      replied: 0,
      ignored: 0,
      processingFailed: 0,
      sendFailed: 1,
    });

    const restartedTransport = new FakeTelegramTransport([privateStartUpdate()]);
    const restartedController = new AbortController();
    const restartedEvents: TelegramPollingRunnerEvent[] = [];
    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: restartedController.signal,
      databasePath,
      transport: restartedTransport,
      onEvent: (event) => {
        restartedEvents.push(event);
        if (event.status === "batch") restartedController.abort();
      },
    });

    expect(restartedTransport.sendMessage).not.toHaveBeenCalled();
    expect(restartedEvents.at(-1)).toEqual({
      status: "batch",
      received: 1,
      replied: 0,
      ignored: 1,
      processingFailed: 0,
      sendFailed: 0,
    });
  });

  it("turns SIGINT and SIGTERM into abort and removes both handlers", () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const listeners = new Map<string, () => void>();
      const source: TelegramShutdownSignalSource = {
        once: vi.fn((name, listener) => listeners.set(name, listener)),
        off: vi.fn((name, listener) => {
          if (listeners.get(name) === listener) listeners.delete(name);
        }),
      };
      const controller = new AbortController();
      const cleanup = installTelegramShutdownHandlers(source, controller);

      listeners.get(signal)?.();
      expect(controller.signal.aborted).toBe(true);
      cleanup();
      expect(listeners.size).toBe(0);
      expect(source.off).toHaveBeenCalledTimes(2);
    }
  });

  it("keeps the CLI separate from the ordinary server", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    const wrapper = readFileSync(
      new URL("../src/scripts/run-telegram-polling.ts", import.meta.url),
      "utf8",
    );
    const server = readFileSync(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    );

    expect(packageJson.scripts["telegram:poll"]).toBe(
      "tsx src/scripts/run-telegram-polling.ts",
    );
    expect(wrapper).toContain('import "dotenv/config";');
    expect(wrapper).toContain("installTelegramShutdownHandlers");
    expect(server.toLowerCase()).not.toContain("telegram");
    expect(server.toLowerCase()).not.toContain("polling");
  });
});

describe("deterministic Telegram interpreter", () => {
  const interpreter = new DeterministicTelegramInterpreter();
  const context = {
    conversationId: "synthetic",
    identity: { channel: "telegram", userId: "synthetic" },
    conversation: {
      status: "new" as const,
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

  it("maps only bounded local commands", async () => {
    await expect(interpreter.interpret(context, " /start ")).resolves.toEqual({
      kind: "command",
      command: { type: "show_cart" },
    });
    await expect(interpreter.interpret(context, "ПОКАЖИ МЕНЮ")).resolves.toEqual({
      kind: "command",
      command: { type: "show_menu" },
    });
    await expect(interpreter.interpret(context, "создай оплату")).resolves.toEqual({
      kind: "needs_clarification",
      reason: "unsupported",
    });
  });
});
