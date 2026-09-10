import { createHash } from "node:crypto";

import type { PaymentRecord } from "../domain/payment.js";
import type { Order } from "../domain/order.js";
import {
  buildPosterIncomingOrderPayload,
  type PosterOrderCustomer,
} from "../integrations/poster/order-payload.js";
import type {
  PosterOrderSubmissionIdentity,
  PosterOrderSubmitter,
} from "../integrations/poster/submitter.js";

interface PosterHandoffState extends PosterOrderSubmissionIdentity {
  status: "submitting" | "submitted" | "uncertain";
}

interface PosterHandoffClaim {
  outcome: "claimed" | "duplicate" | "in_progress" | "uncertain";
}

export interface PosterHandoffRepository {
  findOrderById(orderId: string): Order | undefined;
  findByOrderId(orderId: string): PaymentRecord | undefined;
  findPosterHandoffByOrderId(
    orderId: string,
  ): PosterHandoffState | undefined;
  claimPosterHandoff(
    orderId: string,
    identity: PosterOrderSubmissionIdentity,
    now?: Date,
  ): PosterHandoffClaim;
  markPosterHandoffUncertain(
    orderId: string,
    identity: PosterOrderSubmissionIdentity,
    now?: Date,
  ): void;
  completePosterHandoff(
    orderId: string,
    identity: PosterOrderSubmissionIdentity,
    posterOrderId: string,
    now?: Date,
  ): Order;
}

export interface SubmitPaidOrderToPosterInput {
  orderId: string;
  spotId: string;
  customer: PosterOrderCustomer;
  comment?: string;
}

export type PosterHandoffOutcome =
  | "submitted"
  | "duplicate"
  | "in_progress"
  | "uncertain";

export interface PosterHandoffResult {
  outcome: PosterHandoffOutcome;
}

export interface SubmitPaidOrderToPosterDependencies {
  repository: PosterHandoffRepository;
  submitter: PosterOrderSubmitter;
  now?: () => Date;
}

export class PosterHandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosterHandoffError";
  }
}

/**
 * Coordinates a local, durable Poster handoff around an injected transport.
 * No HTTP implementation is provided here or wired into the ordinary server.
 */
export class SubmitPaidOrderToPosterService {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: SubmitPaidOrderToPosterDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async submit(
    input: SubmitPaidOrderToPosterInput,
  ): Promise<PosterHandoffResult> {
    const existing = this.dependencies.repository.findPosterHandoffByOrderId(
      input.orderId,
    );
    if (existing !== undefined) {
      return { outcome: mapExistingHandoff(existing) };
    }

    const order = this.dependencies.repository.findOrderById(input.orderId);
    const payment = this.dependencies.repository.findByOrderId(input.orderId);
    assertLocallyPaid(order, payment);

    const payload = buildPosterIncomingOrderPayload({
      order,
      spotId: input.spotId,
      customer: input.customer,
      ...(input.comment === undefined ? {} : { comment: input.comment }),
    });
    const identity = createPosterHandoffIdentity(input.orderId, payload);

    const claim = this.dependencies.repository.claimPosterHandoff(
      input.orderId,
      identity,
      this.now(),
    );
    if (claim.outcome !== "claimed") {
      return { outcome: claim.outcome };
    }

    try {
      const receipt = await this.dependencies.submitter.submitOrder({
        ...identity,
        payload,
      });
      this.dependencies.repository.completePosterHandoff(
        input.orderId,
        identity,
        receipt.posterOrderId,
        this.now(),
      );
      return { outcome: "submitted" };
    } catch {
      try {
        this.dependencies.repository.markPosterHandoffUncertain(
          input.orderId,
          identity,
          this.now(),
        );
      } catch {
        throw new PosterHandoffError(
          "Poster submission failed and local recovery state could not be confirmed",
        );
      }

      throw new PosterHandoffError(
        "Poster submission was not confirmed; automatic retry is blocked",
      );
    }
  }
}

export function createPosterHandoffIdentity(
  orderId: string,
  payload: ReturnType<typeof buildPosterIncomingOrderPayload>,
): PosterOrderSubmissionIdentity {
  const payloadFingerprint = createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
  return {
    correlationId: `poster-handoff:${orderId}`,
    payloadFingerprint,
  };
}

function assertLocallyPaid(
  order: Order | undefined,
  payment: PaymentRecord | undefined,
): asserts order is Order {
  if (
    order === undefined ||
    payment === undefined ||
    order.status !== "paid" ||
    payment.orderId !== order.id ||
    payment.status !== "paid" ||
    payment.successfulTransactionId === null ||
    payment.paidAt === null
  ) {
    throw new PosterHandoffError(
      "Poster handoff requires a locally confirmed paid order",
    );
  }
}

function mapExistingHandoff(
  handoff: PosterHandoffState,
): Exclude<PosterHandoffOutcome, "submitted"> {
  switch (handoff.status) {
    case "submitting":
      return "in_progress";
    case "submitted":
      return "duplicate";
    case "uncertain":
      return "uncertain";
  }
}
