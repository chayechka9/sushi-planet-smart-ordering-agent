import type { AIConversationLayerResponse } from "../../application/ai-conversation-layer.js";
import type {
  ConversationAgentCommand,
  ConversationAgentResponse,
  ConversationMissingField,
  ConversationOrderView,
} from "../../application/local-conversation-agent.js";
import type {
  TelegramApiTransport,
  TelegramUpdateEnvelope,
} from "./api-transport.js";
import type { TelegramLocalOrderUpdateResult } from "./local-order-update-handler.js";
import { numberAvailableTelegramMenuItems } from "./menu-numbering.js";

export interface TelegramUpdateHandler {
  handle(update: TelegramUpdateEnvelope): Promise<TelegramLocalOrderUpdateResult>;
}

export interface TelegramPollingAdapterDependencies {
  transport: TelegramApiTransport;
  updateHandler: TelegramUpdateHandler;
}

export interface TelegramPollingAdapterOptions {
  timeoutSeconds?: number;
}

export type TelegramUpdateOutcome =
  | { updateId: number; kind: "replied" }
  | { updateId: number; kind: "ignored"; reason: "unsupported" | "duplicate" }
  | { updateId: number; kind: "processing_failed" }
  | { updateId: number; kind: "send_failed" };

export interface TelegramPollResult {
  nextOffset?: number;
  outcomes: readonly TelegramUpdateOutcome[];
}

export type TelegramPollObserver = (
  result: TelegramPollResult,
) => void | Promise<void>;

export interface TelegramPrivateTextMessage {
  chatId: number;
  userId: number;
  messageId: number;
  text: string;
}

/**
 * Sequential long-polling adapter. It advances Telegram offsets for every
 * received update, ignores unsupported update types and never retries a send.
 */
export class TelegramLongPollingAdapter {
  private readonly timeoutSeconds: number;

  constructor(
    private readonly dependencies: TelegramPollingAdapterDependencies,
    options: TelegramPollingAdapterOptions = {},
  ) {
    this.timeoutSeconds = options.timeoutSeconds ?? 25;
    if (
      !Number.isSafeInteger(this.timeoutSeconds) ||
      this.timeoutSeconds < 0 ||
      this.timeoutSeconds > 50
    ) {
      throw new Error("Telegram polling configuration is invalid");
    }
  }

  async pollOnce(
    offset?: number,
    signal?: AbortSignal,
  ): Promise<TelegramPollResult> {
    const input =
      offset === undefined
        ? {
            timeoutSeconds: this.timeoutSeconds,
            ...(signal === undefined ? {} : { signal }),
          }
        : {
            offset,
            timeoutSeconds: this.timeoutSeconds,
            ...(signal === undefined ? {} : { signal }),
          };
    const updates = await this.dependencies.transport.getUpdates(input);
    const outcomes: TelegramUpdateOutcome[] = [];
    let nextOffset = offset;

    for (const update of updates) {
      nextOffset = maxOffset(nextOffset, update.updateId + 1);
      outcomes.push(await this.processUpdate(update, signal));
    }

    return {
      ...(nextOffset === undefined ? {} : { nextOffset }),
      outcomes,
    };
  }

  async run(
    signal: AbortSignal,
    observe?: TelegramPollObserver,
  ): Promise<void> {
    let offset: number | undefined;
    while (!signal.aborted) {
      try {
        const result = await this.pollOnce(offset, signal);
        offset = result.nextOffset ?? offset;
        await observe?.(result);
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
    }
  }

  private async processUpdate(
    update: TelegramUpdateEnvelope,
    signal?: AbortSignal,
  ): Promise<TelegramUpdateOutcome> {
    let result: TelegramLocalOrderUpdateResult;
    try {
      result = await this.dependencies.updateHandler.handle(update);
    } catch {
      return { updateId: update.updateId, kind: "processing_failed" };
    }
    if (result.updateId !== update.updateId) {
      return { updateId: update.updateId, kind: "processing_failed" };
    }
    if (result.kind === "ignored") return result;
    if (result.kind === "processing_failed") return result;
    if (result.text.trim().length === 0) {
      return { updateId: update.updateId, kind: "processing_failed" };
    }

    try {
      await this.dependencies.transport.sendMessage({
        chatId: result.chatId,
        text: result.text,
        ...(signal === undefined ? {} : { signal }),
      });
      return { updateId: update.updateId, kind: "replied" };
    } catch {
      return { updateId: update.updateId, kind: "send_failed" };
    }
  }
}

export function telegramIdentity(message: TelegramPrivateTextMessage): {
  conversationId: string;
  userId: string;
  messageId: string;
} {
  return {
    conversationId: `telegram:chat:${message.chatId}`,
    userId: `telegram:user:${message.userId}`,
    messageId: `telegram:message:${message.messageId}`,
  };
}

export function parseTelegramPrivateTextMessage(
  payload: unknown,
): TelegramPrivateTextMessage | undefined {
  if (!isRecord(payload) || !isRecord(payload.message)) return undefined;
  const message = payload.message;
  if (!isRecord(message.chat) || !isRecord(message.from)) return undefined;
  if (message.chat.type !== "private" || message.from.is_bot === true) {
    return undefined;
  }

  const chatId = positiveSafeInteger(message.chat.id);
  const userId = positiveSafeInteger(message.from.id);
  const messageId = positiveSafeInteger(message.message_id);
  if (
    chatId === undefined ||
    userId === undefined ||
    messageId === undefined ||
    typeof message.text !== "string" ||
    message.text.trim().length === 0
  ) {
    return undefined;
  }
  return { chatId, userId, messageId, text: message.text };
}

export function renderTelegramResponse(
  response: AIConversationLayerResponse,
): string {
  switch (response.kind) {
    case "needs_clarification": {
      switch (response.reason) {
        case "unsupported":
          return "Доступные команды: /menu, /add <номер> [количество], /cart, /remove <номер> [количество], /pickup, /delivery, /name <имя>, /phone <телефон>, /address <улица> | <город> | <индекс>, /review, /staff.";
        case "missing_information":
          return "Проверьте формат и порядок команд: /add <номер> [количество], /remove <номер из корзины> [количество], /name <имя>, /phone <телефон>, /delivery перед /address <улица> | <город> | <индекс>.";
        case "ambiguous":
          return "Уточните, пожалуйста, что вы хотите заказать.";
      }
    }
    case "error":
      if (response.code === "delivery_unavailable") {
        return "Доставка в эту зону пока недоступна.";
      }
      return "Не удалось обработать сообщение. Попробуйте сформулировать запрос иначе.";
    case "command_applied":
      return renderAppliedResponse(response.command, response.response);
  }
}

function renderAppliedResponse(
  command: ConversationAgentCommand,
  response: ConversationAgentResponse,
): string {
  if (response.kind === "cart") {
    if (command.type === "set_customer") {
      const confirmation = command.firstName !== undefined
        ? "Имя сохранено."
        : "Телефон сохранён.";
      return limitTelegramText(
        `${confirmation}\n${renderReview("Заказ", response.order)}`,
      );
    }
    if (command.type === "set_delivery_address") {
      return limitTelegramText(
        `Адрес сохранён.\n${renderReview("Заказ", response.order)}`,
      );
    }
  }
  return renderConversationResponse(response);
}

function renderConversationResponse(response: ConversationAgentResponse): string {
  switch (response.kind) {
    case "menu": {
      const numbered = numberAvailableTelegramMenuItems(response.menu);
      if (numbered.length === 0) return "Меню сейчас недоступно.";
      return limitTelegramText(
        [
          "Меню:",
          ...numbered.map(
            ({ number, item }) =>
              `${number}. ${item.name} — ${formatEuro(item.unitPriceCents)}`,
          ),
          "Добавить: /add <номер> [количество]",
        ].join("\n"),
      );
    }
    case "cart":
      return limitTelegramText(
        `${renderOrder("Корзина", response.order)}\nУбрать: /remove <номер> [количество]`,
      );
    case "needs_input":
      return renderReview("Заказ", response.order);
    case "order_review":
      return renderReview("Проверьте заказ", response.order);
    case "checkout_ready":
      return limitTelegramText(
        `${renderOrder("Заказ", response.order)}\nСсылка на оплату: ${response.checkoutLink}`,
      );
    case "awaiting_verified_payment":
      return "Ожидаем подтверждение оплаты от платёжного сервиса.";
    case "staff_handoff_registered":
      return "Запрос помощи зарегистрирован локально. Канал уведомления сотрудников пока не подключён.";
  }
}

function renderOrder(title: string, order: ConversationOrderView): string {
  const lines = order.items.length === 0
    ? ["Корзина пуста."]
    : order.items.map(
        (item, index) =>
          `${index + 1}. ${item.name} × ${item.quantity} — ${formatEuro(item.lineTotalCents)}`,
      );
  return limitTelegramText(
    [
      title + ":",
      ...lines,
      `Получение: ${fulfilmentLabel(order.fulfilment)}`,
      `Итого: ${formatEuro(order.totals.totalCents)}`,
    ].join("\n"),
  );
}

function renderReview(title: string, order: ConversationOrderView): string {
  const completion = order.missingFields.length === 0
    ? "Обязательные данные заполнены."
    : `Нужно указать: ${order.missingFields.map(missingFieldLabel).join(", ")}.`;
  return limitTelegramText(`${renderOrder(title, order)}\n${completion}`);
}

function fulfilmentLabel(
  fulfilment: ConversationOrderView["fulfilment"],
): string {
  switch (fulfilment) {
    case "pickup":
      return "самовывоз";
    case "delivery":
      return "доставка";
    case null:
      return "не выбрано";
  }
}

function missingFieldLabel(field: ConversationMissingField): string {
  switch (field) {
    case "cart":
      return "блюда";
    case "fulfilment":
      return "доставка или самовывоз";
    case "first_name":
      return "имя";
    case "phone":
      return "телефон";
    case "address":
      return "адрес";
  }
}

function formatEuro(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}

export function limitTelegramText(text: string): string {
  return text.length <= 4_096 ? text : `${text.slice(0, 4_095)}…`;
}

function maxOffset(current: number | undefined, candidate: number): number {
  return current === undefined ? candidate : Math.max(current, candidate);
}

function positiveSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
