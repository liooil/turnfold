import {
  commitConversationMessage,
  createConversationHistory,
  deleteConversationHistory,
  getConversationHistory,
  listConversationHistory,
  moveConversationHead,
  synchronizeConversationRepository,
  updateConversationHistory
} from "./conversation-client";
import {conversationIdFromHash} from "../shared/conversation-hash";
import {conversationTitlePrompt, normalizeGeneratedConversationTitle, untitledConversationLabel} from "../shared/conversation-title";
import type {Conversation, MessageCompletion, ResponseMetadata, StoredChatMessage, WorkingItem} from "../shared/conversation-types";
import {defaultGenerationSettings, type GenerationSettings} from "../shared/generation-settings";
import {
  activateOfflineProfile,
  cachedLastFetchAt,
  cacheChatConfig,
  listCachedMessages,
  loadCachedChatConfig,
  mergeOfflineProfiles
} from "./storage/offline-history";
import {
  listLocalCredentials,
  listLocalProviderProfiles,
  migrateLegacyProviderProfile,
  saveLocalProviderProfile
} from "./providers/local-providers";
import type {ChatProfile} from "../shared/profile-types";
import {discoverProviderModels, streamProvider} from "./providers/provider-runtime";
import {embeddedModelsDevCatalog, embeddedModelsDevModelCount, modelsDevModelCount} from "./providers/models-dev-catalog";
import {loadStoredModelsDevCatalog} from "./providers/models-dev-storage";
import {responseMetadata} from "../shared/response-metadata";
import {createMessageObject} from "../shared/message-object";
import {rootEditAlternativesInGraph} from "../shared/message-graph";
import {shouldOpenFullscreenEditor} from "./fullscreen-editor";
import {createInitialAppState, type CachedChatBootstrap, type ChatProvider, type HashNavigationMode, type ServerChatConfig} from "./app-state";
import {appUrl, basePath, homeUrl} from "./environment";
import {icons} from "./icons";
import {migrateLegacyPreferences} from "./preferences";
import {createConversationSelectors, messagePartText} from "./conversation-selectors";
import {createModelSelection} from "./model-selection";
import {createMarkdownRenderer, finishingMarkdownMessages, markdownRenderMetrics, streamingMarkdownCaches} from "./markdown-renderer";
import {createDraftModel, draftLabel, messageNow, requestAssistantReplyForSubmission, workingItemText} from "./draft-model";
import {updateConversationHash} from "./navigation";
import {createSettingsView} from "./settings-view";
import {reconcileElement, reconcileHtml, type DomReconcileOptions} from "./dom-reconciler";
import {workingItemRepository} from "./repository/repositories";
import {createProviderController} from "./providers/provider-controller";
import {validProviderUrl} from "./providers/provider-validation";
import {createHistoryView} from "./history-view";
import {createSessionTransferController} from "./session-transfer-controller";

type StreamEvent = {type: string; text?: string; error?: string; metadata?: ResponseMetadata};
type StreamRequestContext = {provider: ChatProvider; model: string; conversationId: string; generationSettings: GenerationSettings};
const rootElement = document.querySelector<HTMLDivElement>("#app");
if (!rootElement) throw new Error("Application root is missing");
const root: HTMLDivElement = rootElement;

migrateLegacyPreferences();

const state = createInitialAppState();
const titleGenerationConversationIds = new Set<string>();
const {conversationGraphObjects, displayedMessages, knownMessageMap, messageChildren, messagePathTo, newestBranchTip} = createConversationSelectors(state);
const {availableModelChoices, rememberModel, renderEffortControl, renderModelOption, renderModelPicker, settingsForProvider} = createModelSelection(state, escapeHtml);
const {clearMathTypesetting, renderMarkdownContainer, scheduleMathTypesetting} = createMarkdownRenderer({
  root,
  escapeHtml,
  isViewportAtBottom,
  scrollBottom: () => scrollBottom()
});
const appDomReconcileOptions: DomReconcileOptions = {
  preserveChildren: (element) => element.id === "message-list",
  beforeDiscard: (node) => {
    if (!(node instanceof Element)) return;
    if (node.matches('.math-fragment, [data-math-rendered="1"]') || node.querySelector('.math-fragment, [data-math-rendered="1"]')) clearMathTypesetting(node);
  }
};
const {activeDraft, canStashActiveDraft, newDraftItem} = createDraftModel(state, {
  uuid,
  displayedHeadId: () => displayedMessages().at(-1)?.id || null
});
const {renderProviderSettings, renderSettingsPage} = createSettingsView(state, {
  escapeHtml,
  localCredential,
  availableModelChoices,
  renderEffortControl,
  renderModelOption
});
const {renderHistory, renderHistoryItems} = createHistoryView(state, escapeHtml);
const providerController = createProviderController(state, {
  root,
  render: renderApp,
  localCredential,
  settingsForProvider,
  scheduleSettingsSave,
  discoverProvider: discoverLocalProvider,
  reportError: showError
});
const sessionTransferController = createSessionTransferController(state, {
  root,
  escapeHtml,
  uuid,
  render: renderApp,
  conversationObjects: conversationGraphObjects,
  selectConversation: (id) => selectConversation(id),
  scheduleSync: scheduleRepositorySync,
  reportError: showError
});

function uuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[character]!);
}

function isStreamingAssistant(message: StoredChatMessage, index: number) {
  return state.streaming
    && state.conversation?.messages.at(-1)?.id === message.id;
}

function estimateFrontendOutputTokens(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const withoutSpaces = trimmed.replace(/\s+/g, "");
  const chineseChars = (withoutSpaces.match(/\p{Script=Han}/gu) || []).length;
  const nonChineseChars = withoutSpaces.length - chineseChars;
  return Math.max(0, Math.round(chineseChars + nonChineseChars / 4));
}

function provider() {
  return state.config?.providers.find((item) => item.id === state.providerId) || null;
}

function configuredResponseModel() {
  const item = provider();
  return item && state.model && item.models.some((model) => model.id === state.model)
    ? {provider: item, model: state.model}
    : null;
}

function localCredential(providerId = state.providerId) {
  return state.localCredentials.find((item) => item.providerId === providerId && item.name === "default")
    || state.localCredentials.find((item) => item.providerId === providerId)
    || null;
}

function avatarPlaceholder(profile: ChatProfile) {
  const source = String(profile.name || profile.username || "U").trim() || "U";
  const parts = source.split(/\s+/).filter(Boolean);
  const initials = (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)![0]}` : [...source].slice(0, 2).join("")).toUpperCase();
  let hash = 0;
  for (const character of String(profile.username || profile.name || initials)) hash = ((hash << 5) - hash + character.codePointAt(0)!) | 0;
  const hue = Math.abs(hash) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="32" fill="hsl(${hue} 58% 48%)"/><text x="128" y="145" text-anchor="middle" font-family="system-ui,sans-serif" font-size="82" font-weight="800" fill="white">${escapeHtml(initials)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function updateAvatar() {
  const image = root.querySelector<HTMLImageElement>(".header-avatar");
  const profile = state.config?.profile;
  const email = String(profile?.email || "").trim().toLowerCase();
  if (!image || !email) return;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  for (const source of [`https://www.gravatar.com/avatar/${hash}?d=404&s=256`, `https://seccdn.libravatar.org/avatar/${hash}?d=404&s=256`]) {
    const loaded = await new Promise<boolean>((resolve) => {
      const candidate = new Image();
      const timer = window.setTimeout(() => resolve(false), 5000);
      candidate.onload = () => { window.clearTimeout(timer); resolve(true); };
      candidate.onerror = () => { window.clearTimeout(timer); resolve(false); };
      candidate.referrerPolicy = "no-referrer";
      candidate.src = source;
    });
    if (loaded && image.isConnected) {
      image.src = source;
      break;
    }
  }
}

function scrollSettingsSection(id: string) {
  const section = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  section?.scrollIntoView({behavior: "smooth", block: "start"});
}

function activeReplyTargetId() {
  const draft = activeDraft();
  if (!draft || draft.editSourceMessageId) return undefined;
  const latestId = displayedMessages().at(-1)?.id || null;
  return draft.observedHeadId === latestId ? undefined : draft.observedHeadId;
}

function replyAction(message: StoredChatMessage, index: number) {
  return `<button class="icon-button" type="button" data-action="reply-message" data-index="${index}" aria-label="回复到这条消息" title="回复到这条消息">${icons.reply}</button>`;
}

function renderMessage(message: StoredChatMessage, index: number) {
  const replyTarget = activeReplyTargetId() === message.id;
  const messageAttributes = `data-message-index="${index}" data-message-id="${escapeHtml(message.id)}"`;
  const branches = renderBranchNavigator(message);
  if (message.role === "user") {
    return `<article class="message user-message${replyTarget ? " reply-target" : ""}" ${messageAttributes}><div class="message-content user-content"><p>${escapeHtml(messagePartText(message, "text"))}</p></div><div class="user-message-actions">${replyAction(message, index)}<button class="icon-button" type="button" data-action="edit-message" data-index="${index}" aria-label="编辑消息"${state.streaming ? " disabled" : ""}>${icons.edit}</button>${branches}</div></article>`;
  }
  if (message.role !== "assistant") return "";
  const reasoning = messagePartText(message, "reasoning");
  const text = messagePartText(message, "text");
  const streamed = isStreamingAssistant(message, index);
  const renderedText = text ? renderMarkdownContainer(text, message.id, !streamed || finishingMarkdownMessages.has(message.id)) : null;
  const error = message.parts.find((part) => part.type === "error" && typeof part.text === "string")?.text;
  const response = message.metadata?.custom?.response;
  const modelLabel = response?.model ? `${response.providerId || state.providerId}/${response.model}` : `${state.providerId}/${state.model}`;
  const speed = typeof response?.tokensPerSecond === "number" ? `${response.tokensPerSecond.toFixed(1)} tok/s` : "速度 —";
  const detail = response?.durationMs ? `${(response.durationMs / 1000).toFixed(1)} 秒${typeof response.outputTokens === "number" ? ` · ${response.outputTokens} tokens` : ""}` : "历史回复未记录速度";
  const partial = message.completion.status === "partial" ? `<span class="partial-badge">未完成${message.completion.reason ? ` · ${escapeHtml(message.completion.reason)}` : ""}</span>` : "";
  return `<article class="message assistant-message${replyTarget ? " reply-target" : ""}" ${messageAttributes}><div class="message-content assistant-content">${reasoning ? `<details class="message-reasoning"><summary>思考过程</summary><div>${escapeHtml(reasoning)}</div></details>` : ""}${renderedText || state.streaming && state.conversation?.messages.at(-1)?.id === message.id ? renderedText || '<span class="response-loader"></span>' : ""}${error ? `<div class="message-error">${escapeHtml(error)}</div>` : ""}</div><div class="message-footer"><div class="response-summary"><div class="response-meta" title="${escapeHtml(detail)}"><span>${escapeHtml(modelLabel)}</span><span>${escapeHtml(speed)}</span></div>${partial}</div><div class="message-actions">${branches}${replyAction(message, index)}<button class="icon-button" type="button" data-action="copy-message" data-index="${index}" aria-label="复制回答">${icons.copy}</button>${state.advancedActions ? `<button class="icon-button" type="button" data-action="edit-message" data-index="${index}" aria-label="编辑回答"${state.streaming ? " disabled" : ""}>${icons.edit}</button>` : ""}<button class="icon-button" type="button" data-action="regenerate-message" data-index="${index}" aria-label="重新生成"${state.streaming ? " disabled" : ""}>${icons.retry}</button></div></div></article>`;
}

function renderBranchNavigator(message: StoredChatMessage) {
  const siblings = message.parentMessageId === null
    ? rootEditAlternativesInGraph(knownMessageMap(), message.id)
    : messageChildren(message.parentMessageId);
  if (siblings.length < 2) return "";
  const index = siblings.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) return "";
  const previous = siblings[(index - 1 + siblings.length) % siblings.length];
  const next = siblings[(index + 1) % siblings.length];
  return `<span class="branch-navigator" aria-label="分支 ${index + 1}/${siblings.length}"><button class="icon-button" type="button" data-action="switch-branch" data-id="${escapeHtml(previous.id)}" aria-label="上一个分支">‹</button><span>${index + 1} / ${siblings.length}</span><button class="icon-button" type="button" data-action="switch-branch" data-id="${escapeHtml(next.id)}" aria-label="下一个分支">›</button></span>`;
}

function renderMessagesMarkup() {
  const messages = displayedMessages();
  if (!messages.length) {
    const description = state.authenticated
      ? "Provider 由当前浏览器直连；对话记录按当前身份同步。"
      : "Provider 由当前浏览器直连；对话与草稿保存在本机。";
    return `<div class="welcome"><div class="welcome-mark">TF</div><h1>今天想聊什么？</h1><p>${escapeHtml(description)}</p></div>`;
  }
  return messages.map(renderMessage).join("");
}

function renderWorkingPanel() {
  const drafts = state.workingItems.filter((item) => item.kind === "user-draft" && item.id !== state.activeDraftId);
  const unfinished = state.workingItems.filter((item) => item.kind === "assistant-stream" && item.status !== "streaming");
  const responseModelAvailable = Boolean(configuredResponseModel());
  const requestAssistantReply = responseModelAvailable && (activeDraft()?.requestAssistantReply ?? true);
  const assistantReplyToggle = state.advancedActions
    ? `<label class="assistant-reply-toggle"${responseModelAvailable ? "" : ' title="请先配置并选择模型"'}><input type="checkbox" data-action="request-assistant-reply"${requestAssistantReply ? " checked" : ""}${responseModelAvailable ? "" : " disabled"}>需要回答</label>`
    : "";
  const draftRows = drafts.map((item) => {
    const text = workingItemText(item).trim().replace(/\s+/g, " ");
    return `<div class="draft-row" data-dom-key="draft:${escapeHtml(item.id)}"><button type="button" data-action="select-draft" data-id="${escapeHtml(item.id)}"><strong>${escapeHtml(text.slice(0, 36) || "空白草稿")}</strong><small>${draftLabel(item)} · ${new Date(item.updatedAt).toLocaleString()}</small></button><button type="button" data-action="delete-working" data-id="${escapeHtml(item.id)}" aria-label="删除草稿">${icons.trash}</button></div>`;
  }).join("");
  const unfinishedRows = unfinished.map((item) => {
    const text = workingItemText(item).trim().replace(/\s+/g, " ");
    return `<div class="unfinished-row" data-dom-key="unfinished:${escapeHtml(item.id)}"><span><strong>未完成回答</strong><small>${escapeHtml(text.slice(0, 64) || "尚未输出正文")} · ${new Date(item.updatedAt).toLocaleString()}</small></span><button type="button" data-action="commit-partial" data-id="${escapeHtml(item.id)}">保留</button><button type="button" data-action="delete-working" data-id="${escapeHtml(item.id)}">清理</button></div>`;
  }).join("");
  const canStash = canStashActiveDraft();
  return `<div class="working-panel">${assistantReplyToggle}${renderComposerControls(activeDraft())}${unfinishedRows ? `<details class="unfinished-menu"><summary>未完成 ${unfinished.length}</summary><div>${unfinishedRows}</div></details>` : ""}<details class="draft-menu"><summary>草稿 ${drafts.length}</summary><div><button class="stash-draft" type="button" data-action="stash-draft" aria-label="将当前编辑区收起为草稿" title="${canStash ? "将当前编辑区收起到草稿列表" : "当前编辑区为空"}"${canStash ? "" : " disabled"}>${icons.stash}收起为草稿</button>${draftRows}</div></details></div>`;
}

function updateDraftStashControl() {
  const button = root.querySelector<HTMLButtonElement>('[data-action="stash-draft"]');
  if (!button) return;
  const canStash = canStashActiveDraft();
  button.disabled = !canStash;
  button.title = canStash ? "将当前编辑区收起到草稿列表" : "当前编辑区为空";
}

function replyTargetLabel(message: StoredChatMessage) {
  const role = message.role === "assistant" ? "助手" : message.role === "user" ? "用户" : "系统";
  const text = messagePartText(message, "text").replace(/\s+/g, " ").trim();
  const partial = message.completion.status === "partial" ? " · 未完成" : "";
  return `${role}${partial} · ${text.slice(0, 48) || "空消息"}`;
}

function renderComposerControls(draft: WorkingItem | null) {
  const messages = displayedMessages();
  const targetId = draft ? draft.observedHeadId : messages.at(-1)?.id || null;
  const target = targetId ? knownMessageMap().get(targetId) : null;
  const latestId = messages.at(-1)?.id || null;
  const showReplyContext = Boolean(draft && !draft.editSourceMessageId && targetId !== latestId);
  const replyContext = showReplyContext
    ? `<div class="reply-context" aria-label="指定回复目标"><span class="reply-context-icon" title="回复到" aria-hidden="true">${icons.reply}</span><button type="button" data-action="jump-reply-target" data-id="${escapeHtml(targetId || "__root__")}" aria-label="跳转到回复目标：${escapeHtml(target ? replyTargetLabel(target) : "会话开头")}">${escapeHtml(target ? replyTargetLabel(target) : "会话开头")}</button><button class="reply-cancel" type="button" data-action="cancel-reply-target" aria-label="取消指定回复目标">${icons.close}</button></div>`
    : "";
  const incompleteControl = target?.completion.status === "partial"
    ? `<label>未完成消息<select data-action="incomplete-target-action"><option value="append"${draft?.incompleteTargetAction !== "interrupt" ? " selected" : ""}>排在它下面</option><option value="interrupt"${draft?.incompleteTargetAction === "interrupt" ? " selected" : ""}>中断并替换它</option></select></label>`
    : "";
  return `<div class="composer-controls">${replyContext}${incompleteControl}</div>`;
}

function updateComposerControls() {
  const controls = root.querySelector<HTMLElement>(".composer-controls");
  if (controls) reconcileElement(controls, renderComposerControls(activeDraft()), appDomReconcileOptions);
}

function renderBranchPreviewNotice() {
  if (!state.previewHeadId || state.previewHeadId === state.conversation?.headMessageId) return "";
  return `<div class="branch-preview-notice"><span>正在查看非当前分支</span><div><button type="button" data-action="leave-branch-preview">返回当前分支</button><button type="button" data-action="confirm-branch-preview">将当前会话切换到这里</button></div></div>`;
}

function renderThread() {
  const draft = activeDraft();
  const editing = Boolean(draft?.editSourceMessageId);
  const editRole = draft?.messageRole === "assistant" ? "助手回答" : "用户消息";
  const fullscreen = state.composerFullscreen;
  const queued = draft?.id === state.queuedDraftId;
  const responseModelAvailable = Boolean(configuredResponseModel());
  const note = !responseModelAvailable ? "消息仍会保存；配置模型后才能请求回答。" : queued ? "已排队；会在当前回答完成后提交。" : state.offline ? "离线模式：提交保存在本地仓库，联网后自动 push。" : "草稿自动保存在此浏览器；模型可能会出错。";
  const editorLabel = editing ? `正在编辑${editRole}` : "全屏编辑";
  const fullscreenHeader = fullscreen
    ? `<header class="fullscreen-editor-header"><span><strong>${editorLabel}</strong><small>草稿自动保存在此浏览器</small></span><button type="button" data-action="toggle-composer-fullscreen" aria-label="退出全屏编辑" title="退出全屏编辑（Esc）">${icons.close}</button></header>`
    : "";
  const placeholder = fullscreen
    ? editing ? "编辑消息；Ctrl/⌘ + Enter 提交" : "输入消息；Ctrl/⌘ + Enter 提交"
    : editing ? "编辑消息，提交后从此处继续" : "输入消息，Enter 发送，Shift + Enter 换行";
  return `<section class="thread-root"><div class="thread-viewport" id="thread-viewport">${renderBranchPreviewNotice()}<div id="message-list">${renderMessagesMarkup()}</div><div class="thread-footer${fullscreen ? " fullscreen-editor" : ""}">${fullscreenHeader}<button class="scroll-button" type="button" data-action="scroll-bottom" aria-label="滚动到底部">${icons.scroll}</button>${renderWorkingPanel()}${editing ? `<div class="edit-context"><span>正在编辑${editRole}；提交后当前会话将从这里继续</span><button type="button" data-action="cancel-edit">取消</button></div>` : ""}<form class="composer" id="composer"><textarea class="composer-input" name="message" placeholder="${placeholder}" rows="1" aria-label="聊天消息">${escapeHtml(draft ? workingItemText(draft) : "")}</textarea><div class="composer-actions">${state.streaming ? `<button class="stop-button" type="button" data-action="stop" aria-label="停止生成">${icons.stop}</button>` : ""}<button class="fullscreen-button" type="button" data-action="toggle-composer-fullscreen" aria-label="${fullscreen ? "退出全屏编辑" : "进入全屏编辑"}" title="${fullscreen ? "退出全屏编辑" : "全屏编辑"}"${fullscreen ? "" : " hidden"}>${fullscreen ? icons.collapse : icons.expand}</button></div>${renderModelPicker()}<button class="send-button" type="submit" data-action="send" aria-label="${state.streaming ? "排队发送" : "发送消息"}">${icons.send}</button></form><p class="composer-note${state.offline ? " offline" : ""}${queued ? " queued" : ""}">${note}</p></div></div></section>`;
}

const compactComposerLineLimit = 3;

function syncComposerInputLayout(input = root.querySelector<HTMLTextAreaElement>('textarea[name="message"]')) {
  if (!input || state.composerFullscreen) return;
  const fullscreenButton = input.form?.querySelector<HTMLButtonElement>(".fullscreen-button");
  if (fullscreenButton) fullscreenButton.hidden = true;
  input.style.height = "auto";
  if (!input.value) return;
  const style = window.getComputedStyle(input);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  const maxHeight = Math.ceil(lineHeight * compactComposerLineLimit + verticalPadding);
  const reachesLineLimit = input.scrollHeight >= maxHeight - 1;
  if (fullscreenButton) fullscreenButton.hidden = !reachesLineLimit;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
}

function setComposerFullscreen(fullscreen: boolean) {
  const currentInput = root.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
  const selectionStart = currentInput?.selectionStart ?? 0;
  const selectionEnd = currentInput?.selectionEnd ?? selectionStart;
  state.composerFullscreen = fullscreen;
  renderApp();
  window.requestAnimationFrame(() => {
    const nextInput = root.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    if (!fullscreen) syncComposerInputLayout(nextInput);
    nextInput?.focus();
    nextInput?.setSelectionRange(selectionStart, selectionEnd);
  });
}

function syncIndicatorTitle() {
  if (!state.authenticated) return state.offline
    ? "当前离线；数据安全保存在当前浏览器"
    : "本地模式：数据仅保存在当前浏览器";
  const last = state.lastFetchAt ? new Date(state.lastFetchAt).toLocaleString() : "从未完成 fetch";
  if (state.offline) return `当前离线；本地更改安全保存在浏览器中 · 上次完成：${last}`;
  if (state.syncing) return `正在 fetch · 上次完成：${last}`;
  if (state.syncError) return `本地更改安全保存在浏览器中 · ${state.syncError} · 上次完成：${last}`;
  if (!state.initialFetchComplete) return `尚未完成首次 fetch · 上次完成：${last}`;
  return `上次 fetch：${last}`;
}

function syncIndicatorState() {
  if (!state.authenticated) return {className: state.offline ? "offline" : "local", label: state.offline ? "离线" : "本地"};
  if (state.offline) return {className: "offline", label: "离线"};
  if (state.syncing) return {className: "fetching", label: "同步中"};
  if (state.syncError) return {className: "error", label: "待同步"};
  if (!state.initialFetchComplete) return {className: "fetching", label: "未 fetch"};
  return {className: "synced", label: "已同步"};
}

function updateSyncIndicator() {
  const indicator = root.querySelector<HTMLElement>(".identity-sync-control");
  if (!indicator) return;
  const visual = syncIndicatorState();
  indicator.className = `identity-sync-control ${visual.className}`;
  indicator.title = syncIndicatorTitle();
  indicator.setAttribute("aria-label", state.authenticated ? `个人同步仓库；${visual.label}` : `${visual.label}仓库`);
  const label = indicator.querySelector<HTMLElement>(".identity-sync-label");
  if (label) label.textContent = visual.label;
}

function renderIdentitySyncControl(profile: ChatProfile) {
  const visual = syncIndicatorState();
  const title = syncIndicatorTitle();
  const ariaLabel = state.authenticated ? `个人同步仓库；${visual.label}` : `${visual.label}仓库`;
  const identity = state.authenticated
    ? `<span class="identity-sync-avatar"><img class="header-avatar" src="${avatarPlaceholder(profile)}" alt="${escapeHtml(profile.name || profile.username)} 的头像" referrerpolicy="no-referrer"><i class="identity-sync-status" aria-hidden="true"></i></span>`
    : `<span class="identity-sync-avatar identity-sync-local" aria-hidden="true">${icons.offline}<i class="identity-sync-status"></i></span>`;
  const content = `${identity}<span class="identity-sync-label">${escapeHtml(visual.label)}</span>`;
  return `<span class="identity-sync-control ${visual.className}" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(title)}">${content}</span>`;
}

function renderApp() {
  if (state.error) {
    reconcileHtml(root, `<main class="state-page"><div class="state-card"><span class="state-mark">!</span><h1>聊天服务暂时不可用</h1><p>${escapeHtml(state.error)}</p>${renderProviderSettings()}</div></main>`, appDomReconcileOptions);
    return;
  }
  if (state.loading || !state.config) {
    reconcileHtml(root, '<main class="state-page"><div class="state-card"><span class="loader"></span><p>正在读取本地工作区…</p></div></main>', appDomReconcileOptions);
    return;
  }
  const profile = state.config.profile;
  const usableProvider = state.config.providers.some((item) => item.models.length > 0);
  const workspace = state.conversation
    ? renderThread()
    : `<section class="empty-workspace"><div class="welcome-mark">TF</div><h1>开始一个新对话</h1><p>${usableProvider ? "当前模型已就绪，也可以只记录消息而不请求回答。" : "无需配置模型即可记录消息；配置模型后才能勾选“需要回答”。"}</p><button type="button" data-action="new-conversation">新对话</button></section>`;
  reconcileHtml(root, `<main class="app-shell with-history${state.historyOpen ? " history-open" : ""}"><header class="app-header"><div class="header-leading"><button class="history-toggle" type="button" data-action="toggle-history" aria-label="聊天历史">${icons.history}</button></div><div class="brand"><a class="portal-home-link" href="${escapeHtml(homeUrl)}" aria-label="Turnfold 主页" title="Turnfold"><img src="${appUrl("/favicon.svg")}" alt=""></a></div><div class="chat-controls">${renderIdentitySyncControl(profile)}</div></header>${renderHistory()}${workspace}${sessionTransferController.renderImportPanel()}${renderSettingsPage()}</main>`, appDomReconcileOptions);
  if (state.conversation) renderMessages();
  window.requestAnimationFrame(() => syncComposerInputLayout());
  scheduleMathTypesetting(root);
  void updateAvatar();
}

function renderMessages(scroll = false) {
  const list = root.querySelector<HTMLElement>("#message-list");
  if (!list) {
    renderApp();
    return;
  }
  const viewport = root.querySelector<HTMLElement>("#thread-viewport");
  const wasAtBottom = isViewportAtBottom(viewport);
  const previousScrollTop = viewport?.scrollTop || 0;
  const reasoningOpenStates = captureReasoningOpenStates(list);
  const messages = displayedMessages();
  if (!messages.length) {
    if (!list.querySelector(".welcome")) {
      clearMathTypesetting(list);
      list.innerHTML = renderMessagesMarkup();
    }
  } else if (list.querySelector(".welcome")) {
    clearMathTypesetting(list);
    list.innerHTML = renderMessagesMarkup();
    scheduleMathTypesetting(list);
  } else {
    const visibleMessages = messages
      .map((message, index) => ({message, index}))
      .filter(({message}) => message.role === "user" || message.role === "assistant");
    const renderedMessages = Array.from(list.querySelectorAll<HTMLElement>(":scope > article[data-message-id]"));
    const prefixMatches = renderedMessages.every((node, renderedIndex) => node.dataset.messageId === visibleMessages[renderedIndex]?.message.id);
    if (!prefixMatches || renderedMessages.length > visibleMessages.length) {
      clearMathTypesetting(list);
      list.innerHTML = renderMessagesMarkup();
      scheduleMathTypesetting(list);
    } else {
      for (let renderedIndex = renderedMessages.length; renderedIndex < visibleMessages.length; renderedIndex += 1) {
        const {message, index} = visibleMessages[renderedIndex];
        const node = renderedMessageNode(message, index);
        if (node) {
          list.appendChild(node);
          scheduleMathTypesetting(node);
        }
      }
      const last = visibleMessages.at(-1);
      const existingLast = list.lastElementChild;
      if (last?.message.role === "assistant" && existingLast instanceof HTMLElement && existingLast.dataset.messageId === last.message.id) {
        patchAssistantMessage(existingLast, last.message, last.index);
      }
    }
  }
  restoreReasoningOpenStates(list, reasoningOpenStates);
  updateStreamingControls();
  if (scroll) {
    if (wasAtBottom) scrollBottom();
    else if (viewport) viewport.scrollTop = previousScrollTop;
  }
}

function isViewportAtBottom(viewport: HTMLElement | null): boolean {
  if (!viewport) return false;
  return viewport.scrollHeight - viewport.clientHeight <= viewport.scrollTop + 8;
}

function renderedMessageNode(message: StoredChatMessage, index: number): HTMLElement | null {
  const template = document.createElement("template");
  template.innerHTML = renderMessage(message, index);
  const node = template.content.firstElementChild;
  return node instanceof HTMLElement ? node : null;
}

function patchMathBlock(current: HTMLElement, desired: HTMLElement) {
  const currentFragments = new Map(
    Array.from(current.querySelectorAll<HTMLElement>(".math-fragment[data-math-key]"))
      .map((fragment) => [fragment.dataset.mathKey || "", fragment] as const)
  );
  const next = desired.cloneNode(true) as HTMLElement;
  for (const placeholder of next.querySelectorAll<HTMLElement>(".math-fragment[data-math-key]")) {
    const key = placeholder.dataset.mathKey || "";
    const preserved = currentFragments.get(key);
    if (!preserved) continue;
    placeholder.replaceWith(preserved);
    currentFragments.delete(key);
  }
  for (const obsolete of currentFragments.values()) clearMathTypesetting(obsolete);
  current.replaceChildren(...Array.from(next.childNodes));
  current.dataset.renderKey = desired.dataset.renderKey;
  current.dataset.hasMath = desired.dataset.hasMath;
  current.dataset.blockStable = desired.dataset.blockStable;
  current.dataset.blockType = desired.dataset.blockType;
  scheduleMathTypesetting(current);
}

function patchMarkdownContainer(current: HTMLElement, desired: HTMLElement) {
  const currentBlocks = Array.from(current.querySelectorAll<HTMLElement>(":scope > .markdown-block"));
  const desiredBlocks = Array.from(desired.querySelectorAll<HTMLElement>(":scope > .markdown-block"));
  const prefixMatches = currentBlocks.every((block, index) => block.dataset.blockId === desiredBlocks[index]?.dataset.blockId);
  if (!prefixMatches || currentBlocks.length > desiredBlocks.length) {
    clearMathTypesetting(current);
    current.replaceChildren(...desiredBlocks.map((block) => block.cloneNode(true)));
    current.dataset.renderKey = desired.dataset.renderKey;
    markdownRenderMetrics.domBlocksUpdated += desiredBlocks.length;
    scheduleMathTypesetting(current);
    return;
  }

  for (let index = 0; index < desiredBlocks.length; index += 1) {
    const desiredBlock = desiredBlocks[index];
    const currentBlock = currentBlocks[index];
    if (!currentBlock) {
      const appended = desiredBlock.cloneNode(true) as HTMLElement;
      current.appendChild(appended);
      markdownRenderMetrics.domBlocksUpdated += 1;
      scheduleMathTypesetting(appended);
      continue;
    }
    if (currentBlock.dataset.renderKey === desiredBlock.dataset.renderKey) {
      currentBlock.dataset.blockStable = desiredBlock.dataset.blockStable;
      continue;
    }
    markdownRenderMetrics.domBlocksUpdated += 1;
    if (desiredBlock.dataset.hasMath === "1") {
      patchMathBlock(currentBlock, desiredBlock);
    } else {
      clearMathTypesetting(currentBlock);
      currentBlock.innerHTML = desiredBlock.innerHTML;
      currentBlock.dataset.renderKey = desiredBlock.dataset.renderKey;
      currentBlock.dataset.hasMath = desiredBlock.dataset.hasMath;
      currentBlock.dataset.blockStable = desiredBlock.dataset.blockStable;
      currentBlock.dataset.blockType = desiredBlock.dataset.blockType;
      delete currentBlock.dataset.mathRendered;
    }
  }
  current.dataset.renderKey = desired.dataset.renderKey;
}

function patchAssistantMessage(existing: HTMLElement, message: StoredChatMessage, index: number) {
  const next = renderedMessageNode(message, index);
  if (!next) return;
  const existingContent = existing.querySelector<HTMLElement>(".assistant-content");
  const nextContent = next.querySelector<HTMLElement>(".assistant-content");
  if (!existingContent || !nextContent) return;

  const selectors = [".partial-badge", ".message-reasoning", ".aui-md", ".response-loader", ".message-error"];
  const retained = new Set<Element>();
  const changedMathElements = new Set<HTMLElement>();
  let insertionPoint = existingContent.firstElementChild;
  for (const selector of selectors) {
    const desired = nextContent.querySelector<HTMLElement>(`:scope > ${selector}`);
    let current = existingContent.querySelector<HTMLElement>(`:scope > ${selector}`);
    if (!desired) {
      if (current) {
        if (selector === ".aui-md") clearMathTypesetting(current);
        if (current === insertionPoint) insertionPoint = current.nextElementSibling;
        current.remove();
      }
      continue;
    }
    if (!current) {
      current = desired.cloneNode(true) as HTMLElement;
      if (selector === ".aui-md") changedMathElements.add(current);
    } else if (selector === ".message-reasoning") {
      const currentBody = current.querySelector<HTMLElement>(":scope > div");
      const desiredBody = desired.querySelector<HTMLElement>(":scope > div");
      if (currentBody && desiredBody && currentBody.textContent !== desiredBody.textContent) currentBody.textContent = desiredBody.textContent;
    } else if (selector === ".aui-md" && current.dataset.renderKey !== desired.dataset.renderKey) {
      patchMarkdownContainer(current, desired);
    } else if (selector === ".message-error" && current.textContent !== desired.textContent) {
      current.textContent = desired.textContent;
    }
    if (current !== insertionPoint) existingContent.insertBefore(current, insertionPoint);
    insertionPoint = current.nextElementSibling;
    retained.add(current);
  }
  for (const child of Array.from(existingContent.children)) {
    if (!retained.has(child)) child.remove();
  }

  const existingFooter = existing.querySelector<HTMLElement>(".message-footer");
  const nextFooter = next.querySelector<HTMLElement>(".message-footer");
  if (existingFooter && nextFooter && existingFooter.innerHTML !== nextFooter.innerHTML) existingFooter.innerHTML = nextFooter.innerHTML;
  for (const element of changedMathElements) scheduleMathTypesetting(element);
}

function updateStreamingControls() {
  const composer = root.querySelector<HTMLFormElement>("#composer");
  const composerActions = composer?.querySelector<HTMLElement>(".composer-actions") || null;
  const button = root.querySelector<HTMLButtonElement>(".send-button");
  if (button) {
    button.type = "submit";
    button.dataset.action = "send";
    button.setAttribute("aria-label", state.streaming ? "排队发送" : "发送消息");
    button.disabled = false;
    if (button.innerHTML !== icons.send) button.innerHTML = icons.send;
  }
  let stopButton = composer?.querySelector<HTMLButtonElement>(".stop-button") || null;
  if (state.streaming && composer && composerActions && !stopButton) {
    composerActions.insertAdjacentHTML("afterbegin", `<button class="stop-button" type="button" data-action="stop" aria-label="停止生成">${icons.stop}</button>`);
    stopButton = composer.querySelector<HTMLButtonElement>(".stop-button");
  }
  if (!state.streaming) stopButton?.remove();
  root.querySelectorAll<HTMLButtonElement>('[data-action="regenerate-message"]').forEach((button) => {
    button.disabled = state.streaming;
  });
  root.querySelectorAll<HTMLButtonElement>('[data-action="edit-message"]').forEach((button) => {
    button.disabled = state.streaming;
  });
}

function captureReasoningOpenStates(list: HTMLElement) {
  const states = new Map<string, boolean>();
  list.querySelectorAll<HTMLElement>("article[data-message-id] details.message-reasoning").forEach((details) => {
    const article = details.closest<HTMLElement>("article[data-message-id]");
    if (!article) return;
    const id = article.dataset.messageId || "";
    states.set(id, details.hasAttribute("open"));
  });
  return states;
}

function restoreReasoningOpenStates(list: HTMLElement, states: Map<string, boolean>) {
  list.querySelectorAll<HTMLElement>("article[data-message-id] details.message-reasoning").forEach((details) => {
    const article = details.closest<HTMLElement>("article[data-message-id]");
    if (!article) return;
    const id = article.dataset.messageId || "";
    const open = states.get(id);
    if (open === undefined) return;
    if (open) details.setAttribute("open", "open");
    else details.removeAttribute("open");
  });
}

function scheduleMessagesRender(scroll = true) {
  if (state.renderFrame) return;
  state.renderFrame = window.requestAnimationFrame(() => {
    state.renderFrame = 0;
    renderMessages(scroll);
  });
}

function scrollBottom(behavior: ScrollBehavior = "auto") {
  const viewport = root.querySelector<HTMLElement>("#thread-viewport");
  if (viewport) viewport.scrollTo({top: viewport.scrollHeight, behavior});
}

function closeHistoryOnMobile() {
  if (window.matchMedia("(max-width: 680px)").matches) state.historyOpen = false;
}

async function discoverLocalProvider(item: ChatProvider) {
  const secret = localCredential(item.id)?.secret || {};
  const discovered = await discoverProviderModels(item, secret);
  const localModels = item.models.filter((model) => model.source !== "discovered" && !discovered.some((candidate) => candidate.id === model.id));
  const models = [...localModels, ...discovered];
  const updated: ChatProvider = {
    ...item,
    models,
    defaultModel: models.some((model) => model.id === item.defaultModel) ? item.defaultModel : models[0].id,
    modelDiscoveryError: undefined,
    updatedAt: messageNow()
  };
  await saveLocalProviderProfile(updated);
  return updated;
}

async function streamLocalProvider(messages: StoredChatMessage[], onEvent: (event: StreamEvent) => void, signal: AbortSignal, context?: StreamRequestContext) {
  const item = context?.provider || provider()!;
  if (!item) throw new Error("当前会话尚未配置 Provider");
  const credential = localCredential(item.id);
  const secret = credential?.secret || {};
  if (item.auth.type !== "none" && !secret.apiKey && !Object.keys(secret.headers || {}).length) throw new Error(`请先配置 ${item.name} 的凭据`);
  const startedAt = performance.now();
  let responseText = "";
  const result = await streamProvider(
    item,
    secret,
    context?.model || state.model,
    messages.filter((message) => ["system", "user", "assistant"].includes(message.role)).map((message) => ({role: message.role as "system" | "user" | "assistant", text: messagePartText(message, "text")})).filter((message) => message.role !== "system" || message.text),
    context?.generationSettings || state.generationSettings,
    (event) => {
      if (event.type === "text-delta") responseText += event.text;
      onEvent(event);
    },
    signal
  );
  onEvent({type: "finish", metadata: responseMetadata(item.id, context?.model || state.model, startedAt, result.outputTokens, result.outputTokens === undefined ? estimateFrontendOutputTokens(responseText) : undefined)});
}

async function generateConversationTitle(conversation: Conversation, item: ChatProvider, model: string) {
  if (titleGenerationConversationIds.has(conversation.id)) return;
  titleGenerationConversationIds.add(conversation.id);
  try {
    const timestamp = messageNow();
    const promptMessage: StoredChatMessage = {
      id: uuid(),
      parentMessageId: null,
      role: "user",
      parts: [{type: "text", text: conversationTitlePrompt(conversation.messages)}],
      origin: {type: "system", source: "conversation-title"},
      completion: {status: "complete"},
      createdAt: timestamp,
      completedAt: timestamp
    };
    const generationSettings: GenerationSettings = {reasoning: "none", showReasoningSummary: false, temperature: 0.2, maxOutputTokens: 48};
    const context: StreamRequestContext = {provider: item, model, conversationId: conversation.id, generationSettings};
    let output = "";
    const onEvent = (event: StreamEvent) => {
      if (event.type === "text-delta" && event.text) output += event.text;
      if (event.type === "error") throw new Error(event.error || "标题生成失败");
    };
    const signal = AbortSignal.timeout(30000);
    await streamLocalProvider([promptMessage], onEvent, signal, context);
    const generated = normalizeGeneratedConversationTitle(output);
    if (!generated) return;
    const current = await getConversationHistory(conversation.id);
    if (current.name) return;
    const name = nextAvailableConversationName(generated);
    const updated = await updateConversationHistory(current.id, current.providerId, current.model, current.generationSettings, name);
    if (state.conversation?.id === updated.id) state.conversation = updated;
    await refreshConversations();
    const historyList = root.querySelector<HTMLElement>(".history-list");
    if (historyList) historyList.innerHTML = renderHistoryItems();
    scheduleRepositorySync();
  } catch (error) {
    console.warn("Unable to generate conversation title", error);
  } finally {
    titleGenerationConversationIds.delete(conversation.id);
  }
}

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
      updateSyncIndicator();
    }
    return;
  }
  state.syncRequested = false;
  state.syncing = true;
  state.syncError = "";
  updateSyncIndicator();
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
      renderMessages(true);
      const historyList = root.querySelector<HTMLElement>(".history-list");
      if (historyList) historyList.innerHTML = renderHistoryItems();
    }
  } catch (error) {
    state.offline = !navigator.onLine;
    state.syncError = error instanceof Error ? error.message : "Fetch failed";
  } finally {
    state.syncing = false;
    updateSyncIndicator();
    if (state.syncRequested) scheduleRepositorySync();
  }
}

async function immutableMessage(input: Pick<StoredChatMessage, "parentMessageId" | "role" | "parts" | "origin" | "completion"> & {metadata?: StoredChatMessage["metadata"]}) {
  const timestamp = messageNow();
  return createMessageObject({...input, createdAt: timestamp, completedAt: timestamp}, state.identityKey);
}

async function loadConversationWorkingItems(conversationId: string) {
  state.messageGraph = await listCachedMessages();
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
  if (render) renderApp();
}

async function editMessage(index: number) {
  if (state.streaming || !state.conversation) return;
  const message = displayedMessages()[index];
  if (!message || (message.role !== "user" && message.role !== "assistant")) return;
  if (message.role === "assistant" && !state.advancedActions) return;
  const existing = state.workingItems.find((item) => item.kind === "user-draft" && item.editSourceMessageId === message.id);
  const draft = existing || newDraftItem(state.conversation.id, {
    observedHeadId: message.parentMessageId,
    editSourceMessageId: message.id,
    text: messagePartText(message, "text"),
    messageRole: message.role,
    requestAssistantReply: message.role !== "assistant"
  });
  state.activeDraftId = draft.id;
  state.composerFullscreen = shouldOpenFullscreenEditor(workingItemText(draft));
  await persistWorkingItem(draft, true);
  const input = root.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
  syncComposerInputLayout(input);
  input?.focus();
  input?.setSelectionRange(input.value.length, input.value.length);
}

async function replyToMessage(index: number) {
  if (!state.conversation) return;
  const message = displayedMessages()[index];
  if (!message) return;
  let draft = activeDraft();
  if (!draft || draft.editSourceMessageId) draft = newDraftItem(state.conversation.id);
  draft.observedHeadId = message.id;
  state.activeDraftId = draft.id;
  await persistWorkingItem(draft, true);
  root.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
}

async function cancelReplyTarget() {
  const draft = activeDraft();
  if (!draft || draft.editSourceMessageId) return;
  draft.observedHeadId = displayedMessages().at(-1)?.id || null;
  await persistWorkingItem(draft, true);
  root.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
}

function jumpToReplyTarget(messageId: string) {
  const scrollToTarget = () => {
    if (messageId === "__root__") {
      root.querySelector<HTMLElement>("#thread-viewport")?.scrollTo({top: 0, behavior: "smooth"});
      return;
    }
    const target = root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    target?.scrollIntoView({behavior: "smooth", block: "center"});
    target?.classList.add("reply-target-pulse");
    if (target) window.setTimeout(() => target.classList.remove("reply-target-pulse"), 900);
  };
  if (messageId !== "__root__" && !root.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`) && knownMessageMap().has(messageId)) {
    state.previewHeadId = newestBranchTip(messageId);
    renderApp();
    window.requestAnimationFrame(scrollToTarget);
    return;
  }
  scrollToTarget();
}

async function cancelEdit() {
  const draft = activeDraft();
  if (!draft?.editSourceMessageId) return;
  await discardWorkingItem(draft.id);
  state.workingItems = state.workingItems.filter((item) => item.id !== draft.id);
  state.activeDraftId = state.workingItems.find((item) => item.kind === "user-draft")?.id || "";
  state.composerFullscreen = false;
  renderApp();
}

async function stashActiveDraft() {
  const draft = activeDraft();
  if (!draft || !workingItemText(draft).trim()) return;
  window.clearTimeout(state.workingSaveTimers.get(draft.id));
  state.workingSaveTimers.delete(draft.id);
  await persistWorkingItem(draft);
  state.activeDraftId = "";
  state.composerFullscreen = false;
  renderApp();
  root.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
}

async function activateDraft(id: string) {
  const next = state.workingItems.find((item) => item.id === id && item.kind === "user-draft");
  if (!next || next.id === state.activeDraftId) return;
  const current = activeDraft();
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
  renderApp();
  root.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
}

async function ensureActiveDraft() {
  let draft = activeDraft();
  if (draft) return draft;
  draft = newDraftItem(state.conversation!.id);
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
  renderApp();
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

async function generateAssistant(baseMessages: StoredChatMessage[]) {
  if (!state.conversation) return;
  const configured = configuredResponseModel();
  if (!configured) throw new Error("当前会话没有可用模型；请先在设置中配置并选择模型");
  const responseProvider = configured.provider;
  const responseModel = configured.model;
  const conversationId = state.conversation.id;
  const baseHeadId = state.conversation.headMessageId;
  const attemptId = uuid();
  const timestamp = messageNow();
  const working: WorkingItem = {
    id: uuid(),
    conversationId,
    kind: "assistant-stream",
    observedHeadId: baseHeadId,
    parts: [],
    status: "streaming",
    attemptId,
    providerId: state.providerId,
    model: state.model,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const assistant: StoredChatMessage = {
    id: working.id,
    parentMessageId: baseHeadId,
    role: "assistant",
    parts: [],
    origin: {type: "model", providerId: state.providerId, model: state.model, attemptId},
    completion: {status: "partial"},
    createdAt: timestamp,
    completedAt: timestamp
  };
  state.conversation!.messages = [...baseMessages, assistant];
  state.streaming = true;
  state.streamController = new AbortController();
  await persistWorkingItem(working);
  renderMessages(true);
  updateComposerControls();
  let text = "";
  let reasoning = "";
  let finished = false;
  let cancelled = false;
  let committedAssistantId = "";
  let titleConversation: Conversation | null = null;
  const onEvent = (event: StreamEvent) => {
    if (event.type === "text-delta" && event.text) text += event.text;
    if (event.type === "reasoning-delta" && event.text) reasoning += event.text;
    assistant.parts = [
      ...(reasoning ? [{type: "reasoning", text: reasoning}] : []),
      ...(text ? [{type: "text", text}] : [])
    ];
    working.parts = assistant.parts;
    if (event.type === "finish" && event.metadata) {
      assistant.metadata = {custom: {response: event.metadata}};
      working.metadata = assistant.metadata;
      finished = true;
      finishingMarkdownMessages.add(assistant.id);
    }
    if (event.type === "error") throw new Error(event.error || "生成失败");
    checkpointWorkingItem(working);
    if (event.type === "finish") renderMessages(true);
    else scheduleMessagesRender();
  };
  try {
    await streamLocalProvider(baseMessages, onEvent, state.streamController.signal);
    if (!finished) throw new Error("Provider 未返回完成事件");
    const committedAssistant = await immutableMessage({
      parentMessageId: baseHeadId,
      role: "assistant",
      parts: assistant.parts,
      origin: assistant.origin,
      completion: {status: "complete"},
      metadata: assistant.metadata
    });
    state.conversation = await commitConversationMessage(conversationId, {
      id: committedAssistant.id,
      expectedHeadId: baseHeadId,
      parentMessageId: baseHeadId,
      role: "assistant",
      parts: committedAssistant.parts,
      origin: committedAssistant.origin,
      completion: committedAssistant.completion,
      createdAt: committedAssistant.createdAt,
      completedAt: committedAssistant.completedAt,
      metadata: committedAssistant.metadata,
      providerId: state.providerId,
      model: state.model
    });
    committedAssistantId = committedAssistant.id;
    streamingMarkdownCaches.move(assistant.id, committedAssistantId);
    finishingMarkdownMessages.delete(assistant.id);
    finishingMarkdownMessages.add(committedAssistantId);
    const streamedArticle = root.querySelector<HTMLElement>("#message-list > article.assistant-message:last-child");
    if (streamedArticle?.dataset.messageId === assistant.id) streamedArticle.dataset.messageId = committedAssistantId;
    await workingItemRepository.remove(working.id);
    state.workingItems = state.workingItems.filter((item) => item.id !== working.id);
    await refreshConversations();
    if (!state.conversation.name) titleConversation = state.conversation;
    scheduleRepositorySync();
  } catch (error) {
    cancelled = state.streamController.signal.aborted;
    working.status = cancelled ? "interrupted" : "failed";
    working.failureReason = cancelled ? "user-cancelled" : navigator.onLine ? "provider-error" : "connection-lost";
    working.parts = [
      ...(reasoning ? [{type: "reasoning", text: reasoning}] : []),
      ...(text ? [{type: "text", text}] : []),
      {type: "error", text: cancelled ? "已停止生成" : error instanceof Error ? error.message : "生成失败"}
    ];
    await persistWorkingItem(working);
    state.conversation!.messages = baseMessages;
  } finally {
    window.clearTimeout(state.workingSaveTimers.get(working.id));
    state.workingSaveTimers.delete(working.id);
    state.streaming = false;
    state.streamController = null;
    if (committedAssistantId) {
      renderMessages(true);
      const historyList = root.querySelector<HTMLElement>(".history-list");
      if (historyList) historyList.innerHTML = renderHistoryItems();
      finishingMarkdownMessages.delete(committedAssistantId);
    } else {
      streamingMarkdownCaches.delete(assistant.id);
      finishingMarkdownMessages.delete(assistant.id);
      renderApp();
    }
    const queuedDraft = state.workingItems.find((item) => item.id === state.queuedDraftId && item.kind === "user-draft");
    let submitQueuedDraft = false;
    if (queuedDraft) {
      if (queuedDraft.observedHeadId === assistant.id) {
        queuedDraft.observedHeadId = committedAssistantId || baseHeadId;
        await persistWorkingItem(queuedDraft);
      }
      submitQueuedDraft = Boolean(committedAssistantId) || cancelled && queuedDraft.incompleteTargetAction === "interrupt";
    }
    state.queuedDraftId = "";
    updateComposerControls();
    updateStreamingControls();
    const composerNote = root.querySelector<HTMLElement>(".composer-note");
    if (composerNote) {
      composerNote.classList.remove("queued");
      composerNote.textContent = state.offline ? "离线模式：提交保存在本地仓库，联网后自动 push。" : "草稿自动保存在此浏览器；模型可能会出错。";
    }
    if (titleConversation) void generateConversationTitle(titleConversation, responseProvider, responseModel);
    if (queuedDraft && submitQueuedDraft) void sendMessage(workingItemText(queuedDraft)).catch(showError);
  }
}

async function sendMessage(text: string) {
  if (!state.conversation || !text.trim()) return;
  const draft = activeDraft();
  if (state.streaming) {
    if (!draft) return;
    state.queuedDraftId = draft.id;
    await persistWorkingItem(draft);
    const activeAssistant = state.conversation.messages.at(-1);
    if (activeAssistant?.role === "assistant" && activeAssistant.completion.status === "partial" && draft.observedHeadId === activeAssistant.id && draft.incompleteTargetAction === "interrupt") {
      state.streamController?.abort();
    }
    const note = root.querySelector<HTMLElement>(".composer-note");
    if (note) {
      note.classList.add("queued");
      note.textContent = draft.incompleteTargetAction === "interrupt" ? "正在中断当前回答；随后会提交草稿。" : "已排队；会在当前回答完成后提交。";
    }
    return;
  }
  const editing = Boolean(draft?.editSourceMessageId);
  const messages = knownMessageMap();
  const selectedTargetId = draft ? draft.observedHeadId : displayedMessages().at(-1)?.id || null;
  const selectedTarget = selectedTargetId ? messages.get(selectedTargetId) : null;
  const parentMessageId = selectedTarget?.completion.status === "partial" && draft?.incompleteTargetAction === "interrupt"
    ? selectedTarget.parentMessageId
    : selectedTargetId;
  if (editing && !messages.has(draft!.editSourceMessageId!)) throw new Error("要编辑的消息已不在本地消息图中");
  if (parentMessageId !== null && !messages.has(parentMessageId)) throw new Error("回复目标已不在本地消息图中");
  state.messageGraph = [...messages.values()];
  if (state.conversation.headMessageId !== parentMessageId) state.conversation = await moveConversationHead(state.conversation.id, parentMessageId);
  state.previewHeadId = "";
  const role = draft?.messageRole || "user";
  const message = await immutableMessage({
    parentMessageId,
    role,
    parts: [{type: "text", text: text.trim()}],
    origin: role === "assistant"
      ? {type: "manual", clientId: window.localStorage.getItem("turnfold-client-id") || "browser", ...(draft?.editSourceMessageId ? {sourceMessageId: draft.editSourceMessageId} : {})}
      : {type: "user", clientId: window.localStorage.getItem("turnfold-client-id") || "browser", ...(draft?.editSourceMessageId ? {sourceMessageId: draft.editSourceMessageId} : {})},
    completion: {status: "complete"}
  });
  const input = root.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
  if (input) {
    input.value = "";
    input.style.height = "auto";
  }
  const draftId = draft?.id || "";
  state.conversation = await commitConversationMessage(state.conversation.id, {
    id: message.id,
    expectedHeadId: parentMessageId,
    parentMessageId,
    role,
    parts: message.parts,
    origin: message.origin,
    completion: message.completion,
    createdAt: message.createdAt,
    completedAt: message.completedAt,
    providerId: state.providerId,
    model: state.model
  });
  if (draftId) await discardWorkingItem(draftId);
  state.workingItems = state.workingItems.filter((item) => item.id !== draftId);
  state.activeDraftId = state.workingItems.find((item) => item.kind === "user-draft")?.id || "";
  state.composerFullscreen = false;
  await refreshConversations();
  renderApp();
  scheduleRepositorySync();
  const requestAssistantReply = requestAssistantReplyForSubmission(
    draft,
    state.advancedActions,
    Boolean(configuredResponseModel())
  );
  if (requestAssistantReply) await generateAssistant(state.conversation.messages);
}

async function regenerate(index: number) {
  if (state.streaming || !state.conversation) return;
  const visible = displayedMessages();
  const message = visible[index];
  if (!message || message.role !== "assistant") return;
  const base = visible.slice(0, index);
  if (!base.some((item) => item.role === "user")) return;
  const baseHead = base.at(-1)?.id || null;
  state.messageGraph = [...knownMessageMap().values()];
  state.conversation = await moveConversationHead(state.conversation.id, baseHead);
  state.previewHeadId = "";
  await refreshConversations();
  scheduleRepositorySync();
  renderApp();
  await generateAssistant(state.conversation.messages);
}

function nextAvailableConversationName(base: string) {
  const conflicts = (candidate: string) => state.conversations.some((item) => item.name === candidate || item.name.startsWith(`${candidate}/`) || candidate.startsWith(`${item.name}/`));
  if (!conflicts(base)) return base;
  const flattened = base.replaceAll("/", "-");
  let suffix = 2;
  while (conflicts(`${flattened}-${suffix}`)) suffix += 1;
  return `${flattened}-${suffix}`;
}

function validatedConversationName(value: string, excludingId = "") {
  const name = value.trim();
  if (!name || name.length > 300 || name.startsWith("/") || name.endsWith("/") || name.split("/").some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f]/.test(segment))) {
    window.alert("名称不能为空，不能以 / 开头或结尾，也不能包含空路径、.、.. 或控制字符。");
    return "";
  }
  const conflict = state.conversations.find((item) => item.id !== excludingId && (item.name === name || item.name.startsWith(`${name}/`) || name.startsWith(`${item.name}/`)));
  if (conflict) {
    window.alert(`名称与现有会话“${conflict.name}”重名或存在路径前缀冲突。`);
    return "";
  }
  return name;
}

async function renameConversation(id: string) {
  const target = state.conversations.find((item) => item.id === id);
  if (!target || !state.conversation) return;
  const proposed = window.prompt("重命名会话（不会重命名同路径下的其他会话）：", target.name);
  if (proposed === null) return;
  const name = validatedConversationName(proposed, id);
  if (!name || name === target.name) return;
  const updated = await updateConversationHistory(id, target.providerId, target.model, id === state.conversation.id ? state.generationSettings : (await getConversationHistory(id)).generationSettings, name);
  if (state.conversation.id === id) state.conversation = updated;
  await refreshConversations();
  renderApp();
  scheduleRepositorySync();
}

async function commitPartial(id: string) {
  let item = state.workingItems.find((candidate) => candidate.id === id && candidate.kind === "assistant-stream");
  if (!item || !state.conversation) return;
  let conversation = state.conversation;
  if (conversation.headMessageId !== item.observedHeadId) {
    const name = nextAvailableConversationName(`${conversation.name || untitledConversationLabel}-partial`);
    const baseIndex = conversation.messages.findIndex((message) => message.id === item.observedHeadId);
    const base = baseIndex >= 0 ? conversation.messages.slice(0, baseIndex + 1) : [];
    conversation = await createConversationHistory(item.providerId || state.providerId, item.model || state.model, state.generationSettings, name, item.observedHeadId, base);
  }
  const completion: MessageCompletion = {status: "partial", reason: item.failureReason || "connection-lost"};
  const partial = await immutableMessage({
    parentMessageId: item.observedHeadId,
    role: "assistant",
    parts: item.parts,
    origin: {type: "model", providerId: item.providerId || state.providerId, model: item.model || state.model, attemptId: item.attemptId || item.id},
    completion,
    metadata: item.metadata
  });
  state.conversation = await commitConversationMessage(conversation.id, {
    id: partial.id,
    expectedHeadId: item.observedHeadId,
    parentMessageId: item.observedHeadId,
    role: "assistant",
    parts: partial.parts,
    origin: partial.origin,
    completion,
    createdAt: partial.createdAt,
    completedAt: partial.completedAt,
    metadata: item.metadata,
    providerId: item.providerId || state.providerId,
    model: item.model || state.model
  });
  await workingItemRepository.remove(item.id);
  state.workingItems = state.workingItems.filter((candidate) => candidate.id !== item.id);
  await refreshConversations();
  updateConversationHash(state.conversation.id, "push");
  renderApp();
  scheduleRepositorySync();
}

async function selectConversation(id: string, navigation: HashNavigationMode = "push") {
  if (state.streaming || !state.config || state.conversation?.id === id) return;
  const selected = await getConversationHistory(id);
  const selectedProvider = state.config.providers.find((item) => item.id === selected.providerId);
  state.conversation = selected;
  state.previewHeadId = "";
  state.composerFullscreen = false;
  state.providerId = selectedProvider?.id || selected.providerId;
  state.model = selectedProvider?.models.some((model) => model.id === selected.model)
    ? selected.model
    : selectedProvider ? settingsForProvider(selectedProvider).model : selected.model;
  state.generationSettings = selected.generationSettings;
  await loadConversationWorkingItems(selected.id);
  if (selectedProvider) rememberModel(state.providerId, state.model);
  closeHistoryOnMobile();
  if (navigation !== "none") updateConversationHash(selected.id, navigation);
  renderApp();
}

function switchBranch(messageId: string) {
  if (state.streaming || !knownMessageMap().has(messageId)) return;
  const tip = newestBranchTip(messageId);
  state.previewHeadId = tip === state.conversation?.headMessageId ? "" : tip;
  renderApp();
}

async function confirmBranchPreview() {
  if (!state.conversation || !state.previewHeadId) return;
  state.messageGraph = [...knownMessageMap().values()];
  state.conversation = await moveConversationHead(state.conversation.id, state.previewHeadId);
  state.previewHeadId = "";
  await refreshConversations();
  renderApp();
  scheduleRepositorySync();
}

async function newConversation() {
  const item = provider();
  const configured = configuredResponseModel();
  const created = await createConversationHistory(item?.id || "", configured?.model || "", state.generationSettings, "");
  state.conversation = created;
  state.workingItems = [];
  state.activeDraftId = "";
  state.composerFullscreen = false;
  state.generationSettings = created.generationSettings;
  await refreshConversations();
  closeHistoryOnMobile();
  updateConversationHash(created.id, "push");
  renderApp();
  scheduleRepositorySync();
}

async function removeConversation(id: string) {
  const target = state.conversations.find((item) => item.id === id);
  if (!target || !window.confirm(`删除会话“${target.name || untitledConversationLabel}”？消息节点仍会保留，直到以后手动清理。`)) return;
  await deleteConversationHistory(id);
  state.conversations = await listConversationHistory();
  if (state.conversation?.id === id) {
    if (state.conversations[0]) await selectConversation(state.conversations[0].id, "replace");
    else await newConversation();
  }
  renderApp();
  scheduleRepositorySync();
}

function chooseModel(providerId: string, model: string) {
  const item = state.config?.providers.find((candidate) => candidate.id === providerId);
  if (!item || !model || !state.conversation) return;
  state.providerId = item.id;
  state.model = model;
  state.conversation = {...state.conversation, providerId: item.id, model};
  state.modelQuery = "";
  window.localStorage.setItem("turnfold-provider", item.id);
  window.localStorage.setItem(`turnfold-model:${item.id}`, model);
  rememberModel(item.id, model);
  scheduleSettingsSave();
  renderApp();
}

function scheduleSettingsSave() {
  window.clearTimeout(state.settingsTimer);
  state.settingsTimer = window.setTimeout(() => {
    if (!state.conversation) return;
    void updateConversationHistory(state.conversation.id, state.providerId, state.model, state.generationSettings)
      .then(() => scheduleRepositorySync())
      .catch((error) => console.error("Unable to save conversation settings", error));
  }, 400);
}

function cachedProfile(value: CachedChatBootstrap | undefined) {
  return value?.profile || value?.config?.profile;
}

function legacyProviderSources(...values: Array<CachedChatBootstrap | undefined>) {
  return values.flatMap((value) => [
    ...(value?.config?.providers || []),
    ...(Array.isArray(value?.frontendProviders) ? value.frontendProviders : [])
  ]);
}

async function migrateRelevantLegacyProviders(sources: unknown[]) {
  const existing = await listLocalProviderProfiles();
  const byId = new Map(existing.map((item) => [item.id, item]));
  const relevantIds = new Set([
    ...state.localCredentials.map((item) => item.providerId),
    ...state.conversations.map((item) => item.providerId),
    window.localStorage.getItem("turnfold-provider") || ""
  ].filter(Boolean));
  for (const source of sources) {
    const migrated = migrateLegacyProviderProfile(source);
    if (!migrated || !relevantIds.has(migrated.id) || byId.has(migrated.id)) continue;
    const credential = state.localCredentials.find((item) => item.providerId === migrated.id);
    const profile = credential?.legacyBaseUrl
      ? {...migrated, baseUrl: validProviderUrl(credential.legacyBaseUrl, "Base URL")}
      : migrated;
    await saveLocalProviderProfile(profile);
    byId.set(profile.id, profile);
  }
  return [...byId.values()];
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
      : selectedProvider ? settingsForProvider(selectedProvider).model : selected.model;
    state.generationSettings = selected.generationSettings;
    await loadConversationWorkingItems(selected.id);
    if (selectedProvider) rememberModel(state.providerId, state.model);
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
  state.model = selectedProvider ? settingsForProvider(selectedProvider).model : "";
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
  state.config.providers = await migrateRelevantLegacyProviders(legacyProviderSources(stored?.config, previouslyActive?.config));
  await cacheChatConfig(repositoryId, {profile: state.config.profile});
  await restoreWorkspace();
  state.loading = false;
  state.offline = !navigator.onLine;
  if (!state.config.providers.length) {
    state.settingsOpen = true;
    providerController.openProviderEditor();
  }
  renderApp();
  if (!state.config.providers.length) window.requestAnimationFrame(() => {
    root.querySelector<HTMLElement>("#settings-providers")?.scrollIntoView({block: "start"});
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
    updateSyncIndicator();
    const preferredConversationId = state.conversation?.id || "";
    const synchronized = await synchronizeConversationRepository();
    state.lastFetchAt = synchronized.fetchedAt;
    state.initialFetchComplete = true;
    state.syncError = synchronized.conflicts ? `${synchronized.conflicts} 个会话发生分叉，本地 head 已保留` : "";
    state.offline = false;
    state.conversations = synchronized.summaries;
    await restoreWorkspace(preferredConversationId);
    state.syncing = false;
    renderApp();
    if (state.syncRequested) scheduleRepositorySync();
  } catch (error) {
    state.authenticated = false;
    state.syncing = false;
    state.offline = !navigator.onLine;
    state.syncError = error instanceof Error ? error.message : "Fetch failed";
    updateSyncIndicator();
    if (state.syncRequested && navigator.onLine) scheduleRepositorySync(1000);
  }
}

root.addEventListener("submit", (event) => {
  if (!(event.target instanceof HTMLFormElement)) return;
  if (providerController.handleSubmit(event.target)) {
    event.preventDefault();
    return;
  }
  if (event.target.id !== "composer") return;
  event.preventDefault();
  const input = event.target.elements.namedItem("message");
  if (input instanceof HTMLTextAreaElement) void sendMessage(input.value).catch(showError);
});

root.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.settingsOpen) {
    if (providerController.closeTopEditor()) return;
    state.settingsOpen = false;
    state.modelQuery = "";
    renderApp();
    return;
  }
  if (event.key === "Escape" && state.importPanelOpen && !state.importing) {
    state.importPanelOpen = false;
    renderApp();
    return;
  }
  if (event.key === "Escape" && state.composerFullscreen) {
    event.preventDefault();
    setComposerFullscreen(false);
    return;
  }
  if (!(event.target instanceof HTMLTextAreaElement) || event.target.name !== "message") return;
  const fullscreenSubmit = state.composerFullscreen && event.key === "Enter" && (event.ctrlKey || event.metaKey);
  const compactSubmit = !state.composerFullscreen && event.key === "Enter" && !event.shiftKey;
  if (fullscreenSubmit || compactSubmit) {
    event.preventDefault();
    void sendMessage(event.target.value).catch(showError);
  }
});

root.addEventListener("input", (event) => {
  const target = event.target;
  if (sessionTransferController.handleInput(target)) return;
  if (target instanceof HTMLTextAreaElement && target.name === "message") {
    syncComposerInputLayout(target);
    if (state.conversation) {
      let draft = activeDraft();
      if (!draft) {
        draft = newDraftItem(state.conversation.id);
        state.activeDraftId = draft.id;
        state.workingItems.unshift(draft);
      }
      draft.parts = target.value ? [{type: "text", text: target.value}] : [];
      draft.updatedAt = messageNow();
      checkpointWorkingItem(draft);
      updateDraftStashControl();
    }
  }
  if (target instanceof HTMLInputElement && target.dataset.action === "model-search") {
    state.modelQuery = target.value;
    renderApp();
  }
  if (providerController.handleInput(target)) return;
});

root.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (sessionTransferController.handleFileChange(target)) return;
  if (target.dataset.action === "advanced-actions" && target instanceof HTMLInputElement) {
    state.advancedActions = target.checked;
    window.localStorage.setItem("turnfold-advanced-actions", target.checked ? "1" : "0");
    renderApp();
    return;
  }
  if (target.dataset.action === "history-tree-setting" && target instanceof HTMLInputElement) {
    state.historyTree = target.checked;
    window.localStorage.setItem("turnfold-history-tree", target.checked ? "1" : "0");
    renderApp();
    return;
  }
  if (target.dataset.action === "request-assistant-reply" && target instanceof HTMLInputElement && state.conversation) {
    void ensureActiveDraft().then(async (draft) => {
      draft.requestAssistantReply = Boolean(configuredResponseModel()) && target.checked;
      target.checked = draft.requestAssistantReply;
      await persistWorkingItem(draft);
    }).catch(showError);
    return;
  }
  if (target.dataset.action === "incomplete-target-action" && target instanceof HTMLSelectElement && state.conversation) {
    void ensureActiveDraft().then(async (draft) => {
      draft.incompleteTargetAction = target.value === "interrupt" ? "interrupt" : "append";
      await persistWorkingItem(draft);
    }).catch(showError);
    return;
  }
  if (!target.dataset.setting) return;
  const key = target.dataset.setting as keyof GenerationSettings;
  if (key === "showReasoningSummary" && target instanceof HTMLInputElement) state.generationSettings.showReasoningSummary = target.checked;
  if (key === "reasoning") state.generationSettings.reasoning = target.value as GenerationSettings["reasoning"];
  if (key === "temperature") state.generationSettings.temperature = target.value === "" ? null : Math.min(2, Math.max(0, Number(target.value)));
  if (key === "maxOutputTokens") state.generationSettings.maxOutputTokens = target.value === "" ? null : Math.min(1_000_000, Math.max(1, Math.floor(Number(target.value))));
  if (state.conversation) state.conversation.generationSettings = {...state.generationSettings};
  scheduleSettingsSave();
});

root.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLElement>("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (providerController.handleAction(button)) return;
  if (sessionTransferController.handleAction(button, event.target)) return;
  if (action === "open-settings") { state.settingsOpen = true; state.modelQuery = ""; renderApp(); }
  if (action === "close-settings") { state.settingsOpen = false; providerController.closeProviderEditor(); providerController.closeProviderModelEditor(); state.modelQuery = ""; renderApp(); }
  if (action === "scroll-settings-section" && button.dataset.id) scrollSettingsSection(button.dataset.id);
  if (action === "toggle-history") { state.historyOpen = !state.historyOpen; renderApp(); }
  if (action === "close-history") { state.historyOpen = false; renderApp(); }
  if (action === "toggle-history-tree") {
    state.historyTree = !state.historyTree;
    window.localStorage.setItem("turnfold-history-tree", state.historyTree ? "1" : "0");
    renderApp();
  }
  if (action === "new-conversation") void newConversation().catch(showError);
  if (action === "switch-branch" && button.dataset.id) switchBranch(button.dataset.id);
  if (action === "leave-branch-preview") { state.previewHeadId = ""; renderApp(); }
  if (action === "confirm-branch-preview") void confirmBranchPreview().catch(showError);
  if (action === "select-conversation" && button.dataset.id) void selectConversation(button.dataset.id).catch(showError);
  if (action === "rename-conversation" && button.dataset.id) void renameConversation(button.dataset.id).catch(showError);
  if (action === "delete-conversation" && button.dataset.id) void removeConversation(button.dataset.id).catch(showError);
  if (action === "stash-draft") void stashActiveDraft().catch(showError);
  if (action === "toggle-composer-fullscreen") setComposerFullscreen(!state.composerFullscreen);
  if (action === "cancel-edit") void cancelEdit().catch(showError);
  if (action === "reply-message") void replyToMessage(Number(button.dataset.index)).catch(showError);
  if (action === "cancel-reply-target") void cancelReplyTarget().catch(showError);
  if (action === "jump-reply-target" && button.dataset.id) jumpToReplyTarget(button.dataset.id);
  if (action === "select-draft" && button.dataset.id) {
    void activateDraft(button.dataset.id).catch(showError);
  }
  if (action === "delete-working" && button.dataset.id) void deleteWorking(button.dataset.id).catch(showError);
  if (action === "commit-partial" && button.dataset.id) void commitPartial(button.dataset.id).catch(showError);
  if (action === "choose-model" && button.dataset.provider && button.dataset.model) chooseModel(button.dataset.provider, button.dataset.model);
  if (action === "reset-settings") { state.generationSettings = {...defaultGenerationSettings}; scheduleSettingsSave(); renderApp(); }
  if (action === "stop") state.streamController?.abort();
  if (action === "scroll-bottom") scrollBottom("smooth");
  if (action === "copy-message") {
    const index = Number(button.dataset.index);
    const message = displayedMessages()[index];
    if (message) void navigator.clipboard.writeText(messagePartText(message, "text")).then(() => {
      button.classList.add("copied");
      window.setTimeout(() => button.classList.remove("copied"), 1200);
    });
  }
  if (action === "edit-message") void editMessage(Number(button.dataset.index)).catch(showError);
  if (action === "regenerate-message") void regenerate(Number(button.dataset.index)).catch(showError);
});

function showError(error: unknown) {
  window.alert(error instanceof Error ? error.message : "操作失败");
}

window.addEventListener("hashchange", () => {
  const id = conversationIdFromHash(window.location.hash);
  if (id && id !== state.conversation?.id && state.conversations.some((item) => item.id === id)) void selectConversation(id, "none").catch(showError);
});
window.addEventListener("offline", () => {
  state.offline = true;
  state.syncing = false;
  state.syncError = "当前离线，提交保存在本地仓库";
  renderApp();
});
window.addEventListener("online", () => {
  state.offline = false;
  scheduleRepositorySync(0);
  renderApp();
});
window.matchMedia("(min-width: 681px)").addEventListener("change", (event) => { state.historyOpen = event.matches; renderApp(); });
window.addEventListener("resize", () => syncComposerInputLayout());
window.addEventListener("pagehide", () => {
  const draft = activeDraft();
  if (draft) void persistWorkingItem(draft);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  const draft = activeDraft();
  if (draft) void persistWorkingItem(draft);
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register(appUrl("/sw.js?v=7"), {scope: `${basePath}/`}).catch((error) => console.error("Unable to register service worker", error));

renderApp();
initialize().catch((error) => {
  state.loading = false;
  state.error = error instanceof Error ? error.message : "配置加载失败";
  renderApp();
});
