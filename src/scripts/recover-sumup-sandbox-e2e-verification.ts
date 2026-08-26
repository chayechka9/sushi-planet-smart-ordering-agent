import "dotenv/config";

import { loadSumUpSandboxConfig } from "../config/sumup.js";
import {
  SumUpCheckoutVerificationError,
  SumUpSandboxCheckoutVerifier,
  type SumUpSandboxCheckoutVerifierOptions,
} from "../integrations/sumup/checkout-verifier.js";
import { SqliteOrderPaymentRepository } from "../storage/sqlite/order-payment-repository.js";
import {
  readSumUpE2eRecoveryState,
  resolveSumUpE2eRecoveryPaths,
} from "./sumup-e2e-local-state.js";
import { verifyRecoveredSumUpE2eCheckout } from "./sumup-e2e-recovery.js";

type SumUpFetch = NonNullable<
  SumUpSandboxCheckoutVerifierOptions["fetcher"]
>;

let readRequests = 0;
let repository: SqliteOrderPaymentRepository | undefined;

async function main(): Promise<void> {
  const paths = resolveSumUpE2eRecoveryPaths();
  const state = readSumUpE2eRecoveryState(paths.statePath);
  if (state.databasePath !== paths.databasePath) {
    throw new Error("Sandbox E2E recovery database path does not match");
  }

  const config = loadSumUpSandboxConfig();
  const fetchExactlyTwice: SumUpFetch = async (input, init) => {
    if (init?.method !== "GET" || readRequests >= 2) {
      throw new SumUpCheckoutVerificationError(
        "Sandbox E2E recovery permits exactly two read-only requests",
      );
    }
    readRequests += 1;
    return fetch(input, init);
  };
  const verifier = new SumUpSandboxCheckoutVerifier({
    apiKey: config.apiKey,
    merchant: {
      merchantCode: config.merchantCode,
      country: "sandbox",
      defaultCurrency: "EUR",
      sandbox: true,
    },
    fetcher: fetchExactlyTwice,
  });
  repository = new SqliteOrderPaymentRepository(state.databasePath, {
    readOnly: true,
  });
  const result = await verifyRecoveredSumUpE2eCheckout({
    state,
    repository,
    verifier,
  });
  if (readRequests !== 2) {
    throw new SumUpCheckoutVerificationError(
      "Sandbox E2E recovery did not complete two read-only requests",
    );
  }
  console.log(
    JSON.stringify({
      ...result,
      sumUpReadRequests: readRequests,
      retry: false,
    }),
  );
}

main()
  .catch((error: unknown) => {
    const status =
      error instanceof SumUpCheckoutVerificationError ? error.status : null;
    console.error(
      JSON.stringify({
        verified: false,
        stage: "sandbox_recovery_verification",
        status,
        sumUpReadRequests: readRequests,
        retry: false,
      }),
    );
    process.exitCode = 1;
  })
  .finally(() => repository?.close());
