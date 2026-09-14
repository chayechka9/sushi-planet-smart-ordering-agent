import type { MenuItemSnapshot } from "../domain/order.js";
import {
  PosterClient,
  type PosterAccountSummary,
  type PosterMenuItem,
} from "../integrations/poster/client.js";
import {
  defaultLocalMenuSnapshotPath,
  writeLocalMenuSnapshotAtomically,
} from "../menu/local-menu-snapshot.js";

export const POSTER_MENU_REFRESH_CONFIRMATION =
  "--confirm-poster-menu-refresh";

export type TelegramMenuRefreshSummary =
  | { status: "success"; itemCount: number }
  | {
      status: "error";
      errorCode:
        | "confirmation_required"
        | "invalid_configuration"
        | "account_mismatch"
        | "unsupported_currency"
        | "refresh_failed";
    };

interface PosterMenuReadClient {
  getAccountSummary(): Promise<PosterAccountSummary>;
  getMenuItems(): Promise<PosterMenuItem[]>;
}

type PosterFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TelegramMenuRefreshOptions {
  argv: readonly string[];
  environment?: NodeJS.ProcessEnv;
  snapshotPath?: string;
  fetcher?: PosterFetch;
  client?: PosterMenuReadClient;
  now?: () => Date;
}

/**
 * Performs only Poster settings/menu GETs after every local gate succeeds,
 * then atomically stores a normalized allowlisted snapshot.
 */
export async function refreshTelegramMenuSnapshot(
  options: TelegramMenuRefreshOptions,
): Promise<TelegramMenuRefreshSummary> {
  if (!hasExactConfirmation(options.argv)) {
    return { status: "error", errorCode: "confirmation_required" };
  }

  const environment = options.environment ?? process.env;
  const account = environment.POSTER_ACCOUNT?.trim() ?? "";
  const token = environment.POSTER_TOKEN?.trim() ?? "";
  const spotId = environment.POSTER_MENU_SPOT_ID?.trim() ?? "";
  if (account.length === 0 || token.length === 0 || spotId.length === 0) {
    return { status: "error", errorCode: "invalid_configuration" };
  }

  try {
    const client =
      options.client ??
      (options.fetcher === undefined
        ? new PosterClient(token)
        : new PosterClient(token, options.fetcher));
    const accountSummary = await client.getAccountSummary();
    if (accountSummary.companyId !== account) {
      return { status: "error", errorCode: "account_mismatch" };
    }
    if (accountSummary.currencyIso !== "EUR") {
      return { status: "error", errorCode: "unsupported_currency" };
    }

    const posterItems = await client.getMenuItems();
    const items = mapPosterMenuSnapshot(posterItems, spotId);
    writeLocalMenuSnapshotAtomically(
      options.snapshotPath ?? defaultLocalMenuSnapshotPath(),
      items,
      options.now?.() ?? new Date(),
    );
    return { status: "success", itemCount: items.length };
  } catch {
    return { status: "error", errorCode: "refresh_failed" };
  }
}

function hasExactConfirmation(argv: readonly string[]): boolean {
  return argv.length === 1 && argv[0] === POSTER_MENU_REFRESH_CONFIRMATION;
}

function mapPosterMenuSnapshot(
  posterItems: readonly PosterMenuItem[],
  spotId: string,
): MenuItemSnapshot[] {
  return posterItems.flatMap((item) => {
    const matchingSpots = item.spots.filter((spot) => spot.spotId === spotId);
    if (matchingSpots.length === 0) return [];
    if (matchingSpots.length !== 1) {
      throw new Error("Poster menu item has ambiguous spot pricing");
    }
    const spot = matchingSpots[0];
    if (spot === undefined) throw new Error("Poster menu spot is unavailable");
    return [
      {
        id: item.id.trim(),
        name: item.name.trim(),
        unitPriceCents: spot.priceCents,
        available: !item.hidden && spot.visible,
      },
    ];
  });
}
