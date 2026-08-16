import {createInitialAppState} from "./app-state";
import {conversationIdFromHash} from "../shared/conversation-hash";
import {defaultGenerationSettings} from "../shared/generation-settings";
import {configuredResponseModel, localCredential} from "./app-selectors";
import {createBootstrap} from "./bootstrap";
import {createComposerView} from "./composer-view";
import {updateConversationHistory} from "./conversation-client";
import {createConversationSelectors, messagePartText} from "./conversation-selectors";
import {createConversationActions} from "./conversation-actions";
import {createDraftActions} from "./draft-actions";
import {createDraftModel} from "./draft-model";
import {reconcileHtml, type DomReconcileOptions} from "./dom-reconciler";
import {appUrl, basePath, homeUrl} from "./environment";
import {createGenerationController} from "./generation-controller";
import {createHistoryView} from "./history-view";
import {escapeHtml} from "./html";
import {icons} from "./icons";
import {createIdentitySyncView} from "./identity-view";
import {createMarkdownRenderer} from "./markdown-renderer";
import {createMessageListView} from "./message-list-view";
import {createModelSelection} from "./model-selection";
import {createProviderController} from "./providers/provider-controller";
import {createProviderStreaming} from "./provider-streaming";
import {createSessionTransferController} from "./session-transfer-controller";
import {createSettingsView} from "./settings-view";
import {createSyncController} from "./sync-controller";
import {createThreadView} from "./thread-view";
import {uuid} from "./uuid";
import {updateAvatar} from "./avatar";
import {isViewportAtBottom, scrollBottom} from "./viewport";

const rootElement = document.querySelector<HTMLDivElement>("#app");
if (!rootElement) throw new Error("Application root is missing");
const root: HTMLDivElement = rootElement;

const state = createInitialAppState();

// Domain selectors and models (constructed once, shared by every view and controller).
const selectors = createConversationSelectors(state);
const draftModel = createDraftModel(state, {
  uuid,
  displayedHeadId: () => selectors.displayedMessages().at(-1)?.id || null
});

const markdown = createMarkdownRenderer({
  root,
  escapeHtml,
  isViewportAtBottom,
  scrollBottom: () => scrollBottom(root)
});

const appDomReconcileOptions: DomReconcileOptions = {
  preserveChildren: (element) => element.id === "message-list",
  beforeDiscard: (node) => {
    if (!(node instanceof Element)) return;
    if (node.matches('.math-fragment, [data-math-rendered="1"]') || node.querySelector('.math-fragment, [data-math-rendered="1"]')) markdown.clearMathTypesetting(node);
  }
};

function renderApp() {
  if (state.error) {
    reconcileHtml(root, `<main class="state-page"><div class="state-card"><span class="state-mark">!</span><h1>聊天服务暂时不可用</h1><p>${escapeHtml(state.error)}</p>${settingsView.renderProviderSettings()}</div></main>`, appDomReconcileOptions);
    return;
  }
  if (state.loading || !state.config) {
    reconcileHtml(root, '<main class="state-page"><div class="state-card"><span class="loader"></span><p>正在读取本地工作区…</p></div></main>', appDomReconcileOptions);
    return;
  }
  const profile = state.config.profile;
  const usableProvider = state.config.providers.some((item) => item.models.length > 0);
  const workspace = state.conversation
    ? threadView.renderThread()
    : `<section class="empty-workspace"><div class="welcome-mark">TF</div><h1>开始一个新对话</h1><p>${usableProvider ? "当前模型已就绪，也可以只记录消息而不请求回答。" : "无需配置模型即可记录消息；配置模型后才能勾选“需要回答”。"}</p><button type="button" data-action="new-conversation" title="开始一个新对话">新对话</button></section>`;
  reconcileHtml(root, `<main class="app-shell with-history${state.historyOpen ? " history-open" : ""}"><header class="app-header"><div class="header-leading"><button class="history-toggle" type="button" data-action="toggle-history" aria-label="聊天历史" title="聊天历史">${icons.history}</button></div><div class="brand"><a class="portal-home-link" href="${escapeHtml(homeUrl)}" aria-label="Turnfold 主页" title="Turnfold"><img src="${appUrl("/favicon.svg")}" alt=""></a></div><div class="chat-controls">${identityView.renderIdentitySyncControl(profile)}</div></header>${historyView.renderHistory()}${workspace}${sessionTransferController.renderImportPanel()}${settingsView.renderSettingsPage()}</main>`, appDomReconcileOptions);
  if (state.conversation) messageListView.renderMessages();
  window.requestAnimationFrame(() => composerView.syncComposerInputLayout());
  void updateAvatar(root, profile);
}

// Existing view factories that keep their own lifecycle state.
const modelSelection = createModelSelection(state, escapeHtml);
const settingsView = createSettingsView(state, {
  escapeHtml,
  localCredential: (providerId = state.providerId) => localCredential(state, providerId),
  availableModelChoices: modelSelection.availableModelChoices,
  renderEffortControl: modelSelection.renderEffortControl,
  renderModelOption: modelSelection.renderModelOption
});
const historyView = createHistoryView(state, escapeHtml);
const identityView = createIdentitySyncView(state, {root, icons});

// Views extracted from the former app monolith.
const composerView = createComposerView(state, {
  root,
  icons,
  appDomReconcileOptions,
  renderApp,
  activeDraft: draftModel.activeDraft,
  canStashActiveDraft: draftModel.canStashActiveDraft,
  displayedMessages: selectors.displayedMessages,
  knownMessageMap: selectors.knownMessageMap
});
const threadView = createThreadView(state, {
  icons,
  activeDraft: draftModel.activeDraft,
  displayedMessages: selectors.displayedMessages,
  graphVersion: selectors.graphVersion,
  messageChildren: selectors.messageChildren,
  rootEditAlternatives: selectors.rootEditAlternatives,
  renderMarkdownContainer: markdown.renderMarkdownContainer,
  renderModelPicker: modelSelection.renderModelPicker,
  renderWorkingPanel: composerView.renderWorkingPanel,
  renderComposerControls: composerView.renderComposerControls
});
const messageListView = createMessageListView(state, {
  root,
  icons,
  renderApp,
  renderMessage: threadView.renderMessage,
  renderMessagesMarkup: threadView.renderMessagesMarkup,
  displayedMessages: selectors.displayedMessages,
  clearMathTypesetting: markdown.clearMathTypesetting,
  scheduleMathTypesetting: markdown.scheduleMathTypesetting
});

// Service and action controllers.
const providerStreaming = createProviderStreaming(state);
const syncController = createSyncController(state, {
  root,
  updateSyncIndicator: identityView.updateSyncIndicator,
  renderMessages: messageListView.renderMessages,
  renderHistoryItems: historyView.renderHistoryItems
});
const draftActions = createDraftActions(state, {
  root,
  renderApp,
  activeDraft: draftModel.activeDraft,
  newDraftItem: draftModel.newDraftItem,
  displayedMessages: selectors.displayedMessages,
  knownMessageMap: selectors.knownMessageMap,
  newestBranchTip: selectors.newestBranchTip,
  syncComposerInputLayout: composerView.syncComposerInputLayout
});
const conversationActions = createConversationActions(state, {
  renderApp,
  refreshConversations: syncController.refreshConversations,
  scheduleRepositorySync: syncController.scheduleRepositorySync,
  loadConversationWorkingItems: draftActions.loadConversationWorkingItems,
  settingsForProvider: modelSelection.settingsForProvider,
  rememberModel: modelSelection.rememberModel,
  knownMessageMap: selectors.knownMessageMap,
  newestBranchTip: selectors.newestBranchTip
});
const generationController = createGenerationController(state, {
  root,
  reportError: showError,
  activeDraft: draftModel.activeDraft,
  displayedMessages: selectors.displayedMessages,
  knownMessageMap: selectors.knownMessageMap,
  renderApp,
  renderMessages: messageListView.renderMessages,
  scheduleMessagesRender: messageListView.scheduleMessagesRender,
  updateComposerControls: composerView.updateComposerControls,
  updateStreamingControls: messageListView.updateStreamingControls,
  renderHistoryItems: historyView.renderHistoryItems,
  refreshConversations: syncController.refreshConversations,
  scheduleRepositorySync: syncController.scheduleRepositorySync,
  persistWorkingItem: draftActions.persistWorkingItem,
  discardWorkingItem: draftActions.discardWorkingItem,
  checkpointWorkingItem: draftActions.checkpointWorkingItem,
  streamLocalProvider: providerStreaming.streamLocalProvider,
  nextAvailableConversationName: conversationActions.nextAvailableConversationName
});

const providerController = createProviderController(state, {
  root,
  render: renderApp,
  localCredential: (providerId = state.providerId) => localCredential(state, providerId),
  settingsForProvider: modelSelection.settingsForProvider,
  scheduleSettingsSave,
  discoverProvider: providerStreaming.discoverLocalProvider,
  reportError: showError
});
const sessionTransferController = createSessionTransferController(state, {
  root,
  escapeHtml,
  uuid,
  render: renderApp,
  conversationObjects: selectors.conversationGraphObjects,
  selectConversation: (id) => conversationActions.selectConversation(id),
  scheduleSync: syncController.scheduleRepositorySync,
  reportError: showError
});
const bootstrap = createBootstrap(state, {
  root,
  renderApp,
  updateSyncIndicator: identityView.updateSyncIndicator,
  scheduleRepositorySync: syncController.scheduleRepositorySync,
  loadConversationWorkingItems: draftActions.loadConversationWorkingItems,
  settingsForProvider: modelSelection.settingsForProvider,
  rememberModel: modelSelection.rememberModel,
  providerController: {openProviderEditor: providerController.openProviderEditor}
});

function scrollSettingsSection(id: string) {
  const section = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  section?.scrollIntoView({behavior: "smooth", block: "start"});
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
  modelSelection.rememberModel(item.id, model);
  scheduleSettingsSave();
  renderApp();
}

function scheduleSettingsSave() {
  window.clearTimeout(state.settingsTimer);
  state.settingsTimer = window.setTimeout(() => {
    if (!state.conversation) return;
    void updateConversationHistory(state.conversation.id, state.providerId, state.model, state.generationSettings)
      .then(() => syncController.scheduleRepositorySync())
      .catch((error) => console.error("Unable to save conversation settings", error));
  }, 400);
}

function showError(error: unknown) {
  window.alert(error instanceof Error ? error.message : "操作失败");
}

const popupDetailsSelector = "[data-popup]";

function closePopupDetails(clickTarget?: Element) {
  const clickedPopup = clickTarget?.closest<HTMLDetailsElement>(popupDetailsSelector) || null;
  root.querySelectorAll<HTMLDetailsElement>(popupDetailsSelector).forEach((popup) => {
    if (popup !== clickedPopup && popup.open) popup.open = false;
  });
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
  if (input instanceof HTMLTextAreaElement) void generationController.sendMessage(input.value).catch(showError);
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
    composerView.setComposerFullscreen(false);
    return;
  }
  if (!(event.target instanceof HTMLTextAreaElement) || event.target.name !== "message") return;
  const fullscreenSubmit = state.composerFullscreen && event.key === "Enter" && (event.ctrlKey || event.metaKey);
  const compactSubmit = !state.composerFullscreen && event.key === "Enter" && !event.shiftKey;
  if (fullscreenSubmit || compactSubmit) {
    event.preventDefault();
    void generationController.sendMessage(event.target.value).catch(showError);
  }
});

root.addEventListener("input", (event) => {
  const target = event.target;
  if (sessionTransferController.handleInput(target)) return;
  if (target instanceof HTMLTextAreaElement && target.name === "message") {
    composerView.syncComposerInputLayout(target);
    messageListView.updateScrollButton();
    if (state.conversation) {
      let draft = draftModel.activeDraft();
      if (!draft) {
        draft = draftModel.newDraftItem(state.conversation.id);
        state.activeDraftId = draft.id;
        state.workingItems.unshift(draft);
      }
      draft.parts = target.value ? [{type: "text", text: target.value}] : [];
      draft.updatedAt = new Date().toISOString();
      draftActions.checkpointWorkingItem(draft);
      composerView.updateDraftStashControl();
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
    void draftActions.ensureActiveDraft().then(async (draft) => {
      draft.requestAssistantReply = Boolean(configuredResponseModel(state)) && target.checked;
      target.checked = draft.requestAssistantReply;
      await draftActions.persistWorkingItem(draft);
    }).catch(showError);
    return;
  }
  if (target.dataset.action === "incomplete-target-action" && target instanceof HTMLSelectElement && state.conversation) {
    void draftActions.ensureActiveDraft().then(async (draft) => {
      draft.incompleteTargetAction = target.value === "interrupt" ? "interrupt" : "append";
      await draftActions.persistWorkingItem(draft);
    }).catch(showError);
    return;
  }
  if (!target.dataset.setting) return;
  const key = target.dataset.setting as keyof typeof state.generationSettings;
  if (key === "showReasoningSummary" && target instanceof HTMLInputElement) state.generationSettings.showReasoningSummary = target.checked;
  if (key === "reasoning") state.generationSettings.reasoning = target.value as typeof state.generationSettings.reasoning;
  if (key === "temperature") state.generationSettings.temperature = target.value === "" ? null : Math.min(2, Math.max(0, Number(target.value)));
  if (key === "maxOutputTokens") state.generationSettings.maxOutputTokens = target.value === "" ? null : Math.min(1_000_000, Math.max(1, Math.floor(Number(target.value))));
  if (state.conversation) state.conversation.generationSettings = {...state.generationSettings};
  scheduleSettingsSave();
});

root.addEventListener("click", (event) => {
  closePopupDetails(event.target instanceof Element ? event.target : undefined);
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
  if (action === "new-conversation") void conversationActions.newConversation().catch(showError);
  if (action === "switch-branch" && button.dataset.id) conversationActions.switchBranch(button.dataset.id);
  if (action === "leave-branch-preview") { state.previewHeadId = ""; renderApp(); }
  if (action === "confirm-branch-preview") void conversationActions.confirmBranchPreview().catch(showError);
  if (action === "select-conversation" && button.dataset.id) void conversationActions.selectConversation(button.dataset.id).catch(showError);
  if (action === "rename-conversation" && button.dataset.id) void conversationActions.renameConversation(button.dataset.id).catch(showError);
  if (action === "delete-conversation" && button.dataset.id) void conversationActions.removeConversation(button.dataset.id).catch(showError);
  if (action === "stash-draft") void draftActions.stashActiveDraft().catch(showError);
  if (action === "toggle-composer-fullscreen") composerView.setComposerFullscreen(!state.composerFullscreen);
  if (action === "cancel-edit") void draftActions.cancelEdit().catch(showError);
  if (action === "reply-message") void draftActions.replyToMessage(Number(button.dataset.index)).catch(showError);
  if (action === "cancel-reply-target") void draftActions.cancelReplyTarget().catch(showError);
  if (action === "jump-reply-target" && button.dataset.id) draftActions.jumpToReplyTarget(button.dataset.id);
  if (action === "select-draft" && button.dataset.id) {
    void draftActions.activateDraft(button.dataset.id).catch(showError);
  }
  if (action === "delete-working" && button.dataset.id) void draftActions.deleteWorking(button.dataset.id).catch(showError);
  if (action === "commit-partial" && button.dataset.id) void conversationActions.commitPartial(button.dataset.id).catch(showError);
  if (action === "choose-model" && button.dataset.provider && button.dataset.model) chooseModel(button.dataset.provider, button.dataset.model);
  if (action === "reset-settings") { state.generationSettings = {...defaultGenerationSettings}; scheduleSettingsSave(); renderApp(); }
  if (action === "stop") state.streamController?.abort();
  if (action === "scroll-bottom") scrollBottom(root, "smooth");
  if (action === "copy-message") {
    const index = Number(button.dataset.index);
    const message = selectors.displayedMessages()[index];
    if (message) void navigator.clipboard.writeText(messagePartText(message, "text")).then(() => {
      button.classList.add("copied");
      window.setTimeout(() => button.classList.remove("copied"), 1200);
    });
  }
  if (action === "edit-message") void draftActions.editMessage(Number(button.dataset.index)).catch(showError);
  if (action === "regenerate-message") void generationController.regenerate(Number(button.dataset.index)).catch(showError);
});

window.addEventListener("hashchange", () => {
  const id = conversationIdFromHash(window.location.hash);
  if (id && id !== state.conversation?.id && state.conversations.some((item) => item.id === id)) void conversationActions.selectConversation(id, "none").catch(showError);
});
window.addEventListener("offline", () => {
  state.offline = true;
  state.syncing = false;
  state.syncError = "当前离线，提交保存在本地仓库";
  renderApp();
});
window.addEventListener("online", () => {
  state.offline = false;
  syncController.scheduleRepositorySync(0);
  renderApp();
});
window.matchMedia("(min-width: 681px)").addEventListener("change", (event) => { state.historyOpen = event.matches; renderApp(); });
window.addEventListener("resize", () => composerView.syncComposerInputLayout());
window.addEventListener("pagehide", () => {
  const draft = draftModel.activeDraft();
  if (draft) void draftActions.persistWorkingItem(draft);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  const draft = draftModel.activeDraft();
  if (draft) void draftActions.persistWorkingItem(draft);
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register(appUrl("/sw.js?v=9"), {scope: `${basePath}/`}).catch((error) => console.error("Unable to register service worker", error));

renderApp();
bootstrap.initialize().catch((error) => {
  state.loading = false;
  state.error = error instanceof Error ? error.message : "配置加载失败";
  renderApp();
});
