import "dotenv/config";

import { refreshTelegramMenuSnapshot } from "./telegram-menu-refresh.js";

const summary = await refreshTelegramMenuSnapshot({
  argv: process.argv.slice(2),
  environment: process.env,
});

process.stdout.write(`${JSON.stringify(summary)}\n`);
if (summary.status === "error") process.exitCode = 1;
