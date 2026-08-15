import type {StoredChatMessage, WorkingItem} from "../shared/conversation-types";
import type {AppState} from "./app-state";
import {messagePartText} from "./conversation-selectors";
import {messageNow, workingItemText, type NewDraftOptions} from "./draft-model";
import {shouldOpenFullscreenEditor} from "./fullscreen-editor";
import {workingItemRepository} from "./repository/repositories";

type DraftActionDependencies = {
  root: HTMLElement;
  renderApp: () => void;
  activeDraft: () => WorkingItem | null;
  newDraftItem: (conversationId: string, options?: NewDraftOptions) => WorkingItem;
  displayedMessages: () => StoredChatMessage[];
  knownMessageMap: () => Map<string, StoredChatMessage>;
  newestBranchTip: (startId: string) => string;
  syncComposerInputLayout: (input?: HTMLTextAreaElement | null) => void;
};

export function createDraftActions(state: AppState, dependencies: DraftActionDependencies) {
  async function loadConversationWorkingItems(conversationId: string) {
    state.workingItems = await workingItemRepository.list(conversationId);
    for (const item of state.workingItems) {
      if (item.kind === "assistant-stream" && item.status === "streaming") {
        item.status = "interrupted";
        item.failureReason = "connection-lost";
        await workingItemRepository.save(item);
      }
    }
    const drafts = state.workingItems.filter((item) => item.kind === "user-draft");
    if (!drafts.some((item) => item.id === state.activeDraftId)) state.activeDraftId = drafts[0]?.id || "";
  }

  async function persistWorkingItem(item: WorkingItem, render = false) {
    item.updatedAt = messageNow();
    await workingItemRepository.save(item);
    const index = state.workingItems.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) state.workingItems[index] = item;
    else state.workingItems.unshift(item);
    if (render) dependencies.renderApp();
  }

  async function discardWorkingItem(id: string) {
    window.clearTimeout(state.workingSaveTimers.get(id));
    state.workingSaveTimers.delete(id);
    await workingItemRepository.remove(id);
  }

  function checkpointWorkingItem(item: WorkingItem) {
    window.clearTimeout(state.workingSaveTimers.get(item.id));
    state.workingSaveTimers.set(item.id, window.setTimeout(() => {
      state.workingSaveTimers.delete(item.id);
      void persistWorkingItem(item).catch((error) => console.error("Unable to checkpoint working item", error));
    }, 300));
  }

  async function editMessage(index: number) {
    if (state.streaming || !state.conversation) return;
    const message = dependencies.displayedMessages()[index];
    if (!message || (message.role !== "user" && message.role !== "assistant")) return;
    if (message.role === "assistant" && !state.advancedActions) return;
    const existing = state.workingItems.find((item) => item.kind === "user-draft" && item.editSourceMessageId === message.id);
    const draft = existing || dependencies.newDraftItem(state.conversation.id, {
      observedHeadId: message.parentMessageId,
      editSourceMessageId: message.id,
      text: messagePartText(message, "text"),
      messageRole: message.role,
      requestAssistantReply: message.role !== "assistant"
    });
    state.activeDraftId = draft.id;
    state.composerFullscreen = shouldOpenFullscreenEditor(workingItemText(draft));
    await persistWorkingItem(draft, true);
    const input = dependencies.root.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    dependencies.syncComposerInputLayout(input);
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }

  async function replyToMessage(index: number) {
    if (!state.conversation) return;
    const message = dependencies.displayedMessages()[index];
    if (!message) return;
    let draft = dependencies.activeDraft();
    if (!draft || draft.editSourceMessageId) draft = dependencies.newDraftItem(state.conversation.id);
    draft.observedHeadId = message.id;
    state.activeDraftId = draft.id;
    await persistWorkingItem(draft, true);
    dependencies.root.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
  }

  async function cancelReplyTarget() {
    const draft = dependencies.activeDraft();
    if (!draft || draft.editSourceMessageId) return;
    draft.observedHeadId = dependencies.displayedMessages().at(-1)?.id || null;
    await persistWorkingItem(draft, true);
    dependencies.root.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
  }

  function jumpToReplyTarget(messageId: string) {
    const scrollToTarget = () => {
      if (messageId === "__root__") {
        dependencies.root.querySelector<HTMLElement>("#thread-viewport")?.scrollTo({top: 0, behavior: "smooth"});
        return;
      }
      const target = dependencies.root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
      target?.scrollIntoView({behavior: "smooth", block: "center"});
      target?.classList.add("reply-target-pulse");
      if (target) window.setTimeout(() => target.classList.remove("reply-target-pulse"), 900);
    };
    if (messageId !== "__root__" && !dependencies.root.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`) && dependencies.knownMessageMap().has(messageId)) {
      state.previewHeadId = dependencies.newestBranchTip(messageId);
      dependencies.renderApp();
      window.requestAnimationFrame(scrollToTarget);
      return;
    }
    scrollToTarget();
  }

  async function cancelEdit() {
    const draft = dependencies.activeDraft();
    if (!draft?.editSourceMessageId) return;
    await discardWorkingItem(draft.id);
    state.workingItems = state.workingItems.filter((item) => item.id !== draft.id);
    state.activeDraftId = state.workingItems.find((item) => item.kind === "user-draft")?.id || "";
    state.composerFullscreen = false;
    dependencies.renderApp();
  }

  async function stashActiveDraft() {
    const draft = dependencies.activeDraft();
    if (!draft || !workingItemText(draft).trim()) return;
    window.clearTimeout(state.workingSaveTimers.get(draft.id));
    state.workingSaveTimers.delete(draft.id);
    await persistWorkingItem(draft);
    state.activeDraftId = "";
    state.composerFullscreen = false;
    dependencies.renderApp();
    dependencies.root.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
  }

  async function activateDraft(id: string) {
    const next = state.workingItems.find((item) => item.id === id && item.kind === "user-draft");
    if (!next || next.id === state.activeDraftId) return;
    const current = dependencies.activeDraft();
    if (current) {
      window.clearTimeout(state.workingSaveTimers.get(current.id));
      state.workingSaveTimers.delete(current.id);
      if (workingItemText(current).trim()) await persistWorkingItem(current);
      else {
        await workingItemRepository.remove(current.id);
        state.workingItems = state.workingItems.filter((item) => item.id !== current.id);
      }
    }
    state.activeDraftId = next.id;
    state.composerFullscreen = false;
    dependencies.renderApp();
    dependencies.root.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
  }

  async function ensureActiveDraft() {
    let draft = dependencies.activeDraft();
    if (draft) return draft;
    draft = dependencies.newDraftItem(state.conversation!.id);
    state.activeDraftId = draft.id;
    state.workingItems.unshift(draft);
    await persistWorkingItem(draft);
    return draft;
  }

  async function deleteWorking(id: string) {
    await discardWorkingItem(id);
    state.workingItems = state.workingItems.filter((item) => item.id !== id);
    if (state.activeDraftId === id) {
      state.activeDraftId = state.workingItems.find((item) => item.kind === "user-draft")?.id || "";
      if (!state.activeDraftId) state.composerFullscreen = false;
    }
    dependencies.renderApp();
  }

  return {
    loadConversationWorkingItems,
    persistWorkingItem,
    discardWorkingItem,
    checkpointWorkingItem,
    editMessage,
    replyToMessage,
    cancelReplyTarget,
    jumpToReplyTarget,
    cancelEdit,
    stashActiveDraft,
    activateDraft,
    ensureActiveDraft,
    deleteWorking
  };
}
