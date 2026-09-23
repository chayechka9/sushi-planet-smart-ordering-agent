import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

import Fastify from "fastify";

import { loadSumUpSandboxConfig } from "../config/sumup.js";
import { SumUpSandboxCheckoutVerifier } from "../integrations/sumup/checkout-verifier.js";
import { SumUpClient } from "../integrations/sumup/client.js";
import { registerSumUpWebhookRoute } from "../routes/sumup-webhook.js";
import { SqliteOrderPaymentRepository } from "../storage/sqlite/order-payment-repository.js";
import {
  POSTER_PREPAID_SANDBOX_WEBHOOK_CONFIRMATION,
  PosterPrepaidSandboxWebhookBridge,
  assertPosterPrepaidPendingMenuFresh,
  assertPosterPrepaidSandboxRecovery,
} from "./poster-prepaid-sandbox-e2e-bridge.js";
import {
  FilePosterPrepaidSandboxVerificationClaim,
  readPosterPrepaidSandboxE2eAttempt,
  readPosterPrepaidSandboxE2eRecoveryState,
  resolvePosterPrepaidSandboxE2ePaths,
} from "./poster-prepaid-sandbox-e2e-local-state.js";
import { requireLocalPort } from "./sumup-e2e-local-state.js";
import { observeSandboxWebhookService } from "./sumup-e2e-webhook-observability.js";

export async function runPosterPrepaidSandboxWebhook(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (
    argv.length !== 1 ||
    argv[0] !== POSTER_PREPAID_SANDBOX_WEBHOOK_CONFIRMATION
  ) {
    console.log(JSON.stringify({ ready: false, outcome: "disabled" }));
    return;
  }

  await import("dotenv/config");
  const paths = resolvePosterPrepaidSandboxE2ePaths();
  const state = readPosterPrepaidSandboxE2eRecoveryState(paths.recoveryStatePath);
  const attempt = readPosterPrepaidSandboxE2eAttempt(paths.attemptMarkerPath);
  const config = loadSumUpSandboxConfig();
  const port = requireLocalPort(process.env);
  const readOnly = new SqliteOrderPaymentRepository(paths.databasePath, {
    readOnly: true,
  });
  try {
    const pair = assertPosterPrepaidSandboxRecovery({
      paths, state, attempt, repository: readOnly,
      merchantCode: config.merchantCode,
    });
    if (pair.payment.status === "pending") {
      assertPosterPrepaidPendingMenuFresh(state, new Date());
      if (existsSync(paths.verificationAttemptPath)) {
        throw new Error("Poster prepaid verification attempt already exists");
      }
    }
  } finally {
    readOnly.close();
  }

  const merchant = await new SumUpClient(config.apiKey).getMerchantSummary(
    config.merchantCode,
  );
  if (
    merchant.merchantCode !== config.merchantCode ||
    !merchant.sandbox ||
    merchant.defaultCurrency !== "EUR"
  ) {
    throw new Error("Poster prepaid webhook requires the EUR sandbox merchant");
  }

  const repository = new SqliteOrderPaymentRepository(paths.databasePath);
  const context = {
    paths, state, attempt, repository, merchantCode: config.merchantCode,
  };
  try {
    assertPosterPrepaidSandboxRecovery(context);
    const verifier = new SumUpSandboxCheckoutVerifier({
      apiKey: config.apiKey, merchant,
    });
    const bridge = new PosterPrepaidSandboxWebhookBridge(
      context,
      verifier,
      new FilePosterPrepaidSandboxVerificationClaim(paths),
    );
    const observed = observeSandboxWebhookService(bridge, (record) => {
      console.log(JSON.stringify(record));
    });
    const app = Fastify({ logger: false });
    app.register(registerSumUpWebhookRoute, { service: observed });
    await app.listen({ host: "127.0.0.1", port });
    console.log(JSON.stringify({
      ready: true,
      lifecycle: "poster_prepaid_sandbox_e2e",
      sandbox: true,
      currency: "EUR",
      posterSubmitted: false,
    }));

    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      repository.close();
      console.log(JSON.stringify({ stopped: true }));
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  } catch (error) {
    repository.close();
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runPosterPrepaidSandboxWebhook().catch(() => {
    console.error(JSON.stringify({
      ready: false,
      stage: "poster_prepaid_webhook_bootstrap",
      retry: false,
    }));
    process.exitCode = 1;
  });
}
