import {conversationIdFromHash} from "../shared/conversation-hash";
import type {CachedChatBootstrap, ChatProvider} from "./app-state";
import {
  BackendPairingRequiredError,
  backendApprovalUrl,
  backendGrantToken,
  backendUrlStorageKey,
  fetchBackendConfig,
  normalizeBackendUrl,
  pollBackendPairing,
  removeBackendGrant,
  revokeBackendGrant,
  saveBackendGrant,
  startBackendPairing,
  suggestedBackendUrl
} from "./backend-connection";
import {
  getConversationHistory,
  listConversationHistory,
  synchronizeConversationRepository
} from "./conversation-client";
import {basePath} from "./environment";
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
    state.backendUrl = suggestedBackendUrl(window.localStorage, window.location.href, basePath);
    state.backendSavedGrant = Boolean(backendGrantToken(window.localStorage, state.backendUrl));
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
      profile: {...state.localProfile},
      providers: []
    };
    state.lastFetchAt = stored?.lastFetchAt || await cachedLastFetchAt();
    state.conversations = await listConversationHistory();
    state.config.providers = await listLocalProviderProfiles();
    await cacheChatConfig(repositoryId, {profile: state.localProfile});
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

  }

  async function connectBackend(value: string) {
    if (state.backendConnecting || state.backendPairing || !state.config) return;
    let backendUrl: string;
    try {
      backendUrl = normalizeBackendUrl(value, window.location.href);
    } catch (error) {
      state.backendError = error instanceof Error ? error.message : "Backend URL 无效";
      dependencies.renderApp();
      return;
    }

    const previous = {
      activeUrl: state.backendActiveUrl,
      activeTransport: state.backendActiveTransport,
      activeGrantToken: state.backendActiveGrantToken,
      authenticated: state.authenticated,
      profile: state.config.profile
    };
    const grantToken = backendGrantToken(window.localStorage, backendUrl);
    state.backendUrl = backendUrl;
    state.backendSavedGrant = Boolean(grantToken);
    state.backendConnecting = true;
    state.backendError = "";
    state.backendPairingRequired = false;
    state.backendApprovalUrl = "";
    state.syncError = "";
    window.clearTimeout(state.syncTimer);
    state.syncRequested = false;
    state.backendConnectionController?.abort();
    state.backendSyncController?.abort();
    state.backendSyncController = null;
    state.syncing = false;
    const connectionController = new AbortController();
    state.backendConnectionController = connectionController;
    const ownsConnection = () => state.backendConnectionController === connectionController
      && !connectionController.signal.aborted;
    dependencies.renderApp();

    let payload;
    try {
      payload = await fetchBackendConfig(backendUrl, fetch, connectionController.signal, grantToken);
    } catch (error) {
      if (!ownsConnection()) return;
      state.backendConnectionController = null;
      state.backendActiveUrl = previous.activeUrl;
      state.backendActiveTransport = previous.activeTransport;
      state.backendActiveGrantToken = previous.activeGrantToken;
      state.authenticated = previous.authenticated;
      state.config.profile = previous.profile;
      state.backendConnecting = false;
      if (error instanceof BackendPairingRequiredError) {
        if (grantToken) removeBackendGrant(window.localStorage, backendUrl);
        state.backendSavedGrant = false;
        state.backendPairingRequired = true;
      }
      state.backendError = error instanceof Error ? error.message : "Backend 连接失败";
      dependencies.renderApp();
      return;
    }

    if (!ownsConnection()) return;

    const repositoryId = state.identityKey;
    try {
      await mergeOfflineProfiles(payload.identityKey, repositoryId);
    } catch (error) {
      if (!ownsConnection()) return;
      state.backendConnectionController = null;
      state.backendActiveUrl = previous.activeUrl;
      state.backendActiveTransport = previous.activeTransport;
      state.backendActiveGrantToken = previous.activeGrantToken;
      state.authenticated = previous.authenticated;
      state.config.profile = previous.profile;
      state.backendConnecting = false;
      state.backendError = error instanceof Error ? error.message : "无法准备本地仓库";
      dependencies.renderApp();
      return;
    }
    if (!ownsConnection()) return;
    state.backendConnectionController = null;
    activateOfflineProfile(repositoryId);
    state.backendActiveUrl = backendUrl;
    state.backendActiveTransport = "native";
    state.backendActiveGrantToken = grantToken;
    state.authenticated = true;
    state.config.profile = payload.profile;
    state.initialFetchComplete = false;
    state.backendConnecting = false;
    state.offline = !navigator.onLine;
    window.localStorage.setItem(backendUrlStorageKey, backendUrl);
    dependencies.renderApp();

    state.syncing = true;
    const syncController = new AbortController();
    state.backendSyncController = syncController;
    const ownsSync = () => state.backendSyncController === syncController
      && !syncController.signal.aborted
      && state.backendActiveUrl === backendUrl
      && state.backendActiveTransport === "native";
    dependencies.updateSyncIndicator();
    const preferredConversationId = state.conversation?.id || "";
    try {
      const synchronized = await synchronizeConversationRepository(backendUrl, syncController.signal, grantToken);
      if (!ownsSync()) return;
      state.lastFetchAt = synchronized.fetchedAt;
      state.initialFetchComplete = true;
      state.syncError = synchronized.conflicts ? `${synchronized.conflicts} 个会话发生分叉，本地 head 已保留` : "";
      state.offline = false;
      state.conversations = synchronized.summaries;
      state.messageGraph = await listCachedMessages();
      if (!ownsSync()) return;
      await restoreWorkspace(preferredConversationId);
    } catch (error) {
      if (!ownsSync()) return;
      state.syncError = error instanceof Error ? error.message : "Backend 同步失败";
      state.offline = !navigator.onLine;
    } finally {
      if (!ownsSync()) return;
      state.backendSyncController = null;
      state.syncing = false;
      dependencies.renderApp();
      if (state.syncRequested) dependencies.scheduleRepositorySync();
    }
  }

  function waitForPairingPoll(delay: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason || new DOMException("Pairing cancelled", "AbortError"));
        return;
      }
      const aborted = () => {
        window.clearTimeout(timer);
        reject(signal.reason || new DOMException("Pairing cancelled", "AbortError"));
      };
      const timer = window.setTimeout(() => {
        signal.removeEventListener("abort", aborted);
        resolve();
      }, delay);
      signal.addEventListener("abort", aborted, {once: true});
    });
  }

  async function pairBackend() {
    if (state.backendPairing || state.backendConnecting || !state.config) return;
    let backendUrl: string;
    try {
      backendUrl = normalizeBackendUrl(state.backendUrl, window.location.href);
    } catch (error) {
      state.backendError = error instanceof Error ? error.message : "Backend URL 无效";
      dependencies.renderApp();
      return;
    }

    state.backendPairingWindow?.close();
    const pairingWindow = window.open("about:blank", "turnfold-backend-pairing", "popup,width=720,height=720");
    state.backendPairingWindow = pairingWindow;
    state.backendPairingController?.abort();
    const controller = new AbortController();
    state.backendPairingController = controller;
    const ownsPairing = () => state.backendPairingController === controller
      && !controller.signal.aborted;
    state.backendPairing = true;
    state.backendPairingRequired = false;
    state.backendError = "";
    state.backendApprovalUrl = "";
    dependencies.renderApp();

    try {
      const clientName = `Turnfold (${window.location.hostname || "browser"})`;
      const pairing = await startBackendPairing(backendUrl, clientName, fetch, controller.signal);
      if (!ownsPairing()) return;
      const approvalUrl = backendApprovalUrl(backendUrl, pairing.pairingId);
      state.backendApprovalUrl = approvalUrl;
      if (pairingWindow) {
        pairingWindow.opener = null;
        pairingWindow.location.href = approvalUrl;
      }
      dependencies.renderApp();

      while (ownsPairing()) {
        const result = await pollBackendPairing(backendUrl, pairing, fetch, controller.signal);
        if (!ownsPairing()) return;
        if (result.status === "pending") {
          await waitForPairingPoll(pairing.pollIntervalMs, controller.signal);
          continue;
        }
        if (result.status === "denied") throw new Error("Backend 已拒绝本次配对");
        if (result.status === "expired") throw new Error("Backend 配对请求已过期，请重新发起");
        saveBackendGrant(window.localStorage, backendUrl, result.token, result.grant);
        state.backendSavedGrant = true;
        state.backendPairingController = null;
        state.backendPairing = false;
        state.backendPairingRequired = false;
        state.backendApprovalUrl = "";
        state.backendPairingWindow = null;
        pairingWindow?.close();
        dependencies.renderApp();
        await connectBackend(backendUrl);
        return;
      }
    } catch (error) {
      if (!ownsPairing()) return;
      state.backendPairingController = null;
      state.backendPairing = false;
      state.backendPairingRequired = true;
      state.backendApprovalUrl = "";
      state.backendPairingWindow = null;
      pairingWindow?.close();
      state.backendError = error instanceof Error ? error.message : "Backend 配对失败";
      dependencies.renderApp();
    }
  }

  async function revokeBackendPairing() {
    if (state.backendConnecting || state.backendPairing || !state.config) return;
    let backendUrl: string;
    try {
      backendUrl = normalizeBackendUrl(state.backendUrl, window.location.href);
    } catch (error) {
      state.backendError = error instanceof Error ? error.message : "Backend URL 无效";
      dependencies.renderApp();
      return;
    }
    const grantToken = backendGrantToken(window.localStorage, backendUrl);
    if (!grantToken) {
      state.backendSavedGrant = false;
      state.backendError = "当前 Backend 没有可撤销的浏览器配对";
      dependencies.renderApp();
      return;
    }
    if (state.backendActiveUrl === backendUrl) disconnectBackend();
    const controller = new AbortController();
    state.backendConnectionController = controller;
    state.backendConnecting = true;
    state.backendError = "";
    dependencies.renderApp();
    try {
      await revokeBackendGrant(backendUrl, grantToken, fetch, controller.signal);
      if (state.backendConnectionController !== controller || controller.signal.aborted) return;
      removeBackendGrant(window.localStorage, backendUrl);
      state.backendSavedGrant = false;
      state.backendPairingRequired = false;
    } catch (error) {
      if (state.backendConnectionController !== controller || controller.signal.aborted) return;
      state.backendError = error instanceof Error ? error.message : "无法撤销 Backend 配对";
    } finally {
      if (state.backendConnectionController === controller) {
        state.backendConnectionController = null;
        state.backendConnecting = false;
        dependencies.renderApp();
      }
    }
  }

  function updateBackendUrl(value: string) {
    state.backendUrl = value;
    state.backendError = "";
    state.backendPairingRequired = false;
    state.backendApprovalUrl = "";
    try {
      state.backendSavedGrant = Boolean(backendGrantToken(window.localStorage, normalizeBackendUrl(value, window.location.href)));
    } catch {
      state.backendSavedGrant = false;
    }
  }

  function disconnectBackend() {
    if (!state.config) return;
    if (state.backendActiveTransport === "webdav") return;
    window.clearTimeout(state.syncTimer);
    state.backendConnectionController?.abort();
    state.backendPairingController?.abort();
    state.backendSyncController?.abort();
    state.backendPairingWindow?.close();
    state.backendConnectionController = null;
    state.backendPairingController = null;
    state.backendPairingWindow = null;
    state.backendSyncController = null;
    state.authenticated = false;
    state.backendActiveUrl = "";
    state.backendActiveTransport = "";
    state.backendActiveGrantToken = "";
    state.backendConnecting = false;
    state.backendPairing = false;
    state.backendPairingRequired = false;
    state.backendApprovalUrl = "";
    state.backendError = "";
    state.syncing = false;
    state.syncRequested = false;
    state.initialFetchComplete = false;
    state.syncError = "";
    state.offline = !navigator.onLine;
    state.config.profile = {...state.localProfile};
    try {
      state.backendSavedGrant = Boolean(backendGrantToken(window.localStorage, normalizeBackendUrl(state.backendUrl, window.location.href)));
    } catch {
      state.backendSavedGrant = false;
    }
    dependencies.renderApp();
  }

  return {
    initialize,
    connectBackend,
    disconnectBackend,
    pairBackend,
    revokeBackendPairing,
    updateBackendUrl
  };
}
