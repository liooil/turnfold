import {conversationIdFromHash} from "../shared/conversation-hash";
import type {CachedChatBootstrap, ChatProvider, ServerChatConfig} from "./app-state";
import {
  getConversationHistory,
  listConversationHistory,
  synchronizeConversationRepository
} from "./conversation-client";
import {appUrl} from "./environment";
import {listLocalCredentials, listLocalProviderProfiles} from "./providers/local-providers";
import {modelsDevModelCount} from "./providers/models-dev-catalog";
import {loadStoredModelsDevCatalog} from "./providers/models-dev-storage";
import {updateConversationHash} from "./navigation";
import {
  activateOfflineProfile,
  cachedLastFetchAt,
  cacheChatConfig,
  listCachedMessages,
  loadCachedChatConfig,
  mergeOfflineProfiles
} from "./storage/offline-history";
import {uuid} from "./uuid";
import type {AppState} from "./app-state";

type BootstrapDependencies = {
  root: HTMLElement;
  renderApp: () => void;
  updateSyncIndicator: () => void;
  scheduleRepositorySync: (delay?: number) => void;
  loadConversationWorkingItems: (conversationId: string) => Promise<void>;
  settingsForProvider: (provider: ChatProvider) => {model: string};
  rememberModel: (providerId: string, model: string) => void;
  providerController: {openProviderEditor: () => void};
};

export function createBootstrap(state: AppState, dependencies: BootstrapDependencies) {
  function cachedProfile(value: CachedChatBootstrap | undefined) {
    return value?.profile || value?.config?.profile;
  }

  async function restoreWorkspace(preferredConversationId = "") {
    if (!state.config) return;
    const hashId = conversationIdFromHash(window.location.hash);
    const summary = state.conversations.find((item) => item.id === preferredConversationId)
      || state.conversations.find((item) => item.id === hashId)
      || state.conversations[0];
    if (summary) {
      const selected = await getConversationHistory(summary.id);
      const selectedProvider = state.config.providers.find((item) => item.id === selected.providerId);
      state.conversation = selected;
      state.providerId = selectedProvider?.id || selected.providerId;
      state.model = selectedProvider?.models.some((model) => model.id === selected.model)
        ? selected.model
        : selectedProvider ? dependencies.settingsForProvider(selectedProvider).model : selected.model;
      state.generationSettings = selected.generationSettings;
      await dependencies.loadConversationWorkingItems(selected.id);
      if (selectedProvider) dependencies.rememberModel(state.providerId, state.model);
      updateConversationHash(selected.id, "replace");
      return;
    }
    state.conversation = null;
    state.workingItems = [];
    state.activeDraftId = "";
    const savedProviderId = window.localStorage.getItem("turnfold-provider") || "";
    const selectedProvider = state.config.providers.find((item) => item.id === savedProviderId)
      || state.config.providers.find((item) => item.models.length)
      || state.config.providers[0];
    state.providerId = selectedProvider?.id || "";
    state.model = selectedProvider ? dependencies.settingsForProvider(selectedProvider).model : "";
  }

  async function initialize() {
    if (!window.localStorage.getItem("turnfold-client-id")) window.localStorage.setItem("turnfold-client-id", uuid());
    const clientId = window.localStorage.getItem("turnfold-client-id")!;
    const repositoryId = `local:${clientId}`;
    state.localCredentials = await listLocalCredentials();
    try {
      const storedModelsDev = await loadStoredModelsDevCatalog();
      if (storedModelsDev) {
        state.modelsDevCatalog = storedModelsDev.catalog;
        state.modelsDevModelCount = modelsDevModelCount(storedModelsDev.catalog);
        state.modelsDevFetchedAt = storedModelsDev.fetchedAt;
      }
    } catch (error) {
      state.modelsDevError = error instanceof Error ? error.message : "无法读取 models.dev 本地目录";
    }
    try {
      const recent = JSON.parse(window.localStorage.getItem("turnfold-recent-models") || "[]");
      if (Array.isArray(recent)) state.recentModelKeys = recent.filter((item) => typeof item === "string").slice(0, 20);
    } catch {
      window.localStorage.removeItem("turnfold-recent-models");
    }
    const previouslyActive = await loadCachedChatConfig<CachedChatBootstrap>();
    if (previouslyActive && previouslyActive.profileId !== repositoryId) await mergeOfflineProfiles(previouslyActive.profileId, repositoryId);
    activateOfflineProfile(repositoryId);
    const stored = await loadCachedChatConfig<CachedChatBootstrap>(repositoryId);
    state.identityKey = repositoryId;
    state.config = {
      profile: cachedProfile(stored?.config) || cachedProfile(previouslyActive?.config) || {username: "local", name: "本地用户", email: ""},
      providers: []
    };
    state.lastFetchAt = stored?.lastFetchAt || await cachedLastFetchAt();
    state.conversations = await listConversationHistory();
    state.config.providers = await listLocalProviderProfiles();
    await cacheChatConfig(repositoryId, {profile: state.config.profile});
    await restoreWorkspace();
    // The full local message graph is profile-wide; load it once at startup
    // (and after sync), not on every conversation switch.
    state.messageGraph = await listCachedMessages();
    state.loading = false;
    state.offline = !navigator.onLine;
    if (!state.config.providers.length) {
      state.settingsOpen = true;
      dependencies.providerController.openProviderEditor();
    }
    dependencies.renderApp();
    if (!state.config.providers.length) window.requestAnimationFrame(() => {
      dependencies.root.querySelector<HTMLElement>("#settings-providers")?.scrollIntoView({block: "start"});
    });

    try {
      const response = await fetch(appUrl("/api/config"), {cache: "no-store", redirect: "manual"});
      if (response.type === "opaqueredirect" || response.status === 0 || response.status === 401 || response.status >= 300 && response.status < 400) return;
      const payload = await response.json() as ServerChatConfig & {error?: string};
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      state.authenticated = true;
      await mergeOfflineProfiles(payload.identityKey, repositoryId);
      state.identityKey = repositoryId;
      activateOfflineProfile(repositoryId);
      state.config.profile = payload.profile;
      await cacheChatConfig(repositoryId, {profile: payload.profile});
      state.syncing = true;
      dependencies.updateSyncIndicator();
      const preferredConversationId = state.conversation?.id || "";
      const synchronized = await synchronizeConversationRepository();
      state.lastFetchAt = synchronized.fetchedAt;
      state.initialFetchComplete = true;
      state.syncError = synchronized.conflicts ? `${synchronized.conflicts} 个会话发生分叉，本地 head 已保留` : "";
      state.offline = false;
      state.conversations = synchronized.summaries;
      state.messageGraph = await listCachedMessages();
      await restoreWorkspace(preferredConversationId);
      state.syncing = false;
      dependencies.renderApp();
      if (state.syncRequested) dependencies.scheduleRepositorySync();
    } catch (error) {
      state.authenticated = false;
      state.syncing = false;
      state.offline = !navigator.onLine;
      state.syncError = error instanceof Error ? error.message : "Fetch failed";
      dependencies.updateSyncIndicator();
      if (state.syncRequested && navigator.onLine) dependencies.scheduleRepositorySync(1000);
    }
  }

  return {initialize};
}
