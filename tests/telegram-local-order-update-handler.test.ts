import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AIConversationInterpretation,
  AIConversationInterpreter,
} from "../src/application/ai-conversation-layer.js";
import { LocalConversationAgentService } from "../src/application/local-conversation-agent.js";
import { LocalOrderFlowService } from "../src/application/local-order-flow.js";
import { LocalDeliveryTariffResolver } from "../src/delivery/local-delivery-tariff-resolver.js";
import { createOrder, type MenuItemSnapshot } from "../src/domain/order.js";
import type { TelegramUpdateEnvelope } from "../src/integrations/telegram/api-transport.js";
import { DeterministicTelegramInterpreter } from "../src/integrations/telegram/deterministic-interpreter.js";
import { TelegramLocalOrderUpdateHandler } from "../src/integrations/telegram/local-order-update-handler.js";
import { InMemoryConversationStateStore } from "../src/storage/in-memory-conversation-store.js";

const fixedNow = new Date("2026-09-16T15:00:00.000Z");
const conversationId = "telegram:chat:501";
const menu: readonly MenuItemSnapshot[] = [
  {
    id: "synthetic-item",
    name: "Synthetic Item",
    unitPriceCents: 625,
    available: true,
  },
];

let temporaryDirectories: string[];
let globalFetch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  temporaryDirectories = [];
  globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network access is forbidden in Telegram flow tests");
  });
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHarness(aiInterpreter?: AIConversationInterpreter) {
  const directory = mkdtempSync(join(tmpdir(), "telegram-local-order-flow-"));
  temporaryDirectories.push(directory);
  const tariffPath = join(directory, "delivery-tariffs.json");
  writeFileSync(
    tariffPath,
    JSON.stringify({ schemaVersion: 1, tariffs: [] }),
    "utf8",
  );

  const stateStore = new InMemoryConversationStateStore();
  const menuProvider = { getMenuSnapshot: () => menu };
  const prepareCheckoutLink = vi.fn(async () => {
    throw new Error("Checkout must remain outside the Telegram update handler");
  });
  let orderNumber = 0;
  const createOrderForConversation = vi.fn(() =>
    createOrder({
      createId: () => `ord_telegram_local_${++orderNumber}`,
      now: () => fixedNow,
    }),
  );
  const conversationAgent = new LocalConversationAgentService({
    stateStore,
    menuProvider,
    deliveryFeePolicy: new LocalDeliveryTariffResolver(tariffPath),
    checkoutFlow: { prepareCheckoutLink },
    checkoutMerchant: {
      merchantCode: "synthetic-merchant",
      country: "IE",
      defaultCurrency: "EUR",
      sandbox: true,
    },
    createOrder: createOrderForConversation,
    now: () => fixedNow,
  });
  const orderFlow = new LocalOrderFlowService({ conversationAgent });

  return {
    handler: new TelegramLocalOrderUpdateHandler({
      interpreter: new DeterministicTelegramInterpreter(menuProvider),
      ...(aiInterpreter === undefined
        ? {}
        : { aiFallback: { interpreter: aiInterpreter } }),
      orderFlow,
      stateStore,
    }),
    conversationAgent,
    stateStore,
    prepareCheckoutLink,
    createOrderForConversation,
  };
}

function fixedAIResult(result: unknown): AIConversationInterpreter {
  return {
    interpret: vi.fn(async () => result as AIConversationInterpretation),
  };
}

function commandUpdate(
  messageId: number,
  text: string,
  updateId = 1_000 + messageId,
): TelegramUpdateEnvelope {
  return {
    updateId,
    payload: {
      update_id: updateId,
      message: {
        message_id: messageId,
        from: { id: 501, is_bot: false },
        chat: { id: 501, type: "private" },
        text,
      },
    },
  };
}

describe("controlled Telegram local order update handler", () => {
  it("normalizes one received command and builds a safe local reply", async () => {
    const harness = createHarness();

    await expect(
      harness.handler.handle(commandUpdate(1, "/menu")),
    ).resolves.toEqual({
      updateId: 1_001,
      kind: "reply",
      chatId: 501,
      text: "Меню:\n1. Synthetic Item — €6.25\nДобавить: /add <номер> [количество]",
      nextStep: {
        kind: "collecting_order",
        missingFields: ["cart", "fulfilment", "first_name", "phone"],
      },
    });

    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();
  });

  it("persists one explicit staff request and replays its safe result without external effects", async () => {
    const harness = createHarness();
    const update = commandUpdate(2, "/staff");
    const expectedReply =
      "Запрос помощи зарегистрирован локально. Канал уведомления сотрудников пока не подключён.";

    await expect(harness.handler.handle(update)).resolves.toEqual({
      updateId: 1_002,
      kind: "reply",
      chatId: 501,
      text: expectedReply,
      nextStep: {
        kind: "collecting_order",
        missingFields: ["cart", "fulfilment", "first_name", "phone"],
      },
    });
    const stored = harness.stateStore.findByConversationId(conversationId);

    expect(harness.conversationAgent.listPendingStaffHandoffRequests()).toEqual([
      {
        conversationId,
        orderId: "ord_telegram_local_1",
        requestedAt: fixedNow.toISOString(),
        reason: "customer_requested",
      },
    ]);
    expect(stored).toMatchObject({
      order: { status: "draft" },
      staffHandoffRequest: {
        requestedAt: fixedNow.toISOString(),
        reason: "customer_requested",
      },
      backendStatus: {
        payment: "not_requested",
        orderSubmission: "not_started",
      },
      processedMessages: [{
        messageId: "telegram:message:2",
        command: { type: "request_staff" },
        response: {
          kind: "staff_handoff_registered",
          request: {
            requestedAt: fixedNow.toISOString(),
            reason: "customer_requested",
          },
        },
      }],
    });
    expect(stored).not.toHaveProperty("checkout");
    expect(Object.keys(stored?.staffHandoffRequest ?? {}).sort()).toEqual([
      "reason",
      "requestedAt",
    ]);
    expect(JSON.stringify(stored)).not.toContain("/staff");

    await expect(harness.handler.handle(update)).resolves.toEqual({
      updateId: 1_002,
      kind: "reply",
      chatId: 501,
      text: expectedReply,
    });
    expect(harness.stateStore.findByConversationId(conversationId)).toEqual(
      stored,
    );
    expect(harness.stateStore.listPendingStaffHandoffRequests()).toHaveLength(1);
    expect(expectedReply).not.toMatch(/сотрудник уведомлён|ответит через|минут/iu);
    expect(harness.createOrderForConversation).toHaveBeenCalledOnce();
    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();
  });

  it("connects a command chain to pickup readiness without creating checkout", async () => {
    const harness = createHarness();

    await harness.handler.handle(commandUpdate(1, "/add 1 2"));
    await expect(
      harness.handler.handle(commandUpdate(2, "/name Synthetic")),
    ).resolves.toMatchObject({
      kind: "reply",
      text: expect.stringContaining("Имя сохранено."),
    });
    await harness.handler.handle(commandUpdate(3, "/phone 0000000"));
    const ready = await harness.handler.handle(commandUpdate(4, "/pickup"));

    expect(ready).toEqual({
      updateId: 1_004,
      kind: "reply",
      chatId: 501,
      text: [
        "Корзина:",
        "1. Synthetic Item × 2 — €12.50",
        "Получение: самовывоз",
        "Итого: €12.50",
        "Убрать: /remove <номер> [количество]",
        "Заказ готов к переходу к оплате. Checkout не создан.",
      ].join("\n"),
      nextStep: {
        kind: "payment_boundary_ready",
        orderId: "ord_telegram_local_1",
        amountCents: 1_250,
        currency: "EUR",
        fulfilment: "pickup",
      },
    });
    expect(harness.conversationAgent.inspect(conversationId)).toMatchObject({
      items: [{ quantity: 2, lineTotalCents: 1_250 }],
      fulfilment: "pickup",
      customer: { firstName: "Synthetic", phone: "0000000" },
      missingFields: [],
      totals: {
        subtotalCents: 1_250,
        fulfilmentCents: 0,
        totalCents: 1_250,
        currency: "EUR",
      },
      totalIsFinal: true,
    });
    expect(harness.createOrderForConversation).toHaveBeenCalledOnce();
    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();
  });

  it("suppresses a repeated processed update without changing the cart", async () => {
    const harness = createHarness();
    const update = commandUpdate(1, "/add 1");

    await expect(harness.handler.handle(update)).resolves.toMatchObject({
      kind: "reply",
    });
    const before = harness.stateStore.findByConversationId(conversationId);
    await expect(harness.handler.handle(update)).resolves.toEqual({
      updateId: 1_001,
      kind: "ignored",
      reason: "duplicate",
    });

    expect(harness.stateStore.findByConversationId(conversationId)).toEqual(
      before,
    );
    expect(harness.conversationAgent.inspect(conversationId)?.items).toEqual([
      expect.objectContaining({ quantity: 1, lineTotalCents: 625 }),
    ]);
    expect(harness.createOrderForConversation).toHaveBeenCalledOnce();
    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();
  });

  it("rejects delivery with an empty tariff table without storing address or fee", async () => {
    const harness = createHarness();

    await harness.handler.handle(commandUpdate(1, "/add 1"));
    await harness.handler.handle(commandUpdate(2, "/name Synthetic"));
    await harness.handler.handle(commandUpdate(3, "/phone 0000000"));
    await harness.handler.handle(commandUpdate(4, "/delivery"));
    const before = harness.stateStore.findByConversationId(conversationId);
    const address = commandUpdate(
      5,
      "/address Synthetic Street | Synthetic District | SYN TEST",
    );

    const rejected = await harness.handler.handle(address);

    expect(rejected).toEqual({
      updateId: 1_005,
      kind: "reply",
      chatId: 501,
      text: "Доставка в эту зону пока недоступна.",
      nextStep: { kind: "collecting_order", missingFields: ["address"] },
    });
    expect(harness.stateStore.findByConversationId(conversationId)).toEqual(
      before,
    );
    expect(harness.conversationAgent.inspect(conversationId)).toMatchObject({
      fulfilment: "delivery",
      customer: {
        firstName: "Synthetic",
        phone: "0000000",
      },
      missingFields: ["address"],
      totals: {
        subtotalCents: 625,
        fulfilmentCents: 0,
        totalCents: 625,
        currency: "EUR",
      },
      totalIsFinal: false,
    });

    await expect(harness.handler.handle(address)).resolves.toEqual(rejected);
    expect(harness.stateStore.findByConversationId(conversationId)).toEqual(
      before,
    );
    expect(harness.createOrderForConversation).toHaveBeenCalledOnce();
    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();
  });

  it("uses an explicitly injected AI fallback for unsupported plain text", async () => {
    let receivedContext: unknown;
    let receivedText = "";
    const aiInterpreter: AIConversationInterpreter = {
      interpret: vi.fn(async (context, text) => {
        receivedContext = context;
        receivedText = text;
        return {
          kind: "command" as const,
          command: {
            type: "add_item" as const,
            menuItemId: "synthetic-item",
            quantity: 2,
          },
        };
      }),
    };
    const harness = createHarness(aiInterpreter);

    await expect(
      harness.handler.handle(commandUpdate(10, "добавь две позиции")),
    ).resolves.toMatchObject({
      kind: "reply",
      text: expect.stringContaining("Synthetic Item × 2 — €12.50"),
      nextStep: {
        kind: "collecting_order",
        missingFields: ["fulfilment", "first_name", "phone"],
      },
    });

    expect(aiInterpreter.interpret).toHaveBeenCalledOnce();
    expect(receivedText).toBe("добавь две позиции");
    expect(receivedContext).toMatchObject({
      identity: {
        channel: "telegram",
        userId: "telegram:user:501",
      },
      conversation: {
        status: "new",
        cart: [],
        fulfilment: null,
        checkoutCreated: false,
      },
    });
    const serializedContext = JSON.stringify(receivedContext);
    for (const forbidden of [
      "unitPriceCents",
      "totalCents",
      "deliveryFeeCents",
      "paymentStatus",
      "posterOrderId",
      "firstName\":\"",
      "phone\":\"",
    ]) {
      expect(serializedContext).not.toContain(forbidden);
    }
    expect(harness.conversationAgent.inspect(conversationId)).toMatchObject({
      items: [{ quantity: 2, lineTotalCents: 1_250 }],
      totals: {
        subtotalCents: 1_250,
        fulfilmentCents: 0,
        totalCents: 1_250,
        currency: "EUR",
      },
    });
    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();
  });

  it("keeps deterministic commands ahead of the AI fallback", async () => {
    const aiInterpreter = fixedAIResult({
      kind: "command",
      command: { type: "choose_delivery" },
    });
    const harness = createHarness(aiInterpreter);

    await expect(
      harness.handler.handle(commandUpdate(11, "покажи меню")),
    ).resolves.toMatchObject({
      kind: "reply",
      text: expect.stringContaining("Меню:"),
    });

    expect(aiInterpreter.interpret).not.toHaveBeenCalled();
    expect(harness.conversationAgent.inspect(conversationId)?.fulfilment).toBe(
      null,
    );
  });

  it("never sends slash commands to the AI fallback", async () => {
    const aiInterpreter = fixedAIResult({
      kind: "command",
      command: { type: "show_menu" },
    });
    const harness = createHarness(aiInterpreter);

    await expect(
      harness.handler.handle(commandUpdate(12, "/unknown")),
    ).resolves.toEqual({
      updateId: 1_012,
      kind: "reply",
      chatId: 501,
      text: "Доступные команды: /menu, /add <номер> [количество], /cart, /remove <номер> [количество], /pickup, /delivery, /name <имя>, /phone <телефон>, /address <улица> | <город> | <индекс>, /review, /staff.",
    });
    expect(aiInterpreter.interpret).not.toHaveBeenCalled();
    expect(harness.stateStore.findByConversationId(conversationId)).toBeUndefined();
  });

  it("keeps AI fallback disabled by default without changing state", async () => {
    const harness = createHarness();

    await expect(
      harness.handler.handle(commandUpdate(13, "хочу что-нибудь")),
    ).resolves.toEqual({
      updateId: 1_013,
      kind: "reply",
      chatId: 501,
      text: "Доступные команды: /menu, /add <номер> [количество], /cart, /remove <номер> [количество], /pickup, /delivery, /name <имя>, /phone <телефон>, /address <улица> | <город> | <индекс>, /review, /staff.",
    });
    expect(harness.stateStore.findByConversationId(conversationId)).toBeUndefined();
    expect(harness.createOrderForConversation).not.toHaveBeenCalled();
    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "empty result",
      createInterpreter: () => fixedAIResult(undefined),
    },
    {
      label: "invalid result",
      createInterpreter: () =>
        fixedAIResult({ kind: "command", command: { type: "unknown" } }),
    },
    {
      label: "interpreter error",
      createInterpreter: (): AIConversationInterpreter => ({
        interpret: vi.fn(async () => {
          throw new Error("synthetic AI failure");
        }),
      }),
    },
  ])("rejects an AI $label without changing state", async ({ createInterpreter }) => {
    const harness = createHarness(createInterpreter());

    await expect(
      harness.handler.handle(commandUpdate(14, "свободный текст")),
    ).resolves.toEqual({
      updateId: 1_014,
      kind: "reply",
      chatId: 501,
      text: "Не удалось обработать сообщение. Попробуйте сформулировать запрос иначе.",
    });
    expect(harness.stateStore.findByConversationId(conversationId)).toBeUndefined();
    expect(harness.createOrderForConversation).not.toHaveBeenCalled();
    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "price or total",
      result: {
        kind: "command",
        command: {
          type: "add_item",
          menuItemId: "synthetic-item",
          quantity: 1,
          totalCents: 1,
        },
      },
    },
    {
      label: "delivery fee",
      result: {
        kind: "command",
        command: { type: "choose_delivery", deliveryFeeCents: 1 },
      },
    },
    {
      label: "checkout",
      result: { kind: "command", command: { type: "prepare_checkout" } },
    },
    {
      label: "payment status",
      result: {
        kind: "command",
        command: { type: "customer_reports_payment" },
      },
    },
  ])("cannot apply an AI-controlled $label", async ({ result }) => {
    const harness = createHarness(fixedAIResult(result));

    await expect(
      harness.handler.handle(commandUpdate(15, "свободный текст")),
    ).resolves.toMatchObject({
      kind: "reply",
      text: "Не удалось обработать сообщение. Попробуйте сформулировать запрос иначе.",
    });
    expect(harness.stateStore.findByConversationId(conversationId)).toBeUndefined();
    expect(harness.createOrderForConversation).not.toHaveBeenCalled();
    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();
  });

  it("keeps an AI-interpreted update idempotent", async () => {
    const aiInterpreter = fixedAIResult({
      kind: "command",
      command: { type: "add_item", menuItemId: "synthetic-item" },
    });
    const harness = createHarness(aiInterpreter);
    const update = commandUpdate(16, "добавь позицию");

    await expect(harness.handler.handle(update)).resolves.toMatchObject({
      kind: "reply",
    });
    const before = harness.stateStore.findByConversationId(conversationId);
    await expect(harness.handler.handle(update)).resolves.toEqual({
      updateId: 1_016,
      kind: "ignored",
      reason: "duplicate",
    });

    expect(aiInterpreter.interpret).toHaveBeenCalledOnce();
    expect(harness.stateStore.findByConversationId(conversationId)).toEqual(
      before,
    );
    expect(harness.conversationAgent.inspect(conversationId)?.items).toEqual([
      expect.objectContaining({ quantity: 1, lineTotalCents: 625 }),
    ]);
    expect(harness.createOrderForConversation).toHaveBeenCalledOnce();
    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();
  });
});
