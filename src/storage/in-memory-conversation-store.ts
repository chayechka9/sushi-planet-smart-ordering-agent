import type {
  LocalConversationState,
  LocalConversationStateStore,
} from "../application/local-conversation-agent.js";

/** Local development store; production durability remains a separate stage. */
export class InMemoryConversationStateStore
  implements LocalConversationStateStore
{
  private readonly states = new Map<string, LocalConversationState>();

  findByConversationId(
    conversationId: string,
  ): LocalConversationState | undefined {
    const state = this.states.get(conversationId);
    return state === undefined ? undefined : structuredClone(state);
  }

  findByOrderId(orderId: string): LocalConversationState | undefined {
    for (const state of this.states.values()) {
      if (state.order.id === orderId) return structuredClone(state);
    }
    return undefined;
  }

  save(state: LocalConversationState): void {
    for (const existing of this.states.values()) {
      if (
        existing.conversationId !== state.conversationId &&
        existing.order.id === state.order.id
      ) {
        throw new Error("Order is already linked to another conversation");
      }
    }
    this.states.set(state.conversationId, structuredClone(state));
  }
}
