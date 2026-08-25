import "dotenv/config";

import { createApp } from "./app.js";
import { loadRuntimeConfig } from "./config/runtime.js";

const config = loadRuntimeConfig();
const app = createApp({ logger: true });

async function start(): Promise<void> {
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

void start();
