import type {
  LocalConversationState,
  LocalConversationStateStore,
  PendingStaffHandoffRequest,
} from "../application/local-conversation-agent.js";

/** Ephemeral test/development implementation; SQLite provides local durability. */
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

  listPendingStaffHandoffRequests(): readonly PendingStaffHandoffRequest[] {
    return [...this.states.values()]
      .flatMap((state) =>
        state.staffHandoffRequest === undefined
          ? []
          : [{
              conversationId: state.conversationId,
              orderId: state.order.id,
              ...state.staffHandoffRequest,
            }],
      )
      .sort((left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) ||
        left.conversationId.localeCompare(right.conversationId),
      )
      .map((request) => structuredClone(request));
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
