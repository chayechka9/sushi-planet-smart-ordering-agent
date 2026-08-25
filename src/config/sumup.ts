export interface SumUpSandboxConfig {
  merchantCode: string;
  apiKey: string;
}

export function loadSumUpSandboxConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SumUpSandboxConfig {
  const merchantCode =
    environment.SUMUP_SANDBOX_MERCHANT_CODE?.trim() ?? "";
  const apiKey = environment.SUMUP_SANDBOX_API_KEY?.trim() ?? "";

  if (merchantCode.length === 0) {
    throw new Error("SUMUP_SANDBOX_MERCHANT_CODE is required");
  }

  if (apiKey.length === 0) {
    throw new Error("SUMUP_SANDBOX_API_KEY is required");
  }

  return { merchantCode, apiKey };
}
