import { SqliteOrderPaymentRepository } from "../storage/sqlite/order-payment-repository.js";
import {
  readSumUpE2eLocalState,
  requireEnvironmentValue,
  requireLocalPort,
} from "./sumup-e2e-local-state.js";

const databasePath = requireEnvironmentValue(
  process.env,
  "SUMUP_E2E_DB_PATH",
);
const statePath = requireEnvironmentValue(
  process.env,
  "SUMUP_E2E_STATE_PATH",
);
const port = requireLocalPort(process.env);
const state = readSumUpE2eLocalState(statePath);
const repository = new SqliteOrderPaymentRepository(databasePath);

try {
  const orderBefore = repository.findOrderById(state.orderId);
  const paymentBefore = repository.findByCheckoutId(state.checkoutId);
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
  const body = (await response.json()) as unknown;
  if (
    response.status !== 200 ||
    !isDuplicateResponse(body)
  ) {
    throw new Error("Duplicate webhook check returned an unexpected response");
  }

  const orderAfter = repository.findOrderById(state.orderId);
  const paymentAfter = repository.findByCheckoutId(state.checkoutId);
  if (orderAfter === undefined || paymentAfter === undefined) {
    throw new Error("Duplicate webhook check lost local state");
  }

  console.log(
    JSON.stringify({
      received: true,
      outcome: "duplicate",
      orderStatus: orderAfter.status,
      paymentStatus: paymentAfter.status,
      orderTimestampUnchanged:
        orderAfter.updatedAt === orderBefore.updatedAt,
      paymentTimestampUnchanged:
        paymentAfter.updatedAt === paymentBefore.updatedAt,
      paidAtUnchanged: paymentAfter.paidAt === paymentBefore.paidAt,
      successfulTransactionUnchanged:
        paymentAfter.successfulTransactionId ===
        paymentBefore.successfulTransactionId,
      externalVerificationCalls: 0,
      posterSubmitted: orderAfter.status === "submitted_to_poster",
    }),
  );
} finally {
  repository.close();
}

function isDuplicateResponse(
  value: unknown,
): value is { received: true; outcome: "duplicate" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "received" in value &&
    value.received === true &&
    "outcome" in value &&
    value.outcome === "duplicate"
  );
}
