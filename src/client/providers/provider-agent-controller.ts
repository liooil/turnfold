import type {ProviderSecret} from "../../shared/provider-types";
import type {AppState, ChatProvider} from "../app-state";
import {
  backendApprovalUrl,
  defaultBackendUrl,
  normalizeBackendUrl,
  pollBackendPairing,
  providerExecuteScope,
  revokeBackendGrant,
  startBackendPairing,
  vaultManageScope
} from "../backend-connection";
import {basePath} from "../environment";
import type {LocalCredential} from "./local-providers";
import {
  deleteProviderAgentCredential,
  deleteProviderAgentProfile,
  fetchProviderAgentInfo,
  fetchProviderAgentResources,
  loadProviderAgentModes,
  providerAgentGrantToken,
  providerAgentUrlStorageKey,
  ProviderAgentPairingRequiredError,
  removeProviderAgentGrant,
  saveProviderAgentCredential,
  saveProviderAgentGrant,
  saveProviderAgentModes,
  saveProviderAgentProfile
} from "./provider-agent-client";

type Dependencies = {
  render: () => void;
  localCredential: (providerId: string) => LocalCredential | null;
  reportError: (error: unknown) => void;
};

function formValue(form: HTMLFormElement, name: string) {
  const field = form.elements.namedItem(name);
  return field instanceof HTMLInputElement || field instanceof HTMLSelectElement ? field.value.trim() : "";
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

export function agentProfileMatches(provider: ChatProvider, profile: AppState["providerAgentProfiles"][number] | undefined) {
  const headers = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  return Boolean(profile)
    && profile?.name === provider.name
    && profile.protocol === provider.protocol
    && profile.baseUrl.replace(/\/+$/, "") === provider.baseUrl.replace(/\/+$/, "")
    && profile.auth.type === provider.auth.type
    && (profile.auth.type !== "header" || profile.auth.header === provider.auth.header)
    && profile.discoveryUrl === provider.discoveryUrl
    && headers(profile.headers) === headers(provider.headers);
}

export function createProviderAgentController(state: AppState, dependencies: Dependencies) {
  const scopes = [providerExecuteScope, vaultManageScope];

  function initialize() {
    state.providerAgentModeIds = loadProviderAgentModes(window.localStorage);
    const stored = window.localStorage.getItem(providerAgentUrlStorageKey);
    try {
      state.providerAgentUrl = stored
        ? normalizeBackendUrl(stored)
        : defaultBackendUrl(window.location.href, basePath);
    } catch {
      state.providerAgentUrl = defaultBackendUrl(window.location.href, basePath);
      window.localStorage.removeItem(providerAgentUrlStorageKey);
    }
    state.providerAgentSavedGrant = Boolean(providerAgentGrantToken(window.localStorage, state.providerAgentUrl));
  }

  async function connect(value: string) {
    if (state.providerAgentConnecting || state.providerAgentPairing) return;
    let agentUrl: string;
    try {
      agentUrl = normalizeBackendUrl(value, window.location.href);
    } catch (error) {
      state.providerAgentError = error instanceof Error ? error.message : "Provider Agent URL 无效";
      dependencies.render();
      return;
    }
    const token = providerAgentGrantToken(window.localStorage, agentUrl);
    state.providerAgentController?.abort();
    const controller = new AbortController();
    state.providerAgentController = controller;
    const owns = () => state.providerAgentController === controller && !controller.signal.aborted;
    state.providerAgentUrl = agentUrl;
    state.providerAgentSavedGrant = Boolean(token);
    state.providerAgentConnecting = true;
    state.providerAgentPairingRequired = false;
    state.providerAgentError = "";
    dependencies.render();
    try {
      await fetchProviderAgentInfo(agentUrl, fetch, controller.signal);
      if (!token) throw new ProviderAgentPairingRequiredError();
      const resources = await fetchProviderAgentResources(agentUrl, token, fetch, controller.signal);
      if (!owns()) return;
      state.providerAgentProfiles = resources.profiles;
      state.providerAgentCredentials = resources.credentials;
      state.providerAgentActiveUrl = agentUrl;
      state.providerAgentGrantToken = token;
      state.providerAgentSavedGrant = true;
      window.localStorage.setItem(providerAgentUrlStorageKey, agentUrl);
    } catch (error) {
      if (!owns()) return;
      state.providerAgentActiveUrl = "";
      state.providerAgentGrantToken = "";
      state.providerAgentProfiles = [];
      state.providerAgentCredentials = [];
      if (error instanceof ProviderAgentPairingRequiredError) {
        if (token) removeProviderAgentGrant(window.localStorage, agentUrl);
        state.providerAgentSavedGrant = false;
        state.providerAgentPairingRequired = true;
      }
      state.providerAgentError = error instanceof Error ? error.message : "Provider Agent 连接失败";
    } finally {
      if (state.providerAgentController === controller) {
        state.providerAgentController = null;
        state.providerAgentConnecting = false;
        dependencies.render();
      }
    }
  }

  function disconnect() {
    state.providerAgentController?.abort();
    state.providerAgentPairingController?.abort();
    state.providerAgentPairingWindow?.close();
    state.providerAgentController = null;
    state.providerAgentPairingController = null;
    state.providerAgentPairingWindow = null;
    state.providerAgentActiveUrl = "";
    state.providerAgentGrantToken = "";
    state.providerAgentProfiles = [];
    state.providerAgentCredentials = [];
    state.providerAgentConnecting = false;
    state.providerAgentPairing = false;
    state.providerAgentApprovalUrl = "";
    state.providerAgentError = "";
    dependencies.render();
  }

  function updateUrl(value: string) {
    state.providerAgentUrl = value;
    state.providerAgentError = "";
    state.providerAgentPairingRequired = false;
    state.providerAgentApprovalUrl = "";
    try {
      state.providerAgentSavedGrant = Boolean(providerAgentGrantToken(window.localStorage, normalizeBackendUrl(value, window.location.href)));
    } catch {
      state.providerAgentSavedGrant = false;
    }
  }

  async function pair() {
    if (state.providerAgentPairing || state.providerAgentConnecting) return;
    let agentUrl: string;
    try {
      agentUrl = normalizeBackendUrl(state.providerAgentUrl, window.location.href);
    } catch (error) {
      state.providerAgentError = error instanceof Error ? error.message : "Provider Agent URL 无效";
      dependencies.render();
      return;
    }
    state.providerAgentPairingWindow?.close();
    const pairingWindow = window.open("about:blank", "turnfold-provider-agent-pairing", "popup,width=720,height=720");
    state.providerAgentPairingWindow = pairingWindow;
    state.providerAgentPairingController?.abort();
    const controller = new AbortController();
    state.providerAgentPairingController = controller;
    const owns = () => state.providerAgentPairingController === controller && !controller.signal.aborted;
    state.providerAgentPairing = true;
    state.providerAgentPairingRequired = false;
    state.providerAgentError = "";
    state.providerAgentApprovalUrl = "";
    dependencies.render();
    try {
      await fetchProviderAgentInfo(agentUrl, fetch, controller.signal);
      const pairing = await startBackendPairing(
        agentUrl,
        `Turnfold Provider Agent (${window.location.hostname || "browser"})`,
        fetch,
        controller.signal,
        scopes
      );
      if (!owns()) return;
      const approvalUrl = backendApprovalUrl(agentUrl, pairing.pairingId);
      state.providerAgentApprovalUrl = approvalUrl;
      if (pairingWindow) {
        pairingWindow.opener = null;
        pairingWindow.location.href = approvalUrl;
      }
      dependencies.render();
      while (owns()) {
        const result = await pollBackendPairing(agentUrl, pairing, fetch, controller.signal, scopes);
        if (!owns()) return;
        if (result.status === "pending") {
          await waitForPoll(pairing.pollIntervalMs, controller.signal);
          continue;
        }
        if (result.status === "denied") throw new Error("Provider Agent 已拒绝本次配对");
        if (result.status === "expired") throw new Error("Provider Agent 配对请求已过期，请重新发起");
        saveProviderAgentGrant(window.localStorage, agentUrl, result.token, result.grant);
        state.providerAgentSavedGrant = true;
        state.providerAgentPairingController = null;
        state.providerAgentPairing = false;
        state.providerAgentPairingRequired = false;
        state.providerAgentApprovalUrl = "";
        state.providerAgentPairingWindow = null;
        pairingWindow?.close();
        dependencies.render();
        await connect(agentUrl);
        return;
      }
    } catch (error) {
      if (!owns()) return;
      state.providerAgentPairingController = null;
      state.providerAgentPairing = false;
      state.providerAgentPairingRequired = true;
      state.providerAgentApprovalUrl = "";
      state.providerAgentPairingWindow = null;
      pairingWindow?.close();
      state.providerAgentError = error instanceof Error ? error.message : "Provider Agent 配对失败";
      dependencies.render();
    }
  }

  async function revokePairing() {
    const agentUrl = normalizeBackendUrl(state.providerAgentUrl, window.location.href);
    const token = providerAgentGrantToken(window.localStorage, agentUrl);
    if (!token) throw new Error("当前 Provider Agent 没有可撤销的浏览器配对");
    state.providerAgentConnecting = true;
    state.providerAgentError = "";
    dependencies.render();
    try {
      await revokeBackendGrant(agentUrl, token);
      removeProviderAgentGrant(window.localStorage, agentUrl);
      state.providerAgentSavedGrant = false;
      state.providerAgentPairingRequired = false;
      disconnect();
    } finally {
      state.providerAgentConnecting = false;
      dependencies.render();
    }
  }

  function connectedContext() {
    if (!state.providerAgentActiveUrl || !state.providerAgentGrantToken) {
      throw new Error("请先显式连接 Provider Agent");
    }
    return {url: state.providerAgentActiveUrl, token: state.providerAgentGrantToken};
  }

  async function registerProvider(providerId: string) {
    const provider = state.config?.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error("Provider 已不存在");
    const agent = connectedContext();
    state.providerAgentSaving = true;
    state.providerAgentError = "";
    dependencies.render();
    try {
      const saved = await saveProviderAgentProfile(agent.url, agent.token, provider);
      state.providerAgentProfiles = [
        ...state.providerAgentProfiles.filter((item) => item.id !== saved.id),
        saved
      ];
    } finally {
      state.providerAgentSaving = false;
      dependencies.render();
    }
  }

  async function saveCredential(providerId: string, secret: ProviderSecret) {
    const provider = state.config?.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error("Provider 已不存在");
    if (provider.auth.type !== "none" && !secret.apiKey && !Object.keys(secret.headers || {}).length) {
      throw new Error("请输入 Provider 凭据");
    }
    const agent = connectedContext();
    state.providerAgentSaving = true;
    state.providerAgentError = "";
    dependencies.render();
    try {
      const profile = await saveProviderAgentProfile(agent.url, agent.token, provider);
      state.providerAgentProfiles = [...state.providerAgentProfiles.filter((item) => item.id !== profile.id), profile];
      if (provider.auth.type !== "none") {
        const credential = await saveProviderAgentCredential(agent.url, agent.token, provider.id, secret);
        state.providerAgentCredentials = [
          ...state.providerAgentCredentials.filter((item) => item.id !== credential.id && !(item.providerId === provider.id && item.name === "default")),
          credential
        ];
      }
    } finally {
      state.providerAgentSaving = false;
      dependencies.render();
    }
  }

  async function migrateCredential(providerId: string) {
    const credential = dependencies.localCredential(providerId);
    if (!credential) throw new Error("当前浏览器没有可迁移的 Provider 凭据");
    if (!window.confirm("将此 Provider profile 与凭据明确发送到已连接的本地 Agent？浏览器中的原凭据会保留，直到你自行删除。")) return;
    await saveCredential(providerId, credential.secret);
  }

  function setMode(providerId: string, mode: "browser" | "agent") {
    const provider = state.config?.providers.find((item) => item.id === providerId);
    if (!provider) return;
    if (mode === "agent") {
      if (!state.providerAgentActiveUrl) throw new Error("请先连接 Provider Agent");
      const profile = state.providerAgentProfiles.find((item) => item.id === providerId);
      if (!agentProfileMatches(provider, profile)) throw new Error("请先将当前 Provider profile 登记或更新到 Agent");
      if (provider.auth.type !== "none" && !state.providerAgentCredentials.some((item) => item.providerId === providerId && item.name === "default")) {
        throw new Error("请先在 Agent Vault 中保存此 Provider 的凭据");
      }
      state.providerAgentModeIds.add(providerId);
    } else {
      state.providerAgentModeIds.delete(providerId);
    }
    state.providerAgentModeIds = new Set(state.providerAgentModeIds);
    saveProviderAgentModes(window.localStorage, state.providerAgentModeIds);
    dependencies.render();
  }

  async function removeCredential(credentialId: string) {
    const credential = state.providerAgentCredentials.find((item) => item.id === credentialId);
    if (!credential || !window.confirm("从 Agent Vault 删除此凭据？浏览器内凭据不会受影响。")) return;
    const agent = connectedContext();
    await deleteProviderAgentCredential(agent.url, agent.token, credentialId);
    state.providerAgentCredentials = state.providerAgentCredentials.filter((item) => item.id !== credentialId);
    state.providerAgentModeIds.delete(credential.providerId);
    state.providerAgentModeIds = new Set(state.providerAgentModeIds);
    saveProviderAgentModes(window.localStorage, state.providerAgentModeIds);
    dependencies.render();
  }

  async function removeProfile(providerId: string) {
    const profile = state.providerAgentProfiles.find((item) => item.id === providerId);
    if (!profile || !window.confirm("从 Agent 删除此 Provider execution profile？浏览器内 Provider 不会受影响。")) return;
    if (state.providerAgentCredentials.some((item) => item.providerId === providerId)) {
      throw new Error("请先删除 Agent Vault 中属于此 Provider 的凭据");
    }
    const agent = connectedContext();
    await deleteProviderAgentProfile(agent.url, agent.token, providerId);
    state.providerAgentProfiles = state.providerAgentProfiles.filter((item) => item.id !== providerId);
    state.providerAgentModeIds.delete(providerId);
    state.providerAgentModeIds = new Set(state.providerAgentModeIds);
    saveProviderAgentModes(window.localStorage, state.providerAgentModeIds);
    dependencies.render();
  }

  function handleSubmit(form: HTMLFormElement) {
    if (form.matches("[data-provider-agent-connection-form]")) {
      void connect(formValue(form, "provider-agent-url")).catch(dependencies.reportError);
      return true;
    }
    if (form.matches("[data-provider-agent-credential-form]")) {
      const providerId = formValue(form, "provider-agent-provider");
      const apiKey = formValue(form, "provider-agent-api-key");
      void saveCredential(providerId, {apiKey}).catch(dependencies.reportError);
      return true;
    }
    return false;
  }

  function handleInput(target: EventTarget | null) {
    if (target instanceof HTMLInputElement && target.dataset.action === "provider-agent-url") {
      updateUrl(target.value);
      return true;
    }
    return false;
  }

  function handleAction(button: HTMLElement) {
    const action = button.dataset.action;
    if (action === "pair-provider-agent") void pair().catch(dependencies.reportError);
    else if (action === "disconnect-provider-agent") disconnect();
    else if (action === "revoke-provider-agent") void revokePairing().catch(dependencies.reportError);
    else if (action === "register-agent-provider" && button.dataset.provider) void registerProvider(button.dataset.provider).catch(dependencies.reportError);
    else if (action === "migrate-agent-credential" && button.dataset.provider) void migrateCredential(button.dataset.provider).catch(dependencies.reportError);
    else if (action === "use-provider-agent" && button.dataset.provider) {
      try { setMode(button.dataset.provider, "agent"); } catch (error) { dependencies.reportError(error); }
    } else if (action === "use-browser-provider" && button.dataset.provider) setMode(button.dataset.provider, "browser");
    else if (action === "delete-agent-credential" && button.dataset.credential) void removeCredential(button.dataset.credential).catch(dependencies.reportError);
    else if (action === "delete-agent-provider" && button.dataset.provider) void removeProfile(button.dataset.provider).catch(dependencies.reportError);
    else return false;
    return true;
  }

  return {
    initialize,
    connect,
    disconnect,
    pair,
    revokePairing,
    registerProvider,
    saveCredential,
    migrateCredential,
    setMode,
    removeCredential,
    removeProfile,
    handleSubmit,
    handleInput,
    handleAction
  };
}
