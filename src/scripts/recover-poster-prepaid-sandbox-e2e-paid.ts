import { lstatSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { loadSumUpSandboxConfig } from "../config/sumup.js";
import { SumUpSandboxCheckoutVerifier } from "../integrations/sumup/checkout-verifier.js";
import { SqliteOrderPaymentRepository } from "../storage/sqlite/order-payment-repository.js";
import {
  FilePosterPrepaidSandboxRecoveryClaim,
  readPosterPrepaidSandboxE2eAttempt,
  readPosterPrepaidSandboxE2eRecoveryState,
  resolvePosterPrepaidSandboxE2ePaths,
} from "./poster-prepaid-sandbox-e2e-local-state.js";
import {
  POSTER_PREPAID_SANDBOX_RECOVERY_CONFIRMATION,
  recoverPosterPrepaidSandboxPaid,
} from "./poster-prepaid-sandbox-e2e-recovery.js";

export async function recoverPosterPrepaidSandboxE2ePaid(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (
    argv.length !== 1 ||
    argv[0] !== POSTER_PREPAID_SANDBOX_RECOVERY_CONFIRMATION
  ) {
    console.log(JSON.stringify({ outcome: "disabled", posterPostCount: 0 }));
    return;
  }

  await import("dotenv/config");
  const paths = resolvePosterPrepaidSandboxE2ePaths();
  for (const path of [
    paths.databasePath,
    paths.attemptMarkerPath,
    paths.verificationAttemptPath,
    paths.recoveryStatePath,
  ]) {
    if (!lstatSync(path).isFile()) {
      throw new Error("Poster prepaid recovery requires regular lifecycle files");
    }
  }
  const state = readPosterPrepaidSandboxE2eRecoveryState(paths.recoveryStatePath);
  const attempt = readPosterPrepaidSandboxE2eAttempt(paths.attemptMarkerPath);
  const config = loadSumUpSandboxConfig();
  const repository = new SqliteOrderPaymentRepository(paths.databasePath);
  try {
    const verifier = new SumUpSandboxCheckoutVerifier({
      apiKey: config.apiKey,
      merchant: {
        merchantCode: config.merchantCode,
        country: "IE",
        defaultCurrency: "EUR",
        sandbox: true,
      },
    });
    const result = await recoverPosterPrepaidSandboxPaid({
      paths,
      state,
      attempt,
      repository,
      merchantCode: config.merchantCode,
      confirmation: POSTER_PREPAID_SANDBOX_RECOVERY_CONFIRMATION,
      verifier,
      recoveryClaim: new FilePosterPrepaidSandboxRecoveryClaim(paths),
    });
    console.log(JSON.stringify({
      outcome: result.outcome,
      posterPostCount: 0,
      retry: false,
    }));
  } finally {
    repository.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  recoverPosterPrepaidSandboxE2ePaid().catch(() => {
    console.error(JSON.stringify({
      outcome: "failed",
      stage: "poster_prepaid_paid_recovery",
      posterPostCount: 0,
      retry: false,
    }));
    process.exitCode = 1;
  });
}
