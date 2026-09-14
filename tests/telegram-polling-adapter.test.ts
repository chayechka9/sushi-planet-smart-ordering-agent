import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AIConversationLayerService,
  type AIConversationInterpreter,
} from "../src/application/ai-conversation-layer.js";
import { LocalConversationAgentService } from "../src/application/local-conversation-agent.js";
import { createOrder } from "../src/domain/order.js";
import type {
  TelegramApiTransport,
  TelegramGetUpdatesInput,
  TelegramSendMessageInput,
  TelegramUpdateEnvelope,
} from "../src/integrations/telegram/api-transport.js";
import { TelegramLongPollingAdapter } from "../src/integrations/telegram/polling-adapter.js";
import { SqliteConversationStateStore } from "../src/storage/sqlite/conversation-state-store.js";

const fixedNow = new Date("2026-09-14T12:00:00.000Z");
const temporaryDirectories: string[] = [];
const stores: SqliteConversationStateStore[] = [];
let globalFetch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  globalFetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Network access is forbidden in Telegram tests"));
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  globalFetch.mockRestore();
  for (const store of stores.splice(0).reverse()) store.close();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeTelegramTransport implements TelegramApiTransport {
  readonly getUpdates = vi.fn(
    async (_input: TelegramGetUpdatesInput) =>
      this.batches.shift() ?? ([] as readonly TelegramUpdateEnvelope[]),
  );
  readonly sendMessage = vi.fn(async (_input: TelegramSendMessageInput) => {
    if (this.failSend) throw new Error("synthetic send failure");
  });
  failSend = false;

  constructor(
    private readonly batches: TelegramUpdateEnvelope[][],
  ) {}
}

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "sushi-planet-telegram-"));
  temporaryDirectories.push(directory);
  return join(directory, "conversation.sqlite");
}

function privateTextUpdate(overrides: {
  updateId?: number;
  messageId?: number;
  chatId?: number;
  userId?: number;
  text?: string;
} = {}): TelegramUpdateEnvelope {
  const updateId = overrides.updateId ?? 100;
  return {
    updateId,
    payload: {
      update_id: updateId,
      message: {
        message_id: overrides.messageId ?? 10,
        from: { id: overrides.userId ?? 501, is_bot: false },
        chat: { id: overrides.chatId ?? 501, type: "private" },
        text: overrides.text ?? "покажи меню",
      },
    },
  };
}

function createHarness(
  transport: FakeTelegramTransport,
  databasePath = createDatabasePath(),
): {
  adapter: TelegramLongPollingAdapter;
  store: SqliteConversationStateStore;
  interpreter: AIConversationInterpreter;
} {
  const store = new SqliteConversationStateStore(databasePath);
  stores.push(store);
  const interpreter: AIConversationInterpreter = {
    interpret: vi.fn(async () => ({
      kind: "command" as const,
      command: { type: "show_menu" as const },
    })),
  };
  const conversationAgent = new LocalConversationAgentService({
    stateStore: store,
    menuProvider: {
      getMenuSnapshot: () => [
        {
          id: "synthetic-roll",
          name: "Synthetic Roll",
          unitPriceCents: 1_250,
          available: true,
        },
      ],
    },
    deliveryFeePolicy: { getDeliveryFeeCents: () => 350 },
    checkoutFlow: {
      prepareCheckoutLink: vi.fn(async ({ order }) => ({
        orderId: order.id,
        checkoutId: "synthetic-checkout",
        checkoutReference: "synthetic-reference",
        checkoutLink: "https://checkout.invalid/synthetic",
      })),
    },
    checkoutMerchant: {
      merchantCode: "synthetic-merchant",
      country: "IE",
      defaultCurrency: "EUR",
      sandbox: true,
    },
    createOrder: () =>
      createOrder({
        createId: () => "ord_telegram_synthetic",
        now: () => fixedNow,
      }),
    now: () => fixedNow,
  });
  const conversation = new AIConversationLayerService({
    interpreter,
    conversationAgent,
    stateStore: store,
  });
  return {
    adapter: new TelegramLongPollingAdapter({
      transport,
      conversation,
      stateStore: store,
    }),
    store,
    interpreter,
  };
}

describe("Telegram long-polling adapter", () => {
  it("handles a private text message through the existing conversation core", async () => {
    const transport = new FakeTelegramTransport([[privateTextUpdate()]]);
    const harness = createHarness(transport);

    await expect(harness.adapter.pollOnce()).resolves.toEqual({
      nextOffset: 101,
      outcomes: [{ updateId: 100, kind: "replied" }],
    });

    expect(transport.getUpdates).toHaveBeenCalledWith({ timeoutSeconds: 25 });
    expect(transport.sendMessage).toHaveBeenCalledWith({
      chatId: 501,
      text: "Меню:\n• Synthetic Roll — €12.50",
    });
    expect(harness.interpreter.interpret).toHaveBeenCalledOnce();
    expect(
      harness.store.findByConversationId("telegram:chat:501"),
    ).toMatchObject({
      identity: { channel: "telegram", userId: "telegram:user:501" },
      processedMessages: [{ messageId: "telegram:message:10" }],
    });
  });

  it("does not answer the same Telegram message twice", async () => {
    const update = privateTextUpdate();
    const transport = new FakeTelegramTransport([[update], [update]]);
    const harness = createHarness(transport);

    await harness.adapter.pollOnce();
    await expect(harness.adapter.pollOnce(101)).resolves.toEqual({
      nextOffset: 101,
      outcomes: [{ updateId: 100, kind: "ignored", reason: "duplicate" }],
    });

    expect(transport.sendMessage).toHaveBeenCalledOnce();
    expect(harness.interpreter.interpret).toHaveBeenCalledOnce();
  });

  it("uses SQLite duplicate state after a restart and sends no second reply", async () => {
    const databasePath = createDatabasePath();
    const firstTransport = new FakeTelegramTransport([[privateTextUpdate()]]);
    const first = createHarness(firstTransport, databasePath);
    await first.adapter.pollOnce();
    first.store.close();

    const restartedTransport = new FakeTelegramTransport([[privateTextUpdate()]]);
    const restarted = createHarness(restartedTransport, databasePath);
    await expect(restarted.adapter.pollOnce()).resolves.toEqual({
      nextOffset: 101,
      outcomes: [{ updateId: 100, kind: "ignored", reason: "duplicate" }],
    });

    expect(restartedTransport.sendMessage).not.toHaveBeenCalled();
    expect(restarted.interpreter.interpret).not.toHaveBeenCalled();
  });

  it("preserves the existing channel and user identity guard", async () => {
    const transport = new FakeTelegramTransport([
      [privateTextUpdate()],
      [privateTextUpdate({ updateId: 101, messageId: 11, userId: 777 })],
    ]);
    const harness = createHarness(transport);
    await harness.adapter.pollOnce();

    await expect(harness.adapter.pollOnce(101)).resolves.toEqual({
      nextOffset: 102,
      outcomes: [{ updateId: 101, kind: "processing_failed" }],
    });
    expect(transport.sendMessage).toHaveBeenCalledOnce();
    expect(harness.interpreter.interpret).toHaveBeenCalledOnce();
    expect(
      harness.store.findByConversationId("telegram:chat:501")?.identity,
    ).toEqual({ channel: "telegram", userId: "telegram:user:501" });
  });

  it("ignores non-text and non-private updates", async () => {
    const transport = new FakeTelegramTransport([
      [
        {
          updateId: 200,
          payload: {
            update_id: 200,
            message: {
              message_id: 20,
              from: { id: 501 },
              chat: { id: 501, type: "private" },
              photo: [{ file_id: "synthetic" }],
            },
          },
        },
        {
          updateId: 201,
          payload: {
            update_id: 201,
            message: {
              message_id: 21,
              from: { id: 501 },
              chat: { id: -900, type: "group" },
              text: "покажи меню",
            },
          },
        },
        { updateId: 202, payload: { update_id: 202, callback_query: {} } },
      ],
    ]);
    const conversation = { handle: vi.fn() };
    const adapter = new TelegramLongPollingAdapter({
      transport,
      conversation,
      stateStore: { findByConversationId: vi.fn() },
    });

    await expect(adapter.pollOnce()).resolves.toEqual({
      nextOffset: 203,
      outcomes: [
        { updateId: 200, kind: "ignored", reason: "unsupported" },
        { updateId: 201, kind: "ignored", reason: "unsupported" },
        { updateId: 202, kind: "ignored", reason: "unsupported" },
      ],
    });
    expect(conversation.handle).not.toHaveBeenCalled();
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it("reports a send failure without retrying or leaking it to the core", async () => {
    const update = privateTextUpdate();
    const transport = new FakeTelegramTransport([[update], [update]]);
    transport.failSend = true;
    const harness = createHarness(transport);

    await expect(harness.adapter.pollOnce()).resolves.toEqual({
      nextOffset: 101,
      outcomes: [{ updateId: 100, kind: "send_failed" }],
    });
    transport.failSend = false;
    await expect(harness.adapter.pollOnce()).resolves.toEqual({
      nextOffset: 101,
      outcomes: [{ updateId: 100, kind: "ignored", reason: "duplicate" }],
    });

    expect(transport.sendMessage).toHaveBeenCalledOnce();
    expect(harness.interpreter.interpret).toHaveBeenCalledOnce();
  });
});
