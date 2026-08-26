import type { FastifyPluginAsync } from "fastify";

import type { ProcessSumUpWebhookService } from "../application/process-sumup-webhook.js";
import { SumUpWebhookContractError } from "../integrations/sumup/webhook.js";

export interface SumUpWebhookRouteOptions {
  service: Pick<ProcessSumUpWebhookService, "process">;
}

interface SafeSumUpWebhookErrorResponse {
  received: false;
  outcome: "invalid" | "retry";
}

/**
 * Local route definition only. Registration does not listen on a network
 * interface, configure a public URL, or provide a real SumUp verifier.
 */
export const registerSumUpWebhookRoute: FastifyPluginAsync<
  SumUpWebhookRouteOptions
> = async (app, options) => {
  app.post<{ Reply: SafeSumUpWebhookErrorResponse | void }>(
    "/webhooks/sumup",
    async (request, reply) => {
      try {
        await options.service.process(request.body);
        return reply.code(204).send();
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
