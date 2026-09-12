import { runOpenAISmoke } from "./openai-smoke-runner.js";

const safeFallback = {
  status: "error",
  errorCode: "execution_failed",
  providerRequestAttempted: false,
} as const;

try {
  const summary = await runOpenAISmoke({
    args: process.argv.slice(2),
    environment: process.env,
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.status === "error") process.exitCode = 1;
} catch {
  process.stdout.write(`${JSON.stringify(safeFallback)}\n`);
  process.exitCode = 1;
}
