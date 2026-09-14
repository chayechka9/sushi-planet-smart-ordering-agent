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
    _context: AIConversationContext,
    text: string,
  ): Promise<AIConversationInterpretation> {
    const normalized = normalizeCommand(text);
    if (normalized === "/add" || normalized.startsWith("/add ")) {
      return this.interpretAdd(normalized);
    }

    switch (normalized) {
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
      default:
        return { kind: "needs_clarification", reason: "unsupported" };
    }
  }

  private interpretAdd(command: string): AIConversationInterpretation {
    const match = /^\/add ([0-9]+)(?: ([0-9]+))?$/u.exec(command);
    if (match === null) return missingAddInformation();

    const menuNumber = parsePositiveSafeInteger(match[1]);
    const quantity =
      match[2] === undefined
        ? undefined
        : parsePositiveSafeInteger(match[2]);
    if (
      menuNumber === undefined ||
      (match[2] !== undefined && quantity === undefined)
    ) {
      return missingAddInformation();
    }

    let numberedMenu: ReturnType<typeof numberAvailableTelegramMenuItems>;
    try {
      numberedMenu = numberAvailableTelegramMenuItems(
        this.menuProvider.getMenuSnapshot(),
      );
    } catch {
      return missingAddInformation();
    }
    const selected = numberedMenu[menuNumber - 1];
    if (selected === undefined) return missingAddInformation();

    return {
      kind: "command",
      command: {
        type: "add_item",
        menuItemId: selected.item.id,
        ...(quantity === undefined ? {} : { quantity }),
      },
    };
  }
}

function normalizeCommand(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function parsePositiveSafeInteger(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function missingAddInformation(): AIConversationInterpretation {
  return { kind: "needs_clarification", reason: "missing_information" };
}
