import "dotenv/config";

import { loadSumUpSandboxConfig } from "../config/sumup.js";
import { SumUpClient } from "../integrations/sumup/client.js";

const config = loadSumUpSandboxConfig();
const client = new SumUpClient(config.apiKey);
const merchant = await client.getMerchantSummary(config.merchantCode);

if (!merchant.sandbox) {
  throw new Error(
    "SumUp access check stopped: configured merchant is not a sandbox",
  );
}

console.log(
  JSON.stringify(
    {
      authenticated: true,
      merchantCode: "configured-and-matched",
      sandbox: merchant.sandbox,
      country: merchant.country,
      defaultCurrency: merchant.defaultCurrency,
      request: {
        method: "GET",
        endpoint: "/v1/merchants/{merchant_code}",
        count: 1,
        retry: false,
        writes: 0,
      },
    },
    null,
    2,
  ),
);
