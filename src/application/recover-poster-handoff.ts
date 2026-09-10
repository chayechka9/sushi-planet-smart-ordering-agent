import type { Order } from "../domain/order.js";
import type {
  PosterOrderSubmissionIdentity,
  PosterOrderSubmissionInspector,
  PosterOrderSubmissionInspection,
} from "../integrations/poster/submitter.js";

interface RecoverablePosterHandoff extends PosterOrderSubmissionIdentity {
  status: "submitting" | "submitted" | "uncertain";
  posterOrderId: string | null;
}

interface PosterHandoffRecoveryCompletion {
  outcome: "confirmed" | "duplicate";
  order: Order;
}

export interface PosterHandoffRecoveryRepository {
  findPosterHandoffByOrderId(
    orderId: string,
  ): RecoverablePosterHandoff | undefined;
  markPosterHandoffUncertain(
    orderId: string,
    identity: PosterOrderSubmissionIdentity,
    now?: Date,
  ): void;
  confirmRecoveredPosterHandoff(
    orderId: string,
    identity: PosterOrderSubmissionIdentity,
    posterOrderId: string,
    now?: Date,
  ): PosterHandoffRecoveryCompletion;
}

export type PosterHandoffInspectionResult =
  | { outcome: "not_started" }
  | ({ outcome: "confirmed" } & PosterOrderSubmissionIdentity)
  | ({
      outcome: "unknown";
      state: "submitting" | "uncertain";
    } & PosterOrderSubmissionIdentity);

export interface RecoverPosterHandoffDependencies {
  repository: PosterHandoffRecoveryRepository;
  inspector: PosterOrderSubmissionInspector;
  now?: () => Date;
}

export interface PosterHandoffRecoveryResult {
  outcome: "confirmed" | "duplicate" | "unknown";
}

export class PosterHandoffRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosterHandoffRecoveryError";
  }
}

/**
 * Recovers only through an injected read-only inspection. It never invokes the
 * Poster submitter or retries a write after an ambiguous outcome.
 */
export class RecoverPosterHandoffService {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: RecoverPosterHandoffDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  inspect(orderId: string): PosterHandoffInspectionResult {
    const handoff = this.dependencies.repository.findPosterHandoffByOrderId(
      orderId,
    );
    if (handoff === undefined) {
      return { outcome: "not_started" };
    }

    const identity = selectIdentity(handoff);
    if (handoff.status === "submitted") {
      return { outcome: "confirmed", ...identity };
    }
    return { outcome: "unknown", state: handoff.status, ...identity };
  }

  async recover(orderId: string): Promise<PosterHandoffRecoveryResult> {
    const handoff = this.dependencies.repository.findPosterHandoffByOrderId(
      orderId,
    );
    if (handoff === undefined) {
      return { outcome: "unknown" };
    }
    if (handoff.status === "submitted") {
      return { outcome: "duplicate" };
    }

    const identity = selectIdentity(handoff);
    let inspection: PosterOrderSubmissionInspection;
    try {
      inspection = await this.dependencies.inspector.inspectSubmission(
        orderId,
        identity,
      );
    } catch {
      this.markUnknown(orderId, handoff.status, identity);
      throw new PosterHandoffRecoveryError(
        "Poster handoff inspection failed; submission state remains unknown",
      );
    }

    if (inspection.outcome === "unknown") {
      this.markUnknown(orderId, handoff.status, identity);
      return { outcome: "unknown" };
    }

    if (!matchesConfirmedInspection(orderId, identity, inspection)) {
      this.markUnknown(orderId, handoff.status, identity);
      throw new PosterHandoffRecoveryError(
        "Poster handoff confirmation does not match durable local identity",
      );
    }

    const completion =
      this.dependencies.repository.confirmRecoveredPosterHandoff(
        orderId,
        identity,
        inspection.posterOrderId,
        this.now(),
      );
    return { outcome: completion.outcome };
  }

  private markUnknown(
    orderId: string,
    status: "submitting" | "uncertain",
    identity: PosterOrderSubmissionIdentity,
  ): void {
    if (status === "submitting") {
      this.dependencies.repository.markPosterHandoffUncertain(
        orderId,
        identity,
        this.now(),
      );
    }
  }
}

function selectIdentity(
  handoff: RecoverablePosterHandoff,
): PosterOrderSubmissionIdentity {
  return {
    correlationId: handoff.correlationId,
    payloadFingerprint: handoff.payloadFingerprint,
  };
}

function matchesConfirmedInspection(
  orderId: string,
  identity: PosterOrderSubmissionIdentity,
  inspection: Extract<PosterOrderSubmissionInspection, { outcome: "confirmed" }>,
): boolean {
  return (
    typeof inspection.orderId === "string" &&
    typeof inspection.correlationId === "string" &&
    typeof inspection.payloadFingerprint === "string" &&
    typeof inspection.posterOrderId === "string" &&
    inspection.orderId === orderId &&
    inspection.correlationId === identity.correlationId &&
    inspection.payloadFingerprint === identity.payloadFingerprint &&
    inspection.posterOrderId.trim().length > 0
  );
}
