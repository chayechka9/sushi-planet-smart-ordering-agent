import { existsSync } from "node:fs";

import {
  cleanupSumUpE2eRecovery,
  readSumUpE2eRecoveryState,
  resolveSumUpE2eRecoveryPaths,
} from "./sumup-e2e-local-state.js";

function main(): void {
  const paths = resolveSumUpE2eRecoveryPaths();
  const state = existsSync(paths.statePath)
    ? readSumUpE2eRecoveryState(paths.statePath)
    : undefined;
  const result = cleanupSumUpE2eRecovery(paths, state, "explicit");

  console.log(
    JSON.stringify({
      cleaned: result.cleaned,
      mode: result.mode,
      checkoutCreated: state !== undefined,
    }),
  );
}

try {
  main();
} catch {
  console.error(
    JSON.stringify({
      cleaned: false,
      mode: "explicit",
      stage: "sandbox_recovery_cleanup",
    }),
  );
  process.exitCode = 1;
}
