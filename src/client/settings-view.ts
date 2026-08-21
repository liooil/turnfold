import type {AppState} from "./app-state";
import {icons} from "./icons";
import {option, providerProtocolLabel, type ModelChoice} from "./model-selection";
import {getEmbeddedProviderProfile, isEmbeddedProvider, selectableCatalogProviderProfiles} from "./providers/embedded-providers";
import type {LocalCredential} from "./providers/local-providers";
import {agentProfileMatches} from "./providers/provider-agent-controller";
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
      const close = `<button type="button" data-action="cancel-provider-edit" aria-label="关闭 Provider 编辑器" title="关闭 Provider 编辑器">${icons.close}</button>`;
      const advanced = '<button type="button" data-action="provider-advanced-mode" title="打开进阶配置">进阶配置</button>';
      if (existing) {
        const credentialField = existing.auth.type === "none"
          ? '<p class="provider-setup-note">此 Provider 不需要凭据。</p>'
          : `<label class="provider-setup-field"><span>API Key</span><input name="provider-api-key" type="password" autocomplete="off" placeholder="${credential?.secret.apiKey ? "已配置；留空则保持不变" : "输入 API Key"}"></label>`;
        return `<form class="provider-editor provider-simple-editor" data-provider-credential-form><header><div><strong>${escapeHtml(existing.name)}</strong><small>更新浏览器凭据，或进入进阶配置修改连接细节</small></div>${close}</header><div class="provider-setup-summary"><span><strong>${escapeHtml(providerProtocolLabel(existing.protocol))}</strong><small>${escapeHtml(existing.baseUrl)}</small></span><em>${existing.models.length} 个模型</em></div>${credentialField}<footer>${advanced}<button class="provider-save-button" type="submit" title="保存到浏览器凭据库">保存到浏览器</button></footer></form>`;
      }
      const enabledIds = new Set(state.config?.providers.map((item) => item.id) || []);
      const choices = catalogProfiles.filter((item) => !enabledIds.has(item.id));
      const selectedId = choices.some((item) => item.id === state.providerEditorId) ? state.providerEditorId : choices[0]?.id || "";
      const kindTabs = `<div class="provider-setup-kinds" role="tablist" aria-label="添加 Provider 的方式"><button type="button" role="tab" aria-selected="${state.providerSetupKind === "catalog"}" class="${state.providerSetupKind === "catalog" ? "selected" : ""}" data-action="provider-setup-kind" data-kind="catalog" title="从 models.dev 模型目录启用 Provider"><strong>从模型目录启用</strong><small>选择 Provider 并设置凭据</small></button><button type="button" role="tab" aria-selected="${state.providerSetupKind === "detect"}" class="${state.providerSetupKind === "detect" ? "selected" : ""}" data-action="provider-setup-kind" data-kind="detect" title="自动探测 Provider URL"><strong>自动探测 URL</strong><small>只需要 URL 和 Key</small></button></div>`;
      const error = state.providerSetupError ? `<p class="local-key-error provider-setup-error">${escapeHtml(state.providerSetupError)}</p>` : "";
      const footer = `<footer>${advanced}<button type="button" data-action="cancel-provider-edit" title="取消添加 Provider">取消</button>`;
      const detected = state.providerSetupDetected;
      const detectedSummary = detected
        ? `<section class="provider-setup-summary provider-detected-summary"><span><strong>${escapeHtml(detected.name)}<em class="provider-kind">待添加</em></strong><small>${escapeHtml(providerProtocolLabel(detected.protocol))} · ${escapeHtml(detected.baseUrl)} · ${detected.auth.type === "none" ? "无认证" : detected.auth.type === "bearer" ? "Bearer" : escapeHtml(detected.auth.header || "")} · ${detected.models.length} 个模型${detected.defaultModel ? ` · 默认 ${escapeHtml(detected.defaultModel)}` : ""}</small></span><em>确认后添加</em></section>`
        : "";
      if (state.providerSetupKind === "detect") {
        const probeLabel = state.providerSetupBusy ? "正在探测…" : detected ? "重新探测" : "探测";
        const addDisabled = state.providerSetupBusy || !detected ? " disabled" : "";
        return `<form class="provider-editor provider-simple-editor" data-provider-detect-form><header><div><strong>自动探测 Provider</strong><small>先探测模型目录与协议，确认结果后再添加</small></div>${close}</header>${kindTabs}<div class="provider-setup-fields"><label class="provider-setup-field"><span>Provider URL</span><input name="provider-url" type="url" required value="${escapeHtml(state.providerSetupUrl)}" data-action="provider-setup-url" placeholder="https://api.example.com/v1"></label><label class="provider-setup-field"><span>API Key</span><input name="provider-api-key" type="password" autocomplete="off" value="${escapeHtml(state.providerSetupKey)}" data-action="provider-setup-key" placeholder="本地无认证端点可留空"></label></div>${error}${detectedSummary}<p class="provider-setup-note">探测请求由当前浏览器直接发送。目标服务需要允许跨域访问；局域网地址可能触发浏览器的本地网络权限提示。</p>${footer}<button class="provider-save-button" type="submit" title="${probeLabel} Provider"${state.providerSetupBusy ? " disabled" : ""}>${probeLabel}</button><button class="provider-save-button" type="button" data-action="add-detected-provider" title="添加探测到的 Provider"${addDisabled}>添加 Provider</button></footer></form>`;
      }
      const choicesHtml = choices.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === selectedId ? " selected" : ""}>${getEmbeddedProviderProfile(item.id) ? "内嵌" : "目录"} · ${escapeHtml(item.name)} · ${item.models.length} 个模型</option>`).join("");
      return `<form class="provider-editor provider-simple-editor" data-provider-catalog-form><header><div><strong>从模型目录添加 Provider</strong><small>内嵌 Provider 优先显示；下载完整目录后可选择更多服务</small></div>${close}</header>${kindTabs}<div class="provider-setup-fields"><label class="provider-setup-field"><span>Provider</span><select name="provider-catalog-id" required>${choicesHtml}</select></label><label class="provider-setup-field"><span>API Key</span><input name="provider-api-key" type="password" autocomplete="off" value="${escapeHtml(state.providerSetupKey)}" data-action="provider-setup-key" placeholder="无认证服务可留空"></label></div>${error}${choices.length ? "" : '<p class="settings-empty">当前目录中的 Provider 已全部启用。</p>'}${footer}<button class="provider-save-button" type="submit" title="启用所选 Provider"${!choices.length ? " disabled" : ""}>启用 Provider</button></footer></form>`;
    }
    const embedded = getEmbeddedProviderProfile(state.providerEditorId);
    const protocol = template?.protocol || "openai-chat";
    const authType = template?.auth.type || "none";
    const editorTitle = existing ? `进阶配置 · ${existing.name}` : template ? `进阶启用 · ${template.name}` : "进阶添加 Provider";
    const editorHint = "手动控制标识、协议、认证、端点、模型和附加 Headers";
    return `<form class="provider-editor provider-advanced-editor" data-provider-form><header><div><strong>${escapeHtml(editorTitle)}</strong><small>${editorHint}</small></div><button type="button" data-action="cancel-provider-edit" aria-label="关闭 Provider 编辑器" title="关闭 Provider 编辑器">${icons.close}</button></header><div class="provider-editor-grid"><label><span>标识</span><input name="provider-id" value="${escapeHtml(template?.id || "")}"${template ? " readonly" : ""} required maxlength="80" placeholder="例如 my-provider" pattern="[a-z0-9][a-z0-9._-]*"></label><label><span>名称</span><input name="provider-name" value="${escapeHtml(template?.name || "")}" required maxlength="120" placeholder="我的模型服务"></label><label><span>协议</span><select name="provider-protocol">${option("openai-chat", "OpenAI Chat Completions", protocol)}${option("openai-responses", "OpenAI Responses", protocol)}${option("anthropic", "Anthropic Messages", protocol)}${option("google", "Google Generative AI", protocol)}</select></label><label><span>认证</span><select name="provider-auth">${option("none", "无认证", authType)}${option("bearer", "Bearer Token", authType)}${option("header", "自定义 Header", authType)}</select></label><label class="provider-editor-wide"><span>Base URL</span><input name="provider-base-url" type="url" value="${escapeHtml(template?.baseUrl || "")}" required placeholder="https://example.com/v1"></label><label><span>认证 Header</span><input name="provider-auth-header" value="${escapeHtml(template?.auth.header || "")}" placeholder="x-api-key"></label><label><span>API Key</span><input name="provider-api-key" type="password" autocomplete="off" placeholder="${credential?.secret.apiKey ? "已配置；留空则保持不变" : "没有则留空"}"></label><label class="provider-editor-wide"><span>模型发现 URL</span><input name="provider-discovery-url" type="url" value="${escapeHtml(template?.discoveryUrl || "")}" placeholder="留空时根据 Base URL 推导"></label><label class="provider-editor-wide"><span>默认 / 手动模型 ID</span><input name="provider-default-model" value="${escapeHtml(template?.defaultModel || "")}" placeholder="例如 model-name"></label><label class="provider-editor-wide"><span>附加 Headers（JSON）</span><textarea name="provider-headers" rows="3" spellcheck="false" placeholder="{}">${escapeHtml(JSON.stringify(template?.headers || {}, null, 2))}</textarea></label></div><footer><button type="button" data-action="provider-simple-mode" title="返回简单模式">返回简单模式</button><button type="button" data-action="cancel-provider-edit" title="取消编辑 Provider">取消</button><button class="provider-save-button" type="submit" title="${embedded && !existing ? "保存并启用 Provider" : "保存 Provider 配置"}">${embedded && !existing ? "保存并启用" : "保存"}</button></footer></form>`;
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
    const presetOptions = visible.map((model) => `<button type="button" class="provider-model-preset${model.id === selectedPreset?.id ? " selected" : ""}" data-action="select-provider-model-preset" data-model="${escapeHtml(model.id)}" title="选择模型模板：${escapeHtml(model.name)}"><strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.id)}</small></button>`).join("");
    const catalogLabel = state.modelsDevFetchedAt ? "已下载的完整 models.dev 目录" : `内嵌的 ${embeddedModelsDevModelCount} 个 models.dev 精选模型`;
    const resultHint = matches.length > visible.length ? `找到 ${matches.length} 个，显示前 ${visible.length} 个` : `${matches.length} 个可添加模型`;
    return `<form class="provider-editor provider-model-editor" data-provider-model-form><header><div><strong>添加模型 · ${escapeHtml(provider.name)}</strong><small>选择 models.dev 模型作为模板，也可手动填写</small></div><button type="button" data-action="cancel-provider-model-edit" aria-label="关闭模型编辑器" title="关闭模型编辑器">${icons.close}</button></header><section class="provider-model-presets"><div><strong>目录模型</strong><small>${escapeHtml(catalogLabel)} · ${escapeHtml(resultHint)}</small></div><label class="settings-model-search provider-model-search">${icons.search}<input value="${escapeHtml(state.providerModelQuery)}" data-action="provider-model-search" placeholder="搜索模型 ID、名称或描述"></label><div>${presetOptions || '<p class="settings-empty">没有匹配且尚未添加的目录模型。</p>'}</div></section><div class="provider-editor-grid"><label><span>模型 ID</span><input name="provider-model-id" value="${escapeHtml(selectedPreset?.id || "")}"${selectedPreset ? " readonly" : ""} required maxlength="300" placeholder="例如 model-name"></label><label><span>显示名称</span><input name="provider-model-name" value="${escapeHtml(selectedPreset?.name || "")}" maxlength="300" placeholder="留空时使用模型 ID"></label></div><footer><button type="button" data-action="cancel-provider-model-edit" title="取消添加模型">取消</button><button class="provider-save-button" type="submit" title="${selectedPreset ? "添加此模型的本地覆盖" : "添加模型"}">${selectedPreset ? "添加本地覆盖" : "添加模型"}</button></footer></form>`;
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
    const resetButton = downloaded ? '<button type="button" data-action="reset-models-dev" title="恢复内嵌模型目录">恢复内嵌目录</button>' : "";
    return `<details class="provider-preset-catalog models-dev-catalog"><summary><span><strong>Models.dev 模型目录</strong><small>${escapeHtml(summary)}</small></span><em>${state.modelsDevModelCount}</em></summary><div><p class="models-dev-catalog-copy">完整目录仅在点击后从 models.dev 下载，保存在当前浏览器。它不包含凭据，也不会在启动时自动联网。</p>${state.modelsDevError ? `<p class="local-key-error models-dev-catalog-error">${escapeHtml(state.modelsDevError)}</p>` : ""}<div class="models-dev-catalog-actions"><button type="button" data-action="update-models-dev" title="${downloaded ? "更新" : "下载"} models.dev 完整目录"${state.modelsDevUpdating ? " disabled" : ""}>${updateLabel}</button>${resetButton}</div></div></details>`;
  }

  function renderProviderSettings() {
    const providers = state.config?.providers || [];
    const rows = providers.map((item) => {
      const agentMode = state.providerAgentModeIds.has(item.id);
      const agentProfile = state.providerAgentProfiles.find((profile) => profile.id === item.id);
      const agentProfileCurrent = agentProfileMatches(item, agentProfile);
      const agentCredential = state.providerAgentCredentials.find((credential) => credential.providerId === item.id && credential.name === "default");
      const browserCredential = state.localCredentials.find((credential) => credential.providerId === item.id);
      const configured = item.auth.type === "none" || (agentMode ? Boolean(agentCredential) : Boolean(browserCredential));
      const modelSummary = item.models.length ? `${item.models.length} 个模型` : "尚无模型";
      const embeddedProvider = isEmbeddedProvider(item.id);
      const register = state.providerAgentActiveUrl && !agentProfileCurrent
        ? `<button type="button" data-action="register-agent-provider" data-provider="${escapeHtml(item.id)}" title="将当前 Provider profile 登记到 Agent">${agentProfile ? "更新 Agent 配置" : "登记到 Agent"}</button>`
        : "";
      const migrate = state.providerAgentActiveUrl && item.auth.type !== "none" && browserCredential && !agentCredential
        ? `<button type="button" data-action="migrate-agent-credential" data-provider="${escapeHtml(item.id)}" title="明确迁移浏览器凭据到 Agent Vault">迁移凭据</button>`
        : "";
      const removeAgentProfile = state.providerAgentActiveUrl && agentProfile && !agentCredential
        ? `<button class="dangerous" type="button" data-action="delete-agent-provider" data-provider="${escapeHtml(item.id)}" title="仅从 Agent 删除 execution profile">移除 Agent 配置</button>`
        : "";
      const mode = state.providerAgentActiveUrl
        ? `<div class="provider-execution-mode" role="group" aria-label="${escapeHtml(item.name)} 执行位置"><button type="button" class="${agentMode ? "" : "selected"}" data-action="use-browser-provider" data-provider="${escapeHtml(item.id)}" title="由当前浏览器直接请求 Provider">浏览器</button><button type="button" class="${agentMode ? "selected" : ""}" data-action="use-provider-agent" data-provider="${escapeHtml(item.id)}" title="由已连接的本地 Agent 请求 Provider">Agent</button></div>`
        : "";
      return `<section class="local-key-entry" data-dom-key="provider:${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.name)}<em class="provider-kind">${embeddedProvider ? "内嵌配置" : "自定义"}</em><em class="provider-kind">${agentMode ? "Agent 执行" : "浏览器直连"}</em></strong><small>${escapeHtml(providerProtocolLabel(item.protocol))} · ${escapeHtml(item.baseUrl)} · ${modelSummary}${configured ? "" : " · 缺少凭据"}${agentMode && !agentProfileCurrent ? " · Agent 配置已过期" : ""}</small>${item.modelDiscoveryError ? `<small class="local-key-error">${escapeHtml(item.modelDiscoveryError)}</small>` : ""}</span><div>${mode}${register}${migrate}${removeAgentProfile}<button type="button" data-action="add-provider-model" data-provider="${escapeHtml(item.id)}" title="为 ${escapeHtml(item.name)} 添加模型">添加模型</button><button type="button" data-action="probe-provider" data-provider="${escapeHtml(item.id)}" title="刷新 ${escapeHtml(item.name)} 的模型列表">刷新模型</button><button type="button" data-action="edit-provider" data-provider="${escapeHtml(item.id)}" title="编辑 ${escapeHtml(item.name)}">编辑</button><button class="dangerous" type="button" data-action="delete-provider" data-provider="${escapeHtml(item.id)}" title="${embeddedProvider ? "禁用" : "删除"} ${escapeHtml(item.name)}">${embeddedProvider ? "禁用" : "删除"}</button></div></section>`;
    }).join("");
    return `<section class="model-provider-settings"><div class="settings-section-heading provider-settings-heading"><span><strong>已启用</strong><small>每个 Provider 独立选择浏览器直连或 Agent 执行</small></span><button type="button" data-action="add-provider" title="添加 Provider">${icons.plus}添加 Provider</button></div>${rows || '<p class="settings-empty">尚未启用 Provider。可从模型目录选择，或让 Turnfold 自动探测 URL。</p>'}${renderProviderEditor()}${renderProviderModelEditor()}${renderModelsDevCatalogSettings()}</section>`;
  }

  function renderProviderAgentSettings() {
    const connected = Boolean(state.providerAgentActiveUrl && state.providerAgentGrantToken);
    const busy = state.providerAgentConnecting || state.providerAgentPairing || state.providerAgentSaving;
    const status = state.providerAgentPairing ? "等待授权确认" : state.providerAgentConnecting ? "正在连接" : connected ? "已连接" : "未连接";
    const statusClass = busy ? "fetching" : connected ? "connected" : "local";
    const statusDetail = connected ? state.providerAgentActiveUrl : state.providerAgentSavedGrant ? "已保存此 Agent 的浏览器授权" : "未授权访问本地服务";
    const pair = state.providerAgentPairingRequired && !state.providerAgentPairing
      ? '<button type="button" data-action="pair-provider-agent" title="审批 Provider 执行与 Vault 管理权限">开始授权</button>'
      : "";
    const revoke = state.providerAgentSavedGrant
      ? '<button type="button" data-action="revoke-provider-agent" title="撤销此浏览器的 Provider Agent 授权">撤销授权</button>'
      : "";
    const disconnect = connected ? '<button type="button" data-action="disconnect-provider-agent" title="断开 Provider Agent">断开</button>' : "";
    const approval = state.providerAgentPairing && state.providerAgentApprovalUrl
      ? `<a class="backend-approval-link" href="${escapeHtml(state.providerAgentApprovalUrl)}" target="_blank" rel="noopener">打开 Agent 确认页</a>`
      : "";
    const connection = `<form class="backend-connection provider-agent-connection" data-provider-agent-connection-form><div class="backend-connection-status ${statusClass}"><span><i aria-hidden="true"></i><strong>${escapeHtml(status)}</strong></span><small>${escapeHtml(statusDetail)}</small></div><label class="backend-url-field"><span>Agent URL</span><input name="provider-agent-url" type="url" required value="${escapeHtml(state.providerAgentUrl)}" data-action="provider-agent-url" autocomplete="url" spellcheck="false" placeholder="http://127.0.0.1:3000"${busy ? " disabled" : ""}></label>${approval}${state.providerAgentError ? `<p class="backend-connection-error">${escapeHtml(state.providerAgentError)}</p>` : ""}<div class="backend-connection-actions">${disconnect}${revoke}${pair}<button class="backend-connect-button" type="submit" title="显式连接指定 Provider Agent"${busy ? " disabled" : ""}>${state.providerAgentConnecting ? "连接中…" : "连接"}</button></div></form>`;
    if (!connected) return connection;
    const providers = state.config?.providers || [];
    const options = providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`).join("");
    const credentialForm = providers.length
      ? `<form class="provider-agent-credential" data-provider-agent-credential-form><label><span>Provider</span><select name="provider-agent-provider">${options}</select></label><label><span>新凭据</span><input name="provider-agent-api-key" type="password" autocomplete="off" placeholder="直接写入 Agent Vault"></label><button type="submit" title="登记 Provider profile 并保存凭据"${state.providerAgentSaving ? " disabled" : ""}>保存到 Agent</button></form>`
      : "";
    const credentials = state.providerAgentCredentials.map((credential) => {
      const provider = providers.find((item) => item.id === credential.providerId);
      return `<section class="local-key-entry agent-credential-entry" data-dom-key="agent-credential:${escapeHtml(credential.id)}"><span><strong>${escapeHtml(provider?.name || credential.providerId)}</strong><small>${escapeHtml(credential.name)} · fingerprint ${escapeHtml(credential.fingerprint)}${credential.lastUsedAt ? ` · 已使用` : ""}</small></span><div><button class="dangerous" type="button" data-action="delete-agent-credential" data-credential="${escapeHtml(credential.id)}" title="从 Agent Vault 删除凭据">删除</button></div></section>`;
    }).join("");
    return `${connection}<div class="provider-agent-vault"><div class="settings-section-heading"><span><strong>Agent Vault</strong><small>metadata 可见；明文凭据不会返回浏览器</small></span></div>${credentialForm}${credentials || '<p class="settings-empty">Agent Vault 中尚无凭据。</p>'}</div>`;
  }

  function renderGenerationSettings() {
    const settings = state.generationSettings;
    return `${dependencies.renderEffortControl("settings-effort")}<div class="settings-field-grid"><label class="settings-check"><input type="checkbox" data-setting="showReasoningSummary"${settings.showReasoningSummary ? " checked" : ""}><span><strong>显示思考摘要</strong><small>Provider 支持时返回可见的思考摘要</small></span></label><label>Temperature<input type="number" min="0" max="2" step="0.1" placeholder="自动" data-setting="temperature" value="${settings.temperature ?? ""}"></label><label>最大输出 Tokens<input type="number" min="1" max="1000000" step="1" placeholder="自动" data-setting="maxOutputTokens" value="${settings.maxOutputTokens ?? ""}"></label></div><button class="settings-reset-button" type="button" data-action="reset-settings" title="恢复默认生成参数">恢复默认生成参数</button>`;
  }

  function renderBackendSettings() {
    const activeUrl = state.backendActiveUrl;
    const connected = state.authenticated && state.backendActiveTransport === "native" && Boolean(activeUrl);
    const status = state.backendPairing
      ? "等待配对确认"
      : state.backendConnecting
      ? "正在连接"
      : connected ? state.syncing ? "正在同步" : state.syncError ? "已连接，等待同步" : "已连接" : "未连接";
    const statusClass = state.backendConnecting || state.backendPairing || state.syncing ? "fetching" : connected ? state.syncError ? "error" : "connected" : "local";
    const active = connected
      ? `<div class="backend-connection-status ${statusClass}"><span><i aria-hidden="true"></i><strong>${escapeHtml(status)}</strong></span><small>${escapeHtml(activeUrl)}</small></div>`
      : `<div class="backend-connection-status ${statusClass}"><span><i aria-hidden="true"></i><strong>${escapeHtml(status)}</strong></span><small>${state.backendSavedGrant ? "已保存此 Backend 的浏览器配对" : "当前浏览器仓库"}</small></div>`;
    const error = state.backendError || (connected ? state.syncError : "");
    const disconnect = connected ? '<button type="button" data-action="disconnect-backend" title="断开 Backend">断开</button>' : "";
    const synchronize = connected ? '<button type="button" data-action="sync-backend" title="立即同步 Backend">立即同步</button>' : "";
    const pair = state.backendPairingRequired && !state.backendPairing
      ? '<button type="button" data-action="pair-backend" title="在 Backend 上确认浏览器配对">开始配对</button>'
      : "";
    const revoke = state.backendSavedGrant
      ? '<button type="button" data-action="revoke-backend-pairing" title="撤销此浏览器的 Backend 授权">撤销配对</button>'
      : "";
    const approval = state.backendPairing && state.backendApprovalUrl
      ? `<a class="backend-approval-link" href="${escapeHtml(state.backendApprovalUrl)}" target="_blank" rel="noopener">打开 Backend 确认页</a>`
      : "";
    const busy = state.backendConnecting || state.backendPairing;
    const connectLabel = state.backendConnecting ? "连接中…" : state.backendPairing ? "等待确认…" : connected && state.backendUrl === activeUrl ? "重新连接" : "连接";
    return `<form class="backend-connection" data-backend-connection-form>${active}<label class="backend-url-field"><span>Backend URL</span><input name="backend-url" type="url" required value="${escapeHtml(state.backendUrl)}" data-action="backend-url" autocomplete="url" spellcheck="false" placeholder="http://127.0.0.1:3000"${busy ? " disabled" : ""}></label>${approval}${error ? `<p class="backend-connection-error">${escapeHtml(error)}</p>` : ""}<div class="backend-connection-actions">${disconnect}${synchronize}${revoke}${pair}<button class="backend-connect-button" type="submit" title="连接指定 Backend"${busy ? " disabled" : ""}>${connectLabel}</button></div></form>`;
  }

  function renderWebDavSettings() {
    const connected = state.authenticated && state.backendActiveTransport === "webdav" && Boolean(state.webdavActiveRootUrl);
    const busy = state.webdavConnecting || state.webdavPairing || state.syncing && connected;
    const status = state.webdavPairing
      ? "等待授权确认"
      : state.webdavConnecting
      ? "正在连接"
      : connected ? state.syncing ? "正在同步" : state.syncError ? "已连接，等待同步" : "已连接" : "未连接";
    const statusClass = busy ? "fetching" : connected ? state.syncError ? "error" : "connected" : "local";
    const detail = connected
      ? state.webdavActiveRootUrl
      : state.webdavMode === "turnfold" && state.webdavSavedGrant ? "已保存此服务的 WebDAV 授权" : "当前浏览器仓库";
    const urlLabel = state.webdavMode === "turnfold" ? "Turnfold Service URL" : "WebDAV Root URL";
    const credentials = state.webdavMode === "basic"
      ? `<div class="webdav-credential-fields"><label class="backend-url-field"><span>用户名</span><input type="text" value="${escapeHtml(state.webdavUsername)}" data-action="webdav-username" autocomplete="username" required${busy ? " disabled" : ""}></label><label class="backend-url-field"><span>密码</span><input type="password" value="${escapeHtml(state.webdavPassword)}" data-action="webdav-password" autocomplete="current-password" required${busy ? " disabled" : ""}></label></div>`
      : "";
    const pair = state.webdavMode === "turnfold" && state.webdavPairingRequired && !state.webdavPairing
      ? '<button type="button" data-action="pair-webdav" title="审批独立的 Repository WebDAV 权限">开始授权</button>'
      : "";
    const revoke = state.webdavMode === "turnfold" && state.webdavSavedGrant
      ? '<button type="button" data-action="revoke-webdav" title="撤销此浏览器的 WebDAV 授权">撤销授权</button>'
      : "";
    const approval = state.webdavPairing && state.webdavApprovalUrl
      ? `<a class="backend-approval-link" href="${escapeHtml(state.webdavApprovalUrl)}" target="_blank" rel="noopener">打开 WebDAV 确认页</a>`
      : "";
    const disconnect = connected ? '<button type="button" data-action="disconnect-webdav" title="断开 WebDAV">断开</button>' : "";
    const synchronize = connected ? '<button type="button" data-action="sync-webdav" title="立即同步 WebDAV">立即同步</button>' : "";
    const error = state.webdavError || (connected ? state.syncError : "");
    return `<form class="backend-connection webdav-connection" data-webdav-connection-form><div class="backend-connection-status ${statusClass}"><span><i aria-hidden="true"></i><strong>${escapeHtml(status)}</strong></span><small>${escapeHtml(detail)}</small></div><label class="backend-url-field"><span>连接类型</span><select data-action="webdav-mode"${busy ? " disabled" : ""}><option value="turnfold"${state.webdavMode === "turnfold" ? " selected" : ""}>Turnfold 授权</option><option value="basic"${state.webdavMode === "basic" ? " selected" : ""}>标准 WebDAV · Basic</option><option value="none"${state.webdavMode === "none" ? " selected" : ""}>标准 WebDAV · 无认证</option></select></label><label class="backend-url-field"><span>${urlLabel}</span><input type="url" required value="${escapeHtml(state.webdavUrl)}" data-action="webdav-url" autocomplete="url" spellcheck="false" placeholder="http://127.0.0.1:3000"${busy ? " disabled" : ""}></label>${credentials}${approval}${error ? `<p class="backend-connection-error">${escapeHtml(error)}</p>` : ""}<div class="backend-connection-actions">${disconnect}${synchronize}${revoke}${pair}<button class="backend-connect-button" type="submit" title="显式连接 WebDAV"${busy ? " disabled" : ""}>${state.webdavConnecting ? "连接中…" : state.webdavPairing ? "等待确认…" : "连接"}</button></div></form>`;
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
    const navigation = `<nav class="settings-nav" aria-label="设置分类"><button type="button" data-action="scroll-settings-section" data-id="settings-models" title="滚动到模型设置">模型</button><button type="button" data-action="scroll-settings-section" data-id="settings-generation" title="滚动到生成设置">生成</button><button type="button" data-action="scroll-settings-section" data-id="settings-providers" title="滚动到 Provider 设置">Provider</button><button type="button" data-action="scroll-settings-section" data-id="settings-backend" title="滚动到 Backend 设置">Backend</button><button type="button" data-action="scroll-settings-section" data-id="settings-webdav" title="滚动到 WebDAV 设置">WebDAV</button><button type="button" data-action="scroll-settings-section" data-id="settings-interface" title="滚动到界面设置">界面</button></nav>`;
    const modelSettings = `<section class="settings-card" id="settings-models"><header><h2>模型</h2><p>选择当前会话使用的模型。</p></header><label class="settings-model-search">${icons.search}<input value="${escapeHtml(state.modelQuery)}" data-action="model-search" placeholder="搜索 Provider 或模型"></label><div class="settings-model-groups">${groups || '<p class="settings-empty">没有可用模型；请启用内嵌 Provider 或添加自定义 Provider。</p>'}</div></section>`;
    const generationSettings = `<section class="settings-card" id="settings-generation"><header><h2>生成</h2><p>这些参数随当前会话保存。</p></header>${renderGenerationSettings()}</section>`;
    const providers = `<section class="settings-card" id="settings-providers"><header><h2>Provider</h2><p>默认由浏览器直连；可为单个 Provider 显式启用本地 Agent。</p></header>${providerSettings}<div class="provider-agent-settings"><div class="settings-section-heading"><span><strong>本地 Provider Agent</strong><small>连接和授权独立于 Backend 仓库同步</small></span></div>${renderProviderAgentSettings()}</div></section>`;
    const backend = `<section class="settings-card" id="settings-backend"><header><h2>Backend</h2><p>浏览器仓库始终独立可用；一次只连接一个远端 repository。</p></header>${renderBackendSettings()}</section>`;
    const webdav = `<section class="settings-card" id="settings-webdav"><header><h2>WebDAV</h2><p>Refs 使用 ETag 并发控制；工作项按当前设备备份。</p></header>${renderWebDavSettings()}</section>`;
    const interfaceSettings = `<section class="settings-card" id="settings-interface"><header><h2>界面</h2><p>这些选项仅保存在当前浏览器。</p></header><div class="settings-interface-options"><label class="settings-check"><input type="checkbox" data-action="advanced-actions"${state.advancedActions ? " checked" : ""}><span><strong>显示高级对话操作</strong><small>显示“需要回答”和编辑助手回答</small></span></label><label class="settings-check"><input type="checkbox" data-action="history-tree-setting"${state.historyTree ? " checked" : ""}><span><strong>树状显示聊天历史</strong><small>按会话名称中的路径组织侧栏</small></span></label></div></section>`;
    return `<section class="settings-page" role="dialog" aria-modal="true" aria-label="设置"><header class="settings-page-header"><button type="button" data-action="close-settings" aria-label="关闭设置" title="关闭设置">${icons.close}</button><span><strong>设置</strong><small>工作区、Provider 与凭据默认保存在当前浏览器</small></span></header><div class="settings-layout">${navigation}<main class="settings-content">${modelSettings}${generationSettings}${providers}${backend}${webdav}${interfaceSettings}</main></div></section>`;
  }

  return {renderProviderSettings, renderSettingsPage};
}
