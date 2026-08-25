import {
  buildSumUpHostedCheckout,
  SUMUP_CREATE_CHECKOUT_ENDPOINT,
  type BuildSumUpHostedCheckoutInput,
} from "./hosted-checkout.js";

export interface SumUpHostedCheckoutDryRun {
  mode: "dry-run";
  method: "POST";
  endpoint: typeof SUMUP_CREATE_CHECKOUT_ENDPOINT;
  headers: {
    "Content-Type": "application/json";
  };
  amountCents: number;
  body: string;
}

/**
 * Returns the exact non-authenticated request shape without performing I/O.
 * The API key is intentionally absent from both the input and the output.
 */
export function prepareSumUpHostedCheckoutDryRun(
  input: BuildSumUpHostedCheckoutInput,
): SumUpHostedCheckoutDryRun {
  const checkout = buildSumUpHostedCheckout(input);

  return {
    mode: "dry-run",
    method: "POST",
    endpoint: SUMUP_CREATE_CHECKOUT_ENDPOINT,
    headers: {
      "Content-Type": "application/json",
    },
    amountCents: checkout.amountCents,
    body: JSON.stringify(checkout.payload),
  };
}
