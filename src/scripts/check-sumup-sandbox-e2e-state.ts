import { SqliteOrderPaymentRepository } from "../storage/sqlite/order-payment-repository.js";
import {
  readSumUpE2eLocalState,
  requireEnvironmentValue,
} from "./sumup-e2e-local-state.js";

const databasePath = requireEnvironmentValue(
  process.env,
  "SUMUP_E2E_DB_PATH",
);
const statePath = requireEnvironmentValue(
  process.env,
  "SUMUP_E2E_STATE_PATH",
);
const state = readSumUpE2eLocalState(statePath);
const repository = new SqliteOrderPaymentRepository(databasePath);

try {
  const order = repository.findOrderById(state.orderId);
  const payment = repository.findByCheckoutId(state.checkoutId);
  if (order === undefined || payment === undefined) {
    throw new Error("Sandbox E2E local order/payment pair is missing");
  }

  console.log(
    JSON.stringify({
      orderStatus: order.status,
      paymentStatus: payment.status,
      orderUpdatedAt: order.updatedAt,
      paymentUpdatedAt: payment.updatedAt,
      paidAt: payment.paidAt,
      successfulTransactionStored:
        payment.successfulTransactionId !== null,
      amountCents: payment.amountCents,
      currency: payment.currency,
      posterSubmitted: order.status === "submitted_to_poster",
    }),
  );
} finally {
  repository.close();
}
