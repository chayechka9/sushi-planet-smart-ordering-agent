import { SqliteOrderPaymentRepository } from "../storage/sqlite/order-payment-repository.js";
import {
  readSumUpE2eRecoveryState,
  resolveSumUpE2eRecoveryPaths,
} from "./sumup-e2e-local-state.js";

const paths = resolveSumUpE2eRecoveryPaths();
const state = readSumUpE2eRecoveryState(paths.statePath);
if (state.databasePath !== paths.databasePath) {
  throw new Error("Sandbox E2E recovery database path does not match");
}
const repository = new SqliteOrderPaymentRepository(state.databasePath, {
  readOnly: true,
});

try {
  const order = repository.findOrderById(state.orderId);
  const payment = repository.findByCheckoutId(state.paymentId);
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
