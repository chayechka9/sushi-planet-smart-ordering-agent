import { createHash } from "node:crypto";

import {
  OrderDomainError,
  addItem,
  calculateOrderTotals,
  markAwaitingPayment,
  setDelivery,
  setItemQuantity,
  setPickup,
  type DeliveryAddress,
  type MenuItemSnapshot,
  type Order,
  type OrderStatus,
  type OrderTotals,
} from "../domain/order.js";
import type {
  PrepareLocalCheckoutLinkInput,
  PreparedLocalCheckoutLink,
} from "./local-backend-flow.js";
import type { SumUpMerchantSummary } from "../integrations/sumup/client.js";

export type ConversationMissingField =
  | "cart"
  | "fulfilment"
  | "first_name"
  | "phone"
  | "address";

export interface ConversationCustomerState {
  firstName?: string;
  lastName?: string;
  phone?: string;
  deliveryAddress?: DeliveryAddress;
}

export interface ConversationCheckoutState {
  orderId: string;
  checkoutId: string;
  checkoutReference: string;
  checkoutLink: string;
}

export interface ConversationIdentity {
  channel: string;
  userId: string;
}

export type ConversationStatus =
  | "collecting_order"
  | "awaiting_payment"
  | "payment_not_confirmed"
  | "payment_confirmed"
  | "submission_pending"
  | "submission_uncertain"
  | "order_submitted";

export type ConversationPaymentStatus =
  | "not_requested"
  | "awaiting_payment"
  | "payment_not_confirmed"
  | "payment_confirmed";

export type ConversationOrderSubmissionStatus =
  | "not_started"
  | "submission_pending"
  | "submission_uncertain"
  | "order_submitted";

export interface ConversationBackendStatus {
  payment: ConversationPaymentStatus;
  orderSubmission: ConversationOrderSubmissionStatus;
}

export interface ConversationCartItemView {
  menuItemId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface ConversationOrderView {
  orderId: string;
  status: OrderStatus;
  items: readonly ConversationCartItemView[];
  fulfilment: "pickup" | "delivery" | null;
  customer: ConversationCustomerState;
  missingFields: readonly ConversationMissingField[];
  totals: OrderTotals;
  totalIsFinal: boolean;
  backendStatus: ConversationBackendStatus;
}

export type ConversationAgentResponse =
  | {
      kind: "menu";
      menu: readonly MenuItemSnapshot[];
      order: ConversationOrderView;
    }
  | {
      kind: "cart";
      order: ConversationOrderView;
    }
  | {
      kind: "needs_input";
      order: ConversationOrderView;
    }
  | {
      kind: "order_review";
      readyForCheckout: boolean;
      order: ConversationOrderView;
    }
  | {
      kind: "checkout_ready";
      checkoutLink: string;
      order: ConversationOrderView;
    }
  | {
      kind: "awaiting_verified_payment";
      order: ConversationOrderView;
    };

export type ConversationAgentCommand =
  | { type: "show_menu" }
  | { type: "show_cart" }
  | { type: "add_item"; menuItemId: string; quantity?: number }
  | { type: "remove_item"; menuItemId: string }
  | { type: "set_quantity"; menuItemId: string; quantity: number }
  | { type: "choose_pickup" }
  | { type: "choose_delivery" }
  | {
      type: "set_customer";
      firstName?: string;
      lastName?: string;
      phone?: string;
    }
  | { type: "set_delivery_address"; address: DeliveryAddress }
  | { type: "review_order" }
  | { type: "prepare_checkout" }
  | { type: "customer_reports_payment" };

export interface HandleConversationCommandInput {
  conversationId: string;
  messageId: string;
  command: ConversationAgentCommand;
  identity?: ConversationIdentity;
  sourceMessageFingerprint?: string;
}

export interface ProcessedConversationMessage {
  messageId: string;
  commandFingerprint: string;
  sourceMessageFingerprint?: string;
  command?: ConversationAgentCommand;
  response: ConversationAgentResponse;
}

export interface LocalConversationState {
  conversationId: string;
  identity: ConversationIdentity;
  status: ConversationStatus;
  order: Order;
  fulfilmentChoice: "pickup" | "delivery" | null;
  customer: ConversationCustomerState;
  checkout?: ConversationCheckoutState;
  backendStatus: ConversationBackendStatus;
  processedMessages: readonly ProcessedConversationMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface LocalConversationStateStore {
  findByConversationId(
    conversationId: string,
  ): LocalConversationState | undefined;
  findByOrderId(orderId: string): LocalConversationState | undefined;
  save(state: LocalConversationState): void;
}

export interface LocalConversationMenuProvider {
  getMenuSnapshot(): readonly MenuItemSnapshot[];
}

export interface LocalDeliveryFeePolicy {
  getDeliveryFeeCents(address: DeliveryAddress): number;
}

export interface LocalConversationCheckoutFlow {
  prepareCheckoutLink(
    input: PrepareLocalCheckoutLinkInput,
  ): Promise<PreparedLocalCheckoutLink>;
}

export interface LocalConversationAgentDependencies {
  stateStore: LocalConversationStateStore;
  menuProvider: LocalConversationMenuProvider;
  deliveryFeePolicy: LocalDeliveryFeePolicy;
  checkoutFlow: LocalConversationCheckoutFlow;
  checkoutMerchant: SumUpMerchantSummary;
  createOrder: () => Order;
  paymentAttempt?: number;
  now?: () => Date;
}

export type ConversationAgentErrorCode =
  | "invalid_identity"
  | "message_conflict"
  | "menu_unavailable"
  | "menu_item_not_found"
  | "menu_item_unavailable"
  | "invalid_quantity"
  | "cart_item_not_found"
  | "order_locked"
  | "address_not_allowed"
  | "delivery_unavailable"
  | "payment_not_requested"
  | "checkout_failed"
  | "state_unavailable";

export class ConversationAgentError extends Error {
  constructor(readonly code: ConversationAgentErrorCode) {
    super(errorMessage(code));
    this.name = "ConversationAgentError";
  }
}

interface CommandResult {
  state: LocalConversationState;
  response: ConversationAgentResponse;
}

/**
 * Transport-neutral conversation use case.
 *
 * It consumes deterministic commands rather than free-form language and can
 * only prepare a checkout through the existing local backend boundary. It has
 * no webhook reconciliation or Poster dependency, so a customer message can
 * never mark an order paid or trigger a Poster handoff.
 */
export class LocalConversationAgentService {
  private readonly paymentAttempt: number;
  private readonly now: () => Date;

  constructor(private readonly dependencies: LocalConversationAgentDependencies) {
    this.paymentAttempt = dependencies.paymentAttempt ?? 1;
    this.now = dependencies.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.paymentAttempt) || this.paymentAttempt < 1) {
      throw new ConversationAgentError("checkout_failed");
    }
  }

  async handle(
    input: HandleConversationCommandInput,
  ): Promise<ConversationAgentResponse> {
    const conversationId = requireIdentity(input.conversationId);
    const messageId = requireIdentity(input.messageId);
    const commandFingerprint = fingerprintCommand(input.command);
    const processedCommand = parseConversationAgentCommand(input.command);
    const sourceMessageFingerprint = normalizeOptionalFingerprint(
      input.sourceMessageFingerprint,
    );
    const existing = this.loadState(conversationId);
    const identity = normalizeConversationIdentity(
      input.identity ?? { channel: "local", userId: conversationId },
    );
    if (
      existing !== undefined &&
      (existing.identity.channel !== identity.channel ||
        existing.identity.userId !== identity.userId)
    ) {
      throw new ConversationAgentError("invalid_identity");
    }
    const prior = existing?.processedMessages.find(
      (message) => message.messageId === messageId,
    );

    if (prior !== undefined) {
      if (
        prior.commandFingerprint !== commandFingerprint ||
        (sourceMessageFingerprint !== undefined &&
          prior.sourceMessageFingerprint !== undefined &&
          prior.sourceMessageFingerprint !== sourceMessageFingerprint)
      ) {
        throw new ConversationAgentError("message_conflict");
      }
      return prior.response;
    }

    const state = existing ?? this.createInitialState(conversationId, identity);
    const result = await this.applyCommand(state, input.command);
    const updatedAt = this.now().toISOString();
    const nextState: LocalConversationState = {
      ...result.state,
      processedMessages: [
        ...result.state.processedMessages,
        {
          messageId,
          commandFingerprint,
          ...(sourceMessageFingerprint === undefined
            ? {}
            : { sourceMessageFingerprint }),
          ...(processedCommand === undefined
            ? {}
            : { command: processedCommand }),
          response: result.response,
        },
      ],
      updatedAt,
    };
    this.saveState(nextState);
    return result.response;
  }

  private async applyCommand(
    state: LocalConversationState,
    command: ConversationAgentCommand,
  ): Promise<CommandResult> {
    switch (command.type) {
      case "show_menu":
        return {
          state,
          response: {
            kind: "menu",
            menu: this.readMenu(),
            order: toOrderView(state),
          },
        };
      case "show_cart":
        return cartResult(state);
      case "add_item":
        return this.addMenuItem(state, command.menuItemId, command.quantity ?? 1);
      case "remove_item":
        return this.removeMenuItem(state, command.menuItemId);
      case "set_quantity":
        return this.changeQuantity(state, command.menuItemId, command.quantity);
      case "choose_pickup":
        return this.choosePickup(state);
      case "choose_delivery":
        return this.chooseDelivery(state);
      case "set_customer":
        return this.setCustomer(state, command);
      case "set_delivery_address":
        return this.setDeliveryAddress(state, command.address);
      case "review_order": {
        const order = toOrderView(state);
        return {
          state,
          response: {
            kind: "order_review",
            readyForCheckout: order.missingFields.length === 0,
            order,
          },
        };
      }
      case "prepare_checkout":
        return this.prepareCheckout(state);
      case "customer_reports_payment":
        return this.recordCustomerPaymentReport(state);
    }
  }

  private addMenuItem(
    state: LocalConversationState,
    menuItemId: string,
    quantity: number,
  ): CommandResult {
    assertEditable(state);
    assertPositiveQuantity(quantity);
    const menuItem = this.readMenu().find((item) => item.id === menuItemId);
    if (menuItem === undefined) {
      throw new ConversationAgentError("menu_item_not_found");
    }
    if (!menuItem.available) {
      throw new ConversationAgentError("menu_item_unavailable");
    }
    return cartResult({
      ...state,
      order: applyOrderChange(
        () =>
          validateOrderTotals(
            addItem(state.order, menuItem, quantity, this.now()),
            "invalid_quantity",
          ),
        "invalid_quantity",
      ),
    });
  }

  private removeMenuItem(
    state: LocalConversationState,
    menuItemId: string,
  ): CommandResult {
    assertEditable(state);
    if (!state.order.items.some((item) => item.menuItemId === menuItemId)) {
      throw new ConversationAgentError("cart_item_not_found");
    }
    return cartResult({
      ...state,
      order: applyOrderChange(() =>
        setItemQuantity(state.order, menuItemId, 0, this.now()),
      ),
    });
  }

  private changeQuantity(
    state: LocalConversationState,
    menuItemId: string,
    quantity: number,
  ): CommandResult {
    assertEditable(state);
    assertPositiveQuantity(quantity);
    if (!state.order.items.some((item) => item.menuItemId === menuItemId)) {
      throw new ConversationAgentError("cart_item_not_found");
    }
    return cartResult({
      ...state,
      order: applyOrderChange(
        () =>
          validateOrderTotals(
            setItemQuantity(state.order, menuItemId, quantity, this.now()),
            "invalid_quantity",
          ),
        "invalid_quantity",
      ),
    });
  }

  private choosePickup(state: LocalConversationState): CommandResult {
    assertEditable(state);
    const customer = { ...state.customer };
    delete customer.deliveryAddress;
    return cartResult({
      ...state,
      order: applyOrderChange(() => setPickup(state.order, this.now())),
      fulfilmentChoice: "pickup",
      customer,
    });
  }

  private chooseDelivery(state: LocalConversationState): CommandResult {
    assertEditable(state);
    const nextState: LocalConversationState = {
      ...state,
      fulfilmentChoice: "delivery",
    };
    return {
      state: nextState,
      response: { kind: "needs_input", order: toOrderView(nextState) },
    };
  }

  private setCustomer(
    state: LocalConversationState,
    command: Extract<ConversationAgentCommand, { type: "set_customer" }>,
  ): CommandResult {
    assertEditable(state);
    const customer = { ...state.customer };
    updateOptionalText(customer, "firstName", command.firstName);
    updateOptionalText(customer, "lastName", command.lastName);
    updateOptionalText(customer, "phone", command.phone);
    return cartResult({ ...state, customer });
  }

  private setDeliveryAddress(
    state: LocalConversationState,
    address: DeliveryAddress,
  ): CommandResult {
    assertEditable(state);
    if (state.fulfilmentChoice !== "delivery") {
      throw new ConversationAgentError("address_not_allowed");
    }

    let deliveryFeeCents: number;
    try {
      deliveryFeeCents = this.dependencies.deliveryFeePolicy.getDeliveryFeeCents(
        address,
      );
    } catch {
      throw new ConversationAgentError("delivery_unavailable");
    }

    const order = applyOrderChange(
      () =>
        validateOrderTotals(
          setDelivery(state.order, address, deliveryFeeCents, this.now()),
          "delivery_unavailable",
        ),
      "delivery_unavailable",
    );
    const storedAddress = order.fulfilment?.type === "delivery"
      ? order.fulfilment.address
      : undefined;
    if (storedAddress === undefined) {
      throw new ConversationAgentError("delivery_unavailable");
    }
    return cartResult({
      ...state,
      order,
      customer: { ...state.customer, deliveryAddress: storedAddress },
    });
  }

  private async prepareCheckout(
    state: LocalConversationState,
  ): Promise<CommandResult> {
    if (state.checkout !== undefined) {
      return {
        state,
        response: {
          kind: "checkout_ready",
          checkoutLink: state.checkout.checkoutLink,
          order: toOrderView(state),
        },
      };
    }
    assertEditable(state);
    const currentView = toOrderView(state);
    if (currentView.missingFields.length > 0) {
      return {
        state,
        response: { kind: "needs_input", order: currentView },
      };
    }

    const order = applyOrderChange(() =>
      markAwaitingPayment(state.order, this.now()),
    );
    let checkout: PreparedLocalCheckoutLink;
    try {
      checkout = await this.dependencies.checkoutFlow.prepareCheckoutLink({
        order,
        paymentAttempt: this.paymentAttempt,
        merchant: this.dependencies.checkoutMerchant,
      });
    } catch {
      throw new ConversationAgentError("checkout_failed");
    }
    if (
      checkout.orderId !== order.id ||
      checkout.checkoutId.trim().length === 0 ||
      checkout.checkoutReference.trim().length === 0 ||
      checkout.checkoutLink.trim().length === 0
    ) {
      throw new ConversationAgentError("checkout_failed");
    }

    const nextState: LocalConversationState = {
      ...state,
      order,
      backendStatus: {
        payment: "awaiting_payment",
        orderSubmission: "not_started",
      },
      status: "awaiting_payment",
      checkout: {
        orderId: checkout.orderId,
        checkoutId: checkout.checkoutId,
        checkoutReference: checkout.checkoutReference,
        checkoutLink: checkout.checkoutLink,
      },
    };
    return {
      state: nextState,
      response: {
        kind: "checkout_ready",
        checkoutLink: checkout.checkoutLink,
        order: toOrderView(nextState),
      },
    };
  }

  private recordCustomerPaymentReport(
    state: LocalConversationState,
  ): CommandResult {
    if (state.checkout === undefined || state.order.status !== "awaiting_payment") {
      throw new ConversationAgentError("payment_not_requested");
    }
    return {
      state,
      response: {
        kind: "awaiting_verified_payment",
        order: toOrderView(state),
      },
    };
  }

  private readMenu(): MenuItemSnapshot[] {
    let menu: readonly MenuItemSnapshot[];
    try {
      menu = this.dependencies.menuProvider.getMenuSnapshot();
    } catch {
      throw new ConversationAgentError("menu_unavailable");
    }
    const ids = new Set<string>();
    const snapshot: MenuItemSnapshot[] = [];
    for (const item of menu) {
      if (
        item.id.trim().length === 0 ||
        item.name.trim().length === 0 ||
        !Number.isSafeInteger(item.unitPriceCents) ||
        item.unitPriceCents < 0 ||
        ids.has(item.id)
      ) {
        throw new ConversationAgentError("menu_unavailable");
      }
      ids.add(item.id);
      snapshot.push({ ...item });
    }
    return snapshot;
  }

  private createInitialState(
    conversationId: string,
    identity: ConversationIdentity,
  ): LocalConversationState {
    let order: Order;
    try {
      order = this.dependencies.createOrder();
    } catch {
      throw new ConversationAgentError("state_unavailable");
    }
    if (
      order.status !== "draft" ||
      order.items.length !== 0 ||
      order.fulfilment !== null
    ) {
      throw new ConversationAgentError("state_unavailable");
    }
    const timestamp = this.now().toISOString();
    return {
      conversationId,
      identity,
      status: "collecting_order",
      order,
      fulfilmentChoice: null,
      customer: {},
      backendStatus: {
        payment: "not_requested",
        orderSubmission: "not_started",
      },
      processedMessages: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private loadState(conversationId: string): LocalConversationState | undefined {
    try {
      return this.dependencies.stateStore.findByConversationId(conversationId);
    } catch {
      throw new ConversationAgentError("state_unavailable");
    }
  }

  private saveState(state: LocalConversationState): void {
    try {
      this.dependencies.stateStore.save(state);
    } catch {
      throw new ConversationAgentError("state_unavailable");
    }
  }
}

function cartResult(state: LocalConversationState): CommandResult {
  return { state, response: { kind: "cart", order: toOrderView(state) } };
}

function toOrderView(state: LocalConversationState): ConversationOrderView {
  const totals = safeOrderTotals(state.order);
  const missingFields = findMissingFields(state);
  return {
    orderId: state.order.id,
    status: state.order.status,
    items: state.order.items.map((item) => ({
      ...item,
      lineTotalCents: item.unitPriceCents * item.quantity,
    })),
    fulfilment: state.fulfilmentChoice,
    customer: cloneCustomer(state.customer),
    missingFields,
    totals,
    totalIsFinal: missingFields.length === 0,
    backendStatus: { ...state.backendStatus },
  };
}

function safeOrderTotals(order: Order): OrderTotals {
  try {
    return calculateOrderTotals(order);
  } catch (error) {
    if (error instanceof OrderDomainError) {
      throw new ConversationAgentError("state_unavailable");
    }
    throw error;
  }
}

function validateOrderTotals(
  order: Order,
  code: ConversationAgentErrorCode,
): Order {
  try {
    calculateOrderTotals(order);
    return order;
  } catch (error) {
    if (error instanceof OrderDomainError) {
      throw new ConversationAgentError(code);
    }
    throw error;
  }
}

function findMissingFields(
  state: LocalConversationState,
): ConversationMissingField[] {
  const missing: ConversationMissingField[] = [];
  if (state.order.items.length === 0) missing.push("cart");
  if (state.fulfilmentChoice === null) missing.push("fulfilment");
  if (state.customer.firstName === undefined) missing.push("first_name");
  if (state.customer.phone === undefined) missing.push("phone");
  if (
    state.fulfilmentChoice === "delivery" &&
    (state.customer.deliveryAddress === undefined ||
      state.order.fulfilment?.type !== "delivery")
  ) {
    missing.push("address");
  }
  return missing;
}

function assertEditable(state: LocalConversationState): void {
  if (state.order.status !== "draft" || state.checkout !== undefined) {
    throw new ConversationAgentError("order_locked");
  }
}

function assertPositiveQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new ConversationAgentError("invalid_quantity");
  }
}

function applyOrderChange(
  operation: () => Order,
  code: ConversationAgentErrorCode = "order_locked",
): Order {
  try {
    return operation();
  } catch (error) {
    if (error instanceof OrderDomainError) {
      throw new ConversationAgentError(code);
    }
    throw error;
  }
}

function updateOptionalText(
  customer: ConversationCustomerState,
  key: "firstName" | "lastName" | "phone",
  value: string | undefined,
): void {
  if (value === undefined) return;
  const normalized = value.trim();
  if (normalized.length === 0) {
    delete customer[key];
  } else {
    customer[key] = normalized;
  }
}

function requireIdentity(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ConversationAgentError("invalid_identity");
  }
  return normalized;
}

function normalizeConversationIdentity(
  identity: ConversationIdentity,
): ConversationIdentity {
  return {
    channel: requireIdentity(identity.channel),
    userId: requireIdentity(identity.userId),
  };
}

function fingerprintCommand(command: ConversationAgentCommand): string {
  const serialized = JSON.stringify(sortValue(command));
  if (serialized === undefined) {
    throw new ConversationAgentError("state_unavailable");
  }
  return createHash("sha256")
    .update(serialized, "utf8")
    .digest("hex");
}

function normalizeOptionalFingerprint(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new ConversationAgentError("state_unavailable");
  }
  return value;
}

export function parseConversationAgentCommand(
  value: unknown,
): ConversationAgentCommand | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;

  switch (value.type) {
    case "show_menu":
    case "show_cart":
    case "choose_pickup":
    case "choose_delivery":
    case "review_order":
    case "prepare_checkout":
    case "customer_reports_payment":
      return hasExactKeys(value, ["type"])
        ? { type: value.type }
        : undefined;
    case "add_item": {
      if (
        !hasNoUnexpectedKeys(value, ["type", "menuItemId", "quantity"]) ||
        !isNonEmptyString(value.menuItemId)
      ) {
        return undefined;
      }
      if (value.quantity !== undefined && !isPositiveInteger(value.quantity)) {
        return undefined;
      }
      return {
        type: "add_item",
        menuItemId: value.menuItemId.trim(),
        ...(value.quantity === undefined ? {} : { quantity: value.quantity }),
      };
    }
    case "remove_item":
      return hasExactKeys(value, ["type", "menuItemId"]) &&
        isNonEmptyString(value.menuItemId)
        ? { type: "remove_item", menuItemId: value.menuItemId.trim() }
        : undefined;
    case "set_quantity":
      return hasExactKeys(value, ["type", "menuItemId", "quantity"]) &&
        isNonEmptyString(value.menuItemId) &&
        isPositiveInteger(value.quantity)
        ? {
            type: "set_quantity",
            menuItemId: value.menuItemId.trim(),
            quantity: value.quantity,
          }
        : undefined;
    case "set_customer":
      if (
        !hasNoUnexpectedKeys(value, ["type", "firstName", "lastName", "phone"]) ||
        !optionalNonEmptyString(value.firstName) ||
        !optionalNonEmptyString(value.lastName) ||
        !optionalNonEmptyString(value.phone)
      ) {
        return undefined;
      }
      return {
        type: "set_customer",
        ...(value.firstName === undefined
          ? {}
          : { firstName: value.firstName.trim() }),
        ...(value.lastName === undefined
          ? {}
          : { lastName: value.lastName.trim() }),
        ...(value.phone === undefined ? {} : { phone: value.phone.trim() }),
      };
    case "set_delivery_address": {
      if (
        !hasExactKeys(value, ["type", "address"]) ||
        !isRecord(value.address) ||
        !hasExactKeys(value.address, ["line1", "city", "postalCode"]) ||
        !isNonEmptyString(value.address.line1) ||
        !isNonEmptyString(value.address.city) ||
        !isNonEmptyString(value.address.postalCode)
      ) {
        return undefined;
      }
      return {
        type: "set_delivery_address",
        address: {
          line1: value.address.line1.trim(),
          city: value.address.city.trim(),
          postalCode: value.address.postalCode.trim(),
        },
      };
    }
    default:
      return undefined;
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return (
    Object.keys(value).length === allowed.size &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function hasNoUnexpectedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}

function cloneCustomer(
  customer: ConversationCustomerState,
): ConversationCustomerState {
  return {
    ...(customer.firstName === undefined ? {} : { firstName: customer.firstName }),
    ...(customer.lastName === undefined ? {} : { lastName: customer.lastName }),
    ...(customer.phone === undefined ? {} : { phone: customer.phone }),
    ...(customer.deliveryAddress === undefined
      ? {}
      : { deliveryAddress: { ...customer.deliveryAddress } }),
  };
}

function errorMessage(code: ConversationAgentErrorCode): string {
  switch (code) {
    case "invalid_identity":
      return "Conversation identity is invalid";
    case "message_conflict":
      return "Message identity was reused for different input";
    case "menu_unavailable":
      return "Menu is temporarily unavailable";
    case "menu_item_not_found":
      return "Menu item was not found";
    case "menu_item_unavailable":
      return "Menu item is unavailable";
    case "invalid_quantity":
      return "Quantity must be a positive integer";
    case "cart_item_not_found":
      return "Cart item was not found";
    case "order_locked":
      return "Order can no longer be edited";
    case "address_not_allowed":
      return "Delivery must be selected before setting an address";
    case "delivery_unavailable":
      return "Delivery details could not be confirmed";
    case "payment_not_requested":
      return "Payment has not been requested for this order";
    case "checkout_failed":
      return "Checkout could not be prepared";
    case "state_unavailable":
      return "Conversation state is unavailable";
  }
}
