export interface RuntimeConfig {
  host: string;
  port: number;
}

export function loadRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const port = Number(environment.PORT ?? "3000");

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return {
    host: environment.HOST ?? "0.0.0.0",
    port,
  };
}
