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

  save(state: LocalConversationState): void {
    this.states.set(state.conversationId, structuredClone(state));
  }
}
