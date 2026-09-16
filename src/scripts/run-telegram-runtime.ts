import "dotenv/config";

import {
  installTelegramShutdownHandlers,
} from "./telegram-polling-runner.js";
import {
  runTelegramRuntime,
  type TelegramRuntimeEvent,
} from "./telegram-runtime.js";

const controller = new AbortController();
const removeSignalHandlers = installTelegramShutdownHandlers(
  process,
  controller,
);

function writeSafeEvent(event: TelegramRuntimeEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

try {
  const summary = await runTelegramRuntime({
    argv: process.argv.slice(2),
    environment: process.env,
    signal: controller.signal,
    onEvent: writeSafeEvent,
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.status === "error") process.exitCode = 1;
} finally {
  removeSignalHandlers();
}
