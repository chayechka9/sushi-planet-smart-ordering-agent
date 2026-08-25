export interface PosterConfig {
  account: string;
  token: string;
}

export function loadPosterConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PosterConfig {
  const account = environment.POSTER_ACCOUNT?.trim() ?? "";
  const token = environment.POSTER_TOKEN?.trim() ?? "";

  if (account.length === 0) {
    throw new Error("POSTER_ACCOUNT is required");
  }

  if (token.length === 0) {
    throw new Error("POSTER_TOKEN is required");
  }

  return { account, token };
}
