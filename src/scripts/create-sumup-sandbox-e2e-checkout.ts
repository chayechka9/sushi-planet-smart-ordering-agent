import "dotenv/config";

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { createSumUpPayment } from "../domain/payment.js";
import {
  addItem,
  createOrder,
  markAwaitingPayment,
  setPickup,
} from "../domain/order.js";
import { loadSumUpSandboxConfig } from "../config/sumup.js";
import {
  createSumUpHostedCheckout,
  SumUpCheckoutCreationError,
} from "../integrations/sumup/create-checkout.js";
import { buildSumUpHostedCheckout } from "../integrations/sumup/hosted-checkout.js";
import { SqliteOrderPaymentRepository } from "../storage/sqlite/order-payment-repository.js";
import {
  readMerchantPreflight,
  requireEnvironmentValue,
  writePrivateJson,
} from "./sumup-e2e-local-state.js";

async function main(): Promise<void> {
  const databasePath = requireEnvironmentValue(
    process.env,
    "SUMUP_E2E_DB_PATH",
  );
  const preflightPath = requireEnvironmentValue(
    process.env,
    "SUMUP_E2E_PREFLIGHT_PATH",
  );
  const statePath = requireEnvironmentValue(
    process.env,
    "SUMUP_E2E_STATE_PATH",
  );
  const attemptMarkerPath = requireEnvironmentValue(
    process.env,
    "SUMUP_E2E_ATTEMPT_MARKER_PATH",
  );
  const returnUrl = normalizeWebhookReturnUrl(
    requireEnvironmentValue(process.env, "SUMUP_E2E_RETURN_URL"),
  );

  if (existsSync(statePath) || existsSync(attemptMarkerPath)) {
    throw new Error("Sandbox E2E checkout attempt already exists");
  }

  const config = loadSumUpSandboxConfig();
  const merchant = readMerchantPreflight(preflightPath);
  if (
    merchant.merchantCode !== config.merchantCode ||
    !merchant.sandbox ||
    merchant.defaultCurrency !== "EUR"
  ) {
    throw new Error("Sandbox E2E merchant preflight does not match config");
  }

  const now = new Date();
  let order = createOrder({
    createId: () => `ord_sumup_e2e_${randomUUID()}`,
    now: () => now,
  });
  order = addItem(
    order,
    {
      id: "sumup-sandbox-e2e-item",
      name: "SumUp Sandbox E2E Test",
      unitPriceCents: 100,
      available: true,
    },
    1,
    now,
  );
  order = markAwaitingPayment(setPickup(order, now), now);

  const prepared = buildSumUpHostedCheckout({
    order,
    paymentAttempt: 1,
    merchant,
    returnUrl,
  });
  const repository = new SqliteOrderPaymentRepository(databasePath);

  try {
    writePrivateJson(attemptMarkerPath, {
      startedAt: now.toISOString(),
      checkoutLimit: 1,
      paymentAttemptLimit: 1,
    });

    const checkout = await createSumUpHostedCheckout({
      apiKey: config.apiKey,
      checkout: prepared,
    });
    const payment = createSumUpPayment({
      order,
      checkoutId: checkout.checkoutId,
      checkoutReference: checkout.checkoutReference,
      merchantCode: checkout.merchantCode,
      amountCents: checkout.amountCents,
      currency: checkout.currency,
      now,
    });
    repository.createOrderWithPayment(order, payment);

    writePrivateJson(statePath, {
      orderId: order.id,
      checkoutId: checkout.checkoutId,
      checkoutReference: checkout.checkoutReference,
      merchantCode: checkout.merchantCode,
      amountCents: checkout.amountCents,
      currency: checkout.currency,
      hostedCheckoutUrl: checkout.hostedCheckoutUrl,
    });

    console.log(
      JSON.stringify({
        created: true,
        checkoutCount: 1,
        paymentAttemptsUsed: 0,
        checkoutStatus: checkout.status,
        localOrderPaymentStored: true,
        amountCents: checkout.amountCents,
        currency: checkout.currency,
        hostedCheckoutUrlStoredPrivately: true,
        retry: false,
        production: false,
        poster: false,
      }),
    );
  } finally {
    repository.close();
  }
}

function normalizeWebhookReturnUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SUMUP_E2E_RETURN_URL must be valid HTTPS");
  }

  if (
    url.protocol !== "https:" ||
    url.pathname !== "/webhooks/sumup" ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error(
      "SUMUP_E2E_RETURN_URL must be an exact HTTPS /webhooks/sumup endpoint",
    );
  }
  return url.href;
}

main().catch((error: unknown) => {
  const status =
    error instanceof SumUpCheckoutCreationError ? error.status : null;
  console.error(
    JSON.stringify({
      created: false,
      stage: "sandbox_checkout_creation",
      status,
      retry: false,
      production: false,
      poster: false,
    }),
  );
  process.exitCode = 1;
});
