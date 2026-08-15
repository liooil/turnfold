import type {Conversation, StoredChatMessage} from "../shared/conversation-types";
import {
  indexMessageGraph,
  messageChildrenInIndex,
  messagePathInGraph,
  newestBranchTipInIndex,
  rootEditAlternativesInIndex,
  type MessageGraphIndex
} from "../shared/message-graph";
import type {AppState} from "./app-state";

export function messagePartText(message: StoredChatMessage, type: "text" | "reasoning") {
  return message.parts.filter((part) => part.type === type && typeof part.text === "string").map((part) => String(part.text)).join("");
}

export function createConversationSelectors(state: AppState) {
  let cached: {graphRef: StoredChatMessage[]; messagesRef: StoredChatMessage[] | null; index: MessageGraphIndex} | null = null;
  let indexVersion = 0;

  /**
   * Memoized message graph index. Rebuilds only when the underlying message
   * arrays are replaced (every mutation path replaces them with new arrays),
   * so repeated lookups during a render are O(1) instead of O(N).
   */
  function messageIndex(): MessageGraphIndex {
    const graph = state.messageGraph;
    const messages = state.conversation?.messages ?? null;
    if (!cached || cached.graphRef !== graph || cached.messagesRef !== messages) {
      cached = {graphRef: graph, messagesRef: messages, index: indexMessageGraph(graph, messages ?? [])};
      indexVersion += 1;
    }
    return cached.index;
  }

  function graphVersion() {
    messageIndex();
    return indexVersion;
  }

  function knownMessageMap() {
    return messageIndex().map;
  }

  function conversationGraphObjects(conversation: Conversation) {
    if (!conversation.headMessageId) return [];
    const index = messageIndex();
    const messages = [...index.map.values()];
    const adjacent = new Map<string, Set<string>>();
    const connect = (left: string, right: string) => {
      if (!adjacent.has(left)) adjacent.set(left, new Set());
      if (!adjacent.has(right)) adjacent.set(right, new Set());
      adjacent.get(left)!.add(right);
      adjacent.get(right)!.add(left);
    };
    for (const message of messages) {
      if (message.parentMessageId) connect(message.id, message.parentMessageId);
      if ("sourceMessageId" in message.origin && message.origin.sourceMessageId) connect(message.id, message.origin.sourceMessageId);
    }
    const selected = new Set<string>();
    const pending = [conversation.headMessageId];
    while (pending.length) {
      const id = pending.pop()!;
      if (selected.has(id)) continue;
      selected.add(id);
      for (const neighbor of adjacent.get(id) || []) pending.push(neighbor);
    }
    return messages.filter((message) => selected.has(message.id));
  }

  function messagePathTo(headMessageId: string | null) {
    return messagePathInGraph(messageIndex().map, headMessageId);
  }

  function displayedMessages() {
    if (!state.previewHeadId) return state.conversation?.messages || [];
    return messagePathTo(state.previewHeadId);
  }

  function messageChildren(parentMessageId: string | null) {
    return messageChildrenInIndex(messageIndex(), parentMessageId);
  }

  function rootEditAlternatives(messageId: string) {
    return rootEditAlternativesInIndex(messageIndex(), messageId);
  }

  function newestBranchTip(startId: string) {
    const currentIds = new Set((state.conversation?.messages || []).map((message) => message.id));
    return newestBranchTipInIndex(messageIndex(), startId, currentIds, state.conversation?.headMessageId || null);
  }

  return {conversationGraphObjects, displayedMessages, graphVersion, knownMessageMap, messageChildren, messagePathTo, newestBranchTip, rootEditAlternatives};
}
