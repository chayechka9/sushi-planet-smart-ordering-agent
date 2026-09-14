import type {
  AIConversationLayerInput,
  AIConversationLayerResponse,
} from "../../application/ai-conversation-layer.js";
import type {
  ConversationAgentResponse,
  ConversationMissingField,
  ConversationOrderView,
  LocalConversationStateStore,
} from "../../application/local-conversation-agent.js";
import type {
  TelegramApiTransport,
  TelegramUpdateEnvelope,
} from "./api-transport.js";

export interface TelegramConversationHandler {
  handle(input: AIConversationLayerInput): Promise<AIConversationLayerResponse>;
}

export interface TelegramPollingAdapterDependencies {
  transport: TelegramApiTransport;
  conversation: TelegramConversationHandler;
  stateStore: Pick<LocalConversationStateStore, "findByConversationId">;
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

interface TelegramPrivateTextMessage {
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
    const message = parsePrivateTextMessage(update.payload);
    if (message === undefined) {
      return { updateId: update.updateId, kind: "ignored", reason: "unsupported" };
    }

    const identity = telegramIdentity(message);
    try {
      const state = this.dependencies.stateStore.findByConversationId(
        identity.conversationId,
      );
      if (
        state !== undefined &&
        (state.identity.channel !== "telegram" ||
          state.identity.userId !== identity.userId)
      ) {
        return { updateId: update.updateId, kind: "processing_failed" };
      }
      if (
        state?.processedMessages.some(
          (processed) => processed.messageId === identity.messageId,
        )
      ) {
        return { updateId: update.updateId, kind: "ignored", reason: "duplicate" };
      }
    } catch {
      return { updateId: update.updateId, kind: "processing_failed" };
    }

    let response: AIConversationLayerResponse;
    try {
      response = await this.dependencies.conversation.handle({
        channel: "telegram",
        userId: identity.userId,
        conversationId: identity.conversationId,
        messageId: identity.messageId,
        text: message.text,
      });
    } catch {
      return { updateId: update.updateId, kind: "processing_failed" };
    }

    const text = renderTelegramResponse(response);
    try {
      await this.dependencies.transport.sendMessage({
        chatId: message.chatId,
        text,
        ...(signal === undefined ? {} : { signal }),
      });
      return { updateId: update.updateId, kind: "replied" };
    } catch {
      return { updateId: update.updateId, kind: "send_failed" };
    }
  }
}

function telegramIdentity(message: TelegramPrivateTextMessage): {
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

function parsePrivateTextMessage(
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

function renderTelegramResponse(response: AIConversationLayerResponse): string {
  switch (response.kind) {
    case "needs_clarification":
      return "Уточните, пожалуйста, что вы хотите заказать.";
    case "error":
      return "Не удалось обработать сообщение. Попробуйте сформулировать запрос иначе.";
    case "command_applied":
      return renderConversationResponse(response.response);
  }
}

function renderConversationResponse(response: ConversationAgentResponse): string {
  switch (response.kind) {
    case "menu": {
      const available = response.menu.filter((item) => item.available);
      if (available.length === 0) return "Меню сейчас недоступно.";
      return limitTelegramText(
        [
          "Меню:",
          ...available.map(
            (item) => `• ${item.name} — ${formatEuro(item.unitPriceCents)}`,
          ),
        ].join("\n"),
      );
    }
    case "cart":
      return renderOrder("Корзина", response.order);
    case "needs_input":
      return limitTelegramText(
        `${renderOrder("Заказ", response.order)}\nНужно указать: ${response.order.missingFields.map(missingFieldLabel).join(", ")}.`,
      );
    case "order_review":
      return limitTelegramText(
        response.readyForCheckout
          ? `${renderOrder("Проверьте заказ", response.order)}\nЗаказ готов к созданию ссылки на оплату.`
          : `${renderOrder("Проверьте заказ", response.order)}\nНужно указать: ${response.order.missingFields.map(missingFieldLabel).join(", ")}.`,
      );
    case "checkout_ready":
      return limitTelegramText(
        `${renderOrder("Заказ", response.order)}\nСсылка на оплату: ${response.checkoutLink}`,
      );
    case "awaiting_verified_payment":
      return "Ожидаем подтверждение оплаты от платёжного сервиса.";
  }
}

function renderOrder(title: string, order: ConversationOrderView): string {
  const lines = order.items.length === 0
    ? ["Корзина пуста."]
    : order.items.map(
        (item) =>
          `• ${item.name} × ${item.quantity} — ${formatEuro(item.lineTotalCents)}`,
      );
  return limitTelegramText(
    [title + ":", ...lines, `Итого: ${formatEuro(order.totals.totalCents)}`].join(
      "\n",
    ),
  );
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

function limitTelegramText(text: string): string {
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
