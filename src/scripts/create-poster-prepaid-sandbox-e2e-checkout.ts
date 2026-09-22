import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  POSTER_PREPAID_SANDBOX_CHECKOUT_CONFIRMATION,
  createPosterPrepaidSandboxE2eCheckout,
  type CreatePosterPrepaidSandboxE2eCheckoutInput,
} from "../application/create-poster-prepaid-sandbox-e2e-checkout.js";
import type { PosterPrepaidSandboxE2eItemInput } from "../application/prepare-poster-prepaid-sandbox-e2e.js";

const MAX_MENU_SNAPSHOT_AGE_MS = 30 * 60 * 1_000;

async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const confirmationCount = argv.filter(
    (argument) => argument === POSTER_PREPAID_SANDBOX_CHECKOUT_CONFIRMATION,
  ).length;
  if (confirmationCount === 0) {
    console.log(
      JSON.stringify({
        outcome: "disabled",
        checkoutCount: 0,
        posterSubmitted: false,
        retry: false,
      }),
    );
    return;
  }
  if (confirmationCount !== 1) {
    throw new Error("Exact one-shot checkout confirmation is required");
  }

  const commandInput = parseCommandInput(argv);

  await import("dotenv/config");
  const [
    { loadSumUpSandboxConfig },
    { createSumUpHostedCheckout },
    {
      FilePosterPrepaidSandboxCheckoutLifecycle,
      resolvePosterPrepaidSandboxE2ePaths,
    },
  ] = await Promise.all([
    import("../config/sumup.js"),
    import("../integrations/sumup/create-checkout.js"),
    import("./poster-prepaid-sandbox-e2e-local-state.js"),
  ]);

  const config = loadSumUpSandboxConfig();
  const returnUrl = requireWebhookReturnUrl(process.env.SUMUP_E2E_RETURN_URL);
  const input: CreatePosterPrepaidSandboxE2eCheckoutInput = {
    confirmation: POSTER_PREPAID_SANDBOX_CHECKOUT_CONFIRMATION,
    item: commandInput.item,
    menuSnapshot: {
      source: "poster_menu_read_only",
      capturedAt: commandInput.menuCapturedAt,
      currency: "EUR",
      items: [
        {
          id: commandInput.item.productId,
          name: commandInput.item.name,
          categoryId: "",
          categoryName: "",
          hidden: false,
          spots: [
            {
              spotId: commandInput.item.spotId,
              priceCents: commandInput.item.unitPriceCents,
              visible: true,
            },
          ],
        },
      ],
    },
    merchant: {
      merchantCode: config.merchantCode,
      country: "IE",
      defaultCurrency: "EUR",
      sandbox: true,
    },
    returnUrl,
    now: new Date(),
    maxMenuSnapshotAgeMs: MAX_MENU_SNAPSHOT_AGE_MS,
    createOrderId: () => `ord_poster_prepaid_e2e_${randomUUID()}`,
  };
  const lifecycle = new FilePosterPrepaidSandboxCheckoutLifecycle(
    resolvePosterPrepaidSandboxE2ePaths(),
  );

  const result = await createPosterPrepaidSandboxE2eCheckout(input, {
    lifecycle,
    checkoutCreator: {
      createOnce: (checkout) =>
        createSumUpHostedCheckout({
          apiKey: config.apiKey,
          checkout,
        }),
    },
  });
  console.log(JSON.stringify(result));
}

function parseCommandInput(argv: readonly string[]): {
  item: PosterPrepaidSandboxE2eItemInput;
  menuCapturedAt: string;
} {
  const allowedValueFlags = new Set([
    "--product-id",
    "--spot-id",
    "--name",
    "--unit-price-cents",
    "--currency",
    "--quantity",
    "--fulfilment",
    "--menu-captured-at",
  ]);
  const values = new Map<string, string>();

  for (const argument of argv) {
    if (argument === POSTER_PREPAID_SANDBOX_CHECKOUT_CONFIRMATION) {
      continue;
    }
    const separator = argument.indexOf("=");
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    const value = separator < 0 ? "" : argument.slice(separator + 1);
    if (!allowedValueFlags.has(flag) || value.length === 0 || values.has(flag)) {
      throw new Error("Poster prepaid sandbox checkout arguments are invalid");
    }
    values.set(flag, value);
  }

  if (values.size !== allowedValueFlags.size) {
    throw new Error("All explicit Poster prepaid checkout inputs are required");
  }

  return {
    item: {
      productId: requireArgument(values, "--product-id"),
      spotId: requireArgument(values, "--spot-id"),
      name: requireArgument(values, "--name"),
      unitPriceCents: Number(
        requireArgument(values, "--unit-price-cents"),
      ),
      currency: requireArgument(values, "--currency") as "EUR",
      quantity: Number(requireArgument(values, "--quantity")) as 1,
      fulfilment: requireArgument(values, "--fulfilment") as "pickup",
    },
    menuCapturedAt: requireArgument(values, "--menu-captured-at"),
  };
}

function requireArgument(
  values: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = values.get(name);
  if (value === undefined) {
    throw new Error("Required Poster prepaid checkout argument is missing");
  }
  return value;
}

function requireWebhookReturnUrl(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("SUMUP_E2E_RETURN_URL is required");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("SUMUP_E2E_RETURN_URL must be valid HTTPS");
  }
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/webhooks/sumup" ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error(
      "SUMUP_E2E_RETURN_URL must be an exact HTTPS /webhooks/sumup endpoint",
    );
  }
  return url.href;
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  main().catch((error: unknown) => {
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : null;
    console.error(
      JSON.stringify({
        outcome: "failed",
        stage: "poster_prepaid_sandbox_checkout_creation",
        status,
        checkoutCountLimit: 1,
        posterSubmitted: false,
        retry: false,
      }),
    );
    process.exitCode = 1;
  });
}
