import { randomUUID } from "node:crypto";

export type OrderStatus =
  | "draft"
  | "awaiting_payment"
  | "paid"
  | "submitted_to_poster"
  | "cancelled";

export interface MenuItemSnapshot {
  id: string;
  name: string;
  unitPriceCents: number;
  available: boolean;
}

export interface CartItem {
  menuItemId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
}

export interface DeliveryAddress {
  line1: string;
  city: string;
  postalCode: string;
}

export type Fulfilment =
  | { type: "pickup" }
  | {
      type: "delivery";
      address: DeliveryAddress;
      deliveryFeeCents: number;
    };

export interface OrderTotals {
  subtotalCents: number;
  fulfilmentCents: number;
  totalCents: number;
  currency: "EUR";
}

export interface Order {
  id: string;
  status: OrderStatus;
  items: CartItem[];
  fulfilment: Fulfilment | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrderDependencies {
  createId?: () => string;
  now?: () => Date;
}

export class OrderDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderDomainError";
  }
}

export function createOrder(
  dependencies: CreateOrderDependencies = {},
): Order {
  const createId = dependencies.createId ?? (() => `ord_${randomUUID()}`);
  const now = dependencies.now ?? (() => new Date());
  const timestamp = now().toISOString();
  const id = createId().trim();

  if (id.length === 0) {
    throw new OrderDomainError("Order ID must not be empty");
  }

  return {
    id,
    status: "draft",
    items: [],
    fulfilment: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function addItem(
  order: Order,
  menuItem: MenuItemSnapshot,
  quantity = 1,
  now: Date = new Date(),
): Order {
  assertDraft(order);
  assertMenuItem(menuItem);
  assertQuantity(quantity);

  if (!menuItem.available) {
    throw new OrderDomainError(`Menu item ${menuItem.id} is unavailable`);
  }

  const existingItem = order.items.find(
    (item) => item.menuItemId === menuItem.id,
  );

  if (
    existingItem &&
    (existingItem.name !== menuItem.name ||
      existingItem.unitPriceCents !== menuItem.unitPriceCents)
  ) {
    throw new OrderDomainError(
      `Menu item ${menuItem.id} changed while it was in the cart`,
    );
  }

  const items = existingItem
    ? order.items.map((item) =>
        item.menuItemId === menuItem.id
          ? { ...item, quantity: item.quantity + quantity }
          : item,
      )
    : [
        ...order.items,
        {
          menuItemId: menuItem.id,
          name: menuItem.name,
          unitPriceCents: menuItem.unitPriceCents,
          quantity,
        },
      ];

  return touch(order, { items }, now);
}

export function setItemQuantity(
  order: Order,
  menuItemId: string,
  quantity: number,
  now: Date = new Date(),
): Order {
  assertDraft(order);
  assertNonEmpty("Menu item ID", menuItemId);
  assertNonNegativeInteger("Quantity", quantity);

  if (!order.items.some((item) => item.menuItemId === menuItemId)) {
    throw new OrderDomainError(`Menu item ${menuItemId} is not in the cart`);
  }

  const items =
    quantity === 0
      ? order.items.filter((item) => item.menuItemId !== menuItemId)
      : order.items.map((item) =>
          item.menuItemId === menuItemId ? { ...item, quantity } : item,
        );

  return touch(order, { items }, now);
}

export function setPickup(order: Order, now: Date = new Date()): Order {
  assertDraft(order);
  return touch(order, { fulfilment: { type: "pickup" } }, now);
}

export function setDelivery(
  order: Order,
  address: DeliveryAddress,
  deliveryFeeCents: number,
  now: Date = new Date(),
): Order {
  assertDraft(order);
  assertNonEmpty("Address line", address.line1);
  assertNonEmpty("City", address.city);
  assertNonEmpty("Postal code", address.postalCode);
  assertMoney("Delivery fee", deliveryFeeCents);

  return touch(
    order,
    {
      fulfilment: {
        type: "delivery",
        address: {
          line1: address.line1.trim(),
          city: address.city.trim(),
          postalCode: address.postalCode.trim(),
        },
        deliveryFeeCents,
      },
    },
    now,
  );
}

export function calculateOrderTotals(order: Order): OrderTotals {
  const subtotalCents = order.items.reduce((subtotal, item) => {
    assertMoney("Unit price", item.unitPriceCents);
    assertQuantity(item.quantity);
    return addMoney(subtotal, item.unitPriceCents * item.quantity);
  }, 0);

  const fulfilmentCents =
    order.fulfilment?.type === "delivery"
      ? order.fulfilment.deliveryFeeCents
      : 0;

  assertMoney("Fulfilment fee", fulfilmentCents);

  return {
    subtotalCents,
    fulfilmentCents,
    totalCents: addMoney(subtotalCents, fulfilmentCents),
    currency: "EUR",
  };
}

export function markAwaitingPayment(
  order: Order,
  now: Date = new Date(),
): Order {
  assertDraft(order);

  if (order.items.length === 0) {
    throw new OrderDomainError("Cannot request payment for an empty cart");
  }

  if (order.fulfilment === null) {
    throw new OrderDomainError("Fulfilment must be selected before payment");
  }

  calculateOrderTotals(order);
  return touch(order, { status: "awaiting_payment" }, now);
}

export function markPaid(order: Order, now: Date = new Date()): Order {
  assertStatus(order, "awaiting_payment");
  return touch(order, { status: "paid" }, now);
}

export function markSubmittedToPoster(
  order: Order,
  now: Date = new Date(),
): Order {
  assertStatus(order, "paid");
  return touch(order, { status: "submitted_to_poster" }, now);
}

export function cancelOrder(order: Order, now: Date = new Date()): Order {
  if (order.status !== "draft" && order.status !== "awaiting_payment") {
    throw new OrderDomainError(
      `Cannot cancel an order with status ${order.status}`,
    );
  }

  return touch(order, { status: "cancelled" }, now);
}

function touch(
  order: Order,
  changes: Partial<Pick<Order, "items" | "fulfilment" | "status">>,
  now: Date,
): Order {
  return { ...order, ...changes, updatedAt: now.toISOString() };
}

function assertDraft(order: Order): void {
  assertStatus(order, "draft");
}

function assertStatus(order: Order, expected: OrderStatus): void {
  if (order.status !== expected) {
    throw new OrderDomainError(
      `Expected order status ${expected}, received ${order.status}`,
    );
  }
}

function assertMenuItem(menuItem: MenuItemSnapshot): void {
  assertNonEmpty("Menu item ID", menuItem.id);
  assertNonEmpty("Menu item name", menuItem.name);
  assertMoney("Unit price", menuItem.unitPriceCents);
}

function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new OrderDomainError("Quantity must be a positive integer");
  }
}

function assertMoney(label: string, cents: number): void {
  assertNonNegativeInteger(label, cents);
}

function assertNonNegativeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OrderDomainError(`${label} must be a non-negative integer`);
  }
}

function assertNonEmpty(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new OrderDomainError(`${label} must not be empty`);
  }
}

function addMoney(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new OrderDomainError("Order total exceeds the supported range");
  }
  return result;
}
