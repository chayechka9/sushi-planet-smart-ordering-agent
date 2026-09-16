import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  TelegramApiTransport,
  TelegramGetUpdatesInput,
  TelegramSendMessageInput,
  TelegramUpdateEnvelope,
} from "../src/integrations/telegram/api-transport.js";
import {
  TelegramLongPollingAdapter,
  type TelegramUpdateHandler,
} from "../src/integrations/telegram/polling-adapter.js";

let globalFetch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  globalFetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Network access is forbidden in Telegram tests"));
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  globalFetch.mockRestore();
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

  constructor(private readonly batches: TelegramUpdateEnvelope[][]) {}
}

function privateTextUpdate(updateId = 100): TelegramUpdateEnvelope {
  return {
    updateId,
    payload: {
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: 501, is_bot: false },
        chat: { id: 501, type: "private" },
        text: "/menu",
      },
    },
  };
}

function reply(updateId: number, text = "Безопасный локальный ответ") {
  return {
    updateId,
    kind: "reply" as const,
    chatId: 501,
    text,
  };
}

describe("Telegram long-polling adapter", () => {
  it("passes one received update to the handler and sends one reply", async () => {
    const update = privateTextUpdate();
    const transport = new FakeTelegramTransport([[update]]);
    const updateHandler: TelegramUpdateHandler = {
      handle: vi.fn(async () => reply(update.updateId)),
    };
    const adapter = new TelegramLongPollingAdapter({ transport, updateHandler });

    await expect(adapter.pollOnce()).resolves.toEqual({
      nextOffset: 101,
      outcomes: [{ updateId: 100, kind: "replied" }],
    });

    expect(transport.getUpdates).toHaveBeenCalledWith({ timeoutSeconds: 25 });
    expect(updateHandler.handle).toHaveBeenCalledOnce();
    expect(updateHandler.handle).toHaveBeenCalledWith(update);
    expect(transport.sendMessage).toHaveBeenCalledOnce();
    expect(transport.sendMessage).toHaveBeenCalledWith({
      chatId: 501,
      text: "Безопасный локальный ответ",
    });
  });

  it("does not send or process business logic again when the handler rejects a duplicate", async () => {
    const update = privateTextUpdate();
    const transport = new FakeTelegramTransport([[update], [update]]);
    const updateHandler: TelegramUpdateHandler = {
      handle: vi
        .fn()
        .mockResolvedValueOnce(reply(update.updateId))
        .mockResolvedValueOnce({
          updateId: update.updateId,
          kind: "ignored",
          reason: "duplicate",
        }),
    };
    const adapter = new TelegramLongPollingAdapter({ transport, updateHandler });

    await adapter.pollOnce();
    await expect(adapter.pollOnce(101)).resolves.toEqual({
      nextOffset: 101,
      outcomes: [{ updateId: 100, kind: "ignored", reason: "duplicate" }],
    });

    expect(updateHandler.handle).toHaveBeenCalledTimes(2);
    expect(transport.sendMessage).toHaveBeenCalledOnce();
  });

  it("does not send a reply for an unsupported update", async () => {
    const update = privateTextUpdate(200);
    const transport = new FakeTelegramTransport([[update]]);
    const updateHandler: TelegramUpdateHandler = {
      handle: vi.fn(async () => ({
        updateId: update.updateId,
        kind: "ignored" as const,
        reason: "unsupported" as const,
      })),
    };
    const adapter = new TelegramLongPollingAdapter({ transport, updateHandler });

    await expect(adapter.pollOnce()).resolves.toEqual({
      nextOffset: 201,
      outcomes: [{ updateId: 200, kind: "ignored", reason: "unsupported" }],
    });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects an empty handler reply and continues with the next update", async () => {
    const first = privateTextUpdate(300);
    const second = privateTextUpdate(301);
    const transport = new FakeTelegramTransport([[first, second]]);
    const updateHandler: TelegramUpdateHandler = {
      handle: vi
        .fn()
        .mockResolvedValueOnce(reply(first.updateId, "   "))
        .mockResolvedValueOnce(reply(second.updateId, "Следующий ответ")),
    };
    const adapter = new TelegramLongPollingAdapter({ transport, updateHandler });

    await expect(adapter.pollOnce()).resolves.toEqual({
      nextOffset: 302,
      outcomes: [
        { updateId: 300, kind: "processing_failed" },
        { updateId: 301, kind: "replied" },
      ],
    });
    expect(updateHandler.handle).toHaveBeenCalledTimes(2);
    expect(transport.sendMessage).toHaveBeenCalledOnce();
    expect(transport.sendMessage).toHaveBeenCalledWith({
      chatId: 501,
      text: "Следующий ответ",
    });
  });

  it("contains a handler error and continues with the next update", async () => {
    const first = privateTextUpdate(400);
    const second = privateTextUpdate(401);
    const transport = new FakeTelegramTransport([[first, second]]);
    const updateHandler: TelegramUpdateHandler = {
      handle: vi
        .fn()
        .mockRejectedValueOnce(new Error("synthetic handler failure"))
        .mockResolvedValueOnce(reply(second.updateId)),
    };
    const adapter = new TelegramLongPollingAdapter({ transport, updateHandler });

    await expect(adapter.pollOnce()).resolves.toEqual({
      nextOffset: 402,
      outcomes: [
        { updateId: 400, kind: "processing_failed" },
        { updateId: 401, kind: "replied" },
      ],
    });
    expect(updateHandler.handle).toHaveBeenCalledTimes(2);
    expect(transport.sendMessage).toHaveBeenCalledOnce();
  });

  it("reports a send failure once and does not retry a duplicate update", async () => {
    const update = privateTextUpdate(500);
    const transport = new FakeTelegramTransport([[update], [update]]);
    transport.failSend = true;
    const updateHandler: TelegramUpdateHandler = {
      handle: vi
        .fn()
        .mockResolvedValueOnce(reply(update.updateId))
        .mockResolvedValueOnce({
          updateId: update.updateId,
          kind: "ignored",
          reason: "duplicate",
        }),
    };
    const adapter = new TelegramLongPollingAdapter({ transport, updateHandler });

    await expect(adapter.pollOnce()).resolves.toEqual({
      nextOffset: 501,
      outcomes: [{ updateId: 500, kind: "send_failed" }],
    });
    transport.failSend = false;
    await expect(adapter.pollOnce(501)).resolves.toEqual({
      nextOffset: 501,
      outcomes: [{ updateId: 500, kind: "ignored", reason: "duplicate" }],
    });

    expect(transport.sendMessage).toHaveBeenCalledOnce();
  });

  it("does not send a result associated with a different update", async () => {
    const update = privateTextUpdate(600);
    const transport = new FakeTelegramTransport([[update]]);
    const updateHandler: TelegramUpdateHandler = {
      handle: vi.fn(async () => reply(999)),
    };
    const adapter = new TelegramLongPollingAdapter({ transport, updateHandler });

    await expect(adapter.pollOnce()).resolves.toEqual({
      nextOffset: 601,
      outcomes: [{ updateId: 600, kind: "processing_failed" }],
    });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });
});
