import type {AppState} from "./app-state";
import {icons} from "./icons";
import {option, providerProtocolLabel, type ModelChoice} from "./model-selection";
import {getEmbeddedProviderProfile, isEmbeddedProvider, selectableCatalogProviderProfiles} from "./providers/embedded-providers";
import type {LocalCredential} from "./providers/local-providers";
import {availableModelsDevModels, embeddedModelsDevModelCount} from "./providers/models-dev-catalog";

export function createSettingsView(state: AppState, dependencies: {
  escapeHtml: (value: unknown) => string;
  localCredential: (providerId: string) => LocalCredential | null;
  availableModelChoices: () => ModelChoice[];
  renderEffortControl: (name: string) => string;
  renderModelOption: (choice: ModelChoice) => string;
}) {
  const {escapeHtml} = dependencies;

  function renderProviderEditor() {
    if (!state.providerEditorOpen) return "";
    const existing = state.config?.providers.find((item) => item.id === state.providerEditorId);
    const catalogProfiles = selectableCatalogProviderProfiles(state.modelsDevCatalog);
    const catalogProfile = catalogProfiles.find((item) => item.id === state.providerEditorId);
    const template = existing || catalogProfile;
    const credential = existing ? dependencies.localCredential(existing.id) : null;
    if (state.providerEditorMode === "simple") {
      const close = `<button type="button" data-action="cancel-provider-edit" aria-label="关闭 Provider 编辑器">${icons.close}</button>`;
      const advanced = '<button type="button" data-action="provider-advanced-mode">进阶配置</button>';
      if (existing) {
        const credentialField = existing.auth.type === "none"
          ? '<p class="provider-setup-note">此 Provider 不需要凭据。</p>'
          : `<label class="provider-setup-field"><span>API Key</span><input name="provider-api-key" type="password" autocomplete="off" placeholder="${credential?.secret.apiKey ? "已配置；留空则保持不变" : "输入 API Key"}"></label>`;
        return `<form class="provider-editor provider-simple-editor" data-provider-credential-form><header><div><strong>${escapeHtml(existing.name)}</strong><small>更新凭据，或进入进阶配置修改连接细节</small></div>${close}</header><div class="provider-setup-summary"><span><strong>${escapeHtml(providerProtocolLabel(existing.protocol))}</strong><small>${escapeHtml(existing.baseUrl)}</small></span><em>${existing.models.length} 个模型</em></div>${credentialField}<footer>${advanced}<button class="provider-save-button" type="submit">保存凭据</button></footer></form>`;
      }
      const enabledIds = new Set(state.config?.providers.map((item) => item.id) || []);
      const choices = catalogProfiles.filter((item) => !enabledIds.has(item.id));
      const selectedId = choices.some((item) => item.id === state.providerEditorId) ? state.providerEditorId : choices[0]?.id || "";
      const kindTabs = `<div class="provider-setup-kinds" role="tablist" aria-label="添加 Provider 的方式"><button type="button" role="tab" aria-selected="${state.providerSetupKind === "catalog"}" class="${state.providerSetupKind === "catalog" ? "selected" : ""}" data-action="provider-setup-kind" data-kind="catalog"><strong>从模型目录启用</strong><small>选择 Provider 并设置凭据</small></button><button type="button" role="tab" aria-selected="${state.providerSetupKind === "detect"}" class="${state.providerSetupKind === "detect" ? "selected" : ""}" data-action="provider-setup-kind" data-kind="detect"><strong>自动探测 URL</strong><small>只需要 URL 和 Key</small></button></div>`;
      const error = state.providerSetupError ? `<p class="local-key-error provider-setup-error">${escapeHtml(state.providerSetupError)}</p>` : "";
      const footer = `<footer>${advanced}<button type="button" data-action="cancel-provider-edit">取消</button>`;
      if (state.providerSetupKind === "detect") {
        return `<form class="provider-editor provider-simple-editor" data-provider-detect-form><header><div><strong>自动探测 Provider</strong><small>Turnfold 会探测模型目录，并根据站点标题或域名生成名称</small></div>${close}</header>${kindTabs}<div class="provider-setup-fields"><label class="provider-setup-field"><span>Provider URL</span><input name="provider-url" type="url" required value="${escapeHtml(state.providerSetupUrl)}" data-action="provider-setup-url" placeholder="https://api.example.com/v1"></label><label class="provider-setup-field"><span>API Key</span><input name="provider-api-key" type="password" autocomplete="off" value="${escapeHtml(state.providerSetupKey)}" data-action="provider-setup-key" placeholder="本地无认证端点可留空"></label></div>${error}<p class="provider-setup-note">探测请求由当前浏览器直接发送。目标服务需要允许跨域访问；局域网地址可能触发浏览器的本地网络权限提示。</p>${footer}<button class="provider-save-button" type="submit"${state.providerSetupBusy ? " disabled" : ""}>${state.providerSetupBusy ? "正在探测…" : "探测并添加"}</button></footer></form>`;
      }
      const choicesHtml = choices.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === selectedId ? " selected" : ""}>${getEmbeddedProviderProfile(item.id) ? "内嵌" : "目录"} · ${escapeHtml(item.name)} · ${item.models.length} 个模型</option>`).join("");
      return `<form class="provider-editor provider-simple-editor" data-provider-catalog-form><header><div><strong>从模型目录添加 Provider</strong><small>内嵌 Provider 优先显示；下载完整目录后可选择更多服务</small></div>${close}</header>${kindTabs}<div class="provider-setup-fields"><label class="provider-setup-field"><span>Provider</span><select name="provider-catalog-id" required>${choicesHtml}</select></label><label class="provider-setup-field"><span>API Key</span><input name="provider-api-key" type="password" autocomplete="off" value="${escapeHtml(state.providerSetupKey)}" data-action="provider-setup-key" placeholder="无认证服务可留空"></label></div>${error}${choices.length ? "" : '<p class="settings-empty">当前目录中的 Provider 已全部启用。</p>'}${footer}<button class="provider-save-button" type="submit"${!choices.length ? " disabled" : ""}>启用 Provider</button></footer></form>`;
    }
    const embedded = getEmbeddedProviderProfile(state.providerEditorId);
    const protocol = template?.protocol || "openai-chat";
    const authType = template?.auth.type || "none";
    const editorTitle = existing ? `进阶配置 · ${existing.name}` : template ? `进阶启用 · ${template.name}` : "进阶添加 Provider";
    const editorHint = "手动控制标识、协议、认证、端点、模型和附加 Headers";
    return `<form class="provider-editor provider-advanced-editor" data-provider-form><header><div><strong>${escapeHtml(editorTitle)}</strong><small>${editorHint}</small></div><button type="button" data-action="cancel-provider-edit" aria-label="关闭 Provider 编辑器">${icons.close}</button></header><div class="provider-editor-grid"><label><span>标识</span><input name="provider-id" value="${escapeHtml(template?.id || "")}"${template ? " readonly" : ""} required maxlength="80" placeholder="例如 my-provider" pattern="[a-z0-9][a-z0-9._-]*"></label><label><span>名称</span><input name="provider-name" value="${escapeHtml(template?.name || "")}" required maxlength="120" placeholder="我的模型服务"></label><label><span>协议</span><select name="provider-protocol">${option("openai-chat", "OpenAI Chat Completions", protocol)}${option("openai-responses", "OpenAI Responses", protocol)}${option("anthropic", "Anthropic Messages", protocol)}${option("google", "Google Generative AI", protocol)}</select></label><label><span>认证</span><select name="provider-auth">${option("none", "无认证", authType)}${option("bearer", "Bearer Token", authType)}${option("header", "自定义 Header", authType)}</select></label><label class="provider-editor-wide"><span>Base URL</span><input name="provider-base-url" type="url" value="${escapeHtml(template?.baseUrl || "")}" required placeholder="https://example.com/v1"></label><label><span>认证 Header</span><input name="provider-auth-header" value="${escapeHtml(template?.auth.header || "")}" placeholder="x-api-key"></label><label><span>API Key</span><input name="provider-api-key" type="password" autocomplete="off" placeholder="${credential?.secret.apiKey ? "已配置；留空则保持不变" : "没有则留空"}"></label><label class="provider-editor-wide"><span>模型发现 URL</span><input name="provider-discovery-url" type="url" value="${escapeHtml(template?.discoveryUrl || "")}" placeholder="留空时根据 Base URL 推导"></label><label class="provider-editor-wide"><span>默认 / 手动模型 ID</span><input name="provider-default-model" value="${escapeHtml(template?.defaultModel || "")}" placeholder="例如 model-name"></label><label class="provider-editor-wide"><span>附加 Headers（JSON）</span><textarea name="provider-headers" rows="3" spellcheck="false" placeholder="{}">${escapeHtml(JSON.stringify(template?.headers || {}, null, 2))}</textarea></label></div><footer><button type="button" data-action="provider-simple-mode">返回简单模式</button><button type="button" data-action="cancel-provider-edit">取消</button><button class="provider-save-button" type="submit">${embedded && !existing ? "保存并启用" : "保存"}</button></footer></form>`;
  }

  function renderProviderModelEditor() {
    if (!state.providerModelEditorOpen) return "";
    const provider = state.config?.providers.find((item) => item.id === state.providerModelProviderId);
    if (!provider) return "";
    const templates = availableModelsDevModels(provider, state.modelsDevCatalog);
    const selectedPreset = templates.find((model) => model.id === state.providerModelPresetId);
    const query = state.providerModelQuery.trim().toLowerCase();
    const matches = templates.filter((model) => !query
      || model.id.toLowerCase().includes(query)
      || model.name.toLowerCase().includes(query)
      || model.description?.toLowerCase().includes(query));
    const visible = matches.slice(0, 100);
    const presetOptions = visible.map((model) => `<button type="button" class="provider-model-preset${model.id === selectedPreset?.id ? " selected" : ""}" data-action="select-provider-model-preset" data-model="${escapeHtml(model.id)}"><strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.id)}</small></button>`).join("");
    const catalogLabel = state.modelsDevFetchedAt ? "已下载的完整 models.dev 目录" : `内嵌的 ${embeddedModelsDevModelCount} 个 models.dev 精选模型`;
    const resultHint = matches.length > visible.length ? `找到 ${matches.length} 个，显示前 ${visible.length} 个` : `${matches.length} 个可添加模型`;
    return `<form class="provider-editor provider-model-editor" data-provider-model-form><header><div><strong>添加模型 · ${escapeHtml(provider.name)}</strong><small>选择 models.dev 模型作为模板，也可手动填写</small></div><button type="button" data-action="cancel-provider-model-edit" aria-label="关闭模型编辑器">${icons.close}</button></header><section class="provider-model-presets"><div><strong>目录模型</strong><small>${escapeHtml(catalogLabel)} · ${escapeHtml(resultHint)}</small></div><label class="settings-model-search provider-model-search">${icons.search}<input value="${escapeHtml(state.providerModelQuery)}" data-action="provider-model-search" placeholder="搜索模型 ID、名称或描述"></label><div>${presetOptions || '<p class="settings-empty">没有匹配且尚未添加的目录模型。</p>'}</div></section><div class="provider-editor-grid"><label><span>模型 ID</span><input name="provider-model-id" value="${escapeHtml(selectedPreset?.id || "")}"${selectedPreset ? " readonly" : ""} required maxlength="300" placeholder="例如 model-name"></label><label><span>显示名称</span><input name="provider-model-name" value="${escapeHtml(selectedPreset?.name || "")}" maxlength="300" placeholder="留空时使用模型 ID"></label></div><footer><button type="button" data-action="cancel-provider-model-edit">取消</button><button class="provider-save-button" type="submit">${selectedPreset ? "添加本地覆盖" : "添加模型"}</button></footer></form>`;
  }

  function modelsDevFetchedLabel() {
    if (!state.modelsDevFetchedAt) return "";
    const date = new Date(state.modelsDevFetchedAt);
    return Number.isNaN(date.getTime()) ? state.modelsDevFetchedAt : date.toLocaleString();
  }

  function renderModelsDevCatalogSettings() {
    const downloaded = Boolean(state.modelsDevFetchedAt);
    const summary = downloaded
      ? `完整目录 · ${state.modelsDevModelCount} 个模型 · ${modelsDevFetchedLabel()}`
      : `内嵌精选 · ${embeddedModelsDevModelCount} 个模型`;
    const updateLabel = state.modelsDevUpdating ? "正在更新…" : downloaded ? "更新完整目录" : "下载完整目录";
    const resetButton = downloaded ? '<button type="button" data-action="reset-models-dev">恢复内嵌目录</button>' : "";
    return `<details class="provider-preset-catalog models-dev-catalog"><summary><span><strong>Models.dev 模型目录</strong><small>${escapeHtml(summary)}</small></span><em>${state.modelsDevModelCount}</em></summary><div><p class="models-dev-catalog-copy">完整目录仅在点击后从 models.dev 下载，保存在当前浏览器。它不包含凭据，也不会在启动时自动联网。</p>${state.modelsDevError ? `<p class="local-key-error models-dev-catalog-error">${escapeHtml(state.modelsDevError)}</p>` : ""}<div class="models-dev-catalog-actions"><button type="button" data-action="update-models-dev"${state.modelsDevUpdating ? " disabled" : ""}>${updateLabel}</button>${resetButton}</div></div></details>`;
  }

  function renderProviderSettings() {
    const providers = state.config?.providers || [];
    const rows = providers.map((item) => {
      const configured = item.auth.type === "none" || state.localCredentials.some((credential) => credential.providerId === item.id);
      const modelSummary = item.models.length ? `${item.models.length} 个模型` : "尚无模型";
      const embeddedProvider = isEmbeddedProvider(item.id);
      return `<section class="local-key-entry" data-dom-key="provider:${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.name)}<em class="provider-kind">${embeddedProvider ? "内嵌配置" : "自定义"}</em></strong><small>${escapeHtml(providerProtocolLabel(item.protocol))} · ${escapeHtml(item.baseUrl)} · ${modelSummary}${configured ? "" : " · 缺少凭据"}</small>${item.modelDiscoveryError ? `<small class="local-key-error">${escapeHtml(item.modelDiscoveryError)}</small>` : ""}</span><div><button type="button" data-action="add-provider-model" data-provider="${escapeHtml(item.id)}">添加模型</button><button type="button" data-action="probe-provider" data-provider="${escapeHtml(item.id)}">刷新模型</button><button type="button" data-action="edit-provider" data-provider="${escapeHtml(item.id)}">编辑</button><button class="dangerous" type="button" data-action="delete-provider" data-provider="${escapeHtml(item.id)}">${embeddedProvider ? "禁用" : "删除"}</button></div></section>`;
    }).join("");
    return `<section class="model-provider-settings"><div class="settings-section-heading provider-settings-heading"><span><strong>已启用</strong><small>连接配置与凭据只保存在当前浏览器</small></span><button type="button" data-action="add-provider">${icons.plus}添加 Provider</button></div>${rows || '<p class="settings-empty">尚未启用 Provider。可从模型目录选择，或让 Turnfold 自动探测 URL。</p>'}${renderProviderEditor()}${renderProviderModelEditor()}${renderModelsDevCatalogSettings()}</section>`;
  }

  function renderGenerationSettings() {
    const settings = state.generationSettings;
    return `${dependencies.renderEffortControl("settings-effort")}<div class="settings-field-grid"><label class="settings-check"><input type="checkbox" data-setting="showReasoningSummary"${settings.showReasoningSummary ? " checked" : ""}><span><strong>显示思考摘要</strong><small>Provider 支持时返回可见的思考摘要</small></span></label><label>Temperature<input type="number" min="0" max="2" step="0.1" placeholder="自动" data-setting="temperature" value="${settings.temperature ?? ""}"></label><label>最大输出 Tokens<input type="number" min="1" max="1000000" step="1" placeholder="自动" data-setting="maxOutputTokens" value="${settings.maxOutputTokens ?? ""}"></label></div><button class="settings-reset-button" type="button" data-action="reset-settings">恢复默认生成参数</button>`;
  }

  function renderSettingsPage() {
    if (!state.settingsOpen || !state.config) return "";
    const query = state.modelQuery.trim().toLowerCase();
    const choices = dependencies.availableModelChoices();
    const matches = choices.filter((choice) => !query || choice.key.toLowerCase().includes(query) || choice.model.name.toLowerCase().includes(query) || choice.provider.name.toLowerCase().includes(query));
    const groups = state.config.providers.map((item) => {
      const items = matches.filter((choice) => choice.provider.id === item.id);
      return items.length ? `<section class="settings-model-group" data-dom-key="model-group:${escapeHtml(item.id)}"><h3>${escapeHtml(item.name)}</h3><div>${items.map(dependencies.renderModelOption).join("")}</div></section>` : "";
    }).join("");
    const providerSettings = renderProviderSettings();
    return `<section class="settings-page" role="dialog" aria-modal="true" aria-label="设置"><header class="settings-page-header"><button type="button" data-action="close-settings" aria-label="关闭设置">${icons.close}</button><span><strong>设置</strong><small>Provider 与凭据保存在当前浏览器</small></span></header><div class="settings-layout"><nav class="settings-nav" aria-label="设置分类"><button type="button" data-action="scroll-settings-section" data-id="settings-models">模型</button><button type="button" data-action="scroll-settings-section" data-id="settings-generation">生成</button><button type="button" data-action="scroll-settings-section" data-id="settings-providers">Provider</button><button type="button" data-action="scroll-settings-section" data-id="settings-interface">界面</button></nav><main class="settings-content"><section class="settings-card" id="settings-models"><header><h2>模型</h2><p>选择当前会话使用的模型。</p></header><label class="settings-model-search">${icons.search}<input value="${escapeHtml(state.modelQuery)}" data-action="model-search" placeholder="搜索 Provider 或模型"></label><div class="settings-model-groups">${groups || '<p class="settings-empty">没有可用模型；请启用内嵌 Provider 或添加自定义 Provider。</p>'}</div></section><section class="settings-card" id="settings-generation"><header><h2>生成</h2><p>这些参数随当前会话保存。</p></header>${renderGenerationSettings()}</section><section class="settings-card" id="settings-providers"><header><h2>Provider</h2><p>所有模型请求都由当前浏览器直接发送。</p></header>${providerSettings}</section><section class="settings-card" id="settings-interface"><header><h2>界面</h2><p>这些选项仅保存在当前浏览器。</p></header><div class="settings-interface-options"><label class="settings-check"><input type="checkbox" data-action="advanced-actions"${state.advancedActions ? " checked" : ""}><span><strong>显示高级对话操作</strong><small>显示“需要回答”和编辑助手回答</small></span></label><label class="settings-check"><input type="checkbox" data-action="history-tree-setting"${state.historyTree ? " checked" : ""}><span><strong>树状显示聊天历史</strong><small>按会话名称中的路径组织侧栏</small></span></label></div></section></main></div></section>`;
  }

  return {renderProviderSettings, renderSettingsPage};
}
