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
 * Normalized read model. A future adapter over PosterClient must map a freshly
 * read sandbox response into this shape only after the raw API fields have
 * been confirmed.
 */
export interface PosterSandboxOrderSnapshot {
  posterOrderId: string;
  correlationId: string;
  status: string | number;
  spotId: number;
  currency: string;
  amountCents: number;
  products: readonly PosterSandboxInspectedProduct[];
  paymentType: number;
  prepaymentCents: number;
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
 * Read-only bridge over PosterClient. The decoder is injected because the raw
 * incoming-order response fields have not yet been freshly confirmed.
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
    snapshot.currency === payload.payment.currency &&
    snapshot.amountCents === payload.payment.sum &&
    snapshot.products.length === 1 &&
    actualProduct !== undefined &&
    actualProduct.productId === expectedProduct.product_id &&
    actualProduct.quantity === expectedProduct.count &&
    actualProduct.priceCents === expectedProduct.price &&
    snapshot.paymentType === payload.payment.type &&
    snapshot.prepaymentCents === payload.payment.sum &&
    snapshot.firstName === payload.first_name &&
    snapshot.lastName === payload.last_name &&
    snapshot.phone === payload.phone &&
    snapshot.comment === payload.comment
  );
}
