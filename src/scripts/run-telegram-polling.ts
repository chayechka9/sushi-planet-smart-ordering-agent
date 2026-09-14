import "dotenv/config";

import {
  installTelegramShutdownHandlers,
  runTelegramPolling,
  type TelegramPollingRunnerEvent,
} from "./telegram-polling-runner.js";

const controller = new AbortController();
const removeSignalHandlers = installTelegramShutdownHandlers(
  process,
  controller,
);

function writeSafeEvent(event: TelegramPollingRunnerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

try {
  const summary = await runTelegramPolling({
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
