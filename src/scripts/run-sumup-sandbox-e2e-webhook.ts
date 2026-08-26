import "dotenv/config";

import { existsSync } from "node:fs";

import Fastify from "fastify";

import { ProcessSumUpWebhookService } from "../application/process-sumup-webhook.js";
import { loadSumUpSandboxConfig } from "../config/sumup.js";
import { SumUpSandboxCheckoutVerifier } from "../integrations/sumup/checkout-verifier.js";
import { SumUpClient } from "../integrations/sumup/client.js";
import { registerSumUpWebhookRoute } from "../routes/sumup-webhook.js";
import {
  requireEnvironmentValue,
  requireLocalPort,
  writePrivateJson,
} from "./sumup-e2e-local-state.js";
import { observeSandboxWebhookService } from "./sumup-e2e-webhook-observability.js";
import { SqliteOrderPaymentRepository } from "../storage/sqlite/order-payment-repository.js";

async function main(): Promise<void> {
  const databasePath = requireEnvironmentValue(
    process.env,
    "SUMUP_E2E_DB_PATH",
  );
  const preflightPath = requireEnvironmentValue(
    process.env,
    "SUMUP_E2E_PREFLIGHT_PATH",
  );
  const port = requireLocalPort(process.env);
  if (existsSync(preflightPath)) {
    throw new Error("Sandbox E2E merchant preflight was already performed");
  }

  const config = loadSumUpSandboxConfig();
  const merchant = await new SumUpClient(config.apiKey).getMerchantSummary(
    config.merchantCode,
  );
  if (!merchant.sandbox || merchant.defaultCurrency !== "EUR") {
    throw new Error("Configured SumUp merchant is not an EUR sandbox");
  }

  writePrivateJson(preflightPath, merchant);

  const repository = new SqliteOrderPaymentRepository(databasePath);
  const verifier = new SumUpSandboxCheckoutVerifier({
    apiKey: config.apiKey,
    merchant,
  });
  const service = new ProcessSumUpWebhookService({ repository, verifier });
  const trackedService = observeSandboxWebhookService(service, (record) => {
    console.log(JSON.stringify(record));
  });

  const app = Fastify({ logger: false });
  app.register(registerSumUpWebhookRoute, { service: trackedService });
  await app.listen({ host: "127.0.0.1", port });

  console.log(
    JSON.stringify({
      ready: true,
      merchant: "configured-and-matched",
      sandbox: true,
      currency: "EUR",
      localEndpoint: "/webhooks/sumup",
      exposedRoutes: 1,
      production: false,
      poster: false,
    }),
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    await app.close();
    repository.close();
    console.log(JSON.stringify({ stopped: true }));
  };

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : null;
  console.error(
    JSON.stringify({
      ready: false,
      stage: "sandbox_webhook_bootstrap",
      status,
      retry: false,
    }),
  );
  process.exitCode = 1;
});
