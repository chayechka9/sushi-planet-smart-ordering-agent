import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  POSTER_PREPAID_SANDBOX_CHECKOUT_CONFIRMATION,
  createPosterPrepaidSandboxE2eCheckout,
  type CreatePosterPrepaidSandboxE2eCheckoutDependencies,
  type CreatePosterPrepaidSandboxE2eCheckoutInput,
} from "../src/application/create-poster-prepaid-sandbox-e2e-checkout.js";
import type { PosterPrepaidSandboxE2eItemInput } from "../src/application/prepare-poster-prepaid-sandbox-e2e.js";
import type { CreatedSumUpHostedCheckout } from "../src/integrations/sumup/create-checkout.js";
import { SqliteOrderPaymentRepository } from "../src/storage/sqlite/order-payment-repository.js";
import {
  FilePosterPrepaidSandboxCheckoutLifecycle,
  readPosterPrepaidSandboxE2eRecoveryState,
  resolvePosterPrepaidSandboxE2ePaths,
} from "../src/scripts/poster-prepaid-sandbox-e2e-local-state.js";

const now = new Date("2026-09-22T14:30:00.000Z");
const menuCapturedAt = new Date("2026-09-22T14:29:00.000Z");
const selectedPosterItem: PosterPrepaidSandboxE2eItemInput = {
  productId: "1",
  spotId: "1",
  name: "Вода минеральная Боржоми в стекле 0.5л",
  unitPriceCents: 1_000,
  currency: "EUR",
  quantity: 1,
  fulfilment: "pickup",
};

const temporaryDirectories: string[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network must be injected in checkout runner tests");
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createWorkingDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "poster-prepaid-runner-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createInput(
  overrides: Partial<CreatePosterPrepaidSandboxE2eCheckoutInput> = {},
): CreatePosterPrepaidSandboxE2eCheckoutInput {
  return {
    confirmation: POSTER_PREPAID_SANDBOX_CHECKOUT_CONFIRMATION,
    item: selectedPosterItem,
    menuSnapshot: {
      source: "poster_menu_read_only",
      capturedAt: menuCapturedAt.toISOString(),
      currency: "EUR",
      items: [
        {
          id: selectedPosterItem.productId,
          name: selectedPosterItem.name,
          categoryId: "1",
          categoryName: "Холодные напитки",
          hidden: false,
          spots: [
            {
              spotId: selectedPosterItem.spotId,
              priceCents: selectedPosterItem.unitPriceCents,
              visible: true,
            },
          ],
        },
      ],
    },
    merchant: {
      merchantCode: "synthetic-sandbox-merchant",
      country: "IE",
      defaultCurrency: "EUR",
      sandbox: true,
    },
    returnUrl: "https://sandbox.invalid/webhooks/sumup",
    now,
    maxMenuSnapshotAgeMs: 5 * 60 * 1_000,
    createOrderId: () => "ord_poster_prepaid_runner",
    ...overrides,
  };
}

function createCheckoutResult(
  checkoutReference: string,
): CreatedSumUpHostedCheckout {
  return {
    checkoutId: "synthetic-checkout-id",
    checkoutReference,
    merchantCode: "synthetic-sandbox-merchant",
    amountCents: 1_000,
    currency: "EUR",
    status: "PENDING",
    hostedCheckoutUrl: "https://checkout.invalid/hosted/synthetic",
  };
}

function createDependencies(): {
  dependencies: CreatePosterPrepaidSandboxE2eCheckoutDependencies;
  createOnce: ReturnType<typeof vi.fn>;
  beginAttempt: ReturnType<typeof vi.fn>;
  saveCreatedCheckout: ReturnType<typeof vi.fn>;
} {
  const createOnce = vi.fn(async (checkout) =>
    createCheckoutResult(checkout.checkoutReference),
  );
  const beginAttempt = vi.fn();
  const saveCreatedCheckout = vi.fn();
  return {
    dependencies: {
      checkoutCreator: { createOnce },
      lifecycle: { beginAttempt, saveCreatedCheckout },
    },
    createOnce,
    beginAttempt,
    saveCreatedCheckout,
  };
}

describe("Poster prepaid sandbox E2E checkout runner", () => {
  it("rejects a non-canonical menu timestamp before claiming or creating checkout", async () => {
    const { dependencies, beginAttempt, createOnce } = createDependencies();
    const input = createInput();
    await expect(createPosterPrepaidSandboxE2eCheckout({
      ...input,
      menuSnapshot: {
        ...input.menuSnapshot,
        capturedAt: "2026-09-22T14:29:00Z",
      },
    }, dependencies)).rejects.toThrow("exact ISO UTC");
    expect(beginAttempt).not.toHaveBeenCalled();
    expect(createOnce).not.toHaveBeenCalled();
  });

  it("is disabled without confirmation and performs no fetch or file mutation", async () => {
    const workingDirectory = createWorkingDirectory();
    const paths = resolvePosterPrepaidSandboxE2ePaths(workingDirectory);
    const createOnce = vi.fn();
    const input = createInput();
    delete input.confirmation;

    await expect(
      createPosterPrepaidSandboxE2eCheckout(
        input,
        {
          checkoutCreator: { createOnce },
          lifecycle: new FilePosterPrepaidSandboxCheckoutLifecycle(paths),
        },
      ),
    ).resolves.toEqual({
      outcome: "disabled",
      checkoutCount: 0,
      paymentAttemptLimit: 1,
      posterSubmitted: false,
      retry: false,
    });

    expect(createOnce).not.toHaveBeenCalled();
    expect(existsSync(paths.directoryPath)).toBe(false);
  });

  it("prepares the selected Poster item as authoritative EUR 10.00 and one pending checkout", async () => {
    const { dependencies, createOnce, beginAttempt, saveCreatedCheckout } =
      createDependencies();

    await expect(
      createPosterPrepaidSandboxE2eCheckout(createInput(), dependencies),
    ).resolves.toEqual({
      outcome: "created",
      checkoutCount: 1,
      paymentAttemptLimit: 1,
      amountCents: 1_000,
      currency: "EUR",
      orderStatus: "awaiting_payment",
      paymentStatus: "pending",
      posterSubmitted: false,
      retry: false,
    });

    expect(createOnce).toHaveBeenCalledTimes(1);
    expect(createOnce.mock.calls[0]?.[0]).toMatchObject({
      amountCents: 1_000,
      payload: {
        amount: 10,
        currency: "EUR",
        hosted_checkout: { enabled: true },
      },
    });
    expect(beginAttempt).toHaveBeenCalledTimes(1);
    expect(saveCreatedCheckout).toHaveBeenCalledTimes(1);
    expect(saveCreatedCheckout.mock.calls[0]?.[0]).toMatchObject({
      order: {
        status: "awaiting_payment",
        fulfilment: { type: "pickup" },
        items: [
          {
            menuItemId: "1",
            name: selectedPosterItem.name,
            unitPriceCents: 1_000,
            quantity: 1,
          },
        ],
      },
      payment: {
        amountCents: 1_000,
        currency: "EUR",
        status: "pending",
        paidAt: null,
        successfulTransactionId: null,
      },
      spotId: "1",
      checkoutCount: 1,
      paymentAttemptLimit: 1,
      posterSubmitted: false,
    });
  });

  it.each([
    { name: "product", item: { ...selectedPosterItem, productId: "" } },
    { name: "spot", item: { ...selectedPosterItem, spotId: "" } },
    { name: "name", item: { ...selectedPosterItem, name: "" } },
    { name: "price", item: { ...selectedPosterItem, unitPriceCents: 0 } },
    {
      name: "currency",
      item: { ...selectedPosterItem, currency: "USD" },
    },
    { name: "quantity", item: { ...selectedPosterItem, quantity: 2 } },
    {
      name: "fulfilment",
      item: { ...selectedPosterItem, fulfilment: "delivery" },
    },
  ])("rejects invalid $name before claim or checkout", async ({ item }) => {
    const { dependencies, createOnce, beginAttempt, saveCreatedCheckout } =
      createDependencies();

    await expect(
      createPosterPrepaidSandboxE2eCheckout(
        createInput({
          item: item as PosterPrepaidSandboxE2eItemInput,
        }),
        dependencies,
      ),
    ).rejects.toThrow();

    expect(beginAttempt).not.toHaveBeenCalled();
    expect(createOnce).not.toHaveBeenCalled();
    expect(saveCreatedCheckout).not.toHaveBeenCalled();
  });

  it("keeps a separate durable lifecycle and blocks a second checkout", async () => {
    const workingDirectory = createWorkingDirectory();
    const paths = resolvePosterPrepaidSandboxE2ePaths(workingDirectory);
    const genericSumUpDirectory = join(workingDirectory, ".sumup-e2e");
    const createOnce = vi.fn(async (checkout) =>
      createCheckoutResult(checkout.checkoutReference),
    );
    const dependencies = {
      checkoutCreator: { createOnce },
      lifecycle: new FilePosterPrepaidSandboxCheckoutLifecycle(paths),
    };

    await createPosterPrepaidSandboxE2eCheckout(createInput(), dependencies);
    await expect(
      createPosterPrepaidSandboxE2eCheckout(createInput(), dependencies),
    ).rejects.toThrow("attempt already exists");

    expect(createOnce).toHaveBeenCalledTimes(1);
    expect(existsSync(paths.attemptMarkerPath)).toBe(true);
    expect(existsSync(paths.recoveryStatePath)).toBe(true);
    expect(existsSync(paths.databasePath)).toBe(true);
    expect(existsSync(genericSumUpDirectory)).toBe(false);

    const state = readPosterPrepaidSandboxE2eRecoveryState(
      paths.recoveryStatePath,
    );
    expect(state).toMatchObject({
      lifecycle: "poster_prepaid_sandbox_e2e",
      spotId: "1",
      amountCents: 1_000,
      currency: "EUR",
      checkoutCount: 1,
      paymentAttemptLimit: 1,
      posterSubmitted: false,
    });
    expect(state.preparationFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      JSON.parse(readFileSync(paths.recoveryStatePath, "utf8")),
    ).not.toHaveProperty("hostedCheckoutUrl");

    const repository = new SqliteOrderPaymentRepository(paths.databasePath, {
      readOnly: true,
    });
    try {
      expect(repository.findOrderById(state.orderId)?.status).toBe(
        "awaiting_payment",
      );
      expect(repository.findByCheckoutId(state.checkoutId)).toMatchObject({
        status: "pending",
        paidAt: null,
        successfulTransactionId: null,
      });
    } finally {
      repository.close();
    }
  });

  it("preserves the attempt guard after an ambiguous creator failure without retry", async () => {
    const workingDirectory = createWorkingDirectory();
    const paths = resolvePosterPrepaidSandboxE2ePaths(workingDirectory);
    const createOnce = vi.fn(async () => {
      throw new Error("synthetic ambiguous provider result");
    });
    const dependencies = {
      checkoutCreator: { createOnce },
      lifecycle: new FilePosterPrepaidSandboxCheckoutLifecycle(paths),
    };

    await expect(
      createPosterPrepaidSandboxE2eCheckout(createInput(), dependencies),
    ).rejects.toThrow("ambiguous provider result");
    await expect(
      createPosterPrepaidSandboxE2eCheckout(createInput(), dependencies),
    ).rejects.toThrow("attempt already exists");

    expect(createOnce).toHaveBeenCalledTimes(1);
    expect(existsSync(paths.attemptMarkerPath)).toBe(true);
    expect(existsSync(paths.recoveryStatePath)).toBe(false);
  });

  it("has no Poster submit boundary and cannot mark paid without webhook verification", async () => {
    const { dependencies, saveCreatedCheckout } = createDependencies();

    const result = await createPosterPrepaidSandboxE2eCheckout(
      createInput(),
      dependencies,
    );

    expect(result.posterSubmitted).toBe(false);
    expect(result).toMatchObject({
      orderStatus: "awaiting_payment",
      paymentStatus: "pending",
    });
    const saved = saveCreatedCheckout.mock.calls[0]?.[0];
    expect(saved.order.status).not.toBe("paid");
    expect(saved.order.status).not.toBe("submitted_to_poster");
    expect(saved.payment.status).not.toBe("paid");
    expect(Object.keys(dependencies)).toEqual([
      "checkoutCreator",
      "lifecycle",
    ]);
  });
});
