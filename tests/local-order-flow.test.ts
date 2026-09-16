import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalConversationAgentService } from "../src/application/local-conversation-agent.js";
import { LocalOrderFlowService } from "../src/application/local-order-flow.js";
import { LocalDeliveryTariffResolver } from "../src/delivery/local-delivery-tariff-resolver.js";
import { createOrder, type MenuItemSnapshot } from "../src/domain/order.js";
import type { SumUpMerchantSummary } from "../src/integrations/sumup/client.js";
import { InMemoryConversationStateStore } from "../src/storage/in-memory-conversation-store.js";

const fixedNow = new Date("2026-09-16T12:00:00.000Z");
const conversationId = "synthetic-local-flow";
const menu: readonly MenuItemSnapshot[] = [
  {
    id: "synthetic-item",
    name: "Synthetic Item",
    unitPriceCents: 625,
    available: true,
  },
];
const merchant: SumUpMerchantSummary = {
  merchantCode: "synthetic-merchant",
  country: "IE",
  defaultCurrency: "EUR",
  sandbox: true,
};

let temporaryDirectories: string[];
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  temporaryDirectories = [];
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network access is forbidden in local order flow tests");
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), "local-order-flow-"));
  temporaryDirectories.push(directory);
  const tariffPath = join(directory, "delivery-tariffs.json");
  writeFileSync(
    tariffPath,
    JSON.stringify({ schemaVersion: 1, tariffs: [] }),
    "utf8",
  );

  const stateStore = new InMemoryConversationStateStore();
  const prepareCheckoutLink = vi.fn(async () => {
    throw new Error("Checkout preparation must stay outside this flow");
  });
  let orderNumber = 0;
  const createOrderForConversation = vi.fn(() =>
    createOrder({
      createId: () => `ord_local_flow_${++orderNumber}`,
      now: () => fixedNow,
    }),
  );
  const conversationAgent = new LocalConversationAgentService({
    stateStore,
    menuProvider: { getMenuSnapshot: () => menu },
    deliveryFeePolicy: new LocalDeliveryTariffResolver(tariffPath),
    checkoutFlow: { prepareCheckoutLink },
    checkoutMerchant: merchant,
    createOrder: createOrderForConversation,
    now: () => fixedNow,
  });

  return {
    flow: new LocalOrderFlowService({ conversationAgent }),
    conversationAgent,
    stateStore,
    prepareCheckoutLink,
    createOrderForConversation,
  };
}

describe("deterministic local order flow", () => {
  it("connects cart and customer data to a pickup summary and local payment-ready step", async () => {
    const harness = createHarness();

    await harness.flow.handle({
      conversationId,
      actionId: "add",
      action: {
        type: "add_item",
        menuItemId: "synthetic-item",
        quantity: 2,
      },
    });
    await harness.flow.handle({
      conversationId,
      actionId: "customer",
      action: {
        type: "set_customer",
        firstName: "Synthetic",
        phone: "synthetic-phone",
      },
    });
    await harness.flow.handle({
      conversationId,
      actionId: "pickup",
      action: { type: "choose_pickup" },
    });
    const result = await harness.flow.handle({
      conversationId,
      actionId: "review",
      action: { type: "review_order" },
    });

    expect(result).toMatchObject({
      status: "accepted",
      summary: {
        orderId: "ord_local_flow_1",
        status: "draft",
        items: [
          {
            menuItemId: "synthetic-item",
            unitPriceCents: 625,
            quantity: 2,
            lineTotalCents: 1_250,
          },
        ],
        fulfilment: "pickup",
        customer: {
          firstName: "Synthetic",
          phone: "synthetic-phone",
        },
        missingFields: [],
        totals: {
          subtotalCents: 1_250,
          fulfilmentCents: 0,
          totalCents: 1_250,
          currency: "EUR",
        },
        totalIsFinal: true,
      },
      nextStep: {
        kind: "payment_boundary_ready",
        orderId: "ord_local_flow_1",
        amountCents: 1_250,
        currency: "EUR",
        fulfilment: "pickup",
      },
    });

    const duplicate = await harness.flow.handle({
      conversationId,
      actionId: "add",
      action: {
        type: "add_item",
        menuItemId: "synthetic-item",
        quantity: 2,
      },
    });
    expect(duplicate).toMatchObject({
      status: "accepted",
      summary: {
        items: [{ quantity: 2, lineTotalCents: 1_250 }],
        totals: { totalCents: 1_250, currency: "EUR" },
      },
      nextStep: { kind: "payment_boundary_ready" },
    });
    expect(harness.createOrderForConversation).toHaveBeenCalledOnce();
    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();
  });

  it("rejects delivery with no approved tariff and leaves order state unchanged", async () => {
    const harness = createHarness();

    await harness.flow.handle({
      conversationId,
      actionId: "add",
      action: { type: "add_item", menuItemId: "synthetic-item" },
    });
    await harness.flow.handle({
      conversationId,
      actionId: "customer",
      action: {
        type: "set_customer",
        firstName: "Synthetic",
        phone: "synthetic-phone",
      },
    });
    await harness.flow.handle({
      conversationId,
      actionId: "delivery",
      action: { type: "choose_delivery" },
    });
    const before = harness.stateStore.findByConversationId(conversationId);
    const deliveryAction = {
      type: "set_delivery_address",
      address: {
        line1: "Synthetic Street",
        city: "Synthetic District",
        postalCode: "SYN TEST",
      },
    } as const;

    const rejected = await harness.flow.handle({
      conversationId,
      actionId: "address",
      action: deliveryAction,
    });

    expect(rejected).toMatchObject({
      status: "rejected",
      reason: "delivery_unavailable",
      summary: {
        items: [{ quantity: 1, lineTotalCents: 625 }],
        fulfilment: "delivery",
        customer: {
          firstName: "Synthetic",
          phone: "synthetic-phone",
        },
        missingFields: ["address"],
        totals: {
          subtotalCents: 625,
          fulfilmentCents: 0,
          totalCents: 625,
          currency: "EUR",
        },
        totalIsFinal: false,
      },
      nextStep: {
        kind: "collecting_order",
        missingFields: ["address"],
      },
    });
    expect(harness.stateStore.findByConversationId(conversationId)).toEqual(
      before,
    );

    const repeated = await harness.flow.handle({
      conversationId,
      actionId: "address",
      action: deliveryAction,
    });
    expect(repeated).toEqual(rejected);
    expect(harness.stateStore.findByConversationId(conversationId)).toEqual(
      before,
    );
    expect(harness.createOrderForConversation).toHaveBeenCalledOnce();
    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();
  });

  it("blocks checkout and payment-report actions before they reach the agent", async () => {
    const harness = createHarness();

    await expect(
      harness.flow.handle({
        conversationId,
        actionId: "checkout",
        action: { type: "prepare_checkout" },
      }),
    ).resolves.toEqual({
      status: "rejected",
      reason: "external_step_not_allowed",
    });
    await expect(
      harness.flow.handle({
        conversationId,
        actionId: "payment-report",
        action: { type: "customer_reports_payment" },
      }),
    ).resolves.toEqual({
      status: "rejected",
      reason: "external_step_not_allowed",
    });

    expect(harness.createOrderForConversation).not.toHaveBeenCalled();
    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();
    expect(harness.stateStore.findByConversationId(conversationId)).toBeUndefined();
  });
});
