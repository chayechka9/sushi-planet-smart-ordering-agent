import { describe, expect, it, vi } from "vitest";

import type { ProcessSumUpWebhookService } from "../src/application/process-sumup-webhook.js";
import { SumUpCheckoutVerificationError } from "../src/integrations/sumup/checkout-verifier.js";
import {
  observeSandboxWebhookService,
  type SandboxWebhookLogRecord,
} from "../src/scripts/sumup-e2e-webhook-observability.js";

const privateBody = {
  event_type: "CHECKOUT_STATUS_CHANGED",
  id: "private-checkout-id",
  transaction_id: "private-transaction-id",
  checkout_url: "https://private.invalid/checkout",
  api_key: "private-api-key",
  phone: "private-phone",
};

function createObservedService(
  process: Pick<ProcessSumUpWebhookService, "process">["process"],
) {
  const records: SandboxWebhookLogRecord[] = [];
  const service = observeSandboxWebhookService({ process }, (record) => {
    records.push(record);
  });
  return { records, service };
}

describe("sandbox E2E webhook observability", () => {
  it.each(["paid", "duplicate"] as const)(
    "logs webhook_received then %s without private data",
    async (outcome) => {
      const process = vi.fn(async () => ({ outcome }));
      const { records, service } = createObservedService(process);

      await expect(service.process(privateBody)).resolves.toEqual({ outcome });

      expect(records).toEqual([
        { event: "webhook_received" },
        { event: outcome },
      ]);
      expect(JSON.stringify(records)).not.toContain("private-");
    },
  );

  it("logs verification_failed without error or webhook details", async () => {
    const process = vi.fn(async () => {
      throw new SumUpCheckoutVerificationError(
        "private-verification-detail",
        502,
      );
    });
    const { records, service } = createObservedService(process);

    await expect(service.process(privateBody)).rejects.toThrow(
      "private-verification-detail",
    );

    expect(records).toEqual([
      { event: "webhook_received" },
      { event: "verification_failed" },
    ]);
    const diagnostic = JSON.stringify(records);
    expect(diagnostic).not.toContain("private-");
    expect(diagnostic).not.toContain("502");
  });
});
