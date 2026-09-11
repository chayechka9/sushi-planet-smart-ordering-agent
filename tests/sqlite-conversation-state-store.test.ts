import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LocalConversationAgentService,
  type ConversationAgentCommand,
  type LocalConversationState,
} from "../src/application/local-conversation-agent.js";
import {
  createOrder,
  markPaid,
  markSubmittedToPoster,
  type MenuItemSnapshot,
} from "../src/domain/order.js";
import type { SumUpMerchantSummary } from "../src/integrations/sumup/client.js";
import {
  SqliteConversationStateStore,
  SqliteConversationStateStoreError,
} from "../src/storage/sqlite/conversation-state-store.js";

const initialNow = new Date("2026-09-11T22:00:00.000Z");
const paidNow = new Date("2026-09-11T22:05:00.000Z");
const submittedNow = new Date("2026-09-11T22:06:00.000Z");
const identity = {
  channel: "synthetic-channel",
  userId: "synthetic-user",
};
const menu: readonly MenuItemSnapshot[] = [
  {
    id: "synthetic-roll",
    name: "Synthetic Roll",
    unitPriceCents: 1_250,
    available: true,
  },
];
const merchant: SumUpMerchantSummary = {
  merchantCode: "synthetic-merchant",
  country: "IE",
  defaultCurrency: "EUR",
  sandbox: true,
};

const stores: SqliteConversationStateStore[] = [];
const temporaryDirectories: string[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network access is forbidden in conversation storage tests");
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

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "conversation-storage-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "local.sqlite");
}

function openStore(databasePath: string): SqliteConversationStateStore {
  const store = new SqliteConversationStateStore(databasePath);
  stores.push(store);
  return store;
}

function reopenStore(
  store: SqliteConversationStateStore,
  databasePath: string,
): SqliteConversationStateStore {
  store.close();
  return openStore(databasePath);
}

function createAgent(
  stateStore: SqliteConversationStateStore,
  conversationId: string,
  orderId: string,
  checkoutReference = `synthetic-reference-${orderId}`,
): LocalConversationAgentService {
  return new LocalConversationAgentService({
    stateStore,
    menuProvider: { getMenuSnapshot: () => menu },
    deliveryFeePolicy: { getDeliveryFeeCents: () => 350 },
    checkoutFlow: {
      prepareCheckoutLink: async ({ order }) => ({
        orderId: order.id,
        checkoutId: `synthetic-checkout-${order.id}`,
        checkoutReference,
        checkoutLink: `synthetic-checkout-link-${order.id}`,
      }),
    },
    checkoutMerchant: merchant,
    createOrder: () =>
      createOrder({ createId: () => orderId, now: () => initialNow }),
    now: () => initialNow,
  });
}

async function send(
  agent: LocalConversationAgentService,
  conversationId: string,
  messageId: string,
  command: ConversationAgentCommand,
) {
  return agent.handle({ conversationId, messageId, command, identity });
}

async function makePickupReady(
  agent: LocalConversationAgentService,
  conversationId: string,
): Promise<void> {
  await send(agent, conversationId, "add", {
    type: "add_item",
    menuItemId: "synthetic-roll",
    quantity: 2,
  });
  await send(agent, conversationId, "pickup", { type: "choose_pickup" });
  await send(agent, conversationId, "customer", {
    type: "set_customer",
    firstName: "Synthetic",
    phone: "synthetic-phone",
  });
}

async function prepareCheckout(
  agent: LocalConversationAgentService,
  conversationId: string,
): Promise<void> {
  await makePickupReady(agent, conversationId);
  await send(agent, conversationId, "checkout", { type: "prepare_checkout" });
}

function confirmedState(state: LocalConversationState): LocalConversationState {
  return {
    ...state,
    order: markPaid(state.order, paidNow),
    status: "payment_confirmed",
    backendStatus: {
      payment: "payment_confirmed",
      orderSubmission: "not_started",
    },
    updatedAt: paidNow.toISOString(),
  };
}

describe("SQLite conversation state store", () => {
  it("restores conversation identity and timestamps after reopening", async () => {
    const databasePath = createDatabasePath();
    let store = openStore(databasePath);
    const agent = createAgent(store, "conversation-reopen", "order-reopen");
    await send(agent, "conversation-reopen", "menu", { type: "show_menu" });
    const before = store.findByConversationId("conversation-reopen");

    store = reopenStore(store, databasePath);

    expect(store.findByConversationId("conversation-reopen")).toEqual(before);
    expect(before).toMatchObject({
      conversationId: "conversation-reopen",
      identity,
      status: "collecting_order",
      createdAt: initialNow.toISOString(),
      updatedAt: initialNow.toISOString(),
    });
  });

  it("persists cart, customer, delivery, checkout references and awaiting status", async () => {
    const databasePath = createDatabasePath();
    let store = openStore(databasePath);
    const agent = createAgent(store, "conversation-cart", "order-cart");
    await send(agent, "conversation-cart", "add", {
      type: "add_item",
      menuItemId: "synthetic-roll",
      quantity: 2,
    });
    await send(agent, "conversation-cart", "delivery", {
      type: "choose_delivery",
    });
    await send(agent, "conversation-cart", "customer", {
      type: "set_customer",
      firstName: "Synthetic",
      phone: "synthetic-phone",
    });
    await send(agent, "conversation-cart", "address", {
      type: "set_delivery_address",
      address: {
        line1: "Synthetic Street",
        city: "Synthetic City",
        postalCode: "SYN TEST",
      },
    });
    await send(agent, "conversation-cart", "checkout", {
      type: "prepare_checkout",
    });

    store = reopenStore(store, databasePath);
    expect(store.findByConversationId("conversation-cart")).toMatchObject({
      status: "awaiting_payment",
      order: {
        id: "order-cart",
        status: "awaiting_payment",
        items: [{ menuItemId: "synthetic-roll", quantity: 2 }],
        fulfilment: {
          type: "delivery",
          address: {
            line1: "Synthetic Street",
            city: "Synthetic City",
            postalCode: "SYN TEST",
          },
          deliveryFeeCents: 350,
        },
      },
      customer: {
        firstName: "Synthetic",
        phone: "synthetic-phone",
        deliveryAddress: {
          line1: "Synthetic Street",
          city: "Synthetic City",
          postalCode: "SYN TEST",
        },
      },
      checkout: {
        orderId: "order-cart",
        checkoutId: "synthetic-checkout-order-cart",
        checkoutReference: "synthetic-reference-order-cart",
      },
      backendStatus: {
        payment: "awaiting_payment",
        orderSubmission: "not_started",
      },
    });
  });

  it("deduplicates a processed message after reopening without changing state", async () => {
    const databasePath = createDatabasePath();
    let store = openStore(databasePath);
    let agent = createAgent(store, "conversation-duplicate", "order-duplicate");
    const command = {
      type: "add_item",
      menuItemId: "synthetic-roll",
    } as const;
    const first = await send(
      agent,
      "conversation-duplicate",
      "duplicate-message",
      command,
    );
    const stored = store.findByConversationId("conversation-duplicate");

    store = reopenStore(store, databasePath);
    agent = createAgent(store, "conversation-duplicate", "unused-order");
    const duplicate = await send(
      agent,
      "conversation-duplicate",
      "duplicate-message",
      command,
    );

    expect(duplicate).toEqual(first);
    expect(store.findByConversationId("conversation-duplicate")).toEqual(stored);
    expect(stored?.order.items).toMatchObject([{ quantity: 1 }]);
    expect(stored?.processedMessages).toHaveLength(1);

    await expect(
      send(agent, "conversation-duplicate", "duplicate-message", {
        type: "show_cart",
      }),
    ).rejects.toMatchObject({
      code: "message_conflict",
    });
    expect(store.findByConversationId("conversation-duplicate")).toEqual(stored);
  });

  it("persists payment_confirmed and order_submitted snapshots", async () => {
    const databasePath = createDatabasePath();
    let store = openStore(databasePath);
    const agent = createAgent(store, "conversation-paid", "order-paid");
    await prepareCheckout(agent, "conversation-paid");
    const awaiting = store.findByConversationId("conversation-paid");
    if (awaiting === undefined) throw new Error("Expected stored conversation");

    const paid = confirmedState(awaiting);
    store.save(paid);
    store = reopenStore(store, databasePath);
    expect(store.findByOrderId("order-paid")).toMatchObject({
      status: "payment_confirmed",
      order: { status: "paid" },
      backendStatus: { payment: "payment_confirmed" },
    });

    const submitted: LocalConversationState = {
      ...paid,
      order: markSubmittedToPoster(paid.order, submittedNow),
      status: "order_submitted",
      backendStatus: {
        payment: "payment_confirmed",
        orderSubmission: "order_submitted",
      },
      updatedAt: submittedNow.toISOString(),
    };
    store.save(submitted);
    store = reopenStore(store, databasePath);
    expect(store.findByOrderId("order-paid")).toMatchObject({
      status: "order_submitted",
      order: { status: "submitted_to_poster" },
      backendStatus: { orderSubmission: "order_submitted" },
    });
  });

  it("persists pending and safe uncertain snapshots", async () => {
    const databasePath = createDatabasePath();
    let store = openStore(databasePath);
    const agent = createAgent(store, "conversation-uncertain", "order-uncertain");
    await prepareCheckout(agent, "conversation-uncertain");
    const pending = store.findByConversationId("conversation-uncertain");
    expect(pending).toMatchObject({
      status: "awaiting_payment",
      backendStatus: { payment: "awaiting_payment" },
    });
    if (pending === undefined) throw new Error("Expected stored conversation");

    const uncertain: LocalConversationState = {
      ...confirmedState(pending),
      status: "submission_uncertain",
      backendStatus: {
        payment: "payment_confirmed",
        orderSubmission: "submission_uncertain",
      },
    };
    store.save(uncertain);
    store = reopenStore(store, databasePath);
    expect(store.findByConversationId("conversation-uncertain")).toMatchObject({
      status: "submission_uncertain",
      order: { status: "paid" },
      backendStatus: {
        payment: "payment_confirmed",
        orderSubmission: "submission_uncertain",
      },
    });
  });

  it("returns undefined for an unknown conversation without changing another", async () => {
    const databasePath = createDatabasePath();
    const store = openStore(databasePath);
    const agent = createAgent(store, "conversation-known", "order-known");
    await send(agent, "conversation-known", "cart", { type: "show_cart" });
    const before = store.findByConversationId("conversation-known");

    expect(store.findByConversationId("conversation-unknown")).toBeUndefined();
    expect(store.findByOrderId("order-unknown")).toBeUndefined();
    expect(store.findByConversationId("conversation-known")).toEqual(before);
  });

  it("rolls back a failed update and preserves the prior conversation", async () => {
    const databasePath = createDatabasePath();
    const store = openStore(databasePath);
    const firstAgent = createAgent(
      store,
      "conversation-owner",
      "order-owner",
      "shared-reference",
    );
    await prepareCheckout(firstAgent, "conversation-owner");

    const secondAgent = createAgent(
      store,
      "conversation-conflict",
      "order-conflict",
    );
    await makePickupReady(secondAgent, "conversation-conflict");
    const before = store.findByConversationId("conversation-conflict");
    if (before === undefined) throw new Error("Expected stored conversation");
    const conflicting: LocalConversationState = {
      ...before,
      order: { ...before.order, status: "awaiting_payment" },
      status: "awaiting_payment",
      checkout: {
        orderId: before.order.id,
        checkoutId: "synthetic-checkout-conflict",
        checkoutReference: "shared-reference",
        checkoutLink: "synthetic-checkout-link-conflict",
      },
      backendStatus: {
        payment: "awaiting_payment",
        orderSubmission: "not_started",
      },
    };

    expect(() => store.save(conflicting)).toThrow(
      SqliteConversationStateStoreError,
    );
    expect(store.findByConversationId("conversation-conflict")).toEqual(before);
    expect(store.findByOrderId("order-owner")?.checkout?.checkoutReference).toBe(
      "shared-reference",
    );
  });
});
