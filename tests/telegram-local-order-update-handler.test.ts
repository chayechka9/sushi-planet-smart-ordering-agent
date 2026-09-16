import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function createHarness() {
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
      orderFlow,
      stateStore,
    }),
    conversationAgent,
    stateStore,
    prepareCheckoutLink,
    createOrderForConversation,
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
});
