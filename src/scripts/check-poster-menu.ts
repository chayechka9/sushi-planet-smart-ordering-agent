import "dotenv/config";

import { loadPosterConfig } from "../config/poster.js";
import { PosterClient } from "../integrations/poster/client.js";

const config = loadPosterConfig();
const client = new PosterClient(config.token);

const account = await client.getAccountSummary();

if (account.companyId !== config.account) {
  throw new Error(
    `Expected Poster account ${config.account}, received ${account.companyId}`,
  );
}

if (account.currencyIso !== "EUR") {
  throw new Error(
    `Expected Poster currency EUR, received ${account.currencyIso}`,
  );
}

const menuItems = await client.getMenuItems();

console.log(
  JSON.stringify(
    {
      account: account.companyId,
      currency: account.currencyIso,
      timezone: account.timezone,
      productCount: menuItems.length,
      products: menuItems.map((item) => ({
        id: item.id,
        name: item.name,
        category: item.categoryName,
        hidden: item.hidden,
        spots: item.spots,
      })),
    },
    null,
    2,
  ),
);
