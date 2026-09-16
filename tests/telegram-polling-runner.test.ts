import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  TelegramApiTransport,
  TelegramGetUpdatesInput,
  TelegramSendMessageInput,
  TelegramUpdateEnvelope,
} from "../src/integrations/telegram/api-transport.js";
import {
  TelegramApiTransportError,
  type TelegramTransportFailureCode,
} from "../src/integrations/telegram/api-transport.js";
import { DeterministicTelegramInterpreter } from "../src/integrations/telegram/deterministic-interpreter.js";
import { writeLocalMenuSnapshotAtomically } from "../src/menu/local-menu-snapshot.js";
import {
  installTelegramShutdownHandlers,
  runTelegramPolling,
  TELEGRAM_POLLING_CONFIRMATION,
  type TelegramPollingRunnerEvent,
  type TelegramShutdownSignalSource,
} from "../src/scripts/telegram-polling-runner.js";
import { SqliteConversationStateStore } from "../src/storage/sqlite/conversation-state-store.js";

const syntheticToken = "synthetic-controlled-telegram-token-never-send";
const temporaryDirectories: string[] = [];
let globalFetch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  globalFetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Real Telegram network access is forbidden"));
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  globalFetch.mockRestore();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeTelegramTransport implements TelegramApiTransport {
  readonly getUpdates = vi.fn(
    async (_input: TelegramGetUpdatesInput) => this.updates,
  );
  readonly sendMessage = vi.fn(async (_input: TelegramSendMessageInput) => {
    if (this.failSend) throw new Error("synthetic send failure");
  });

  constructor(
    private readonly updates: readonly TelegramUpdateEnvelope[] = [],
    readonly failSend = false,
  ) {}
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "sushi-planet-telegram-runner-"));
  temporaryDirectories.push(directory);
  return join(directory, "conversation.sqlite");
}

function privateStartUpdate(): TelegramUpdateEnvelope {
  return {
    updateId: 700,
    payload: {
      update_id: 700,
      message: {
        message_id: 71,
        from: { id: 501, is_bot: false },
        chat: { id: 501, type: "private" },
        text: "/start",
      },
    },
  };
}

function privateMenuUpdate(): TelegramUpdateEnvelope {
  return privateCommandUpdate({
    updateId: 701,
    messageId: 72,
    text: "/menu",
  });
}

function privateCommandUpdate(input: {
  updateId: number;
  messageId: number;
  text: string;
}): TelegramUpdateEnvelope {
  return {
    updateId: input.updateId,
    payload: {
      update_id: input.updateId,
      message: {
        message_id: input.messageId,
        from: { id: 502, is_bot: false },
        chat: { id: 502, type: "private" },
        text: input.text,
      },
    },
  };
}

function writeSyntheticMenu(databasePath: string): string {
  const menuSnapshotPath = join(databasePath, "..", "menu.json");
  writeLocalMenuSnapshotAtomically(menuSnapshotPath, [
    {
      id: "synthetic-item-beta",
      name: "Synthetic Fixture Beta",
      unitPriceCents: 250,
      available: true,
    },
    {
      id: "synthetic-item-alpha",
      name: "Synthetic Fixture Alpha",
      unitPriceCents: 123,
      available: true,
    },
    {
      id: "synthetic-item-disabled",
      name: "Synthetic Disabled Fixture",
      unitPriceCents: 999,
      available: false,
    },
  ]);
  return menuSnapshotPath;
}

function writeSyntheticDeliveryTariffs(
  databasePath: string,
  tariffs: readonly unknown[],
): string {
  const tariffPath = join(databasePath, "..", "delivery-tariffs.json");
  writeFileSync(
    tariffPath,
    JSON.stringify({ schemaVersion: 1, tariffs }),
    "utf8",
  );
  return tariffPath;
}

function enabledEnvironment(): NodeJS.ProcessEnv {
  return {
    TELEGRAM_RUNTIME_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: syntheticToken,
  };
}

describe("controlled Telegram polling runner", () => {
  it("requires the exact confirmation flag before any network or local state", async () => {
    const databasePath = temporaryDatabasePath();
    const controller = new AbortController();

    await expect(
      runTelegramPolling({
        argv: [],
        environment: enabledEnvironment(),
        signal: controller.signal,
        databasePath,
      }),
    ).resolves.toEqual({
      status: "error",
      errorCode: "confirmation_required",
    });
    await expect(
      runTelegramPolling({
        argv: [TELEGRAM_POLLING_CONFIRMATION, "unexpected"],
        environment: enabledEnvironment(),
        signal: controller.signal,
        databasePath,
      }),
    ).resolves.toEqual({
      status: "error",
      errorCode: "confirmation_required",
    });

    expect(existsSync(databasePath)).toBe(false);
  });

  it("requires the runtime opt-in and token without calling a transport", async () => {
    const transport = new FakeTelegramTransport();
    const controller = new AbortController();

    await expect(
      runTelegramPolling({
        argv: [TELEGRAM_POLLING_CONFIRMATION],
        environment: { TELEGRAM_BOT_TOKEN: syntheticToken },
        signal: controller.signal,
        databasePath: temporaryDatabasePath(),
        transport,
      }),
    ).resolves.toEqual({ status: "error", errorCode: "runtime_disabled" });
    await expect(
      runTelegramPolling({
        argv: [TELEGRAM_POLLING_CONFIRMATION],
        environment: { TELEGRAM_RUNTIME_ENABLED: "true" },
        signal: controller.signal,
        databasePath: temporaryDatabasePath(),
        transport,
      }),
    ).resolves.toEqual({
      status: "error",
      errorCode: "invalid_configuration",
    });

    expect(transport.getUpdates).not.toHaveBeenCalled();
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it("runs one deterministic batch and stops cleanly without OpenAI", async () => {
    const databasePath = temporaryDatabasePath();
    const transport = new FakeTelegramTransport([privateStartUpdate()]);
    const controller = new AbortController();
    const events: TelegramPollingRunnerEvent[] = [];

    const summary = await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: controller.signal,
      databasePath,
      transport,
      onEvent: (event) => {
        events.push(event);
        if (event.status === "batch") controller.abort();
      },
    });

    expect(summary).toEqual({ status: "stopped" });
    expect(events).toEqual([
      { status: "started" },
      {
        status: "batch",
        received: 1,
        replied: 1,
        ignored: 0,
        processingFailed: 0,
        sendFailed: 0,
      },
    ]);
    expect(transport.getUpdates).toHaveBeenCalledOnce();
    expect(transport.sendMessage).toHaveBeenCalledWith({
      chatId: 501,
      text: "Корзина:\nКорзина пуста.\nПолучение: не выбрано\nИтого: €0.00\nУбрать: /remove <номер> [количество]",
      signal: controller.signal,
    });

    const store = new SqliteConversationStateStore(databasePath, {
      readOnly: true,
    });
    try {
      expect(store.findByConversationId("telegram:chat:501")).toMatchObject({
        identity: { channel: "telegram", userId: "telegram:user:501" },
        processedMessages: [{ messageId: "telegram:message:71" }],
      });
    } finally {
      store.close();
    }

    const safeOutput = JSON.stringify([...events, summary]);
    expect(safeOutput).not.toContain(syntheticToken);
    expect(safeOutput).not.toContain("/start");
    expect(safeOutput).not.toContain("501");
  });

  it("reports send failure without retry and suppresses the same message after restart", async () => {
    const databasePath = temporaryDatabasePath();
    const firstTransport = new FakeTelegramTransport(
      [privateStartUpdate()],
      true,
    );
    const firstController = new AbortController();
    const firstEvents: TelegramPollingRunnerEvent[] = [];

    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: firstController.signal,
      databasePath,
      transport: firstTransport,
      onEvent: (event) => {
        firstEvents.push(event);
        if (event.status === "batch") firstController.abort();
      },
    });

    expect(firstTransport.sendMessage).toHaveBeenCalledOnce();
    expect(firstEvents.at(-1)).toEqual({
      status: "batch",
      received: 1,
      replied: 0,
      ignored: 0,
      processingFailed: 0,
      sendFailed: 1,
    });

    const restartedTransport = new FakeTelegramTransport([privateStartUpdate()]);
    const restartedController = new AbortController();
    const restartedEvents: TelegramPollingRunnerEvent[] = [];
    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: restartedController.signal,
      databasePath,
      transport: restartedTransport,
      onEvent: (event) => {
        restartedEvents.push(event);
        if (event.status === "batch") restartedController.abort();
      },
    });

    expect(restartedTransport.sendMessage).not.toHaveBeenCalled();
    expect(restartedEvents.at(-1)).toEqual({
      status: "batch",
      received: 1,
      replied: 0,
      ignored: 1,
      processingFailed: 0,
      sendFailed: 0,
    });
  });

  it("renders the validated local snapshot for the deterministic menu command", async () => {
    const databasePath = temporaryDatabasePath();
    const menuSnapshotPath = join(databasePath, "..", "menu.json");
    writeLocalMenuSnapshotAtomically(menuSnapshotPath, [
      {
        id: "synthetic-fixture-item",
        name: "Synthetic Fixture Item",
        unitPriceCents: 123,
        available: true,
      },
    ]);
    const transport = new FakeTelegramTransport([privateMenuUpdate()]);
    const controller = new AbortController();

    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: controller.signal,
      databasePath,
      menuSnapshotPath,
      transport,
      onEvent: (event) => {
        if (event.status === "batch") controller.abort();
      },
    });

    expect(transport.sendMessage).toHaveBeenCalledWith({
      chatId: 502,
      text: "Меню:\n1. Synthetic Fixture Item — €1.23\nДобавить: /add <номер> [количество]",
      signal: controller.signal,
    });
  });

  it("numbers the menu and uses the existing core for add quantity and cart totals", async () => {
    const databasePath = temporaryDatabasePath();
    const menuSnapshotPath = writeSyntheticMenu(databasePath);
    const transport = new FakeTelegramTransport([
      privateCommandUpdate({ updateId: 710, messageId: 80, text: "/menu" }),
      privateCommandUpdate({ updateId: 711, messageId: 81, text: "/add 2 3" }),
      privateCommandUpdate({ updateId: 712, messageId: 82, text: "/cart" }),
    ]);
    const controller = new AbortController();
    const events: TelegramPollingRunnerEvent[] = [];

    const summary = await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: controller.signal,
      databasePath,
      menuSnapshotPath,
      transport,
      onEvent: (event) => {
        events.push(event);
        if (event.status === "batch") controller.abort();
      },
    });

    expect(summary).toEqual({ status: "stopped" });
    expect(events.at(-1)).toEqual({
      status: "batch",
      received: 3,
      replied: 3,
      ignored: 0,
      processingFailed: 0,
      sendFailed: 0,
    });
    expect(transport.sendMessage).toHaveBeenNthCalledWith(1, {
      chatId: 502,
      text: [
        "Меню:",
        "1. Synthetic Fixture Alpha — €1.23",
        "2. Synthetic Fixture Beta — €2.50",
        "Добавить: /add <номер> [количество]",
      ].join("\n"),
      signal: controller.signal,
    });
    const expectedCart =
      "Корзина:\n1. Synthetic Fixture Beta × 3 — €7.50\nПолучение: не выбрано\nИтого: €7.50\nУбрать: /remove <номер> [количество]";
    expect(transport.sendMessage).toHaveBeenNthCalledWith(2, {
      chatId: 502,
      text: expectedCart,
      signal: controller.signal,
    });
    expect(transport.sendMessage).toHaveBeenNthCalledWith(3, {
      chatId: 502,
      text: expectedCart,
      signal: controller.signal,
    });
  });

  it("explains invalid add commands without changing the cart", async () => {
    const databasePath = temporaryDatabasePath();
    const menuSnapshotPath = writeSyntheticMenu(databasePath);
    const transport = new FakeTelegramTransport([
      privateCommandUpdate({ updateId: 720, messageId: 90, text: "/add" }),
      privateCommandUpdate({ updateId: 721, messageId: 91, text: "/add 9" }),
      privateCommandUpdate({ updateId: 722, messageId: 92, text: "/add 1 0" }),
      privateCommandUpdate({ updateId: 723, messageId: 93, text: "/add nope" }),
      privateCommandUpdate({ updateId: 724, messageId: 94, text: "/checkout" }),
      privateCommandUpdate({ updateId: 725, messageId: 95, text: "/cart" }),
    ]);
    const controller = new AbortController();

    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: controller.signal,
      databasePath,
      menuSnapshotPath,
      transport,
      onEvent: (event) => {
        if (event.status === "batch") controller.abort();
      },
    });

    const explanation =
      "Проверьте формат и порядок команд: /add <номер> [количество], /remove <номер из корзины> [количество], /name <имя>, /phone <телефон>, /delivery перед /address <улица> | <город> | <индекс>.";
    for (let call = 1; call <= 4; call += 1) {
      expect(transport.sendMessage).toHaveBeenNthCalledWith(call, {
        chatId: 502,
        text: explanation,
        signal: controller.signal,
      });
    }
    expect(transport.sendMessage).toHaveBeenNthCalledWith(5, {
      chatId: 502,
      text: "Доступные команды: /menu, /add <номер> [количество], /cart, /remove <номер> [количество], /pickup, /delivery, /name <имя>, /phone <телефон>, /address <улица> | <город> | <индекс>, /review.",
      signal: controller.signal,
    });
    expect(transport.sendMessage).toHaveBeenNthCalledWith(6, {
      chatId: 502,
      text: "Корзина:\nКорзина пуста.\nПолучение: не выбрано\nИтого: €0.00\nУбрать: /remove <номер> [количество]",
      signal: controller.signal,
    });
  });

  it("keeps the cart unchanged when no validated menu is available", async () => {
    const databasePath = temporaryDatabasePath();
    const transport = new FakeTelegramTransport([
      privateCommandUpdate({ updateId: 730, messageId: 100, text: "/add 1" }),
      privateCommandUpdate({ updateId: 731, messageId: 101, text: "/cart" }),
    ]);
    const controller = new AbortController();

    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: controller.signal,
      databasePath,
      menuSnapshotPath: join(databasePath, "..", "missing-menu.json"),
      transport,
      onEvent: (event) => {
        if (event.status === "batch") controller.abort();
      },
    });

    expect(transport.sendMessage).toHaveBeenNthCalledWith(1, {
      chatId: 502,
      text: "Проверьте формат и порядок команд: /add <номер> [количество], /remove <номер из корзины> [количество], /name <имя>, /phone <телефон>, /delivery перед /address <улица> | <город> | <индекс>.",
      signal: controller.signal,
    });
    expect(transport.sendMessage).toHaveBeenNthCalledWith(2, {
      chatId: 502,
      text: "Корзина:\nКорзина пуста.\nПолучение: не выбрано\nИтого: €0.00\nУбрать: /remove <номер> [количество]",
      signal: controller.signal,
    });
  });

  it("does not add twice for a duplicate message and preserves the cart after restart", async () => {
    const databasePath = temporaryDatabasePath();
    const menuSnapshotPath = writeSyntheticMenu(databasePath);
    const addUpdate = privateCommandUpdate({
      updateId: 740,
      messageId: 110,
      text: "/add 1 2",
    });
    const firstTransport = new FakeTelegramTransport([addUpdate, addUpdate]);
    const firstController = new AbortController();
    const firstEvents: TelegramPollingRunnerEvent[] = [];

    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: firstController.signal,
      databasePath,
      menuSnapshotPath,
      transport: firstTransport,
      onEvent: (event) => {
        firstEvents.push(event);
        if (event.status === "batch") firstController.abort();
      },
    });

    expect(firstEvents.at(-1)).toEqual({
      status: "batch",
      received: 2,
      replied: 1,
      ignored: 1,
      processingFailed: 0,
      sendFailed: 0,
    });
    expect(firstTransport.sendMessage).toHaveBeenCalledOnce();

    const restartedTransport = new FakeTelegramTransport([
      addUpdate,
      privateCommandUpdate({ updateId: 741, messageId: 111, text: "/cart" }),
    ]);
    const restartedController = new AbortController();
    const restartedEvents: TelegramPollingRunnerEvent[] = [];
    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: restartedController.signal,
      databasePath,
      menuSnapshotPath,
      transport: restartedTransport,
      onEvent: (event) => {
        restartedEvents.push(event);
        if (event.status === "batch") restartedController.abort();
      },
    });

    expect(restartedEvents.at(-1)).toEqual({
      status: "batch",
      received: 2,
      replied: 1,
      ignored: 1,
      processingFailed: 0,
      sendFailed: 0,
    });
    expect(restartedTransport.sendMessage).toHaveBeenCalledOnce();
    expect(restartedTransport.sendMessage).toHaveBeenCalledWith({
      chatId: 502,
      text: "Корзина:\n1. Synthetic Fixture Alpha × 2 — €2.46\nПолучение: не выбрано\nИтого: €2.46\nУбрать: /remove <номер> [количество]",
      signal: restartedController.signal,
    });
  });

  it("removes a bounded quantity once and can remove the full cart line", async () => {
    const databasePath = temporaryDatabasePath();
    const menuSnapshotPath = writeSyntheticMenu(databasePath);
    const removeUpdate = privateCommandUpdate({
      updateId: 751,
      messageId: 121,
      text: "/remove 1 1",
    });
    const transport = new FakeTelegramTransport([
      privateCommandUpdate({ updateId: 750, messageId: 120, text: "/add 1 3" }),
      removeUpdate,
      removeUpdate,
      privateCommandUpdate({ updateId: 752, messageId: 122, text: "/cart" }),
      privateCommandUpdate({ updateId: 753, messageId: 123, text: "/remove 1" }),
      privateCommandUpdate({ updateId: 754, messageId: 124, text: "/cart" }),
    ]);
    const controller = new AbortController();
    const events: TelegramPollingRunnerEvent[] = [];

    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: controller.signal,
      databasePath,
      menuSnapshotPath,
      transport,
      onEvent: (event) => {
        events.push(event);
        if (event.status === "batch") controller.abort();
      },
    });

    expect(events.at(-1)).toEqual({
      status: "batch",
      received: 6,
      replied: 5,
      ignored: 1,
      processingFailed: 0,
      sendFailed: 0,
    });
    expect(transport.sendMessage).toHaveBeenNthCalledWith(3, {
      chatId: 502,
      text: "Корзина:\n1. Synthetic Fixture Alpha × 2 — €2.46\nПолучение: не выбрано\nИтого: €2.46\nУбрать: /remove <номер> [количество]",
      signal: controller.signal,
    });
    expect(transport.sendMessage).toHaveBeenNthCalledWith(5, {
      chatId: 502,
      text: "Корзина:\nКорзина пуста.\nПолучение: не выбрано\nИтого: €0.00\nУбрать: /remove <номер> [количество]",
      signal: controller.signal,
    });
  });

  it("collects pickup contact fields and reviews without requiring an address", async () => {
    const databasePath = temporaryDatabasePath();
    const menuSnapshotPath = writeSyntheticMenu(databasePath);
    const transport = new FakeTelegramTransport([
      privateCommandUpdate({ updateId: 760, messageId: 130, text: "/add 1" }),
      privateCommandUpdate({ updateId: 761, messageId: 131, text: "/pickup" }),
      privateCommandUpdate({
        updateId: 762,
        messageId: 132,
        text: "/name Synthetic Tester",
      }),
      privateCommandUpdate({
        updateId: 763,
        messageId: 133,
        text: "/phone +000 000 0000",
      }),
      privateCommandUpdate({ updateId: 764, messageId: 134, text: "/review" }),
    ]);
    const controller = new AbortController();

    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: controller.signal,
      databasePath,
      menuSnapshotPath,
      transport,
      onEvent: (event) => {
        if (event.status === "batch") controller.abort();
      },
    });

    expect(transport.sendMessage).toHaveBeenNthCalledWith(5, {
      chatId: 502,
      text: "Проверьте заказ:\n1. Synthetic Fixture Alpha × 1 — €1.23\nПолучение: самовывоз\nИтого: €1.23\nОбязательные данные заполнены.\nЗаказ готов к переходу к оплате. Checkout не создан.",
      signal: controller.signal,
    });
    const sentOutput = JSON.stringify(transport.sendMessage.mock.calls);
    expect(sentOutput).not.toContain("Synthetic Tester");
    expect(sentOutput).not.toContain("+0000000000");
    const store = new SqliteConversationStateStore(databasePath, {
      readOnly: true,
    });
    try {
      expect(store.findByConversationId("telegram:chat:502")).toMatchObject({
        fulfilmentChoice: "pickup",
        customer: {
          firstName: "Synthetic Tester",
          phone: "+0000000000",
        },
      });
    } finally {
      store.close();
    }
  });

  it("persists delivery fields and review state across a SQLite restart", async () => {
    const databasePath = temporaryDatabasePath();
    const menuSnapshotPath = writeSyntheticMenu(databasePath);
    const deliveryTariffPath = writeSyntheticDeliveryTariffs(databasePath, [
      {
        district: "Fixture City",
        eircode: "TEST CODE",
        feeCents: 350,
      },
    ]);
    const firstTransport = new FakeTelegramTransport([
      privateCommandUpdate({ updateId: 770, messageId: 140, text: "/add 1" }),
      privateCommandUpdate({ updateId: 771, messageId: 141, text: "/delivery" }),
      privateCommandUpdate({
        updateId: 772,
        messageId: 142,
        text: "/name Synthetic Tester",
      }),
      privateCommandUpdate({
        updateId: 773,
        messageId: 143,
        text: "/phone +000 000 0000",
      }),
      privateCommandUpdate({
        updateId: 774,
        messageId: 144,
        text: "/address Fixture Lane | Fixture City | TEST CODE",
      }),
    ]);
    const firstController = new AbortController();
    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: firstController.signal,
      databasePath,
      menuSnapshotPath,
      deliveryTariffPath,
      transport: firstTransport,
      onEvent: (event) => {
        if (event.status === "batch") firstController.abort();
      },
    });

    const restartedTransport = new FakeTelegramTransport([
      privateCommandUpdate({ updateId: 775, messageId: 145, text: "/review" }),
    ]);
    const restartedController = new AbortController();
    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: restartedController.signal,
      databasePath,
      menuSnapshotPath,
      deliveryTariffPath,
      transport: restartedTransport,
      onEvent: (event) => {
        if (event.status === "batch") restartedController.abort();
      },
    });

    expect(restartedTransport.sendMessage).toHaveBeenCalledWith({
      chatId: 502,
      text: "Проверьте заказ:\n1. Synthetic Fixture Alpha × 1 — €1.23\nПолучение: доставка\nИтого: €4.73\nОбязательные данные заполнены.\nЗаказ готов к переходу к оплате. Checkout не создан.",
      signal: restartedController.signal,
    });
    expect(JSON.stringify(firstTransport.sendMessage.mock.calls)).not.toContain(
      "Fixture Lane",
    );
  });

  it("rejects an unavailable delivery zone without changing address or price", async () => {
    const databasePath = temporaryDatabasePath();
    const menuSnapshotPath = writeSyntheticMenu(databasePath);
    const deliveryTariffPath = writeSyntheticDeliveryTariffs(databasePath, []);
    const transport = new FakeTelegramTransport([
      privateCommandUpdate({ updateId: 776, messageId: 146, text: "/delivery" }),
      privateCommandUpdate({
        updateId: 777,
        messageId: 147,
        text: "/address Fixture Lane | Fixture City | TEST CODE",
      }),
      privateCommandUpdate({ updateId: 778, messageId: 148, text: "/review" }),
    ]);
    const controller = new AbortController();

    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: controller.signal,
      databasePath,
      menuSnapshotPath,
      deliveryTariffPath,
      transport,
      onEvent: (event) => {
        if (event.status === "batch") controller.abort();
      },
    });

    expect(transport.sendMessage).toHaveBeenNthCalledWith(2, {
      chatId: 502,
      text: "Доставка в эту зону пока недоступна.",
      signal: controller.signal,
    });
    expect(transport.sendMessage).toHaveBeenNthCalledWith(3, {
      chatId: 502,
      text: "Проверьте заказ:\nКорзина пуста.\nПолучение: доставка\nИтого: €0.00\nНужно указать: блюда, имя, телефон, адрес.",
      signal: controller.signal,
    });
    const store = new SqliteConversationStateStore(databasePath, {
      readOnly: true,
    });
    try {
      expect(store.findByConversationId("telegram:chat:502")).toMatchObject({
        fulfilmentChoice: "delivery",
        order: { fulfilment: null },
        customer: {},
      });
    } finally {
      store.close();
    }
  });

  it("rejects malformed order commands without mutating the saved order", async () => {
    const databasePath = temporaryDatabasePath();
    const menuSnapshotPath = writeSyntheticMenu(databasePath);
    const transport = new FakeTelegramTransport([
      privateCommandUpdate({ updateId: 780, messageId: 150, text: "/add 1 2" }),
      privateCommandUpdate({ updateId: 781, messageId: 151, text: "/delivery" }),
      privateCommandUpdate({ updateId: 782, messageId: 152, text: "/remove 9" }),
      privateCommandUpdate({ updateId: 783, messageId: 153, text: "/remove 1 0" }),
      privateCommandUpdate({ updateId: 784, messageId: 154, text: "/remove 1 3" }),
      privateCommandUpdate({ updateId: 785, messageId: 155, text: "/name 123" }),
      privateCommandUpdate({ updateId: 786, messageId: 156, text: "/phone invalid" }),
      privateCommandUpdate({
        updateId: 787,
        messageId: 157,
        text: "/address !! | 123 | !!!",
      }),
      privateCommandUpdate({ updateId: 788, messageId: 158, text: "/pickup now" }),
      privateCommandUpdate({ updateId: 789, messageId: 159, text: "/review" }),
    ]);
    const controller = new AbortController();

    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: controller.signal,
      databasePath,
      menuSnapshotPath,
      transport,
      onEvent: (event) => {
        if (event.status === "batch") controller.abort();
      },
    });

    expect(transport.sendMessage).toHaveBeenNthCalledWith(10, {
      chatId: 502,
      text: "Проверьте заказ:\n1. Synthetic Fixture Alpha × 2 — €2.46\nПолучение: доставка\nИтого: €2.46\nНужно указать: имя, телефон, адрес.",
      signal: controller.signal,
    });
  });

  it("renders menu unavailable without fallback when the snapshot is missing", async () => {
    const databasePath = temporaryDatabasePath();
    const transport = new FakeTelegramTransport([privateMenuUpdate()]);
    const controller = new AbortController();

    await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: controller.signal,
      databasePath,
      menuSnapshotPath: join(databasePath, "..", "missing-menu.json"),
      transport,
      onEvent: (event) => {
        if (event.status === "batch") controller.abort();
      },
    });

    expect(transport.sendMessage).toHaveBeenCalledWith({
      chatId: 502,
      text: "Меню сейчас недоступно.",
      signal: controller.signal,
    });
  });

  it.each([
    "timeout",
    "http_failure",
    "network_failure",
    "invalid_response",
  ] satisfies TelegramTransportFailureCode[])(
    "reports allowlisted %s without retry or transport details",
    async (diagnosticReason) => {
      const rawSecret = `raw provider detail ${syntheticToken}`;
      const transportError = Object.assign(
        new TelegramApiTransportError(diagnosticReason),
        { rawSecret },
      );
      const transport: TelegramApiTransport = {
        getUpdates: vi.fn(async () => {
          throw transportError;
        }),
        sendMessage: vi.fn(),
      };
      const events: TelegramPollingRunnerEvent[] = [];

      const summary = await runTelegramPolling({
        argv: [TELEGRAM_POLLING_CONFIRMATION],
        environment: enabledEnvironment(),
        signal: new AbortController().signal,
        databasePath: temporaryDatabasePath(),
        transport,
        onEvent: (event) => {
          events.push(event);
        },
      });

      expect(summary).toEqual({
        status: "error",
        errorCode: "polling_failed",
        diagnosticReason,
      });
      expect(transport.getUpdates).toHaveBeenCalledOnce();
      expect(transport.sendMessage).not.toHaveBeenCalled();
      const safeOutput = JSON.stringify([...events, summary]);
      expect(safeOutput).not.toContain(rawSecret);
      expect(safeOutput).not.toContain(syntheticToken);
      expect(safeOutput).not.toContain("message");
      expect(safeOutput).not.toContain("chat");
      expect(safeOutput).not.toContain("update");
    },
  );

  it("maps an unknown raw polling exception to safe internal_failure", async () => {
    const rawSecret = `raw internal exception ${syntheticToken}`;
    const transport: TelegramApiTransport = {
      getUpdates: vi.fn(async () => {
        throw new Error(rawSecret);
      }),
      sendMessage: vi.fn(),
    };
    const events: TelegramPollingRunnerEvent[] = [];

    const summary = await runTelegramPolling({
      argv: [TELEGRAM_POLLING_CONFIRMATION],
      environment: enabledEnvironment(),
      signal: new AbortController().signal,
      databasePath: temporaryDatabasePath(),
      transport,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(summary).toEqual({
      status: "error",
      errorCode: "polling_failed",
      diagnosticReason: "internal_failure",
    });
    expect(transport.getUpdates).toHaveBeenCalledOnce();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify([...events, summary])).not.toContain(rawSecret);
    expect(JSON.stringify([...events, summary])).not.toContain(syntheticToken);
  });

  it("turns SIGINT and SIGTERM into abort and removes both handlers", () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const listeners = new Map<string, () => void>();
      const source: TelegramShutdownSignalSource = {
        once: vi.fn((name, listener) => listeners.set(name, listener)),
        off: vi.fn((name, listener) => {
          if (listeners.get(name) === listener) listeners.delete(name);
        }),
      };
      const controller = new AbortController();
      const cleanup = installTelegramShutdownHandlers(source, controller);

      listeners.get(signal)?.();
      expect(controller.signal.aborted).toBe(true);
      cleanup();
      expect(listeners.size).toBe(0);
      expect(source.off).toHaveBeenCalledTimes(2);
    }
  });

  it("keeps the CLI separate from the ordinary server", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    const wrapper = readFileSync(
      new URL("../src/scripts/run-telegram-polling.ts", import.meta.url),
      "utf8",
    );
    const server = readFileSync(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    );

    expect(packageJson.scripts["telegram:poll"]).toBe(
      "tsx src/scripts/run-telegram-polling.ts",
    );
    expect(wrapper).toContain('import "dotenv/config";');
    expect(wrapper).toContain("installTelegramShutdownHandlers");
    expect(server.toLowerCase()).not.toContain("telegram");
    expect(server.toLowerCase()).not.toContain("polling");
  });
});

describe("deterministic Telegram interpreter", () => {
  const interpreter = new DeterministicTelegramInterpreter({
    getMenuSnapshot: () => [
      {
        id: "synthetic-item-beta",
        name: "Synthetic Fixture Beta",
        unitPriceCents: 250,
        available: true,
      },
      {
        id: "synthetic-item-alpha",
        name: "Synthetic Fixture Alpha",
        unitPriceCents: 123,
        available: true,
      },
      {
        id: "synthetic-item-disabled",
        name: "Synthetic Disabled Fixture",
        unitPriceCents: 999,
        available: false,
      },
    ],
  });
  const context = {
    conversationId: "synthetic",
    identity: { channel: "telegram", userId: "synthetic" },
    conversation: {
      status: "new" as const,
      cart: [],
      fulfilment: null,
      customerFields: {
        firstName: false,
        lastName: false,
        phone: false,
        deliveryAddress: false,
      },
      checkoutCreated: false,
    },
  };

  it("maps only bounded local commands", async () => {
    await expect(interpreter.interpret(context, " /start ")).resolves.toEqual({
      kind: "command",
      command: { type: "show_cart" },
    });
    await expect(interpreter.interpret(context, "ПОКАЖИ МЕНЮ")).resolves.toEqual({
      kind: "command",
      command: { type: "show_menu" },
    });
    await expect(interpreter.interpret(context, "/add 1")).resolves.toEqual({
      kind: "command",
      command: { type: "add_item", menuItemId: "synthetic-item-alpha" },
    });
    await expect(interpreter.interpret(context, "/add 2 3")).resolves.toEqual({
      kind: "command",
      command: {
        type: "add_item",
        menuItemId: "synthetic-item-beta",
        quantity: 3,
      },
    });
    await expect(interpreter.interpret(context, "/add 0")).resolves.toEqual({
      kind: "needs_clarification",
      reason: "missing_information",
    });
    await expect(interpreter.interpret(context, "создай оплату")).resolves.toEqual({
      kind: "needs_clarification",
      reason: "unsupported",
    });
  });

  it("maps removal, fulfilment, customer fields and review to core commands", async () => {
    const cartContext = {
      ...context,
      conversation: {
        ...context.conversation,
        cart: [{ menuItemId: "synthetic-item-alpha", quantity: 3 }],
        fulfilment: "delivery" as const,
      },
    };

    await expect(interpreter.interpret(cartContext, "/remove 1 2")).resolves.toEqual({
      kind: "command",
      command: {
        type: "set_quantity",
        menuItemId: "synthetic-item-alpha",
        quantity: 1,
      },
    });
    await expect(interpreter.interpret(cartContext, "/remove 1 3")).resolves.toEqual({
      kind: "command",
      command: { type: "remove_item", menuItemId: "synthetic-item-alpha" },
    });
    await expect(interpreter.interpret(context, "/pickup")).resolves.toEqual({
      kind: "command",
      command: { type: "choose_pickup" },
    });
    await expect(interpreter.interpret(context, "/delivery")).resolves.toEqual({
      kind: "command",
      command: { type: "choose_delivery" },
    });
    await expect(
      interpreter.interpret(context, "/name Synthetic Tester"),
    ).resolves.toEqual({
      kind: "command",
      command: { type: "set_customer", firstName: "Synthetic Tester" },
    });
    await expect(
      interpreter.interpret(context, "/phone +000 000-0000"),
    ).resolves.toEqual({
      kind: "command",
      command: { type: "set_customer", phone: "+0000000000" },
    });
    await expect(
      interpreter.interpret(
        cartContext,
        "/address Fixture Lane | Fixture City | TEST CODE",
      ),
    ).resolves.toEqual({
      kind: "command",
      command: {
        type: "set_delivery_address",
        address: {
          line1: "Fixture Lane",
          city: "Fixture City",
          postalCode: "TEST CODE",
        },
      },
    });
    await expect(interpreter.interpret(context, "/review")).resolves.toEqual({
      kind: "command",
      command: { type: "review_order" },
    });
  });

  it("rejects malformed values before they reach the order core", async () => {
    await expect(interpreter.interpret(context, "/remove 1")).resolves.toEqual({
      kind: "needs_clarification",
      reason: "missing_information",
    });
    await expect(interpreter.interpret(context, "/name 123")).resolves.toEqual({
      kind: "needs_clarification",
      reason: "missing_information",
    });
    await expect(interpreter.interpret(context, "/phone invalid")).resolves.toEqual({
      kind: "needs_clarification",
      reason: "missing_information",
    });
    await expect(
      interpreter.interpret(
        context,
        "/address Fixture Lane | Fixture City | TEST CODE",
      ),
    ).resolves.toEqual({
      kind: "needs_clarification",
      reason: "missing_information",
    });
    await expect(interpreter.interpret(context, "/review now")).resolves.toEqual({
      kind: "needs_clarification",
      reason: "missing_information",
    });
  });
});
