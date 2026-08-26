import type {
  ProcessSumUpWebhookService,
  SumUpWebhookProcessingResult,
} from "../application/process-sumup-webhook.js";
import { SumUpCheckoutVerificationError } from "../integrations/sumup/checkout-verifier.js";

type SandboxWebhookService = Pick<ProcessSumUpWebhookService, "process">;

export type SandboxWebhookLogRecord =
  | { event: "webhook_received" }
  | { event: "verification_failed" }
  | { event: "paid" }
  | { event: "duplicate" }
  | {
      event: "webhook_processed";
      outcome: Exclude<
        SumUpWebhookProcessingResult["outcome"],
        "paid" | "duplicate"
      >;
    }
  | { event: "webhook_failed" };

export type SandboxWebhookLogWriter = (
  record: SandboxWebhookLogRecord,
) => void;

export function observeSandboxWebhookService(
  service: SandboxWebhookService,
  writeLog: SandboxWebhookLogWriter,
): SandboxWebhookService {
  return {
    process: async (body) => {
      writeLog({ event: "webhook_received" });

      try {
        const result = await service.process(body);
        if (result.outcome === "paid" || result.outcome === "duplicate") {
          writeLog({ event: result.outcome });
        } else {
          writeLog({ event: "webhook_processed", outcome: result.outcome });
        }
        return result;
      } catch (error) {
        writeLog({
          event:
            error instanceof SumUpCheckoutVerificationError
              ? "verification_failed"
              : "webhook_failed",
        });
        throw error;
      }
    },
  };
}
