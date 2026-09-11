import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import {
  ConversationAgentError,
  LocalConversationAgentService,
  type ConversationAgentCommand,
  type ConversationAgentResponse,
  type LocalConversationCheckoutFlow,
  type LocalConversationMenuProvider,
} from "../src/application/local-conversation-agent.js";
import { createOrder, type MenuItemSnapshot } from "../src/domain/order.js";
import type { SumUpMerchantSummary } from "../src/integrations/sumup/client.js";
import { InMemoryConversationStateStore } from "../src/storage/in-memory-conversation-store.js";

const fixedNow = new Date("2026-09-11T20:00:00.000Z");
const conversationId = "synthetic-conversation";
const menu: readonly MenuItemSnapshot[] = [
  {
    id: "synthetic-roll",
    name: "Synthetic Roll",
    unitPriceCents: 1_250,
    available: true,
  },
  {
    id: "synthetic-drink",
    name: "Synthetic Drink",
    unitPriceCents: 300,
    available: true,
  },
  {
    id: "synthetic-unavailable",
    name: "Synthetic Unavailable Item",
    unitPriceCents: 900,
    available: false,
  },
];
const merchant: SumUpMerchantSummary = {
  merchantCode: "synthetic-merchant",
  country: "IE",
  defaultCurrency: "EUR",
  sandbox: true,
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network access is forbidden in conversation tests");
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

interface Harness {
  service: LocalConversationAgentService;
  stateStore: InMemoryConversationStateStore;
  getMenuSnapshot: ReturnType<typeof vi.fn>;
  getDeliveryFeeCents: ReturnType<typeof vi.fn>;
  prepareCheckoutLink: Mock<
    LocalConversationCheckoutFlow["prepareCheckoutLink"]
  >;
  processPaymentWebhook: ReturnType<typeof vi.fn>;
}

function createHarness(options: {
  menuProvider?: LocalConversationMenuProvider;
  checkoutFailure?: Error;
} = {}): Harness {
  const stateStore = new InMemoryConversationStateStore();
  const getMenuSnapshot = vi.fn(() => menu);
  const getDeliveryFeeCents = vi.fn(() => 350);
  const prepareCheckoutLink = vi.fn<
    LocalConversationCheckoutFlow["prepareCheckoutLink"]
  >(async ({ order }) => {
    if (options.checkoutFailure !== undefined) {
      throw options.checkoutFailure;
    }
    return {
      orderId: order.id,
      checkoutId: "synthetic-checkout-id",
      checkoutReference: `synthetic-checkout-reference-${order.id}`,
      checkoutLink: "synthetic-checkout-link",
    };
  });
  const processPaymentWebhook = vi.fn();
  const checkoutFlow = { prepareCheckoutLink, processPaymentWebhook };
  let orderNumber = 0;
  const service = new LocalConversationAgentService({
    stateStore,
    menuProvider: options.menuProvider ?? { getMenuSnapshot },
    deliveryFeePolicy: { getDeliveryFeeCents },
    checkoutFlow,
    checkoutMerchant: merchant,
    createOrder: () =>
      createOrder({
        createId: () => `ord_conversation_${++orderNumber}`,
        now: () => fixedNow,
      }),
    now: () => fixedNow,
  });
  return {
    service,
    stateStore,
    getMenuSnapshot,
    getDeliveryFeeCents,
    prepareCheckoutLink,
    processPaymentWebhook,
  };
}

async function send(
  harness: Harness,
  messageId: string,
  command: ConversationAgentCommand,
): Promise<ConversationAgentResponse> {
  return harness.service.handle({ conversationId, messageId, command });
}

async function makePickupOrderReady(
  harness: Harness,
  prefix = "ready",
): Promise<void> {
  await send(harness, `${prefix}-add`, {
    type: "add_item",
    menuItemId: "synthetic-roll",
  });
  await send(harness, `${prefix}-pickup`, { type: "choose_pickup" });
  await send(harness, `${prefix}-customer`, {
    type: "set_customer",
    firstName: "Synthetic",
    phone: "synthetic-phone",
  });
}

function expectErrorCode(error: unknown, code: ConversationAgentError["code"]): void {
  expect(error).toBeInstanceOf(ConversationAgentError);
  expect((error as ConversationAgentError).code).toBe(code);
}

describe("local transport-neutral conversation agent", () => {
  it("shows the current synthetic menu and adds then removes an item", async () => {
    const harness = createHarness();

    await expect(
      send(harness, "menu", { type: "show_menu" }),
    ).resolves.toMatchObject({ kind: "menu", menu });
    await expect(
      send(harness, "add", {
        type: "add_item",
        menuItemId: "synthetic-roll",
      }),
    ).resolves.toMatchObject({
      kind: "cart",
      order: {
        items: [{ menuItemId: "synthetic-roll", quantity: 1 }],
      },
    });
    await expect(
      send(harness, "remove", {
        type: "remove_item",
        menuItemId: "synthetic-roll",
      }),
    ).resolves.toMatchObject({ kind: "cart", order: { items: [] } });

    expect(harness.getMenuSnapshot).toHaveBeenCalledTimes(2);
  });

  it("changes quantity but rejects zero, negative, fractional and unsafe values", async () => {
    const harness = createHarness();
    await send(harness, "add", {
      type: "add_item",
      menuItemId: "synthetic-roll",
    });

    await expect(
      send(harness, "quantity", {
        type: "set_quantity",
        menuItemId: "synthetic-roll",
        quantity: 3,
      }),
    ).resolves.toMatchObject({
      kind: "cart",
      order: { items: [{ quantity: 3, lineTotalCents: 3_750 }] },
    });

    for (const [index, quantity] of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
    ].entries()) {
      await send(harness, `invalid-${index}`, {
        type: "set_quantity",
        menuItemId: "synthetic-roll",
        quantity,
      }).then(
        () => {
          throw new Error("Expected invalid quantity to fail");
        },
        (error: unknown) => expectErrorCode(error, "invalid_quantity"),
      );
    }
  });

  it("accepts pickup without requesting an address", async () => {
    const harness = createHarness();
    await makePickupOrderReady(harness);

    await expect(
      send(harness, "review", { type: "review_order" }),
    ).resolves.toMatchObject({
      kind: "order_review",
      readyForCheckout: true,
      order: {
        fulfilment: "pickup",
        missingFields: [],
        totals: { fulfilmentCents: 0, totalCents: 1_250 },
      },
    });
    expect(harness.getDeliveryFeeCents).not.toHaveBeenCalled();
  });

  it("requests an address for delivery and applies only the injected fee", async () => {
    const harness = createHarness();
    await send(harness, "add", {
      type: "add_item",
      menuItemId: "synthetic-roll",
    });
    await send(harness, "customer", {
      type: "set_customer",
      firstName: "Synthetic",
      phone: "synthetic-phone",
    });

    await expect(
      send(harness, "delivery", { type: "choose_delivery" }),
    ).resolves.toMatchObject({
      kind: "needs_input",
      order: { missingFields: ["address"], totalIsFinal: false },
    });
    await expect(
      send(harness, "address", {
        type: "set_delivery_address",
        address: {
          line1: " Synthetic Street ",
          city: " Synthetic City ",
          postalCode: " SYN TEST ",
        },
      }),
    ).resolves.toMatchObject({
      kind: "cart",
      order: {
        missingFields: [],
        totals: {
          subtotalCents: 1_250,
          fulfilmentCents: 350,
          totalCents: 1_600,
          currency: "EUR",
        },
        customer: {
          deliveryAddress: {
            line1: "Synthetic Street",
            city: "Synthetic City",
            postalCode: "SYN TEST",
          },
        },
      },
    });
    expect(harness.getDeliveryFeeCents).toHaveBeenCalledOnce();
  });

  it("requests only the missing required customer fields", async () => {
    const harness = createHarness();
    await send(harness, "add", {
      type: "add_item",
      menuItemId: "synthetic-roll",
    });
    await send(harness, "pickup", { type: "choose_pickup" });

    await expect(
      send(harness, "review", { type: "review_order" }),
    ).resolves.toMatchObject({
      kind: "order_review",
      readyForCheckout: false,
      order: { missingFields: ["first_name", "phone"] },
    });
  });

  it("calculates exact integer-cent item, subtotal, delivery and total amounts", async () => {
    const harness = createHarness();
    await send(harness, "roll", {
      type: "add_item",
      menuItemId: "synthetic-roll",
      quantity: 2,
    });
    await send(harness, "drink", {
      type: "add_item",
      menuItemId: "synthetic-drink",
    });
    await send(harness, "customer", {
      type: "set_customer",
      firstName: "Synthetic",
      phone: "synthetic-phone",
    });
    await send(harness, "delivery", { type: "choose_delivery" });
    await send(harness, "address", {
      type: "set_delivery_address",
      address: {
        line1: "Synthetic Street",
        city: "Synthetic City",
        postalCode: "SYN TEST",
      },
    });

    await expect(
      send(harness, "cart", { type: "show_cart" }),
    ).resolves.toMatchObject({
      kind: "cart",
      order: {
        items: [
          { unitPriceCents: 1_250, quantity: 2, lineTotalCents: 2_500 },
          { unitPriceCents: 300, quantity: 1, lineTotalCents: 300 },
        ],
        totals: {
          subtotalCents: 2_800,
          fulfilmentCents: 350,
          totalCents: 3_150,
          currency: "EUR",
        },
      },
    });
  });

  it("prepares checkout only after the order is ready and stores the shared order link", async () => {
    const harness = createHarness();

    await expect(
      send(harness, "checkout-too-early", { type: "prepare_checkout" }),
    ).resolves.toMatchObject({
      kind: "needs_input",
      order: {
        status: "draft",
        missingFields: ["cart", "fulfilment", "first_name", "phone"],
      },
    });
    expect(harness.prepareCheckoutLink).not.toHaveBeenCalled();

    await makePickupOrderReady(harness);
    await expect(
      send(harness, "checkout", { type: "prepare_checkout" }),
    ).resolves.toMatchObject({
      kind: "checkout_ready",
      checkoutLink: "synthetic-checkout-link",
      order: { status: "awaiting_payment" },
    });

    const state = harness.stateStore.findByConversationId(conversationId);
    expect(state?.checkout).toEqual({
      orderId: state?.order.id,
      checkoutId: "synthetic-checkout-id",
      checkoutReference: `synthetic-checkout-reference-${state?.order.id}`,
      checkoutLink: "synthetic-checkout-link",
    });
    expect(harness.prepareCheckoutLink).toHaveBeenCalledOnce();
    expect(harness.prepareCheckoutLink).toHaveBeenCalledWith(
      expect.objectContaining({
        order: expect.objectContaining({
          id: state?.order.id,
          status: "awaiting_payment",
        }),
        paymentAttempt: 1,
        merchant,
      }),
    );
  });

  it("never treats a customer payment report as verified or calls the webhook/Poster flow", async () => {
    const harness = createHarness();
    await makePickupOrderReady(harness);
    await send(harness, "checkout", { type: "prepare_checkout" });

    await expect(
      send(harness, "customer-paid", { type: "customer_reports_payment" }),
    ).resolves.toMatchObject({
      kind: "awaiting_verified_payment",
      order: { status: "awaiting_payment" },
    });
    expect(
      harness.stateStore.findByConversationId(conversationId)?.order.status,
    ).toBe("awaiting_payment");
    expect(harness.processPaymentWebhook).not.toHaveBeenCalled();
  });

  it("returns safe dependency errors without exposing their details", async () => {
    const menuProvider: LocalConversationMenuProvider = {
      getMenuSnapshot: () => {
        throw new Error("sensitive upstream detail");
      },
    };
    const harness = createHarness({ menuProvider });

    await send(harness, "menu", { type: "show_menu" }).then(
      () => {
        throw new Error("Expected menu failure");
      },
      (error: unknown) => {
        expectErrorCode(error, "menu_unavailable");
        expect((error as Error).message).not.toContain("upstream");
      },
    );

    const checkoutHarness = createHarness({
      checkoutFailure: new Error("sensitive checkout detail"),
    });
    await makePickupOrderReady(checkoutHarness, "checkout-failure");
    await send(checkoutHarness, "checkout-failure", {
      type: "prepare_checkout",
    }).then(
      () => {
        throw new Error("Expected checkout failure");
      },
      (error: unknown) => {
        expectErrorCode(error, "checkout_failed");
        expect((error as Error).message).not.toContain("sensitive");
      },
    );
  });

  it("replays the same message safely without duplicating cart or checkout effects", async () => {
    const harness = createHarness();
    const addCommand = {
      type: "add_item",
      menuItemId: "synthetic-roll",
    } as const;

    const first = await send(harness, "repeated-add", addCommand);
    const repeated = await send(harness, "repeated-add", addCommand);
    expect(repeated).toEqual(first);
    expect(
      harness.stateStore.findByConversationId(conversationId)?.order.items,
    ).toMatchObject([{ quantity: 1 }]);

    await send(harness, "pickup", { type: "choose_pickup" });
    await send(harness, "customer", {
      type: "set_customer",
      firstName: "Synthetic",
      phone: "synthetic-phone",
    });
    const checkout = await send(harness, "repeated-checkout", {
      type: "prepare_checkout",
    });
    const repeatedCheckout = await send(harness, "repeated-checkout", {
      type: "prepare_checkout",
    });

    expect(repeatedCheckout).toEqual(checkout);
    expect(harness.prepareCheckoutLink).toHaveBeenCalledOnce();
  });

  it("rejects reuse of a message identity for a different command", async () => {
    const harness = createHarness();
    await send(harness, "same-message", { type: "show_cart" });

    await send(harness, "same-message", { type: "show_menu" }).then(
      () => {
        throw new Error("Expected message conflict");
      },
      (error: unknown) => expectErrorCode(error, "message_conflict"),
    );
  });
});
