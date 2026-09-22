import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LocalBackendFlowService,
  type LocalBackendCheckoutCreator,
} from "../src/application/local-backend-flow.js";
import { LocalConversationAgentService } from "../src/application/local-conversation-agent.js";
import { LocalOrderFlowService } from "../src/application/local-order-flow.js";
import { createOrder, type MenuItemSnapshot } from "../src/domain/order.js";
import type { PosterOrderSubmitter } from "../src/integrations/poster/submitter.js";
import type { TelegramUpdateEnvelope } from "../src/integrations/telegram/api-transport.js";
import { DeterministicTelegramInterpreter } from "../src/integrations/telegram/deterministic-interpreter.js";
import { TelegramLocalOrderUpdateHandler } from "../src/integrations/telegram/local-order-update-handler.js";
import type { SumUpMerchantSummary } from "../src/integrations/sumup/client.js";
import { SqliteConversationStateStore } from "../src/storage/sqlite/conversation-state-store.js";
import { SqliteOrderPaymentRepository } from "../src/storage/sqlite/order-payment-repository.js";

const fixedNow = new Date("2026-09-22T20:30:00.000Z");
const conversationId = "telegram:chat:701";
const orderId = "ord_telegram_pickup_checkout";
const merchant: SumUpMerchantSummary = {
  merchantCode: "synthetic-merchant",
  country: "IE",
  defaultCurrency: "EUR",
  sandbox: true,
};
const menu: readonly MenuItemSnapshot[] = [
  {
    id: "synthetic-pickup-item",
    name: "Synthetic Pickup Item",
    unitPriceCents: 725,
    available: true,
  },
];

interface Harness {
  backendRepository: SqliteOrderPaymentRepository;
  conversationStore: SqliteConversationStateStore;
  createCheckout: ReturnType<typeof vi.fn<LocalBackendCheckoutCreator["createCheckout"]>>;
  handler: TelegramLocalOrderUpdateHandler;
  posterSubmitOrder: ReturnType<typeof vi.fn>;
  verifyCheckout: ReturnType<typeof vi.fn>;
}

const temporaryDirectories: string[] = [];
const harnesses: Harness[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network access is forbidden in pickup checkout tests");
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0).reverse()) closeHarness(harness);
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "telegram-pickup-checkout-"));
  temporaryDirectories.push(directory);
  return join(directory, "local.sqlite");
}

function openHarness(
  databasePath: string,
  createCheckout?: Harness["createCheckout"],
): Harness {
  const conversationStore = new SqliteConversationStateStore(databasePath);
  const backendRepository = new SqliteOrderPaymentRepository(databasePath);
  const checkoutCreator = createCheckout ?? vi.fn<
    LocalBackendCheckoutCreator["createCheckout"]
  >(async (preparation) => ({
    checkoutId: `local-checkout-${orderId}`,
    checkoutReference: preparation.checkoutReference,
    merchantCode: preparation.payload.merchant_code,
    amountCents: preparation.amountCents,
    currency: "EUR",
    status: "PENDING",
    hostedCheckoutUrl: "local-checkout-intent",
  }));
  const verifyCheckout = vi.fn(async () => {
    throw new Error("Payment verification is outside this local flow");
  });
  const posterSubmitOrder = vi.fn(async () => {
    throw new Error("Poster is outside this local flow");
  });
  const posterSubmitter: PosterOrderSubmitter = {
    submitOrder: posterSubmitOrder,
  };
  const backendFlow = new LocalBackendFlowService({
    repository: backendRepository,
    checkoutCreator: { createCheckout: checkoutCreator },
    checkoutVerifier: { verifyCheckout },
    posterSubmitter,
    now: () => fixedNow,
  });
  const menuProvider = { getMenuSnapshot: () => menu };
  const conversationAgent = new LocalConversationAgentService({
    stateStore: conversationStore,
    menuProvider,
    deliveryFeePolicy: {
      getDeliveryFeeCents: () => {
        throw new Error("Delivery is outside this pickup-only composition");
      },
    },
    checkoutFlow: backendFlow,
    checkoutMerchant: merchant,
    createOrder: () =>
      createOrder({ createId: () => orderId, now: () => fixedNow }),
    now: () => fixedNow,
  });
  const orderFlow = new LocalOrderFlowService({ conversationAgent });
  const harness = {
    backendRepository,
    conversationStore,
    createCheckout: checkoutCreator,
    handler: new TelegramLocalOrderUpdateHandler({
      interpreter: new DeterministicTelegramInterpreter(menuProvider),
      orderFlow,
      pickupCheckoutPreparation: orderFlow,
      stateStore: conversationStore,
    }),
    posterSubmitOrder,
    verifyCheckout,
  };
  harnesses.push(harness);
  return harness;
}

function closeHarness(harness: Harness): void {
  harness.conversationStore.close();
  harness.backendRepository.close();
}

function commandUpdate(messageId: number, text: string): TelegramUpdateEnvelope {
  return {
    updateId: 2_000 + messageId,
    payload: {
      update_id: 2_000 + messageId,
      message: {
        message_id: messageId,
        from: { id: 701, is_bot: false },
        chat: { id: 701, type: "private" },
        text,
      },
    },
  };
}

async function completePickup(harness: Harness): Promise<TelegramUpdateEnvelope> {
  await harness.handler.handle(commandUpdate(1, "/add 1"));
  await harness.handler.handle(commandUpdate(2, "/name Synthetic"));
  await harness.handler.handle(commandUpdate(3, "/phone 0000000"));
  const finalUpdate = commandUpdate(4, "/pickup");
  await harness.handler.handle(finalUpdate);
  return finalUpdate;
}

describe("local injected Telegram pickup checkout composition", () => {
  it("does not prepare checkout for an incomplete pickup", async () => {
    const harness = openHarness(createDatabasePath());

    await expect(
      harness.handler.handle(commandUpdate(1, "/pickup")),
    ).resolves.toMatchObject({
      kind: "reply",
      nextStep: {
        kind: "collecting_order",
        missingFields: ["cart", "first_name", "phone"],
      },
    });

    expect(harness.createCheckout).not.toHaveBeenCalled();
    expect(harness.backendRepository.findOrderById(orderId)).toBeUndefined();
    expect(harness.conversationStore.findByConversationId(conversationId))
      .not.toHaveProperty("checkout");
  });

  it("prepares and persists one pickup checkout intent with a safe reply", async () => {
    const harness = openHarness(createDatabasePath());
    await harness.handler.handle(commandUpdate(1, "/add 1"));
    await harness.handler.handle(commandUpdate(2, "/name Synthetic"));
    await harness.handler.handle(commandUpdate(3, "/phone 0000000"));
    const finalUpdate = commandUpdate(4, "/pickup");

    const first = await harness.handler.handle(finalUpdate);

    expect(first).toEqual({
      updateId: 2_004,
      kind: "reply",
      chatId: 701,
      text: [
        "Корзина:",
        "1. Synthetic Pickup Item × 1 — €7.25",
        "Получение: самовывоз",
        "Итого: €7.25",
        "Убрать: /remove <номер> [количество]",
        "Заказ подготовлен к следующему шагу оплаты. Оплата не выполнена.",
      ].join("\n"),
      nextStep: { kind: "awaiting_verified_payment", orderId },
    });
    expect(harness.createCheckout).toHaveBeenCalledOnce();
    expect(harness.backendRepository.findOrderById(orderId)?.status).toBe(
      "awaiting_payment",
    );
    expect(harness.backendRepository.findByOrderId(orderId)).toMatchObject({
      status: "pending",
      amountCents: 725,
      currency: "EUR",
    });
    expect(harness.conversationStore.findByConversationId(conversationId))
      .toMatchObject({
        order: { id: orderId, status: "awaiting_payment" },
        checkout: {
          orderId,
          checkoutId: `local-checkout-${orderId}`,
          checkoutReference: `sumup-${orderId}-1`,
          checkoutLink: "local-checkout-intent",
        },
        backendStatus: {
          payment: "awaiting_payment",
          orderSubmission: "not_started",
        },
      });
    if (first.kind !== "reply") throw new Error("Expected a safe reply");
    expect(first.text).not.toContain("local-checkout-intent");
    expect(first.text).not.toMatch(/ссылка|оплачен|paid/iu);
    expect(harness.verifyCheckout).not.toHaveBeenCalled();
    expect(harness.posterSubmitOrder).not.toHaveBeenCalled();

    await expect(harness.handler.handle(finalUpdate)).resolves.toEqual(first);
    expect(harness.createCheckout).toHaveBeenCalledOnce();
    await expect(
      harness.handler.handle(commandUpdate(1, "/add 1")),
    ).resolves.toEqual({
      updateId: 2_001,
      kind: "ignored",
      reason: "duplicate",
    });
    expect(harness.createCheckout).toHaveBeenCalledOnce();
  });

  it("reuses the persisted checkout after SQLite reopen without another dependency call", async () => {
    const databasePath = createDatabasePath();
    const firstHarness = openHarness(databasePath);
    const finalUpdate = await completePickup(firstHarness);
    expect(firstHarness.createCheckout).toHaveBeenCalledOnce();
    closeHarness(firstHarness);

    const reopenedCreateCheckout = vi.fn<
      LocalBackendCheckoutCreator["createCheckout"]
    >(async () => {
      throw new Error("Persisted checkout must be reused");
    });
    const reopened = openHarness(databasePath, reopenedCreateCheckout);

    await expect(reopened.handler.handle(finalUpdate)).resolves.toMatchObject({
      kind: "reply",
      text: expect.stringContaining(
        "Заказ подготовлен к следующему шагу оплаты. Оплата не выполнена.",
      ),
      nextStep: { kind: "awaiting_verified_payment", orderId },
    });
    expect(reopenedCreateCheckout).not.toHaveBeenCalled();
    expect(reopened.backendRepository.findOrderById(orderId)?.status).toBe(
      "awaiting_payment",
    );
    expect(reopened.backendRepository.findByOrderId(orderId)?.status).toBe(
      "pending",
    );
    expect(reopened.verifyCheckout).not.toHaveBeenCalled();
    expect(reopened.posterSubmitOrder).not.toHaveBeenCalled();
  });
});
