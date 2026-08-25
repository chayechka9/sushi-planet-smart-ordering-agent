import type { FastifyPluginAsync } from "fastify";

import type {
  ProcessSumUpWebhookService,
  SumUpWebhookProcessingResult,
} from "../application/process-sumup-webhook.js";
import { SumUpWebhookContractError } from "../integrations/sumup/webhook.js";

export interface SumUpWebhookRouteOptions {
  service: Pick<ProcessSumUpWebhookService, "process">;
}

interface SafeSumUpWebhookResponse {
  received: boolean;
  outcome: SumUpWebhookProcessingResult["outcome"] | "invalid" | "retry";
}

/**
 * Local route definition only. Registration does not listen on a network
 * interface, configure a public URL, or provide a real SumUp verifier.
 */
export const registerSumUpWebhookRoute: FastifyPluginAsync<
  SumUpWebhookRouteOptions
> = async (app, options) => {
  app.post<{ Reply: SafeSumUpWebhookResponse }>(
    "/webhooks/sumup",
    async (request, reply) => {
      try {
        const result = await options.service.process(request.body);
        return reply.code(200).send({
          received: true,
          outcome: result.outcome,
        });
      } catch (error) {
        if (error instanceof SumUpWebhookContractError) {
          return reply.code(400).send({
            received: false,
            outcome: "invalid",
          });
        }

        return reply.code(503).send({
          received: false,
          outcome: "retry",
        });
      }
    },
  );
};
