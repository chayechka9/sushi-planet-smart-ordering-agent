import type {
  AIConversationContext,
  AIConversationInterpretation,
  AIConversationInterpreter,
} from "../../application/ai-conversation-layer.js";

/**
 * Minimal command interpreter for the first controlled Telegram test. It does
 * not use a model or any external dependency and cannot create a checkout.
 */
export class DeterministicTelegramInterpreter
  implements AIConversationInterpreter
{
  async interpret(
    _context: AIConversationContext,
    text: string,
  ): Promise<AIConversationInterpretation> {
    switch (normalizeCommand(text)) {
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
}

function normalizeCommand(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}
