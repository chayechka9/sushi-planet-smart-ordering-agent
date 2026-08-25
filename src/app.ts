import Fastify, { type FastifyServerOptions } from "fastify";

import type { ProcessSumUpWebhookService } from "./application/process-sumup-webhook.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerSumUpWebhookRoute } from "./routes/sumup-webhook.js";

export interface AppDependencies {
  sumUpWebhookService?: Pick<ProcessSumUpWebhookService, "process">;
}

export function createApp(
  options: FastifyServerOptions = {},
  dependencies: AppDependencies = {},
) {
  const app = Fastify(options);

  app.register(registerHealthRoute);
  if (dependencies.sumUpWebhookService !== undefined) {
    app.register(registerSumUpWebhookRoute, {
      service: dependencies.sumUpWebhookService,
    });
  }

  return app;
}
