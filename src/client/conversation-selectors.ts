import type {Conversation, StoredChatMessage} from "../shared/conversation-types";
import {mergeMessageGraph, messageChildrenInGraph, messagePathInGraph, newestBranchTipInGraph} from "../shared/message-graph";
import type {AppState} from "./app-state";

export function messagePartText(message: StoredChatMessage, type: "text" | "reasoning") {
  return message.parts.filter((part) => part.type === type && typeof part.text === "string").map((part) => String(part.text)).join("");
}

export function createConversationSelectors(state: AppState) {
  function knownMessageMap() {
    return mergeMessageGraph(state.messageGraph, state.conversation?.messages || []);
  }

  function conversationGraphObjects(conversation: Conversation) {
    if (!conversation.headMessageId) return [];
    const messages = [...knownMessageMap().values()];
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
    return messagePathInGraph(knownMessageMap(), headMessageId);
  }

  function displayedMessages() {
    if (!state.previewHeadId) return state.conversation?.messages || [];
    return messagePathTo(state.previewHeadId);
  }

  function messageChildren(parentMessageId: string | null) {
    return messageChildrenInGraph(knownMessageMap(), parentMessageId);
  }

  function newestBranchTip(startId: string) {
    const currentIds = new Set((state.conversation?.messages || []).map((message) => message.id));
    return newestBranchTipInGraph(knownMessageMap(), startId, currentIds, state.conversation?.headMessageId || null);
  }

  return {conversationGraphObjects, displayedMessages, knownMessageMap, messageChildren, messagePathTo, newestBranchTip};
}
