import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LocalConversationBackendBridge,
  type ConversationBackendEventResult,
} from "../src/application/local-conversation-backend-bridge.js";
import { LocalBackendFlowService } from "../src/application/local-backend-flow.js";
import {
  LocalConversationAgentService,
  type ConversationAgentCommand,
  type ConversationAgentResponse,
} from "../src/application/local-conversation-agent.js";
import type {
  VerifiedSumUpCheckout,
  VerifiedSumUpCheckoutStatus,
} from "../src/domain/payment.js";
import { createOrder, type MenuItemSnapshot } from "../src/domain/order.js";
import type { PosterOrderSubmitter } from "../src/integrations/poster/submitter.js";
import type { SumUpMerchantSummary } from "../src/integrations/sumup/client.js";
import { SqliteConversationStateStore } from "../src/storage/sqlite/conversation-state-store.js";
import { SqliteOrderPaymentRepository } from "../src/storage/sqlite/order-payment-repository.js";

const fixedNow = new Date("2026-09-11T21:00:00.000Z");
const conversationId = "synthetic-status-conversation";
const orderId = "ord_conversation_status";
const checkoutId = "synthetic-status-checkout";
const menu: readonly MenuItemSnapshot[] = [
  {
    id: "1",
    name: "Synthetic Product",
    unitPriceCents: 1_000,
    available: true,
  },
];
const merchant: SumUpMerchantSummary = {
  merchantCode: "synthetic-merchant",
  country: "IE",
  defaultCurrency: "EUR",
  sandbox: true,
};

const repositories: SqliteOrderPaymentRepository[] = [];
const conversationStores: SqliteConversationStateStore[] = [];
const temporaryDirectories: string[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network access is forbidden in conversation bridge tests");
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  for (const store of conversationStores.splice(0).reverse()) store.close();
  for (const repository of repositories.splice(0).reverse()) repository.close();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Harness {
  agent: LocalConversationAgentService;
  backendFlow: LocalBackendFlowService;
  bridge: LocalConversationBackendBridge;
  conversationStore: SqliteConversationStateStore;
  repository: SqliteOrderPaymentRepository;
  createCheckout: ReturnType<typeof vi.fn>;
  verifyCheckout: ReturnType<typeof vi.fn>;
  submitOrder: ReturnType<typeof vi.fn>;
}

function createHarness(options: {
  checkoutStatus?: VerifiedSumUpCheckoutStatus;
  verifierFailure?: boolean;
  posterFailure?: boolean;
} = {}): Harness {
  const directory = mkdtempSync(join(tmpdir(), "conversation-bridge-test-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "orders.sqlite");
  const repository = new SqliteOrderPaymentRepository(databasePath);
  repositories.push(repository);
  const conversationStore = new SqliteConversationStateStore(databasePath);
  conversationStores.push(conversationStore);
  const createCheckout = vi.fn(async (preparation) => ({
    checkoutId,
    checkoutReference: preparation.checkoutReference,
    merchantCode: preparation.payload.merchant_code,
    amountCents: preparation.amountCents,
    currency: "EUR" as const,
    status: "PENDING" as const,
    hostedCheckoutUrl: "synthetic-checkout-link",
  }));
  const checkoutStatus = options.checkoutStatus ?? "PAID";
  const verifyCheckout = vi.fn(async (): Promise<VerifiedSumUpCheckout> => {
    if (options.verifierFailure === true) {
      throw new Error("sensitive verifier detail");
    }
    return {
      checkoutId,
      checkoutReference: `sumup-${orderId}-1`,
      merchantCode: merchant.merchantCode,
      amountCents: 1_000,
      currency: "EUR",
      status: checkoutStatus,
      transactions:
        checkoutStatus === "PAID"
          ? [
              {
                id: "synthetic-status-transaction",
                status: "SUCCESSFUL",
                amountCents: 1_000,
                currency: "EUR",
              },
            ]
          : [],
    };
  });
  const submitOrder = vi.fn(async () => {
    if (options.posterFailure === true) {
      throw new Error("sensitive Poster detail");
    }
    return { posterOrderId: "synthetic-poster-order" };
  });
  const posterSubmitter: PosterOrderSubmitter = { submitOrder };
  const backendFlow = new LocalBackendFlowService({
    repository,
    checkoutCreator: { createCheckout },
    checkoutVerifier: { verifyCheckout },
    posterSubmitter,
    now: () => fixedNow,
  });
  const agent = new LocalConversationAgentService({
    stateStore: conversationStore,
    menuProvider: { getMenuSnapshot: () => menu },
    deliveryFeePolicy: { getDeliveryFeeCents: () => 350 },
    checkoutFlow: backendFlow,
    checkoutMerchant: merchant,
    createOrder: () =>
      createOrder({ createId: () => orderId, now: () => fixedNow }),
    now: () => fixedNow,
  });
  const bridge = new LocalConversationBackendBridge({
    backendFlow,
    repository,
    stateStore: conversationStore,
  });
  return {
    agent,
    backendFlow,
    bridge,
    conversationStore,
    repository,
    createCheckout,
    verifyCheckout,
    submitOrder,
  };
}

async function send(
  harness: Harness,
  messageId: string,
  command: ConversationAgentCommand,
): Promise<ConversationAgentResponse> {
  return harness.agent.handle({ conversationId, messageId, command });
}

async function prepareConversationCheckout(
  harness: Harness,
): Promise<ConversationAgentResponse> {
  await send(harness, "add", { type: "add_item", menuItemId: "1" });
  await send(harness, "pickup", { type: "choose_pickup" });
  await send(harness, "customer", {
    type: "set_customer",
    firstName: "Synthetic",
    phone: "synthetic-phone",
  });
  return send(harness, "checkout", { type: "prepare_checkout" });
}

async function processWebhook(
  harness: Harness,
  id = checkoutId,
): Promise<ConversationBackendEventResult> {
  return harness.bridge.process({
    body: { event_type: "CHECKOUT_STATUS_CHANGED", id },
    spotId: "1",
    comment: "SYNTHETIC CONVERSATION STATUS",
  });
}

describe("local conversation to verified backend status bridge", () => {
  it("creates checkout through the backend flow and keeps conversation awaiting payment", async () => {
    const harness = createHarness();

    await expect(prepareConversationCheckout(harness)).resolves.toMatchObject({
      kind: "checkout_ready",
      order: {
        status: "awaiting_payment",
        backendStatus: {
          payment: "awaiting_payment",
          orderSubmission: "not_started",
        },
      },
    });

    expect(harness.createCheckout).toHaveBeenCalledOnce();
    expect(harness.repository.findOrderById(orderId)?.status).toBe(
      "awaiting_payment",
    );
    expect(harness.repository.findByOrderId(orderId)?.status).toBe("pending");
  });

  it("emits payment_confirmed only after verified reconciliation", async () => {
    const harness = createHarness();
    await prepareConversationCheckout(harness);

    const result = await processWebhook(harness);

    expect(result.events).toContain("payment_confirmed");
    expect(result.status?.payment).toBe("payment_confirmed");
    expect(harness.verifyCheckout).toHaveBeenCalledOnce();
    expect(harness.repository.findByOrderId(orderId)?.status).toBe("paid");
  });

  it("does not emit a second confirmation for a duplicate webhook", async () => {
    const harness = createHarness();
    await prepareConversationCheckout(harness);
    await processWebhook(harness);

    const duplicate = await processWebhook(harness);

    expect(duplicate.events).toEqual(["already_processed"]);
    expect(duplicate.events).not.toContain("payment_confirmed");
    expect(duplicate.status).toEqual({
      payment: "payment_confirmed",
      orderSubmission: "order_submitted",
    });
    expect(harness.verifyCheckout).toHaveBeenCalledOnce();
    expect(harness.submitOrder).toHaveBeenCalledOnce();
  });

  it.each([
    {
      checkoutStatus: "PENDING" as const,
      event: "payment_pending" as const,
      payment: "awaiting_payment" as const,
    },
    {
      checkoutStatus: "FAILED" as const,
      event: "payment_not_confirmed" as const,
      payment: "payment_not_confirmed" as const,
    },
  ])(
    "maps $checkoutStatus without confirming payment",
    async ({ checkoutStatus, event, payment }) => {
      const harness = createHarness({ checkoutStatus });
      await prepareConversationCheckout(harness);

      const result = await processWebhook(harness);

      expect(result.events).toEqual([event]);
      expect(result.events).not.toContain("payment_confirmed");
      expect(result.status).toEqual({
        payment,
        orderSubmission: "not_started",
      });
      expect(harness.repository.findOrderById(orderId)?.status).toBe(
        "awaiting_payment",
      );
      expect(harness.submitOrder).not.toHaveBeenCalled();
    },
  );

  it("emits order_submitted only after the backend Poster handoff succeeds", async () => {
    const harness = createHarness();
    await prepareConversationCheckout(harness);

    await expect(processWebhook(harness)).resolves.toEqual({
      events: ["payment_confirmed", "order_submitted"],
      status: {
        payment: "payment_confirmed",
        orderSubmission: "order_submitted",
      },
    });
    expect(harness.submitOrder).toHaveBeenCalledOnce();
    expect(
      harness.conversationStore.findByOrderId(orderId)?.order.status,
    ).toBe("submitted_to_poster");
  });

  it("keeps a safe uncertain status when the Poster result is ambiguous", async () => {
    const harness = createHarness({ posterFailure: true });
    await prepareConversationCheckout(harness);

    await expect(processWebhook(harness)).resolves.toEqual({
      events: ["payment_confirmed", "order_submission_uncertain"],
      status: {
        payment: "payment_confirmed",
        orderSubmission: "submission_uncertain",
      },
    });
    expect(harness.repository.findOrderById(orderId)?.status).toBe("paid");
    expect(
      harness.repository.findPosterHandoffByOrderId(orderId)?.status,
    ).toBe("uncertain");
    expect(harness.submitOrder).toHaveBeenCalledOnce();
  });

  it("does not change another conversation for an unknown payment or order", async () => {
    const harness = createHarness();
    await prepareConversationCheckout(harness);
    const before = harness.conversationStore.findByConversationId(conversationId);

    await expect(processWebhook(harness, "unknown-checkout")).resolves.toEqual({
      events: ["unknown_payment"],
      status: null,
    });
    expect(
      harness.conversationStore.findByConversationId(conversationId),
    ).toEqual(before);

    const emptyConversationStore = new SqliteConversationStateStore(
      join(temporaryDirectories[0]!, "empty-conversations.sqlite"),
    );
    conversationStores.push(emptyConversationStore);
    const bridgeWithoutConversation = new LocalConversationBackendBridge({
      backendFlow: harness.backendFlow,
      repository: harness.repository,
      stateStore: emptyConversationStore,
    });
    await expect(
      bridgeWithoutConversation.process({
        body: { event_type: "CHECKOUT_STATUS_CHANGED", id: checkoutId },
        spotId: "1",
      }),
    ).resolves.toEqual({ events: ["unknown_order"], status: null });

    expect(harness.verifyCheckout).not.toHaveBeenCalled();
    expect(harness.repository.findByOrderId(orderId)?.status).toBe("pending");
    expect(harness.submitOrder).not.toHaveBeenCalled();
  });

  it("never hands off to Poster for a customer claim or unverified payment", async () => {
    const harness = createHarness({ checkoutStatus: "PENDING" });
    await prepareConversationCheckout(harness);

    await expect(
      send(harness, "customer-paid", { type: "customer_reports_payment" }),
    ).resolves.toMatchObject({
      kind: "awaiting_verified_payment",
      order: { status: "awaiting_payment" },
    });
    expect(harness.repository.findByOrderId(orderId)?.status).toBe("pending");
    expect(harness.submitOrder).not.toHaveBeenCalled();

    await processWebhook(harness);
    expect(harness.submitOrder).not.toHaveBeenCalled();
  });

  it("returns a safe processing status when verification fails", async () => {
    const harness = createHarness({ verifierFailure: true });
    await prepareConversationCheckout(harness);

    await expect(processWebhook(harness)).resolves.toEqual({
      events: ["processing_error"],
      status: {
        payment: "awaiting_payment",
        orderSubmission: "not_started",
      },
    });
    expect(harness.repository.findByOrderId(orderId)?.status).toBe("pending");
    expect(harness.submitOrder).not.toHaveBeenCalled();
  });
});
