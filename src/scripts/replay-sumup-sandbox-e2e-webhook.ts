import { SqliteOrderPaymentRepository } from "../storage/sqlite/order-payment-repository.js";
import {
  cleanupSumUpE2eRecovery,
  readSumUpE2eRecoveryState,
  requireLocalPort,
  resolveSumUpE2eRecoveryPaths,
} from "./sumup-e2e-local-state.js";

const paths = resolveSumUpE2eRecoveryPaths();
const port = requireLocalPort(process.env);
const state = readSumUpE2eRecoveryState(paths.statePath);
if (state.databasePath !== paths.databasePath) {
  throw new Error("Sandbox E2E recovery database path does not match");
}
const repository = new SqliteOrderPaymentRepository(state.databasePath);
let summary: Record<string, unknown> | undefined;

try {
  const orderBefore = repository.findOrderById(state.orderId);
  const paymentBefore = repository.findByCheckoutId(state.paymentId);
  if (
    orderBefore?.status !== "paid" ||
    paymentBefore?.status !== "paid" ||
    paymentBefore.successfulTransactionId === null
  ) {
    throw new Error("Duplicate check requires an already paid local pair");
  }

  const response = await fetch(
    `http://127.0.0.1:${port}/webhooks/sumup`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "CHECKOUT_STATUS_CHANGED",
        id: state.checkoutId,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status !== 204 || (await response.text()) !== "") {
    throw new Error("Duplicate webhook check returned an unexpected response");
  }

  const orderAfter = repository.findOrderById(state.orderId);
  const paymentAfter = repository.findByCheckoutId(state.paymentId);
  if (orderAfter === undefined || paymentAfter === undefined) {
    throw new Error("Duplicate webhook check lost local state");
  }

  const orderTimestampUnchanged =
    orderAfter.updatedAt === orderBefore.updatedAt;
  const paymentTimestampUnchanged =
    paymentAfter.updatedAt === paymentBefore.updatedAt;
  const paidAtUnchanged = paymentAfter.paidAt === paymentBefore.paidAt;
  const successfulTransactionUnchanged =
    paymentAfter.successfulTransactionId ===
    paymentBefore.successfulTransactionId;
  if (
    !orderTimestampUnchanged ||
    !paymentTimestampUnchanged ||
    !paidAtUnchanged ||
    !successfulTransactionUnchanged
  ) {
    throw new Error("Duplicate webhook check changed local state");
  }

  summary = {
    received: true,
    outcome: "duplicate",
    orderStatus: orderAfter.status,
    paymentStatus: paymentAfter.status,
    orderTimestampUnchanged,
    paymentTimestampUnchanged,
    paidAtUnchanged,
    successfulTransactionUnchanged,
    externalVerificationCalls: 0,
    posterSubmitted: orderAfter.status === "submitted_to_poster",
  };
} finally {
  repository.close();
}

if (summary === undefined) {
  throw new Error("Duplicate webhook check did not complete");
}
const cleanup = cleanupSumUpE2eRecovery(paths, state, "verified", {
  paid: true,
  duplicateVerified: true,
});
console.log(JSON.stringify({ ...summary, recoveryCleaned: cleanup.cleaned }));
