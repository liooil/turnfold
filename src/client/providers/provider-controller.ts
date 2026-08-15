import type {ProviderModel, ProviderProfile, ProviderProtocol} from "../../shared/provider-types";
import type {AppState, ChatProvider} from "../app-state";
import {cacheChatConfig} from "../storage/offline-history";
import {messageNow} from "../draft-model";
import {getEmbeddedProviderProfile, isEmbeddedProvider, selectableCatalogProviderProfiles} from "./embedded-providers";
import {
  deleteLocalCredential,
  deleteLocalProviderProfile,
  listLocalCredentials,
  saveLocalCredential,
  saveLocalProviderProfile,
  type LocalCredential
} from "./local-providers";
import {embeddedModelsDevCatalog, embeddedModelsDevModelCount, modelsDevModel, modelsDevModelCount} from "./models-dev-catalog";
import {deleteStoredModelsDevCatalog, downloadModelsDevCatalog} from "./models-dev-storage";
import {autoDetectProvider} from "./provider-auto-detect";
import {providerHeadersFromJson, validProviderId, validProviderUrl} from "./provider-validation";

type Dependencies = {
  root: HTMLElement;
  render: () => void;
  localCredential: (providerId: string) => LocalCredential | null;
  settingsForProvider: (provider: ChatProvider) => {model: string};
  scheduleSettingsSave: () => void;
  discoverProvider: (provider: ChatProvider) => Promise<ChatProvider>;
  reportError: (error: unknown) => void;
};

function formValue(form: HTMLFormElement, name: string) {
  const field = form.elements.namedItem(name);
  return field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement ? field.value.trim() : "";
}

export function createProviderController(state: AppState, dependencies: Dependencies) {
  const {render} = dependencies;

  function closeProviderEditor() {
    state.providerSetupController?.abort();
    state.providerEditorOpen = false;
    state.providerEditorId = "";
    state.providerEditorMode = "simple";
    state.providerSetupKind = "catalog";
    state.providerSetupUrl = "";
    state.providerSetupKey = "";
    state.providerSetupBusy = false;
    state.providerSetupError = "";
    state.providerSetupDetected = null;
    state.providerSetupController = null;
  }

  function closeProviderModelEditor() {
    state.providerModelEditorOpen = false;
    state.providerModelProviderId = "";
    state.providerModelPresetId = "";
    state.providerModelQuery = "";
  }

  function focusProviderSettings(selector?: string) {
    window.requestAnimationFrame(() => {
      dependencies.root.querySelector<HTMLElement>("#settings-providers")?.scrollIntoView({block: "start"});
      if (selector) dependencies.root.querySelector<HTMLInputElement>(selector)?.focus();
    });
  }

  function openProviderEditor(providerId = "") {
    closeProviderEditor();
    state.settingsOpen = true;
    state.providerEditorOpen = true;
    state.providerEditorId = providerId;
    closeProviderModelEditor();
    render();
    focusProviderSettings('[name="provider-name"]');
  }

  function openProviderModelEditor(providerId: string) {
    if (!state.config?.providers.some((item) => item.id === providerId)) return;
    state.settingsOpen = true;
    closeProviderEditor();
    state.providerModelEditorOpen = true;
    state.providerModelProviderId = providerId;
    render();
    focusProviderSettings('[name="provider-model-id"]');
  }

  function openProviderSettings() {
    state.settingsOpen = true;
    closeProviderEditor();
    closeProviderModelEditor();
    render();
    focusProviderSettings();
  }

  async function updateModelsDevCatalog() {
    if (state.modelsDevUpdating) return;
    state.modelsDevUpdating = true;
    state.modelsDevError = "";
    render();
    try {
      const stored = await downloadModelsDevCatalog();
      state.modelsDevCatalog = stored.catalog;
      state.modelsDevModelCount = modelsDevModelCount(stored.catalog);
      state.modelsDevFetchedAt = stored.fetchedAt;
    } catch (error) {
      state.modelsDevError = error instanceof Error ? error.message : "models.dev 目录更新失败";
    } finally {
      state.modelsDevUpdating = false;
      render();
    }
  }

  async function resetModelsDevCatalog() {
    await deleteStoredModelsDevCatalog();
    state.modelsDevCatalog = embeddedModelsDevCatalog;
    state.modelsDevModelCount = embeddedModelsDevModelCount;
    state.modelsDevFetchedAt = "";
    state.modelsDevError = "";
    state.providerModelPresetId = "";
    render();
  }

  async function persistProviderProfile(profileInput: ChatProvider, apiKey: string) {
    if (!state.config) throw new Error("Provider 配置尚未加载");
    const existing = state.config.providers.find((item) => item.id === profileInput.id);
    const activeProviderMissing = Boolean(state.providerId && !state.config.providers.some((item) => item.id === state.providerId));
    const profile = await saveLocalProviderProfile(profileInput) as ChatProvider;
    if (profile.auth.type === "none") await deleteLocalCredential(profile.id);
    else if (apiKey) await saveLocalCredential(profile.id, "default", {apiKey});
    state.localCredentials = await listLocalCredentials();
    state.config.providers = existing
      ? state.config.providers.map((item) => item.id === profile.id ? profile : item)
      : [...state.config.providers, profile];
    if (!state.providerId || activeProviderMissing || state.providerId === profile.id) {
      state.providerId = profile.id;
      state.model = dependencies.settingsForProvider(profile).model;
      if (state.conversation) {
        state.conversation = {...state.conversation, providerId: profile.id, model: state.model};
        dependencies.scheduleSettingsSave();
      }
    }
    window.localStorage.setItem("turnfold-provider", profile.id);
    if (state.model) window.localStorage.setItem(`turnfold-model:${profile.id}`, state.model);
    closeProviderEditor();
    await cacheChatConfig(state.identityKey, {profile: state.config.profile});
    render();
    return profile;
  }

  async function saveCatalogProviderForm(form: HTMLFormElement) {
    if (!state.config) return;
    const providerId = formValue(form, "provider-catalog-id");
    const template = selectableCatalogProviderProfiles(state.modelsDevCatalog).find((item) => item.id === providerId);
    if (!template) throw new Error("所选 Provider 已不在当前模型目录中");
    if (state.config.providers.some((item) => item.id === providerId)) throw new Error("该 Provider 已启用");
    const apiKey = formValue(form, "provider-api-key");
    if (template.auth.type !== "none" && !apiKey) throw new Error("请输入 API Key");
    const timestamp = messageNow();
    await persistProviderProfile({...template, createdAt: timestamp, updatedAt: timestamp}, apiKey);
  }

  async function saveProviderCredentialForm(form: HTMLFormElement) {
    const provider = state.config?.providers.find((item) => item.id === state.providerEditorId);
    if (!provider) throw new Error("Provider 已不存在");
    const apiKey = formValue(form, "provider-api-key");
    const credential = dependencies.localCredential(provider.id);
    if (provider.auth.type !== "none" && !apiKey && !credential?.secret.apiKey) throw new Error("请输入 API Key");
    if (provider.auth.type === "none") await deleteLocalCredential(provider.id);
    else if (apiKey) await saveLocalCredential(provider.id, "default", {apiKey});
    state.localCredentials = await listLocalCredentials();
    closeProviderEditor();
    render();
  }

  async function detectProviderForm(form: HTMLFormElement) {
    if (!state.config || state.providerSetupBusy) return;
    state.providerSetupUrl = formValue(form, "provider-url");
    state.providerSetupKey = formValue(form, "provider-api-key");
    state.providerSetupController?.abort();
    const controller = new AbortController();
    state.providerSetupController = controller;
    state.providerSetupBusy = true;
    state.providerSetupError = "";
    state.providerSetupDetected = null;
    render();
    try {
      const detected = await autoDetectProvider(state.providerSetupUrl, state.providerSetupKey, state.config.providers.map((item) => item.id), fetch, controller.signal);
      if (state.providerSetupController !== controller) return;
      state.providerSetupController = null;
      state.providerSetupBusy = false;
      state.providerSetupDetected = detected;
      render();
    } catch (error) {
      if (state.providerSetupController !== controller) return;
      state.providerSetupController = null;
      state.providerSetupBusy = false;
      state.providerSetupError = error instanceof Error ? error.message : "Provider 自动探测失败";
      render();
    }
  }

  async function addDetectedProviderForm() {
    const detected = state.providerSetupDetected;
    if (!state.config || !detected || state.providerSetupBusy) return;
    state.providerSetupBusy = true;
    state.providerSetupError = "";
    render();
    try {
      const timestamp = messageNow();
      await persistProviderProfile({...detected, createdAt: timestamp, updatedAt: timestamp}, state.providerSetupKey);
    } catch (error) {
      state.providerSetupBusy = false;
      state.providerSetupError = error instanceof Error ? error.message : "添加 Provider 失败";
      render();
    }
  }

  async function saveProviderForm(form: HTMLFormElement) {
    if (!state.config) return;
    const existing = state.config.providers.find((item) => item.id === state.providerEditorId);
    const embedded = getEmbeddedProviderProfile(state.providerEditorId);
    const template = existing || embedded;
    const providerId = validProviderId(formValue(form, "provider-id"));
    const name = formValue(form, "provider-name");
    const protocol = formValue(form, "provider-protocol") as ProviderProtocol;
    const baseUrl = validProviderUrl(formValue(form, "provider-base-url"), "Base URL");
    const discoveryUrl = validProviderUrl(formValue(form, "provider-discovery-url"), "模型发现 URL", false);
    const authType = formValue(form, "provider-auth") as ProviderProfile["auth"]["type"];
    const authHeader = formValue(form, "provider-auth-header");
    const defaultModel = formValue(form, "provider-default-model");
    const headers = providerHeadersFromJson(formValue(form, "provider-headers"));
    if (!name) throw new Error("Provider 名称不能为空");
    if (state.providerEditorId && providerId !== state.providerEditorId) throw new Error("已保存 Provider 的标识不能修改");
    if (!existing && state.config.providers.some((item) => item.id === providerId)) throw new Error("该 Provider 标识已存在");
    if (!["openai-chat", "openai-responses", "anthropic", "google"].includes(protocol)) throw new Error("不支持的 Provider 协议");
    if (!["none", "bearer", "header"].includes(authType)) throw new Error("不支持的认证方式");
    if (authType === "header" && !authHeader) throw new Error("自定义 Header 认证需要填写 Header 名称");
    const timestamp = messageNow();
    const endpointChanged = Boolean(template && (template.baseUrl !== baseUrl || template.protocol !== protocol));
    const models = endpointChanged ? [] : [...(template?.models || [])];
    if (defaultModel && !models.some((model) => model.id === defaultModel)) models.unshift({id: defaultModel, name: defaultModel, source: "manual"});
    await persistProviderProfile({
      id: providerId,
      name,
      protocol,
      baseUrl,
      auth: authType === "header" ? {type: "header", header: authHeader} : {type: authType},
      headers,
      discoveryUrl,
      models,
      defaultModel: defaultModel || models[0]?.id || "",
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp
    }, formValue(form, "provider-api-key"));
  }

  async function saveProviderModelForm(form: HTMLFormElement) {
    if (!state.config) return;
    const provider = state.config.providers.find((item) => item.id === state.providerModelProviderId);
    if (!provider) throw new Error("Provider 已不存在");
    const modelId = formValue(form, "provider-model-id");
    if (!modelId) throw new Error("模型 ID 不能为空");
    if (/\s/.test(modelId)) throw new Error("模型 ID 不能包含空白字符");
    const modelName = formValue(form, "provider-model-name") || modelId;
    const template = modelsDevModel(state.modelsDevCatalog, provider.id, modelId) || provider.models.find((model) => model.id === modelId);
    const model: ProviderModel = {...template, id: modelId, name: modelName, source: "manual"};
    const models = [...provider.models];
    const existingIndex = models.findIndex((item) => item.id === modelId);
    if (existingIndex >= 0) models.splice(existingIndex, 1, model);
    else models.push(model);
    const updated = await saveLocalProviderProfile({...provider, models, defaultModel: provider.defaultModel || modelId, updatedAt: messageNow()}) as ChatProvider;
    state.config.providers = state.config.providers.map((item) => item.id === updated.id ? updated : item);
    if (state.providerId === updated.id && !state.model) {
      state.model = updated.defaultModel;
      window.localStorage.setItem(`turnfold-model:${updated.id}`, state.model);
      if (state.conversation) {
        state.conversation = {...state.conversation, model: state.model};
        dependencies.scheduleSettingsSave();
      }
    }
    closeProviderModelEditor();
    render();
  }

  async function probeProvider(providerId: string) {
    if (!state.config) return;
    const item = state.config.providers.find((candidate) => candidate.id === providerId);
    if (!item) return;
    try {
      const detected = await dependencies.discoverProvider(item);
      state.config.providers = state.config.providers.map((candidate) => candidate.id === detected.id ? detected : candidate);
      if (state.providerId === detected.id && !detected.models.some((model) => model.id === state.model)) state.model = dependencies.settingsForProvider(detected).model;
      window.alert(`探测成功：发现 ${detected.models.length} 个模型`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      state.config.providers = state.config.providers.map((candidate) => candidate.id === providerId ? {...candidate, modelDiscoveryError: message} : candidate);
      window.alert(`探测失败：${message}\n\n请确认 Provider 允许当前网页跨域访问；本机端点还可能需要浏览器的“本地网络访问”权限。`);
    }
    render();
  }

  async function removeProvider(providerId: string) {
    if (!state.config) return;
    const item = state.config.providers.find((candidate) => candidate.id === providerId);
    const prompt = isEmbeddedProvider(providerId)
      ? `禁用内嵌 Provider“${item?.name || providerId}”并删除其本地配置和凭据？历史对话不会删除。`
      : `删除此浏览器中的 Provider“${item?.name || providerId}”及其凭据？历史对话不会删除。`;
    if (!item || !window.confirm(prompt)) return;
    await deleteLocalProviderProfile(providerId);
    await deleteLocalCredential(providerId);
    state.localCredentials = await listLocalCredentials();
    state.config.providers = state.config.providers.filter((candidate) => candidate.id !== providerId);
    if (state.providerId === providerId) {
      const replacement = state.config.providers.find((candidate) => candidate.models.length) || state.config.providers[0];
      state.providerId = state.conversation?.providerId === providerId ? providerId : replacement?.id || "";
      state.model = state.conversation?.providerId === providerId ? state.conversation.model : replacement ? dependencies.settingsForProvider(replacement).model : "";
    }
    if (state.providerEditorId === providerId) closeProviderEditor();
    if (state.providerModelProviderId === providerId) closeProviderModelEditor();
    await cacheChatConfig(state.identityKey, {profile: state.config.profile});
    render();
  }

  function handleSubmit(form: HTMLFormElement) {
    if (form.matches("[data-provider-catalog-form]")) void saveCatalogProviderForm(form).catch(dependencies.reportError);
    else if (form.matches("[data-provider-detect-form]")) void detectProviderForm(form);
    else if (form.matches("[data-provider-credential-form]")) void saveProviderCredentialForm(form).catch(dependencies.reportError);
    else if (form.matches("[data-provider-model-form]")) void saveProviderModelForm(form).catch(dependencies.reportError);
    else if (form.matches("[data-provider-form]")) void saveProviderForm(form).catch(dependencies.reportError);
    else return false;
    return true;
  }

  function handleInput(target: EventTarget | null) {
    if (target instanceof HTMLInputElement && target.dataset.action === "provider-model-search") {
      state.providerModelQuery = target.value;
      render();
      return true;
    }
    if (target instanceof HTMLInputElement && target.dataset.action === "provider-setup-url") {
      state.providerSetupUrl = target.value;
      state.providerSetupDetected = null;
      render();
      return true;
    }
    if (target instanceof HTMLInputElement && target.dataset.action === "provider-setup-key") {
      state.providerSetupKey = target.value;
      state.providerSetupDetected = null;
      render();
      return true;
    }
    return false;
  }

  function handleAction(button: HTMLElement) {
    const action = button.dataset.action;
    if (action === "open-provider-settings") openProviderSettings();
    else if (action === "add-provider") openProviderEditor();
    else if (action === "edit-provider" && button.dataset.provider) openProviderEditor(button.dataset.provider);
    else if (action === "cancel-provider-edit") { closeProviderEditor(); render(); }
    else if (action === "provider-simple-mode") { state.providerEditorMode = "simple"; state.providerSetupError = ""; render(); }
    else if (action === "provider-advanced-mode") { state.providerEditorMode = "advanced"; state.providerSetupError = ""; render(); }
    else if (action === "provider-setup-kind" && (button.dataset.kind === "catalog" || button.dataset.kind === "detect")) { state.providerSetupKind = button.dataset.kind; state.providerSetupError = ""; state.providerSetupDetected = null; render(); }
    else if (action === "add-detected-provider") void addDetectedProviderForm().catch(dependencies.reportError);
    else if (action === "add-provider-model" && button.dataset.provider) openProviderModelEditor(button.dataset.provider);
    else if (action === "select-provider-model-preset" && button.dataset.model) { state.providerModelPresetId = button.dataset.model; render(); }
    else if (action === "cancel-provider-model-edit") { closeProviderModelEditor(); render(); }
    else if (action === "update-models-dev") void updateModelsDevCatalog();
    else if (action === "reset-models-dev") void resetModelsDevCatalog().catch(dependencies.reportError);
    else if (action === "probe-provider" && button.dataset.provider) void probeProvider(button.dataset.provider).catch(dependencies.reportError);
    else if (action === "delete-provider" && button.dataset.provider) void removeProvider(button.dataset.provider).catch(dependencies.reportError);
    else return false;
    return true;
  }

  function closeTopEditor() {
    if (state.providerModelEditorOpen) closeProviderModelEditor();
    else if (state.providerEditorOpen) closeProviderEditor();
    else return false;
    render();
    return true;
  }

  return {
    closeProviderEditor,
    closeProviderModelEditor,
    closeTopEditor,
    handleAction,
    handleInput,
    handleSubmit,
    openProviderEditor,
    openProviderModelEditor,
    openProviderSettings,
    probeProvider,
    removeProvider,
    resetModelsDevCatalog,
    saveCatalogProviderForm,
    detectProviderForm,
    addDetectedProviderForm,
    saveProviderCredentialForm,
    saveProviderForm,
    saveProviderModelForm,
    updateModelsDevCatalog
  };
}
