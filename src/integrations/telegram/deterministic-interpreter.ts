import type {
  AIConversationContext,
  AIConversationInterpretation,
  AIConversationInterpreter,
} from "../../application/ai-conversation-layer.js";
import type { LocalConversationMenuProvider } from "../../application/local-conversation-agent.js";
import { numberAvailableTelegramMenuItems } from "./menu-numbering.js";

/**
 * Minimal command interpreter for the first controlled Telegram test. It does
 * not use a model or any external dependency and cannot create a checkout.
 */
export class DeterministicTelegramInterpreter
  implements AIConversationInterpreter
{
  constructor(private readonly menuProvider: LocalConversationMenuProvider) {}

  async interpret(
    context: AIConversationContext,
    text: string,
  ): Promise<AIConversationInterpretation> {
    const normalized = normalizeText(text);
    const command = normalized.toLowerCase();
    if (command === "/add" || command.startsWith("/add ")) {
      return this.interpretAdd(normalized);
    }
    if (command === "/remove" || command.startsWith("/remove ")) {
      return this.interpretRemove(context, normalized);
    }
    if (command === "/name" || command.startsWith("/name ")) {
      return interpretName(normalized);
    }
    if (command === "/phone" || command.startsWith("/phone ")) {
      return interpretPhone(normalized);
    }
    if (command === "/address" || command.startsWith("/address ")) {
      return interpretAddress(context, normalized);
    }
    if (
      command.startsWith("/pickup ") ||
      command.startsWith("/delivery ") ||
      command.startsWith("/review ") ||
      command.startsWith("/staff ")
    ) {
      return missingInformation();
    }

    switch (command) {
      case "/start":
      case "/cart":
      case "cart":
      case "корзина":
      case "покажи корзину":
        return { kind: "command", command: { type: "show_cart" } };
      case "/menu":
      case "menu":
      case "меню":
      case "покажи меню":
        return { kind: "command", command: { type: "show_menu" } };
      case "/pickup":
        return { kind: "command", command: { type: "choose_pickup" } };
      case "/delivery":
        return { kind: "command", command: { type: "choose_delivery" } };
      case "/review":
        return { kind: "command", command: { type: "review_order" } };
      case "/staff":
        return { kind: "command", command: { type: "request_staff" } };
      default:
        return { kind: "needs_clarification", reason: "unsupported" };
    }
  }

  private interpretAdd(command: string): AIConversationInterpretation {
    const match = /^\/add ([0-9]+)(?: ([0-9]+))?$/iu.exec(command);
    if (match === null) return missingInformation();

    const menuNumber = parsePositiveSafeInteger(match[1]);
    const quantity =
      match[2] === undefined
        ? undefined
        : parsePositiveSafeInteger(match[2]);
    if (
      menuNumber === undefined ||
      (match[2] !== undefined && quantity === undefined)
    ) {
      return missingInformation();
    }

    let numberedMenu: ReturnType<typeof numberAvailableTelegramMenuItems>;
    try {
      numberedMenu = numberAvailableTelegramMenuItems(
        this.menuProvider.getMenuSnapshot(),
      );
    } catch {
      return missingInformation();
    }
    const selected = numberedMenu[menuNumber - 1];
    if (selected === undefined) return missingInformation();

    return {
      kind: "command",
      command: {
        type: "add_item",
        menuItemId: selected.item.id,
        ...(quantity === undefined ? {} : { quantity }),
      },
    };
  }

  private interpretRemove(
    context: AIConversationContext,
    command: string,
  ): AIConversationInterpretation {
    const match = /^\/remove ([0-9]+)(?: ([0-9]+))?$/iu.exec(command);
    if (match === null) return missingInformation();

    const cartNumber = parsePositiveSafeInteger(match[1]);
    const removeQuantity =
      match[2] === undefined
        ? undefined
        : parsePositiveSafeInteger(match[2]);
    if (
      cartNumber === undefined ||
      (match[2] !== undefined && removeQuantity === undefined)
    ) {
      return missingInformation();
    }

    const selected = context.conversation.cart[cartNumber - 1];
    if (selected === undefined) return missingInformation();
    if (removeQuantity === undefined || removeQuantity === selected.quantity) {
      return {
        kind: "command",
        command: { type: "remove_item", menuItemId: selected.menuItemId },
      };
    }
    if (removeQuantity > selected.quantity) return missingInformation();
    return {
      kind: "command",
      command: {
        type: "set_quantity",
        menuItemId: selected.menuItemId,
        quantity: selected.quantity - removeQuantity,
      },
    };
  }
}

function normalizeText(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function parsePositiveSafeInteger(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function interpretName(command: string): AIConversationInterpretation {
  const firstName = command.slice("/name".length).trim();
  if (!isValidName(firstName)) return missingInformation();
  return {
    kind: "command",
    command: { type: "set_customer", firstName },
  };
}

function interpretPhone(command: string): AIConversationInterpretation {
  const phone = normalizePhone(command.slice("/phone".length).trim());
  if (phone === undefined) return missingInformation();
  return {
    kind: "command",
    command: { type: "set_customer", phone },
  };
}

function interpretAddress(
  context: AIConversationContext,
  command: string,
): AIConversationInterpretation {
  if (context.conversation.fulfilment !== "delivery") {
    return missingInformation();
  }
  const parts = command
    .slice("/address".length)
    .split("|")
    .map((part) => part.trim());
  if (
    parts.length !== 3 ||
    !isValidAddressLine(parts[0]) ||
    !isValidCity(parts[1]) ||
    !isValidPostalCode(parts[2])
  ) {
    return missingInformation();
  }
  return {
    kind: "command",
    command: {
      type: "set_delivery_address",
      address: {
        line1: parts[0],
        city: parts[1],
        postalCode: parts[2],
      },
    },
  };
}

function isValidName(value: string): boolean {
  return (
    value.length <= 100 &&
    /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(value)
  );
}

function normalizePhone(value: string): string | undefined {
  if (!/^\+?[0-9 ()-]+$/u.test(value)) return undefined;
  const normalized = value.replace(/[ ()-]/gu, "");
  const digits = normalized.startsWith("+")
    ? normalized.slice(1)
    : normalized;
  return /^\d{7,15}$/u.test(digits) ? normalized : undefined;
}

function isBoundedText(
  value: string | undefined,
  maximumLength: number,
): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isValidAddressLine(value: string | undefined): value is string {
  return isBoundedText(value, 200) && /[\p{L}\p{N}]/u.test(value);
}

function isValidCity(value: string | undefined): value is string {
  return isBoundedText(value, 100) && /\p{L}/u.test(value);
}

function isValidPostalCode(value: string | undefined): value is string {
  return (
    isBoundedText(value, 20) &&
    /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u.test(value)
  );
}

function missingInformation(): AIConversationInterpretation {
  return { kind: "needs_clarification", reason: "missing_information" };
}
