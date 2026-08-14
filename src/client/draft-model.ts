import type {WorkingItem} from "../shared/conversation-types";
import type {AppState} from "./app-state";

export type NewDraftOptions = {
  observedHeadId?: string | null;
  editSourceMessageId?: string;
  text?: string;
  messageRole?: "user" | "assistant";
  requestAssistantReply?: boolean;
};

export function workingItemText(item: WorkingItem) {
  return item.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => String(part.text)).join("");
}

export function draftLabel(item: WorkingItem) {
  return item.editSourceMessageId ? "编辑草稿" : "草稿";
}

export function messageNow() {
  return new Date().toISOString();
}

export function requestAssistantReplyForSubmission(
  draft: WorkingItem | null,
  advancedActions: boolean,
  responseModelAvailable: boolean
) {
  if (!responseModelAvailable) return false;
  return advancedActions
    ? draft?.requestAssistantReply ?? true
    : draft?.messageRole !== "assistant";
}

export function createDraftModel(state: AppState, dependencies: {uuid: () => string; displayedHeadId: () => string | null}) {
  function activeDraft() {
    return state.workingItems.find((item) => item.id === state.activeDraftId && item.kind === "user-draft") || null;
  }

  function canStashActiveDraft() {
    const draft = activeDraft();
    return Boolean(draft && workingItemText(draft).trim());
  }

  function newDraftItem(conversationId: string, options: NewDraftOptions = {}): WorkingItem {
    const timestamp = messageNow();
    return {
      id: dependencies.uuid(),
      conversationId,
      kind: "user-draft",
      observedHeadId: options.observedHeadId === undefined ? dependencies.displayedHeadId() : options.observedHeadId,
      ...(options.editSourceMessageId ? {editSourceMessageId: options.editSourceMessageId} : {}),
      messageRole: options.messageRole || "user",
      requestAssistantReply: options.requestAssistantReply ?? true,
      incompleteTargetAction: "append",
      parts: options.text ? [{type: "text", text: options.text}] : [],
      status: "editing",
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  return {activeDraft, canStashActiveDraft, newDraftItem};
}
