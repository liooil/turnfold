import type {AppState} from "./app-state";
import {
  backendApiUrl,
  backendApprovalUrl,
  backendGrantToken,
  normalizeBackendUrl,
  pollBackendPairing,
  removeBackendGrant,
  revokeBackendGrant,
  saveBackendGrant,
  startBackendPairing,
  suggestedBackendUrl
} from "./backend-connection";
import {basePath} from "./environment";
import {
  WebDavHttpError,
  WebDavRepositoryPeer,
  normalizeWebDavUrl,
  type WebDavAuthentication
} from "./sync/webdav-repository-peer";

export const repositoryWebDavScope = "repository.webdav";
export const webdavGrantStorageKey = "turnfold-webdav-grants-v1";
const webdavUrlStorageKey = "turnfold-webdav-url";
const webdavModeStorageKey = "turnfold-webdav-mode";
const webdavUsernameStorageKey = "turnfold-webdav-username";

type Dependencies = {
  render: () => void;
  disconnectNative: () => void;
  synchronize: () => Promise<void>;
};

export function webdavRootUrl(value: string, mode: AppState["webdavMode"], pageUrl?: string) {
  if (mode === "turnfold") return normalizeWebDavUrl(backendApiUrl(normalizeBackendUrl(value, pageUrl), "/dav"));
  return normalizeWebDavUrl(value, pageUrl);
}

function waitForPoll(delay: number, signal: AbortSignal) {
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

export function createWebDavController(state: AppState, dependencies: Dependencies) {
  function serviceUrl() {
    return normalizeBackendUrl(state.webdavUrl, window.location.href);
  }

  function savedGrant(url = state.webdavUrl) {
    if (state.webdavMode !== "turnfold") return "";
    try {
      return backendGrantToken(window.localStorage, normalizeBackendUrl(url, window.location.href), webdavGrantStorageKey);
    } catch {
      return "";
    }
  }

  function initialize() {
    if (!(["turnfold", "basic", "none"] as const).includes(state.webdavMode)) state.webdavMode = "turnfold";
    if (!state.webdavUrl) state.webdavUrl = suggestedBackendUrl(window.localStorage, window.location.href, basePath);
    state.webdavSavedGrant = Boolean(savedGrant());
  }

  function authentication(mode = state.webdavMode, grantToken = savedGrant()): WebDavAuthentication {
    if (mode === "turnfold") return {type: "bearer", token: grantToken};
    if (mode === "basic") return {type: "basic", username: state.webdavUsername, password: state.webdavPassword};
    return {type: "none"};
  }

  async function connect(value = state.webdavUrl) {
    if (state.webdavConnecting || state.webdavPairing || !state.config) return;
    let rootUrl: string;
    let normalizedInput: string;
    try {
      normalizedInput = state.webdavMode === "turnfold"
        ? normalizeBackendUrl(value, window.location.href)
        : normalizeWebDavUrl(value, window.location.href);
      rootUrl = webdavRootUrl(value, state.webdavMode, window.location.href);
    } catch (error) {
      state.webdavError = error instanceof Error ? error.message : "WebDAV URL 无效";
      dependencies.render();
      return;
    }
    if (state.webdavMode === "basic" && (!state.webdavUsername || !state.webdavPassword)) {
      state.webdavError = "请输入 WebDAV 用户名和密码";
      dependencies.render();
      return;
    }

    const grantToken = state.webdavMode === "turnfold"
      ? backendGrantToken(window.localStorage, normalizedInput, webdavGrantStorageKey)
      : "";
    state.webdavConnecting = true;
    state.webdavError = "";
    state.webdavPairingRequired = false;
    state.webdavApprovalUrl = "";
    state.webdavController?.abort();
    const controller = new AbortController();
    state.webdavController = controller;
    const ownsConnection = () => state.webdavController === controller && !controller.signal.aborted;
    dependencies.render();

    try {
      const peer = new WebDavRepositoryPeer(rootUrl, authentication(state.webdavMode, grantToken), controller.signal);
      await peer.identity();
      if (!ownsConnection()) return;
      dependencies.disconnectNative();
      disconnect(false);
      state.webdavController = null;
      state.webdavUrl = normalizedInput;
      state.webdavActiveRootUrl = rootUrl;
      state.webdavActiveMode = state.webdavMode;
      state.webdavActiveUsername = state.webdavUsername;
      state.webdavActivePassword = state.webdavMode === "basic" ? state.webdavPassword : "";
      state.webdavGrantToken = grantToken;
      state.webdavSavedGrant = Boolean(grantToken);
      state.backendActiveUrl = rootUrl;
      state.backendActiveTransport = "webdav";
      state.backendActiveGrantToken = "";
      state.authenticated = true;
      state.initialFetchComplete = false;
      state.webdavConnecting = false;
      state.syncError = "";
      state.config.profile = {...state.localProfile};
      window.localStorage.setItem(webdavUrlStorageKey, normalizedInput);
      window.localStorage.setItem(webdavModeStorageKey, state.webdavMode);
      window.localStorage.setItem(webdavUsernameStorageKey, state.webdavUsername);
      dependencies.render();
      await dependencies.synchronize();
      if (state.backendActiveTransport === "webdav" && state.webdavActiveRootUrl === rootUrl) dependencies.render();
    } catch (error) {
      if (!ownsConnection()) return;
      state.webdavController = null;
      state.webdavConnecting = false;
      if (state.webdavMode === "turnfold" && error instanceof WebDavHttpError && error.status === 401) {
        if (grantToken) removeBackendGrant(window.localStorage, normalizedInput, webdavGrantStorageKey);
        state.webdavSavedGrant = false;
        state.webdavPairingRequired = true;
      }
      state.webdavError = error instanceof Error ? error.message : "WebDAV 连接失败";
      dependencies.render();
    }
  }

  function disconnect(render = true) {
    state.webdavController?.abort();
    state.webdavPairingController?.abort();
    state.webdavPairingWindow?.close();
    state.webdavController = null;
    state.webdavPairingController = null;
    state.webdavPairingWindow = null;
    state.webdavConnecting = false;
    state.webdavPairing = false;
    state.webdavApprovalUrl = "";
    if (state.backendActiveTransport === "webdav") {
      window.clearTimeout(state.syncTimer);
      state.backendSyncController?.abort();
      state.backendSyncController = null;
      state.backendActiveUrl = "";
      state.backendActiveTransport = "";
      state.authenticated = false;
      state.syncing = false;
      state.syncRequested = false;
      state.initialFetchComplete = false;
      state.syncError = "";
      state.config && (state.config.profile = {...state.localProfile});
    }
    state.webdavActiveRootUrl = "";
    state.webdavActiveMode = "";
    state.webdavActiveUsername = "";
    state.webdavActivePassword = "";
    state.webdavGrantToken = "";
    state.webdavSavedGrant = Boolean(savedGrant());
    if (render) dependencies.render();
  }

  async function pair() {
    if (state.webdavMode !== "turnfold" || state.webdavPairing || state.webdavConnecting) return;
    let url: string;
    try {
      url = serviceUrl();
    } catch (error) {
      state.webdavError = error instanceof Error ? error.message : "Turnfold Service URL 无效";
      dependencies.render();
      return;
    }
    state.webdavPairingWindow?.close();
    const pairingWindow = window.open("about:blank", "turnfold-webdav-pairing", "popup,width=720,height=720");
    state.webdavPairingWindow = pairingWindow;
    state.webdavPairingController?.abort();
    const controller = new AbortController();
    state.webdavPairingController = controller;
    const ownsPairing = () => state.webdavPairingController === controller && !controller.signal.aborted;
    state.webdavPairing = true;
    state.webdavPairingRequired = false;
    state.webdavError = "";
    dependencies.render();
    try {
      const pairing = await startBackendPairing(
        url,
        `Turnfold WebDAV (${window.location.hostname || "browser"})`,
        fetch,
        controller.signal,
        [repositoryWebDavScope]
      );
      if (!ownsPairing()) return;
      const approvalUrl = backendApprovalUrl(url, pairing.pairingId);
      state.webdavApprovalUrl = approvalUrl;
      if (pairingWindow) {
        pairingWindow.opener = null;
        pairingWindow.location.href = approvalUrl;
      }
      dependencies.render();
      while (ownsPairing()) {
        const result = await pollBackendPairing(url, pairing, fetch, controller.signal, [repositoryWebDavScope]);
        if (!ownsPairing()) return;
        if (result.status === "pending") {
          await waitForPoll(pairing.pollIntervalMs, controller.signal);
          continue;
        }
        if (result.status === "denied") throw new Error("WebDAV 授权已被拒绝");
        if (result.status === "expired") throw new Error("WebDAV 授权请求已过期");
        saveBackendGrant(window.localStorage, url, result.token, result.grant, webdavGrantStorageKey);
        state.webdavSavedGrant = true;
        state.webdavPairingController = null;
        state.webdavPairing = false;
        state.webdavPairingRequired = false;
        state.webdavApprovalUrl = "";
        state.webdavPairingWindow = null;
        pairingWindow?.close();
        dependencies.render();
        await connect(url);
        return;
      }
    } catch (error) {
      if (!ownsPairing()) return;
      state.webdavPairingController = null;
      state.webdavPairing = false;
      state.webdavPairingRequired = true;
      state.webdavApprovalUrl = "";
      state.webdavPairingWindow = null;
      pairingWindow?.close();
      state.webdavError = error instanceof Error ? error.message : "WebDAV 授权失败";
      dependencies.render();
    }
  }

  async function revoke() {
    if (state.webdavMode !== "turnfold" || state.webdavConnecting || state.webdavPairing) return;
    let url: string;
    try {
      url = serviceUrl();
    } catch (error) {
      state.webdavError = error instanceof Error ? error.message : "Turnfold Service URL 无效";
      dependencies.render();
      return;
    }
    const token = backendGrantToken(window.localStorage, url, webdavGrantStorageKey);
    if (!token) {
      state.webdavSavedGrant = false;
      state.webdavError = "当前 URL 没有可撤销的 WebDAV 授权";
      dependencies.render();
      return;
    }
    if (state.backendActiveTransport === "webdav") disconnect(false);
    state.webdavConnecting = true;
    state.webdavError = "";
    dependencies.render();
    try {
      await revokeBackendGrant(url, token);
      removeBackendGrant(window.localStorage, url, webdavGrantStorageKey);
      state.webdavSavedGrant = false;
      state.webdavPairingRequired = false;
    } catch (error) {
      state.webdavError = error instanceof Error ? error.message : "无法撤销 WebDAV 授权";
    } finally {
      state.webdavConnecting = false;
      dependencies.render();
    }
  }

  function updateConnection() {
    state.webdavError = "";
    state.webdavPairingRequired = false;
    state.webdavApprovalUrl = "";
    state.webdavSavedGrant = Boolean(savedGrant());
  }

  function handleInput(target: EventTarget | null) {
    if (!(target instanceof HTMLInputElement)) return false;
    if (target.dataset.action === "webdav-url") state.webdavUrl = target.value;
    else if (target.dataset.action === "webdav-username") state.webdavUsername = target.value;
    else if (target.dataset.action === "webdav-password") state.webdavPassword = target.value;
    else return false;
    updateConnection();
    return true;
  }

  function handleChange(target: EventTarget | null) {
    if (!(target instanceof HTMLSelectElement) || target.dataset.action !== "webdav-mode") return false;
    state.webdavMode = target.value === "basic" ? "basic" : target.value === "none" ? "none" : "turnfold";
    updateConnection();
    dependencies.render();
    return true;
  }

  function handleSubmit(form: HTMLFormElement) {
    if (!form.matches("[data-webdav-connection-form]")) return false;
    void connect(state.webdavUrl);
    return true;
  }

  function handleAction(button: HTMLElement) {
    const action = button.dataset.action;
    if (action === "disconnect-webdav") disconnect();
    else if (action === "pair-webdav") void pair();
    else if (action === "revoke-webdav") void revoke();
    else if (action === "sync-webdav") void dependencies.synchronize().then(dependencies.render);
    else return false;
    return true;
  }

  return {initialize, connect, disconnect, pair, revoke, handleInput, handleChange, handleSubmit, handleAction};
}
