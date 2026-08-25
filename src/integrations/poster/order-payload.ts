import {
  calculateOrderTotals,
  type Order,
} from "../../domain/order.js";

export interface PosterOrderCustomer {
  firstName: string;
  lastName?: string;
  phone: string;
}

export interface PosterIncomingOrderProduct {
  product_id: number;
  count: number;
  price: number;
}

export interface PosterIncomingOrderPayment {
  type: 1;
  sum: number;
  currency: "EUR";
}

export interface PosterCreateIncomingOrderPayload {
  spot_id: number;
  first_name: string;
  last_name?: string;
  phone: string;
  comment?: string;
  products: [PosterIncomingOrderProduct];
  payment: PosterIncomingOrderPayment;
}

export interface BuildPosterIncomingOrderPayloadInput {
  order: Order;
  spotId: string;
  customer: PosterOrderCustomer;
  comment?: string;
}

export class PosterOrderPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosterOrderPayloadError";
  }
}

/**
 * Builds the documented minimum for one prepaid pickup order.
 *
 * This function has no network side effects. Delivery is deliberately rejected:
 * Poster documents an address field, but not fulfilment type, delivery fee, or
 * delivery time fields for incomingOrders.createIncomingOrder.
 */
export function buildPosterIncomingOrderPayload(
  input: BuildPosterIncomingOrderPayloadInput,
): PosterCreateIncomingOrderPayload {
  const { order, customer } = input;

  if (order.status !== "paid") {
    throw new PosterOrderPayloadError(
      `Poster payload requires a paid order, received ${order.status}`,
    );
  }

  if (order.fulfilment?.type !== "pickup") {
    throw new PosterOrderPayloadError(
      "Only pickup is supported until Poster delivery fields are confirmed",
    );
  }

  const [item] = order.items;
  if (order.items.length !== 1 || item === undefined) {
    throw new PosterOrderPayloadError(
      "The first Poster test payload must contain exactly one product",
    );
  }

  const spotId = parsePosterId("Poster spot ID", input.spotId);
  const productId = parsePosterId("Poster product ID", item.menuItemId);
  const firstName = requireText("Customer first name", customer.firstName);
  const phone = requireText("Customer phone", customer.phone);
  const lastName = optionalText("Customer last name", customer.lastName);
  const comment = optionalText("Order comment", input.comment);

  assertPositiveInteger("Product count", item.quantity);
  assertNonNegativeInteger("Product price", item.unitPriceCents);

  const totals = calculateOrderTotals(order);
  const expectedTotal = item.unitPriceCents * item.quantity;

  if (!Number.isSafeInteger(expectedTotal)) {
    throw new PosterOrderPayloadError("Product total must be a safe integer");
  }

  if (
    totals.currency !== "EUR" ||
    totals.fulfilmentCents !== 0 ||
    totals.totalCents !== expectedTotal
  ) {
    throw new PosterOrderPayloadError(
      "Order total cannot be represented by the confirmed Poster pickup fields",
    );
  }

  return {
    spot_id: spotId,
    first_name: firstName,
    ...(lastName === undefined ? {} : { last_name: lastName }),
    phone,
    ...(comment === undefined ? {} : { comment }),
    products: [
      {
        product_id: productId,
        count: item.quantity,
        price: item.unitPriceCents,
      },
    ],
    payment: {
      type: 1,
      sum: totals.totalCents,
      currency: totals.currency,
    },
  };
}

function parsePosterId(label: string, value: string): number {
  const trimmed = value.trim();

  if (!/^\d+$/.test(trimmed)) {
    throw new PosterOrderPayloadError(`${label} must contain only digits`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new PosterOrderPayloadError(
      `${label} must be a positive safe integer`,
    );
  }

  return parsed;
}

function requireText(label: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new PosterOrderPayloadError(`${label} must not be empty`);
  }
  return trimmed;
}

function optionalText(
  label: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireText(label, value);
}

function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PosterOrderPayloadError(
      `${label} must be a positive safe integer`,
    );
  }
}

function assertNonNegativeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PosterOrderPayloadError(
      `${label} must be a non-negative safe integer`,
    );
  }
}
