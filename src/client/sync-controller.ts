import type {AppState} from "./app-state";
import {getConversationHistory, listConversationHistory, synchronizeConversationRepository} from "./conversation-client";
import {listCachedMessages} from "./storage/offline-history";

type SyncControllerDependencies = {
  root: HTMLElement;
  updateSyncIndicator: () => void;
  renderMessages: (scroll?: boolean) => void;
  renderHistoryItems: () => string;
};

export function createSyncController(state: AppState, dependencies: SyncControllerDependencies) {
  async function refreshConversations() {
    state.conversations = await listConversationHistory();
  }

  function scheduleRepositorySync(delay = 50) {
    if (!state.authenticated) return;
    state.syncRequested = true;
    window.clearTimeout(state.syncTimer);
    state.syncTimer = window.setTimeout(() => void synchronizeRepository(), delay);
  }

  async function synchronizeRepository() {
    if (!state.authenticated) return;
    if (state.syncing || !navigator.onLine) {
      if (!navigator.onLine) {
        state.offline = true;
        state.syncError = "当前离线，等待下次 fetch";
        dependencies.updateSyncIndicator();
      }
      return;
    }
    state.syncRequested = false;
    state.syncing = true;
    state.syncError = "";
    dependencies.updateSyncIndicator();
    try {
      const result = await synchronizeConversationRepository();
      state.lastFetchAt = result.fetchedAt;
      state.initialFetchComplete = true;
      state.offline = false;
      state.syncError = result.conflicts ? `${result.conflicts} 个会话发生分叉，本地 head 已保留` : "";
      state.conversations = result.summaries;
      state.messageGraph = await listCachedMessages();
      if (!state.streaming && state.conversation && state.conversations.some((item) => item.id === state.conversation!.id)) {
        state.conversation = await getConversationHistory(state.conversation.id);
        dependencies.renderMessages(true);
        const historyList = dependencies.root.querySelector<HTMLElement>(".history-list");
        if (historyList) historyList.innerHTML = dependencies.renderHistoryItems();
      }
    } catch (error) {
      state.offline = !navigator.onLine;
      state.syncError = error instanceof Error ? error.message : "Fetch failed";
    } finally {
      state.syncing = false;
      dependencies.updateSyncIndicator();
      if (state.syncRequested) scheduleRepositorySync();
    }
  }

  return {refreshConversations, scheduleRepositorySync, synchronizeRepository};
}
