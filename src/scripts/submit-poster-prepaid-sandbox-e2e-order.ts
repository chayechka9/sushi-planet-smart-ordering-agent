import { pathToFileURL } from "node:url";

import { POSTER_PREPAID_SANDBOX_E2E_CONFIRMATION } from "../application/prepare-poster-prepaid-sandbox-e2e.js";
import { loadPosterConfig } from "../config/poster.js";
import { loadSumUpSandboxConfig } from "../config/sumup.js";
import { PosterClient } from "../integrations/poster/client.js";
import {
  InjectedPosterSandboxSubmitter,
  PosterSandboxHttpPostTransport,
} from "../integrations/poster/sandbox-submitter.js";
import { SqliteOrderPaymentRepository } from "../storage/sqlite/order-payment-repository.js";
import {
  POSTER_PREPAID_TEST_ACCOUNT,
  assertPosterPrepaidSandboxRecovery,
  submitPosterPrepaidSandboxPaidOrder,
} from "./poster-prepaid-sandbox-e2e-bridge.js";
import {
  readPosterPrepaidSandboxE2eAttempt,
  readPosterPrepaidSandboxE2eRecoveryState,
  resolvePosterPrepaidSandboxE2ePaths,
} from "./poster-prepaid-sandbox-e2e-local-state.js";

export async function submitPosterPrepaidSandboxOrder(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (argv.length !== 1 || argv[0] !== POSTER_PREPAID_SANDBOX_E2E_CONFIRMATION) {
    console.log(JSON.stringify({ outcome: "disabled", posterPostCount: 0 }));
    return;
  }

  await import("dotenv/config");
  const paths = resolvePosterPrepaidSandboxE2ePaths();
  const state = readPosterPrepaidSandboxE2eRecoveryState(paths.recoveryStatePath);
  const attempt = readPosterPrepaidSandboxE2eAttempt(paths.attemptMarkerPath);
  const sumUp = loadSumUpSandboxConfig();
  const readOnly = new SqliteOrderPaymentRepository(paths.databasePath, {
    readOnly: true,
  });
  try {
    const context = {
      paths, state, attempt, repository: readOnly,
      merchantCode: sumUp.merchantCode,
    };
    const pair = assertPosterPrepaidSandboxRecovery(context);
    const previous = readOnly.findPosterHandoffByOrderId(state.orderId);
    if (previous !== undefined) {
      console.log(JSON.stringify({
        outcome: previous.status === "submitted" ? "duplicate" : previous.status,
        posterPostCount: 0,
        retry: false,
      }));
      return;
    }
    if (pair.order.status !== "paid" || pair.payment.status !== "paid") {
      throw new Error("Poster prepaid sandbox payment is not verified paid");
    }
  } finally {
    readOnly.close();
  }

  const poster = loadPosterConfig();
  if (poster.account !== POSTER_PREPAID_TEST_ACCOUNT) {
    throw new Error("Poster prepaid handoff requires the test account");
  }
  const phone = process.env.POSTER_TEST_PHONE?.trim() ?? "";
  if (phone.length === 0) {
    throw new Error("A local test phone is required for Poster handoff");
  }
  const client = new PosterClient(poster.token);
  const account = await client.getAccountSummary();
  if (
    account.companyId !== POSTER_PREPAID_TEST_ACCOUNT ||
    account.currencyIso !== "EUR"
  ) {
    throw new Error("Poster test account or currency did not match");
  }
  const items = await client.getMenuItems();
  const now = new Date();
  const repository = new SqliteOrderPaymentRepository(paths.databasePath);
  try {
    const result = await submitPosterPrepaidSandboxPaidOrder({
      paths, state, attempt, repository,
      merchantCode: sumUp.merchantCode,
      confirmation: POSTER_PREPAID_SANDBOX_E2E_CONFIRMATION,
      account,
      menuSnapshot: {
        source: "poster_menu_read_only",
        capturedAt: now.toISOString(),
        currency: "EUR",
        items,
      },
      customer: { firstName: "Poster API Test", phone },
      submitter: new InjectedPosterSandboxSubmitter(
        new PosterSandboxHttpPostTransport({ token: poster.token, enabled: true }),
      ),
      now,
    });
    console.log(JSON.stringify({
      outcome: result.outcome,
      posterPostLimit: 1,
      retry: false,
    }));
  } finally {
    repository.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  submitPosterPrepaidSandboxOrder().catch(() => {
    console.error(JSON.stringify({
      outcome: "failed",
      stage: "poster_prepaid_sandbox_handoff",
      retry: false,
    }));
    process.exitCode = 1;
  });
}
