import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AIConversationLayerService,
  type AIConversationInterpreter,
  type AIConversationInterpretation,
} from "../src/application/ai-conversation-layer.js";
import {
  LocalConversationAgentService,
  type ConversationAgentCommand,
} from "../src/application/local-conversation-agent.js";
import { createOrder } from "../src/domain/order.js";
import { SqliteConversationStateStore } from "../src/storage/sqlite/conversation-state-store.js";

const fixedNow = new Date("2026-09-12T12:00:00.000Z");
const menu = [
  {
    id: "synthetic-roll",
    name: "Synthetic Roll",
    unitPriceCents: 1_250,
    available: true,
  },
] as const;

const temporaryDirectories: string[] = [];
const stores: SqliteConversationStateStore[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network access is forbidden in AI layer tests");
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  for (const store of stores.splice(0).reverse()) store.close();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHarness(
  interpreter: AIConversationInterpreter,
  existingDatabasePath?: string,
): {
  service: AIConversationLayerService;
  store: SqliteConversationStateStore;
  databasePath: string;
  prepareCheckoutLink: ReturnType<typeof vi.fn>;
  verifyPayment: ReturnType<typeof vi.fn>;
  submitPoster: ReturnType<typeof vi.fn>;
} {
  let databasePath = existingDatabasePath;
  if (databasePath === undefined) {
    const directory = mkdtempSync(join(tmpdir(), "sushi-planet-ai-layer-"));
    temporaryDirectories.push(directory);
    databasePath = join(directory, "conversation.sqlite");
  }
  const store = new SqliteConversationStateStore(databasePath);
  stores.push(store);

  const prepareCheckoutLink = vi.fn(async ({ order }: { order: { id: string } }) => ({
    orderId: order.id,
    checkoutId: "synthetic-checkout",
    checkoutReference: "synthetic-reference",
    checkoutLink: "https://checkout.invalid/synthetic",
  }));
  const verifyPayment = vi.fn();
  const submitPoster = vi.fn();
  const checkoutFlow = {
    prepareCheckoutLink,
    processPaymentWebhook: verifyPayment,
    submitOrder: submitPoster,
  };
  const conversationAgent = new LocalConversationAgentService({
    stateStore: store,
    menuProvider: { getMenuSnapshot: () => menu },
    deliveryFeePolicy: { getDeliveryFeeCents: () => 350 },
    checkoutFlow,
    checkoutMerchant: {
      merchantCode: "synthetic-merchant",
      country: "IE",
      defaultCurrency: "EUR",
      sandbox: true,
    },
    createOrder: () =>
      createOrder({
        createId: () => "ord_ai_layer_synthetic",
        now: () => fixedNow,
      }),
    now: () => fixedNow,
  });

  return {
    service: new AIConversationLayerService({
      interpreter,
      conversationAgent,
      stateStore: store,
    }),
    store,
    databasePath,
    prepareCheckoutLink,
    verifyPayment,
    submitPoster,
  };
}

function input(
  text: string,
  overrides: Partial<{
    channel: string;
    userId: string;
    conversationId: string;
    messageId: string;
  }> = {},
) {
  return {
    channel: "synthetic-channel",
    userId: "synthetic-user",
    conversationId: "synthetic-conversation",
    messageId: "synthetic-message",
    text,
    ...overrides,
  };
}

function fixedInterpreter(
  command: ConversationAgentCommand,
): AIConversationInterpreter {
  return {
    interpret: vi.fn(async () => ({ kind: "command" as const, command })),
  };
}

describe("provider-neutral AI conversation layer", () => {
  it("converts free text into an allowlisted command and passes safe context", async () => {
    let receivedContext: unknown;
    let receivedText = "";
    const interpreter: AIConversationInterpreter = {
      interpret: vi.fn<AIConversationInterpreter["interpret"]>(async (context, text) => {
        receivedContext = context;
        receivedText = text;
        return {
          kind: "command",
          command: {
            type: "add_item",
            menuItemId: "synthetic-roll",
            quantity: 2,
          },
        };
      }),
    };
    const harness = createHarness(interpreter);

    await expect(
      harness.service.handle(input("  добавь ролл  ")),
    ).resolves.toMatchObject({
      kind: "command_applied",
      command: {
        type: "add_item",
        menuItemId: "synthetic-roll",
        quantity: 2,
      },
      response: {
        kind: "cart",
        order: {
          items: [{ menuItemId: "synthetic-roll", quantity: 2 }],
        },
      },
    });

    expect(receivedText).toBe("добавь ролл");
    expect(receivedContext).toMatchObject({
      conversationId: "synthetic-conversation",
      identity: {
        channel: "synthetic-channel",
        userId: "synthetic-user",
      },
      conversation: {
        status: "new",
        cart: [],
        fulfilment: null,
        checkoutCreated: false,
      },
    });
    expect(receivedContext).not.toHaveProperty("unitPriceCents");
    expect(receivedContext).not.toHaveProperty("available");
    expect(receivedContext).not.toHaveProperty("totalCents");
    expect(receivedContext).not.toHaveProperty("deliveryFeeCents");
    expect(receivedContext).not.toHaveProperty("paymentStatus");
    expect(receivedContext).not.toHaveProperty("posterOrderId");
  });

  it.each([
    {
      label: "unknown result",
      result: { kind: "unsupported_result" },
    },
    {
      label: "command with forbidden price field",
      result: {
        kind: "command",
        command: {
          type: "add_item",
          menuItemId: "synthetic-roll",
          priceCents: 1,
        },
      },
    },
  ])("returns a safe error for an interpreter $label", async ({ result }) => {
    const interpreter: AIConversationInterpreter = {
      interpret: vi.fn(async () =>
        result as unknown as AIConversationInterpretation,
      ),
    };
    const harness = createHarness(interpreter);

    await expect(harness.service.handle(input("непонятно"))).resolves.toEqual({
      kind: "error",
      code: "invalid_interpreter_result",
    });
    expect(harness.store.findByConversationId("synthetic-conversation")).toBe(
      undefined,
    );
  });

  it("returns an injected clarification without touching the deterministic core", async () => {
    const interpreter: AIConversationInterpreter = {
      interpret: vi.fn(async () => ({
        kind: "needs_clarification" as const,
        reason: "ambiguous" as const,
      })),
    };
    const harness = createHarness(interpreter);

    await expect(harness.service.handle(input("хочу что-нибудь"))).resolves.toEqual({
      kind: "needs_clarification",
      reason: "ambiguous",
    });
    expect(harness.store.findByConversationId("synthetic-conversation")).toBe(
      undefined,
    );
    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();
  });

  it("returns a duplicate result before calling the interpreter again", async () => {
    const interpreter = fixedInterpreter({
      type: "add_item",
      menuItemId: "synthetic-roll",
    });
    const harness = createHarness(interpreter);

    const first = await harness.service.handle(input("добавь ролл"));
    const duplicate = await harness.service.handle(input("  добавь   ролл  "));

    expect(duplicate).toEqual(first);
    expect(interpreter.interpret).toHaveBeenCalledOnce();
    expect(
      harness.store.findByConversationId("synthetic-conversation")?.order.items,
    ).toEqual([
      {
        menuItemId: "synthetic-roll",
        name: "Synthetic Roll",
        unitPriceCents: 1_250,
        quantity: 1,
      },
    ]);
  });

  it("returns message conflict for different source text before interpreting again", async () => {
    const interpreter: AIConversationInterpreter = {
      interpret: vi.fn(async (_context, text) => ({
        kind: "command" as const,
        command:
          text === "add"
            ? {
                type: "add_item" as const,
                menuItemId: "synthetic-roll",
              }
            : { type: "show_cart" as const },
      })),
    };
    const harness = createHarness(interpreter);

    await harness.service.handle(input("add"));
    await expect(harness.service.handle(input("different command"))).resolves.toEqual({
      kind: "error",
      code: "message_conflict",
    });
    expect(interpreter.interpret).toHaveBeenCalledOnce();
    expect(
      harness.store.findByConversationId("synthetic-conversation")?.order.items,
    ).toHaveLength(1);
  });

  it.each([
    { channel: "other-channel", userId: "synthetic-user" },
    { channel: "synthetic-channel", userId: "other-user" },
  ])("rejects a different channel/user identity", async (identity) => {
    const interpreter = fixedInterpreter({ type: "show_cart" });
    const harness = createHarness(interpreter);
    await harness.service.handle(input("добавь ролл", { messageId: "first" }));
    vi.mocked(interpreter.interpret).mockClear();

    const result = await harness.service.handle(
      input("покажи корзину", { ...identity, messageId: "second" }),
    );

    expect(result).toEqual({ kind: "error", code: "invalid_identity" });
    expect(interpreter.interpret).not.toHaveBeenCalled();
    expect(
      harness.store.findByConversationId("synthetic-conversation")?.identity,
    ).toEqual({
      channel: "synthetic-channel",
      userId: "synthetic-user",
    });
  });

  it("keeps AI duplicate, conflict and no-provider behavior after SQLite reopen", async () => {
    const firstInterpreter = fixedInterpreter({
      type: "add_item",
      menuItemId: "synthetic-roll",
    });
    const firstHarness = createHarness(firstInterpreter);
    const first = await firstHarness.service.handle(input("добавь ролл"));
    const stored = firstHarness.store.findByConversationId(
      "synthetic-conversation",
    );
    expect(stored?.processedMessages[0]).toMatchObject({
      messageId: "synthetic-message",
      command: { type: "add_item", menuItemId: "synthetic-roll" },
      sourceMessageFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(stored?.processedMessages)).not.toContain(
      "добавь ролл",
    );

    firstHarness.store.close();
    const reopenedInterpreter = fixedInterpreter({ type: "show_cart" });
    const reopened = createHarness(
      reopenedInterpreter,
      firstHarness.databasePath,
    );

    await expect(
      reopened.service.handle(input("добавь ролл")),
    ).resolves.toEqual(first);
    await expect(
      reopened.service.handle(input("другой текст")),
    ).resolves.toEqual({ kind: "error", code: "message_conflict" });
    await expect(
      reopened.service.handle(
        input("покажи корзину", {
          messageId: "other-message",
          userId: "other-user",
        }),
      ),
    ).resolves.toEqual({ kind: "error", code: "invalid_identity" });
    expect(reopenedInterpreter.interpret).not.toHaveBeenCalled();
    expect(reopened.prepareCheckoutLink).not.toHaveBeenCalled();
    expect(reopened.verifyPayment).not.toHaveBeenCalled();
    expect(reopened.submitPoster).not.toHaveBeenCalled();
  });

  it("does not treat 'я оплатил' as payment and cannot call payment or Poster boundaries", async () => {
    const commands: Record<string, ConversationAgentCommand> = {
      add: { type: "add_item", menuItemId: "synthetic-roll" },
      pickup: { type: "choose_pickup" },
      customer: {
        type: "set_customer",
        firstName: "Synthetic",
        phone: "synthetic-phone",
      },
      checkout: { type: "prepare_checkout" },
      paid: { type: "customer_reports_payment" },
    };
    const interpreter: AIConversationInterpreter = {
      interpret: vi.fn(async (_context, text) => ({
        kind: "command" as const,
        command: commands[text]!,
      })),
    };
    const harness = createHarness(interpreter);

    for (const text of ["add", "pickup", "customer", "checkout"]) {
      await harness.service.handle(input(text, { messageId: text }));
    }
    const result = await harness.service.handle(
      input("paid", { messageId: "paid" }),
    );

    expect(result).toMatchObject({
      kind: "command_applied",
      command: { type: "customer_reports_payment" },
      response: {
        kind: "awaiting_verified_payment",
        order: { status: "awaiting_payment" },
      },
    });
    expect(harness.prepareCheckoutLink).toHaveBeenCalledOnce();
    expect(harness.verifyPayment).not.toHaveBeenCalled();
    expect(harness.submitPoster).not.toHaveBeenCalled();
    expect(
      harness.store.findByConversationId("synthetic-conversation")?.order.status,
    ).toBe("awaiting_payment");
  });
});
