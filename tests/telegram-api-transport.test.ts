import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TelegramApiTransportError,
  TelegramBotApiHttpTransport,
  type TelegramFetch,
} from "../src/integrations/telegram/api-transport.js";

const syntheticToken = "synthetic-telegram-token-never-send";
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

describe("Telegram Bot API HTTP transport", () => {
  it("uses injected HTTP for long polling and sending a text response", async () => {
    const fetcher = vi
      .fn<TelegramFetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: [{ update_id: 42, message: { text: "synthetic" } }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: {} }));
    const transport = new TelegramBotApiHttpTransport(
      { enabled: true, botToken: syntheticToken },
      { fetcher, requestTimeoutMs: 1_000 },
    );

    await expect(
      transport.getUpdates({ offset: 40, timeoutSeconds: 25 }),
    ).resolves.toEqual([
      {
        updateId: 42,
        payload: { update_id: 42, message: { text: "synthetic" } },
      },
    ]);
    await expect(
      transport.sendMessage({ chatId: 101, text: "Локальный ответ" }),
    ).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [updatesUrl, updatesInit] = fetcher.mock.calls[0]!;
    expect(String(updatesUrl)).toBe(
      `https://api.telegram.org/bot${syntheticToken}/getUpdates`,
    );
    expect(updatesInit).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "manual",
    });
    expect(JSON.parse(String(updatesInit?.body))).toEqual({
      timeout: 25,
      allowed_updates: ["message"],
      offset: 40,
    });

    const [sendUrl, sendInit] = fetcher.mock.calls[1]!;
    expect(String(sendUrl)).toBe(
      `https://api.telegram.org/bot${syntheticToken}/sendMessage`,
    );
    expect(JSON.parse(String(sendInit?.body))).toEqual({
      chat_id: 101,
      text: "Локальный ответ",
    });
  });

  it("returns a fixed safe error without reading a non-success body", async () => {
    const json = vi.fn();
    const fetcher = vi.fn<TelegramFetch>().mockResolvedValue({
      ok: false,
      status: 401,
      json,
    } as unknown as Response);
    const transport = new TelegramBotApiHttpTransport(
      { enabled: true, botToken: syntheticToken },
      { fetcher },
    );

    let caught: unknown;
    try {
      await transport.getUpdates({ timeoutSeconds: 25 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TelegramApiTransportError);
    expect(caught).toMatchObject({ code: "http_failure" });
    expect(String(caught)).not.toContain(syntheticToken);
    expect(json).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("classifies a bounded request timeout without retaining the raw error", async () => {
    const rawFailure = `raw timeout ${syntheticToken}`;
    const fetcher = vi.fn<TelegramFetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error(rawFailure)),
            { once: true },
          );
        }),
    );
    const transport = new TelegramBotApiHttpTransport(
      { enabled: true, botToken: syntheticToken },
      { fetcher, requestTimeoutMs: 1 },
    );

    const caught = await captureFailure(
      transport.getUpdates({ timeoutSeconds: 25 }),
    );

    expect(caught).toMatchObject({ code: "timeout" });
    expect(String(caught)).not.toContain(rawFailure);
    expect(String(caught)).not.toContain(syntheticToken);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("classifies a network failure without retaining provider details", async () => {
    const rawFailure = `raw network failure ${syntheticToken}`;
    const fetcher = vi
      .fn<TelegramFetch>()
      .mockRejectedValue(new Error(rawFailure));
    const transport = new TelegramBotApiHttpTransport(
      { enabled: true, botToken: syntheticToken },
      { fetcher },
    );

    const caught = await captureFailure(
      transport.getUpdates({ timeoutSeconds: 25 }),
    );

    expect(caught).toMatchObject({ code: "network_failure" });
    expect(String(caught)).not.toContain(rawFailure);
    expect(String(caught)).not.toContain(syntheticToken);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("classifies invalid provider JSON without retaining its exception", async () => {
    const rawFailure = `raw response failure ${syntheticToken}`;
    const fetcher = vi.fn<TelegramFetch>().mockResolvedValue({
      ok: true,
      async json() {
        throw new Error(rawFailure);
      },
    } as unknown as Response);
    const transport = new TelegramBotApiHttpTransport(
      { enabled: true, botToken: syntheticToken },
      { fetcher },
    );

    const caught = await captureFailure(
      transport.getUpdates({ timeoutSeconds: 25 }),
    );

    expect(caught).toMatchObject({ code: "invalid_response" });
    expect(String(caught)).not.toContain(rawFailure);
    expect(String(caught)).not.toContain(syntheticToken);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("classifies invalid local transport input as an internal failure", async () => {
    const fetcher = vi.fn<TelegramFetch>();
    const transport = new TelegramBotApiHttpTransport(
      { enabled: true, botToken: syntheticToken },
      { fetcher },
    );

    const caught = await captureFailure(
      transport.getUpdates({ timeoutSeconds: 51 }),
    );

    expect(caught).toMatchObject({ code: "internal_failure" });
    expect(String(caught)).not.toContain(syntheticToken);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

async function captureFailure(request: Promise<unknown>): Promise<unknown> {
  try {
    await request;
  } catch (error) {
    return error;
  }
  throw new Error("Expected Telegram transport request to fail");
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    async json() {
      return payload;
    },
  } as Response;
}
