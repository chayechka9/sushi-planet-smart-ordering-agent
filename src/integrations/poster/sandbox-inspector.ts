import type { PosterCreateIncomingOrderPayload } from "./order-payload.js";
import type { PosterClient } from "./client.js";
import type {
  PosterOrderSubmission,
  PosterOrderSubmissionIdentity,
  PosterOrderSubmissionInspection,
  PosterOrderSubmissionInspector,
} from "./submitter.js";

export interface PosterSandboxInspectedProduct {
  productId: number;
  quantity: number;
  priceCents: number;
}

/**
 * Normalized read model. Optional payment fields represent evidence that the
 * incoming-orders endpoint may not expose; the inspector still requires every
 * payment field before it can return confirmed.
 */
export interface PosterSandboxOrderSnapshot {
  posterOrderId: string;
  correlationId: string;
  status: string | number;
  spotId: number;
  currency?: string;
  amountCents?: number;
  products: readonly PosterSandboxInspectedProduct[];
  paymentType?: number;
  prepaymentCents?: number;
  firstName: string;
  lastName?: string;
  phone: string;
  comment?: string;
}

/** Read-only lookup boundary; it intentionally exposes no mutation method. */
export interface PosterSandboxReadOnlyOrderLookup {
  findByCorrelation(
    correlationId: string,
  ): Promise<PosterSandboxOrderSnapshot | undefined>;
}

export type PosterSandboxOrderSnapshotDecoder = (
  rows: readonly unknown[],
  correlationId: string,
) => PosterSandboxOrderSnapshot | undefined;

/**
 * Decodes only fields confirmed by the read-only sandbox schema audit.
 * Payment, currency and prepayment evidence are intentionally left absent:
 * getOwnIncomingOrders did not expose confirmed fields for those claims.
 */
export function decodePosterSandboxOrderSnapshot(
  rows: readonly unknown[],
  correlationId: string,
): PosterSandboxOrderSnapshot | undefined {
  if (correlationId.length === 0) {
    return undefined;
  }

  for (const value of rows) {
    const row = asRecord(value);
    if (row === undefined || row.comment !== correlationId) {
      continue;
    }

    const posterOrderId = asPositiveNumericId(row.incoming_order_id);
    const status = asSafeInteger(row.status);
    const spotId = asPositiveNumericId(row.spot_id);
    const firstName = asString(row.first_name);
    const lastName = asOptionalNullableString(row.last_name);
    const phone = asString(row.phone);
    const comment = asString(row.comment);
    const products = decodeProducts(row.products);

    if (
      posterOrderId === undefined ||
      status === undefined ||
      spotId === undefined ||
      firstName === undefined ||
      lastName === invalidOptionalString ||
      phone === undefined ||
      comment === undefined ||
      products === undefined
    ) {
      return undefined;
    }

    return {
      posterOrderId: String(posterOrderId),
      correlationId: comment,
      status,
      spotId,
      products,
      firstName,
      ...(lastName === undefined ? {} : { lastName }),
      phone,
      comment,
    };
  }

  return undefined;
}

/**
 * Read-only bridge over PosterClient. The decoder stays injected so callers
 * must choose an explicitly supported raw schema.
 */
export class PosterClientSandboxOrderLookup
  implements PosterSandboxReadOnlyOrderLookup
{
  constructor(
    private readonly client: Pick<PosterClient, "getOwnIncomingOrders">,
    private readonly decode: PosterSandboxOrderSnapshotDecoder,
  ) {}

  async findByCorrelation(
    correlationId: string,
  ): Promise<PosterSandboxOrderSnapshot | undefined> {
    const rows = await this.client.getOwnIncomingOrders();
    return this.decode(rows, correlationId);
  }
}

export class PosterSandboxInspectionError extends Error {
  constructor() {
    super("Poster sandbox read-only inspection failed");
    this.name = "PosterSandboxInspectionError";
  }
}

export interface PosterSandboxInspectorOptions {
  expectedOrderId: string;
  expectedSubmission: PosterOrderSubmission;
  expectedStatus: string | number;
  expectedPosterOrderId?: string;
  lookup: PosterSandboxReadOnlyOrderLookup;
}

/**
 * Strictly verifies a normalized read-only result against the exact submitted
 * payload and durable identity. It cannot submit or mutate an order.
 */
export class PosterSandboxInspector
  implements PosterOrderSubmissionInspector
{
  constructor(private readonly options: PosterSandboxInspectorOptions) {}

  async inspectSubmission(
    orderId: string,
    identity: PosterOrderSubmissionIdentity,
  ): Promise<PosterOrderSubmissionInspection> {
    if (!this.matchesExpectedIdentity(orderId, identity)) {
      return { outcome: "unknown" };
    }

    let snapshot: PosterSandboxOrderSnapshot | undefined;
    try {
      snapshot = await this.options.lookup.findByCorrelation(
        identity.correlationId,
      );
    } catch {
      throw new PosterSandboxInspectionError();
    }

    if (
      snapshot === undefined ||
      !matchesPayload(
        snapshot,
        this.options.expectedSubmission.payload,
        this.options.expectedStatus,
        this.options.expectedPosterOrderId,
      )
    ) {
      return { outcome: "unknown" };
    }

    return {
      outcome: "confirmed",
      orderId,
      posterOrderId: snapshot.posterOrderId,
      correlationId: identity.correlationId,
      payloadFingerprint: identity.payloadFingerprint,
    };
  }

  private matchesExpectedIdentity(
    orderId: string,
    identity: PosterOrderSubmissionIdentity,
  ): boolean {
    const expected = this.options.expectedSubmission;
    return (
      orderId === this.options.expectedOrderId &&
      identity.correlationId === expected.correlationId &&
      identity.payloadFingerprint === expected.payloadFingerprint &&
      expected.payload.comment === expected.correlationId
    );
  }
}

function matchesPayload(
  snapshot: PosterSandboxOrderSnapshot,
  payload: PosterCreateIncomingOrderPayload,
  expectedStatus: string | number,
  expectedPosterOrderId: string | undefined,
): boolean {
  const [expectedProduct] = payload.products;
  const [actualProduct] = snapshot.products;
  return (
    snapshot.posterOrderId.trim().length > 0 &&
    (expectedPosterOrderId === undefined ||
      snapshot.posterOrderId === expectedPosterOrderId) &&
    snapshot.status === expectedStatus &&
    snapshot.correlationId === payload.comment &&
    snapshot.spotId === payload.spot_id &&
    snapshot.products.length === 1 &&
    actualProduct !== undefined &&
    actualProduct.productId === expectedProduct.product_id &&
    actualProduct.quantity === expectedProduct.count &&
    actualProduct.priceCents === expectedProduct.price &&
    matchesPaymentEvidence(snapshot, payload) &&
    matchesNames(snapshot, payload) &&
    snapshot.phone === payload.phone &&
    snapshot.comment === payload.comment
  );
}

function matchesPaymentEvidence(
  snapshot: PosterSandboxOrderSnapshot,
  payload: PosterCreateIncomingOrderPayload,
): boolean {
  return (
    snapshot.currency === payload.payment.currency &&
    snapshot.amountCents === payload.payment.sum &&
    snapshot.paymentType === payload.payment.type &&
    snapshot.prepaymentCents === payload.payment.sum
  );
}

function matchesNames(
  snapshot: PosterSandboxOrderSnapshot,
  payload: PosterCreateIncomingOrderPayload,
): boolean {
  return (
    snapshot.firstName === payload.first_name &&
    snapshot.lastName === payload.last_name
  );
}

const invalidOptionalString = Symbol("invalid optional string");

function decodeProducts(
  value: unknown,
): PosterSandboxInspectedProduct[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const products: PosterSandboxInspectedProduct[] = [];
  for (const itemValue of value) {
    const item = asRecord(itemValue);
    if (item === undefined) {
      return undefined;
    }

    const productId = asPositiveNumericId(item.product_id);
    const quantity = asPositiveQuantity(item.count);
    const priceCents = asNonNegativeInteger(item.price);
    if (
      productId === undefined ||
      quantity === undefined ||
      priceCents === undefined
    ) {
      return undefined;
    }

    products.push({ productId, quantity, priceCents });
  }

  return products;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalNullableString(
  value: unknown,
): string | undefined | typeof invalidOptionalString {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" ? value : invalidOptionalString;
}

function asSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function asPositiveNumericId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function asPositiveQuantity(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}
