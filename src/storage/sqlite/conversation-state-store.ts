import { DatabaseSync } from "node:sqlite";

import {
  parseConversationAgentCommand,
  type ConversationAgentResponse,
  type ConversationBackendStatus,
  type ConversationCartItemView,
  type ConversationCheckoutState,
  type ConversationCustomerState,
  type ConversationIdentity,
  type ConversationMissingField,
  type ConversationOrderSubmissionStatus,
  type ConversationOrderView,
  type ConversationPaymentStatus,
  type ConversationStatus,
  type LocalConversationState,
  type LocalConversationStateStore,
  type PendingStaffHandoffRequest,
  type ProcessedConversationMessage,
} from "../../application/local-conversation-agent.js";
import {
  calculateOrderTotals,
  type CartItem,
  type DeliveryAddress,
  type Fulfilment,
  type MenuItemSnapshot,
  type Order,
  type OrderStatus,
  type OrderTotals,
} from "../../domain/order.js";
import { applySqliteMigrations } from "./migrations.js";

interface ConversationRow {
  conversation_id: unknown;
  channel: unknown;
  user_id: unknown;
  order_id: unknown;
  checkout_id: unknown;
  checkout_reference: unknown;
  checkout_link: unknown;
  status: unknown;
  payment_status: unknown;
  order_submission_status: unknown;
  last_processed_message_id: unknown;
  state_json: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface SqliteConversationStateStoreOptions {
  readOnly?: boolean;
}

export class SqliteConversationStateStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqliteConversationStateStoreError";
  }
}

/** Durable implementation of the existing transport-neutral conversation port. */
export class SqliteConversationStateStore
  implements LocalConversationStateStore
{
  private readonly database: DatabaseSync;
  private readonly readOnly: boolean;
  private closed = false;

  constructor(
    databasePath: string,
    options: SqliteConversationStateStoreOptions = {},
  ) {
    if (databasePath.trim().length === 0) {
      throw new SqliteConversationStateStoreError(
        "SQLite database path must not be empty",
      );
    }

    this.readOnly = options.readOnly ?? false;
    this.database = new DatabaseSync(databasePath, {
      readOnly: this.readOnly,
    });

    try {
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA busy_timeout = 5000");
      if (!this.readOnly) {
        this.database.exec("PRAGMA synchronous = FULL");
        applySqliteMigrations(this.database);
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  findByConversationId(
    conversationId: string,
  ): LocalConversationState | undefined {
    const row = this.database
      .prepare(`${SELECT_CONVERSATION} WHERE conversation_id = ?`)
      .get(conversationId) as unknown as ConversationRow | undefined;
    return row === undefined ? undefined : readConversation(row);
  }

  findByOrderId(orderId: string): LocalConversationState | undefined {
    const row = this.database
      .prepare(`${SELECT_CONVERSATION} WHERE order_id = ?`)
      .get(orderId) as unknown as ConversationRow | undefined;
    return row === undefined ? undefined : readConversation(row);
  }

  listPendingStaffHandoffRequests(): readonly PendingStaffHandoffRequest[] {
    const rows = this.database
      .prepare(`${SELECT_CONVERSATION} ORDER BY updated_at, conversation_id`)
      .all() as unknown as ConversationRow[];
    return rows.flatMap((row) => {
      const state = readConversation(row);
      return state.staffHandoffRequest === undefined
        ? []
        : [{
            conversationId: state.conversationId,
            orderId: state.order.id,
            ...state.staffHandoffRequest,
          }];
    });
  }

  save(state: LocalConversationState): void {
    this.assertWritable();
    const payload = serializeConversation(state);
    const lastMessageId =
      state.processedMessages.at(-1)?.messageId ?? null;

    this.runInTransaction(() => {
      const existingRow = this.database
        .prepare(`${SELECT_CONVERSATION} WHERE conversation_id = ?`)
        .get(state.conversationId) as unknown as ConversationRow | undefined;

      if (existingRow === undefined) {
        this.database
          .prepare(
            `INSERT INTO conversations (
               conversation_id,
               channel,
               user_id,
               order_id,
               checkout_id,
               checkout_reference,
               checkout_link,
               status,
               payment_status,
               order_submission_status,
               last_processed_message_id,
               state_json,
               created_at,
               updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...writeValues(state, lastMessageId, payload));
        return;
      }

      const existing = readConversation(existingRow);
      assertAllowedUpdate(existing, state);
      const update = this.database
        .prepare(
          `UPDATE conversations
           SET
             channel = ?,
             user_id = ?,
             order_id = ?,
             checkout_id = ?,
             checkout_reference = ?,
             checkout_link = ?,
             status = ?,
             payment_status = ?,
             order_submission_status = ?,
             last_processed_message_id = ?,
             state_json = ?,
             created_at = ?,
             updated_at = ?
           WHERE conversation_id = ? AND state_json = ?`,
        )
        .run(
          state.identity.channel,
          state.identity.userId,
          state.order.id,
          state.checkout?.checkoutId ?? null,
          state.checkout?.checkoutReference ?? null,
          state.checkout?.checkoutLink ?? null,
          state.status,
          state.backendStatus.payment,
          state.backendStatus.orderSubmission,
          lastMessageId,
          payload,
          state.createdAt,
          state.updatedAt,
          state.conversationId,
          requireString(existingRow.state_json, "Stored conversation payload"),
        );
      if (update.changes !== 1) {
        throw new SqliteConversationStateStoreError(
          "Conversation changed during update",
        );
      }
    });
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }

  private assertWritable(): void {
    if (this.readOnly) {
      throw new SqliteConversationStateStoreError(
        "SQLite conversation store is read-only",
      );
    }
  }

  private runInTransaction(operation: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original validation, concurrency or constraint error.
      }
      if (error instanceof SqliteConversationStateStoreError) throw error;
      if (isSqliteConstraintError(error)) {
        throw new SqliteConversationStateStoreError(
          "Stored conversation identities and references must be unique and valid",
        );
      }
      throw error;
    }
  }
}

const SELECT_CONVERSATION = `SELECT
  conversation_id,
  channel,
  user_id,
  order_id,
  checkout_id,
  checkout_reference,
  checkout_link,
  status,
  payment_status,
  order_submission_status,
  last_processed_message_id,
  state_json,
  created_at,
  updated_at
FROM conversations`;

function writeValues(
  state: LocalConversationState,
  lastMessageId: string | null,
  payload: string,
): readonly (string | null)[] {
  return [
    state.conversationId,
    state.identity.channel,
    state.identity.userId,
    state.order.id,
    state.checkout?.checkoutId ?? null,
    state.checkout?.checkoutReference ?? null,
    state.checkout?.checkoutLink ?? null,
    state.status,
    state.backendStatus.payment,
    state.backendStatus.orderSubmission,
    lastMessageId,
    payload,
    state.createdAt,
    state.updatedAt,
  ];
}

function serializeConversation(state: LocalConversationState): string {
  assertValidState(state);
  return JSON.stringify({
    conversationId: state.conversationId,
    identity: { ...state.identity },
    status: state.status,
    order: cloneOrder(state.order),
    fulfilmentChoice: state.fulfilmentChoice,
    customer: cloneCustomer(state.customer),
    ...(state.checkout === undefined
      ? {}
      : { checkout: { ...state.checkout } }),
    ...(state.staffHandoffRequest === undefined
      ? {}
      : { staffHandoffRequest: { ...state.staffHandoffRequest } }),
    backendStatus: { ...state.backendStatus },
    processedMessages: state.processedMessages.map((message) => ({
      messageId: message.messageId,
      commandFingerprint: message.commandFingerprint,
      ...(message.sourceMessageFingerprint === undefined
        ? {}
        : { sourceMessageFingerprint: message.sourceMessageFingerprint }),
      ...(message.command === undefined
        ? {}
        : { command: structuredClone(message.command) }),
      response: cloneResponse(message.response),
    })),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  });
}

function readConversation(row: ConversationRow): LocalConversationState {
  const payload = requireString(row.state_json, "Stored conversation payload");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new SqliteConversationStateStoreError(
      "Stored conversation payload is invalid JSON",
    );
  }

  const state = readState(parsed);
  const lastMessageId = state.processedMessages.at(-1)?.messageId ?? null;
  if (
    requireString(row.conversation_id, "Stored conversation ID") !==
      state.conversationId ||
    requireString(row.channel, "Stored conversation channel") !==
      state.identity.channel ||
    requireString(row.user_id, "Stored conversation user ID") !==
      state.identity.userId ||
    requireString(row.order_id, "Stored conversation order ID") !==
      state.order.id ||
    requireNullableString(row.checkout_id, "Stored checkout ID") !==
      (state.checkout?.checkoutId ?? null) ||
    requireNullableString(
      row.checkout_reference,
      "Stored checkout reference",
    ) !== (state.checkout?.checkoutReference ?? null) ||
    requireNullableString(row.checkout_link, "Stored checkout link") !==
      (state.checkout?.checkoutLink ?? null) ||
    requireConversationStatus(row.status) !== state.status ||
    requirePaymentStatus(row.payment_status) !== state.backendStatus.payment ||
    requireSubmissionStatus(row.order_submission_status) !==
      state.backendStatus.orderSubmission ||
    requireNullableString(
      row.last_processed_message_id,
      "Stored last processed message ID",
    ) !== lastMessageId ||
    requireTimestamp(row.created_at, "Stored conversation created_at") !==
      state.createdAt ||
    requireTimestamp(row.updated_at, "Stored conversation updated_at") !==
      state.updatedAt
  ) {
    throw new SqliteConversationStateStoreError(
      "Stored conversation columns do not match the payload",
    );
  }
  return state;
}

function readState(value: unknown): LocalConversationState {
  const record = requireRecord(value, "Stored conversation state");
  const checkout =
    record.checkout === undefined
      ? undefined
      : readCheckout(record.checkout);
  const staffHandoffRequest =
    record.staffHandoffRequest === undefined
      ? undefined
      : readStaffHandoffRequest(record.staffHandoffRequest);
  const state: LocalConversationState = {
    conversationId: requireString(record.conversationId, "Conversation ID"),
    identity: readIdentity(record.identity),
    status: requireConversationStatus(record.status),
    order: readOrder(record.order),
    fulfilmentChoice: requireFulfilmentChoice(record.fulfilmentChoice),
    customer: readCustomer(record.customer),
    ...(checkout === undefined ? {} : { checkout }),
    ...(staffHandoffRequest === undefined ? {} : { staffHandoffRequest }),
    backendStatus: readBackendStatus(record.backendStatus),
    processedMessages: readProcessedMessages(record.processedMessages),
    createdAt: requireTimestamp(record.createdAt, "Conversation createdAt"),
    updatedAt: requireTimestamp(record.updatedAt, "Conversation updatedAt"),
  };
  assertValidState(state);
  return state;
}

function assertValidState(state: LocalConversationState): void {
  requireString(state.conversationId, "Conversation ID");
  readIdentity(state.identity);
  requireConversationStatus(state.status);
  const order = readOrder(state.order);
  requireFulfilmentChoice(state.fulfilmentChoice);
  const customer = readCustomer(state.customer);
  const backendStatus = readBackendStatus(state.backendStatus);
  const messages = readProcessedMessages(state.processedMessages);
  const staffHandoffRequest = state.staffHandoffRequest === undefined
    ? undefined
    : readStaffHandoffRequest(state.staffHandoffRequest);
  const createdAt = requireTimestamp(state.createdAt, "Conversation createdAt");
  const updatedAt = requireTimestamp(state.updatedAt, "Conversation updatedAt");
  if (updatedAt < createdAt) {
    throw new SqliteConversationStateStoreError(
      "Conversation updatedAt precedes createdAt",
    );
  }
  if (
    staffHandoffRequest !== undefined &&
    (staffHandoffRequest.requestedAt < createdAt ||
      staffHandoffRequest.requestedAt > updatedAt)
  ) {
    throw new SqliteConversationStateStoreError(
      "Staff handoff timestamp is outside the conversation lifetime",
    );
  }
  if (state.status !== statusFromBackend(backendStatus)) {
    throw new SqliteConversationStateStoreError(
      "Conversation status does not match its backend snapshot",
    );
  }
  if (state.fulfilmentChoice === "pickup" && order.fulfilment?.type !== "pickup") {
    throw new SqliteConversationStateStoreError(
      "Pickup choice does not match the order",
    );
  }
  if (
    order.fulfilment?.type === "delivery" &&
    (state.fulfilmentChoice !== "delivery" ||
      customer.deliveryAddress === undefined ||
      JSON.stringify(customer.deliveryAddress) !==
        JSON.stringify(order.fulfilment.address))
  ) {
    throw new SqliteConversationStateStoreError(
      "Delivery state does not match the order",
    );
  }
  if (backendStatus.payment === "not_requested") {
    if (state.checkout !== undefined || order.status !== "draft") {
      throw new SqliteConversationStateStoreError(
        "Unpaid conversation has an invalid checkout snapshot",
      );
    }
  } else {
    if (state.checkout === undefined || state.checkout.orderId !== order.id) {
      throw new SqliteConversationStateStoreError(
        "Payment conversation must have a matching checkout",
      );
    }
    readCheckout(state.checkout);
  }
  if (
    backendStatus.payment !== "payment_confirmed" &&
    backendStatus.orderSubmission !== "not_started"
  ) {
    throw new SqliteConversationStateStoreError(
      "Poster submission cannot precede confirmed payment",
    );
  }
  if (
    backendStatus.payment === "payment_confirmed" &&
    order.status !== "paid" &&
    order.status !== "submitted_to_poster"
  ) {
    throw new SqliteConversationStateStoreError(
      "Confirmed payment does not match the order",
    );
  }
  if (
    (backendStatus.payment === "awaiting_payment" ||
      backendStatus.payment === "payment_not_confirmed") &&
    order.status !== "awaiting_payment"
  ) {
    throw new SqliteConversationStateStoreError(
      "Unconfirmed payment cannot advance the order",
    );
  }
  if (
    (backendStatus.orderSubmission === "order_submitted") !==
    (order.status === "submitted_to_poster")
  ) {
    throw new SqliteConversationStateStoreError(
      "Submitted conversation does not match the order",
    );
  }
  const ids = new Set<string>();
  for (const message of messages) {
    if (ids.has(message.messageId)) {
      throw new SqliteConversationStateStoreError(
        "Processed message IDs must be unique",
      );
    }
    ids.add(message.messageId);
  }
}

function assertAllowedUpdate(
  existing: LocalConversationState,
  next: LocalConversationState,
): void {
  if (
    existing.conversationId !== next.conversationId ||
    existing.identity.channel !== next.identity.channel ||
    existing.identity.userId !== next.identity.userId ||
    existing.order.id !== next.order.id ||
    existing.createdAt !== next.createdAt
  ) {
    throw new SqliteConversationStateStoreError(
      "Conversation identity is immutable",
    );
  }
  if (next.updatedAt < existing.updatedAt) {
    throw new SqliteConversationStateStoreError(
      "Conversation timestamp cannot move backwards",
    );
  }
  if (
    existing.checkout !== undefined &&
    JSON.stringify(existing.checkout) !== JSON.stringify(next.checkout)
  ) {
    throw new SqliteConversationStateStoreError(
      "Conversation checkout identity is immutable",
    );
  }
  if (
    existing.staffHandoffRequest !== undefined &&
    JSON.stringify(existing.staffHandoffRequest) !==
      JSON.stringify(next.staffHandoffRequest)
  ) {
    throw new SqliteConversationStateStoreError(
      "Staff handoff request is immutable",
    );
  }
  if (
    existing.backendStatus.payment === "payment_confirmed" &&
    next.backendStatus.payment !== "payment_confirmed"
  ) {
    throw new SqliteConversationStateStoreError(
      "Confirmed payment status cannot regress",
    );
  }
  if (
    existing.backendStatus.orderSubmission === "order_submitted" &&
    next.backendStatus.orderSubmission !== "order_submitted"
  ) {
    throw new SqliteConversationStateStoreError(
      "Submitted order status cannot regress",
    );
  }
  if (next.processedMessages.length < existing.processedMessages.length) {
    throw new SqliteConversationStateStoreError(
      "Processed message history cannot shrink",
    );
  }
  for (const [index, message] of existing.processedMessages.entries()) {
    if (JSON.stringify(message) !== JSON.stringify(next.processedMessages[index])) {
      throw new SqliteConversationStateStoreError(
        "Processed message history is immutable",
      );
    }
  }
}

function readIdentity(value: unknown): ConversationIdentity {
  const record = requireRecord(value, "Conversation identity");
  return {
    channel: requireString(record.channel, "Conversation channel"),
    userId: requireString(record.userId, "Conversation user ID"),
  };
}

function readCheckout(value: unknown): ConversationCheckoutState {
  const record = requireRecord(value, "Conversation checkout");
  return {
    orderId: requireString(record.orderId, "Checkout order ID"),
    checkoutId: requireString(record.checkoutId, "Checkout ID"),
    checkoutReference: requireString(
      record.checkoutReference,
      "Checkout reference",
    ),
    checkoutLink: requireString(record.checkoutLink, "Checkout link"),
  };
}

function readStaffHandoffRequest(
  value: unknown,
): NonNullable<LocalConversationState["staffHandoffRequest"]> {
  const record = requireRecord(value, "Staff handoff request");
  if (record.reason !== "customer_requested") {
    throw new SqliteConversationStateStoreError(
      "Staff handoff reason is invalid",
    );
  }
  return {
    requestedAt: requireTimestamp(
      record.requestedAt,
      "Staff handoff requestedAt",
    ),
    reason: "customer_requested",
  };
}

function readBackendStatus(value: unknown): ConversationBackendStatus {
  const record = requireRecord(value, "Conversation backend status");
  return {
    payment: requirePaymentStatus(record.payment),
    orderSubmission: requireSubmissionStatus(record.orderSubmission),
  };
}

function readOrder(value: unknown): Order {
  const record = requireRecord(value, "Conversation order");
  const order: Order = {
    id: requireString(record.id, "Order ID"),
    status: requireOrderStatus(record.status),
    items: readCartItems(record.items),
    fulfilment: readFulfilment(record.fulfilment),
    createdAt: requireTimestamp(record.createdAt, "Order createdAt"),
    updatedAt: requireTimestamp(record.updatedAt, "Order updatedAt"),
  };
  try {
    calculateOrderTotals(order);
  } catch {
    throw new SqliteConversationStateStoreError("Conversation order is invalid");
  }
  return order;
}

function readCartItems(value: unknown): CartItem[] {
  if (!Array.isArray(value)) {
    throw new SqliteConversationStateStoreError("Order items must be an array");
  }
  return value.map((item) => {
    const record = requireRecord(item, "Order item");
    return {
      menuItemId: requireString(record.menuItemId, "Menu item ID"),
      name: requireString(record.name, "Menu item name"),
      unitPriceCents: requireMoney(record.unitPriceCents, "Unit price"),
      quantity: requirePositiveInteger(record.quantity, "Quantity"),
    };
  });
}

function readFulfilment(value: unknown): Fulfilment | null {
  if (value === null) return null;
  const record = requireRecord(value, "Order fulfilment");
  if (record.type === "pickup") return { type: "pickup" };
  if (record.type === "delivery") {
    return {
      type: "delivery",
      address: readAddress(record.address),
      deliveryFeeCents: requireMoney(
        record.deliveryFeeCents,
        "Delivery fee",
      ),
    };
  }
  throw new SqliteConversationStateStoreError(
    "Order fulfilment type is invalid",
  );
}

function readCustomer(value: unknown): ConversationCustomerState {
  const record = requireRecord(value, "Conversation customer");
  const firstName = readOptionalString(record.firstName, "Customer first name");
  const lastName = readOptionalString(record.lastName, "Customer last name");
  const phone = readOptionalString(record.phone, "Customer phone");
  const deliveryAddress =
    record.deliveryAddress === undefined
      ? undefined
      : readAddress(record.deliveryAddress);
  return {
    ...(firstName === undefined ? {} : { firstName }),
    ...(lastName === undefined ? {} : { lastName }),
    ...(phone === undefined ? {} : { phone }),
    ...(deliveryAddress === undefined ? {} : { deliveryAddress }),
  };
}

function readAddress(value: unknown): DeliveryAddress {
  const record = requireRecord(value, "Delivery address");
  return {
    line1: requireString(record.line1, "Address line"),
    city: requireString(record.city, "Address city"),
    postalCode: requireString(record.postalCode, "Address postal code"),
  };
}

function readProcessedMessages(value: unknown): ProcessedConversationMessage[] {
  if (!Array.isArray(value)) {
    throw new SqliteConversationStateStoreError(
      "Processed messages must be an array",
    );
  }
  return value.map((message) => {
    const record = requireRecord(message, "Processed message");
    const fingerprint = requireString(
      record.commandFingerprint,
      "Command fingerprint",
    );
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new SqliteConversationStateStoreError(
        "Command fingerprint is invalid",
      );
    }
    const sourceMessageFingerprint =
      record.sourceMessageFingerprint === undefined
        ? undefined
        : requireFingerprint(
            record.sourceMessageFingerprint,
            "Source message fingerprint",
          );
    const command =
      record.command === undefined
        ? undefined
        : parseConversationAgentCommand(record.command);
    if (record.command !== undefined && command === undefined) {
      throw new SqliteConversationStateStoreError(
        "Processed message command is invalid",
      );
    }
    return {
      messageId: requireString(record.messageId, "Processed message ID"),
      commandFingerprint: fingerprint,
      ...(sourceMessageFingerprint === undefined
        ? {}
        : { sourceMessageFingerprint }),
      ...(command === undefined ? {} : { command }),
      response: readResponse(record.response),
    };
  });
}

function requireFingerprint(value: unknown, label: string): string {
  const fingerprint = requireString(value, label);
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new SqliteConversationStateStoreError(`${label} is invalid`);
  }
  return fingerprint;
}

function readResponse(value: unknown): ConversationAgentResponse {
  const record = requireRecord(value, "Conversation response");
  if (record.kind === "staff_handoff_registered") {
    return {
      kind: "staff_handoff_registered",
      request: readStaffHandoffRequest(record.request),
    };
  }
  const order = readOrderView(record.order);
  switch (record.kind) {
    case "menu":
      return { kind: "menu", menu: readMenu(record.menu), order };
    case "cart":
      return { kind: "cart", order };
    case "needs_input":
      return { kind: "needs_input", order };
    case "order_review":
      if (typeof record.readyForCheckout !== "boolean") {
        throw new SqliteConversationStateStoreError(
          "Order review readiness is invalid",
        );
      }
      return {
        kind: "order_review",
        readyForCheckout: record.readyForCheckout,
        order,
      };
    case "checkout_ready":
      return {
        kind: "checkout_ready",
        checkoutLink: requireString(record.checkoutLink, "Checkout link"),
        order,
      };
    case "awaiting_verified_payment":
      return { kind: "awaiting_verified_payment", order };
    default:
      throw new SqliteConversationStateStoreError(
        "Conversation response kind is invalid",
      );
  }
}

function readOrderView(value: unknown): ConversationOrderView {
  const record = requireRecord(value, "Conversation order view");
  if (typeof record.totalIsFinal !== "boolean") {
    throw new SqliteConversationStateStoreError(
      "Order total finality is invalid",
    );
  }
  return {
    orderId: requireString(record.orderId, "Order view ID"),
    status: requireOrderStatus(record.status),
    items: readCartItemViews(record.items),
    fulfilment: requireFulfilmentChoice(record.fulfilment),
    customer: readCustomer(record.customer),
    missingFields: readMissingFields(record.missingFields),
    totals: readTotals(record.totals),
    totalIsFinal: record.totalIsFinal,
    backendStatus: readBackendStatus(record.backendStatus),
  };
}

function readCartItemViews(value: unknown): ConversationCartItemView[] {
  if (!Array.isArray(value)) {
    throw new SqliteConversationStateStoreError(
      "Order view items must be an array",
    );
  }
  return value.map((item) => {
    const record = requireRecord(item, "Order view item");
    return {
      menuItemId: requireString(record.menuItemId, "Menu item ID"),
      name: requireString(record.name, "Menu item name"),
      unitPriceCents: requireMoney(record.unitPriceCents, "Unit price"),
      quantity: requirePositiveInteger(record.quantity, "Quantity"),
      lineTotalCents: requireMoney(record.lineTotalCents, "Line total"),
    };
  });
}

function readMenu(value: unknown): MenuItemSnapshot[] {
  if (!Array.isArray(value)) {
    throw new SqliteConversationStateStoreError("Menu must be an array");
  }
  return value.map((item) => {
    const record = requireRecord(item, "Menu item");
    if (typeof record.available !== "boolean") {
      throw new SqliteConversationStateStoreError(
        "Menu item availability is invalid",
      );
    }
    return {
      id: requireString(record.id, "Menu item ID"),
      name: requireString(record.name, "Menu item name"),
      unitPriceCents: requireMoney(record.unitPriceCents, "Unit price"),
      available: record.available,
    };
  });
}

function readMissingFields(value: unknown): ConversationMissingField[] {
  if (!Array.isArray(value)) {
    throw new SqliteConversationStateStoreError(
      "Missing fields must be an array",
    );
  }
  return value.map((field) => {
    if (
      field !== "cart" &&
      field !== "fulfilment" &&
      field !== "first_name" &&
      field !== "phone" &&
      field !== "address"
    ) {
      throw new SqliteConversationStateStoreError(
        "Missing field is invalid",
      );
    }
    return field;
  });
}

function readTotals(value: unknown): OrderTotals {
  const record = requireRecord(value, "Order totals");
  if (record.currency !== "EUR") {
    throw new SqliteConversationStateStoreError("Order currency is invalid");
  }
  return {
    subtotalCents: requireMoney(record.subtotalCents, "Subtotal"),
    fulfilmentCents: requireMoney(record.fulfilmentCents, "Fulfilment total"),
    totalCents: requireMoney(record.totalCents, "Order total"),
    currency: "EUR",
  };
}

function cloneOrder(order: Order): Order {
  return {
    ...order,
    items: order.items.map((item) => ({ ...item })),
    fulfilment:
      order.fulfilment?.type === "delivery"
        ? {
            ...order.fulfilment,
            address: { ...order.fulfilment.address },
          }
        : order.fulfilment === null
          ? null
          : { ...order.fulfilment },
  };
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

function cloneResponse(response: ConversationAgentResponse): ConversationAgentResponse {
  if (response.kind === "staff_handoff_registered") {
    return {
      kind: response.kind,
      request: { ...response.request },
    };
  }
  const order = {
    ...response.order,
    items: response.order.items.map((item) => ({ ...item })),
    customer: cloneCustomer(response.order.customer),
    missingFields: [...response.order.missingFields],
    totals: { ...response.order.totals },
    backendStatus: { ...response.order.backendStatus },
  };
  switch (response.kind) {
    case "menu":
      return {
        kind: "menu",
        menu: response.menu.map((item) => ({ ...item })),
        order,
      };
    case "order_review":
      return {
        kind: "order_review",
        readyForCheckout: response.readyForCheckout,
        order,
      };
    case "checkout_ready":
      return {
        kind: "checkout_ready",
        checkoutLink: response.checkoutLink,
        order,
      };
    case "cart":
    case "needs_input":
    case "awaiting_verified_payment":
      return { kind: response.kind, order };
  }
}

function statusFromBackend(status: ConversationBackendStatus): ConversationStatus {
  switch (status.orderSubmission) {
    case "order_submitted":
      return "order_submitted";
    case "submission_uncertain":
      return "submission_uncertain";
    case "submission_pending":
      return "submission_pending";
    case "not_started":
      switch (status.payment) {
        case "payment_confirmed":
          return "payment_confirmed";
        case "payment_not_confirmed":
          return "payment_not_confirmed";
        case "awaiting_payment":
          return "awaiting_payment";
        case "not_requested":
          return "collecting_order";
      }
  }
}

function requireConversationStatus(value: unknown): ConversationStatus {
  if (
    value === "collecting_order" ||
    value === "awaiting_payment" ||
    value === "payment_not_confirmed" ||
    value === "payment_confirmed" ||
    value === "submission_pending" ||
    value === "submission_uncertain" ||
    value === "order_submitted"
  ) return value;
  throw new SqliteConversationStateStoreError("Conversation status is invalid");
}

function requirePaymentStatus(value: unknown): ConversationPaymentStatus {
  if (
    value === "not_requested" ||
    value === "awaiting_payment" ||
    value === "payment_not_confirmed" ||
    value === "payment_confirmed"
  ) return value;
  throw new SqliteConversationStateStoreError("Payment snapshot is invalid");
}

function requireSubmissionStatus(
  value: unknown,
): ConversationOrderSubmissionStatus {
  if (
    value === "not_started" ||
    value === "submission_pending" ||
    value === "submission_uncertain" ||
    value === "order_submitted"
  ) return value;
  throw new SqliteConversationStateStoreError(
    "Order submission snapshot is invalid",
  );
}

function requireOrderStatus(value: unknown): OrderStatus {
  if (
    value === "draft" ||
    value === "awaiting_payment" ||
    value === "paid" ||
    value === "submitted_to_poster" ||
    value === "cancelled"
  ) return value;
  throw new SqliteConversationStateStoreError("Order status is invalid");
}

function requireFulfilmentChoice(
  value: unknown,
): "pickup" | "delivery" | null {
  if (value === null || value === "pickup" || value === "delivery") return value;
  throw new SqliteConversationStateStoreError(
    "Conversation fulfilment choice is invalid",
  );
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SqliteConversationStateStoreError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SqliteConversationStateStoreError(`${label} is invalid`);
  }
  return value;
}

function readOptionalString(
  value: unknown,
  label: string,
): string | undefined {
  return value === undefined ? undefined : requireString(value, label);
}

function requireNullableString(value: unknown, label: string): string | null {
  return value === null ? null : requireString(value, label);
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  let normalized: string;
  try {
    normalized = new Date(timestamp).toISOString();
  } catch {
    throw new SqliteConversationStateStoreError(`${label} is invalid`);
  }
  if (normalized !== timestamp) {
    throw new SqliteConversationStateStoreError(`${label} is invalid`);
  }
  return timestamp;
}

function requireMoney(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SqliteConversationStateStoreError(`${label} is invalid`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const integer = requireMoney(value, label);
  if (integer < 1) {
    throw new SqliteConversationStateStoreError(`${label} is invalid`);
  }
  return integer;
}

function isSqliteConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    (error.code.startsWith("ERR_SQLITE_CONSTRAINT") ||
      (error.code === "ERR_SQLITE_ERROR" &&
        "errcode" in error &&
        typeof error.errcode === "number" &&
        (error.errcode & 0xff) === 19))
  );
}
