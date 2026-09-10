import type {
  PosterCreateIncomingOrderPayload,
  PosterMinimalCreateIncomingOrderPayload,
} from "./order-payload.js";

export interface PosterOrderSubmissionIdentity {
  correlationId: string;
  payloadFingerprint: string;
}

export interface PosterOrderSubmission<
  TPayload = PosterCreateIncomingOrderPayload,
> extends PosterOrderSubmissionIdentity {
  payload: TPayload;
}

export type PosterSandboxOrderSubmission = PosterOrderSubmission<
  PosterCreateIncomingOrderPayload | PosterMinimalCreateIncomingOrderPayload
>;

export interface PosterOrderSubmissionReceipt {
  posterOrderId: string;
}

export type PosterOrderSubmissionInspection =
  | { outcome: "unknown" }
  | ({
      outcome: "confirmed";
      orderId: string;
      posterOrderId: string;
    } & PosterOrderSubmissionIdentity);

/**
 * Transport boundary for a future Poster write adapter.
 *
 * A sandbox-only implementation exists behind an explicit disabled-by-default
 * transport gate; the ordinary server bootstrap does not construct it. An
 * adapter must serialize only `submission.payload`; identity fields are local
 * correlation metadata, not additional Poster request fields.
 */
export interface PosterOrderSubmitter {
  submitOrder(
    submission: PosterOrderSubmission,
  ): Promise<PosterOrderSubmissionReceipt>;
}

/**
 * Read-only boundary for recovery checks against Poster sandbox. The sandbox
 * bridge can use the read-only client with an injected raw-response decoder;
 * the ordinary server does not construct it.
 */
export interface PosterOrderSubmissionInspector {
  inspectSubmission(
    orderId: string,
    identity: PosterOrderSubmissionIdentity,
  ): Promise<PosterOrderSubmissionInspection>;
}
