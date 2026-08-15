import type {StoredChatMessage, WorkingItem} from "../shared/conversation-types";
import type {AppState} from "./app-state";
import {configuredResponseModel} from "./app-selectors";
import {messagePartText} from "./conversation-selectors";
import {workingItemText} from "./draft-model";
import {escapeHtml} from "./html";
import {finishingMarkdownMessages} from "./markdown-renderer";

type IconSet = typeof import("./icons").icons;

type ThreadDependencies = {
  icons: IconSet;
  activeDraft: () => WorkingItem | null;
  displayedMessages: () => StoredChatMessage[];
  graphVersion: () => number;
  messageChildren: (parentMessageId: string | null) => StoredChatMessage[];
  rootEditAlternatives: (messageId: string) => StoredChatMessage[];
  renderMarkdownContainer: (value: string, messageId: string, complete: boolean) => string;
  renderModelPicker: () => string;
  renderWorkingPanel: () => string;
  renderComposerControls: (draft: WorkingItem | null) => string;
};

export function createThreadView(state: AppState, dependencies: ThreadDependencies) {
  function isStreamingAssistant(message: StoredChatMessage) {
    return state.streaming
      && state.conversation?.messages.at(-1)?.id === message.id;
  }

  function activeReplyTargetId() {
    const draft = dependencies.activeDraft();
    if (!draft || draft.editSourceMessageId) return undefined;
    const latestId = dependencies.displayedMessages().at(-1)?.id || null;
    return draft.observedHeadId === latestId ? undefined : draft.observedHeadId;
  }

  function replyAction(message: StoredChatMessage, index: number) {
    return `<button class="icon-button" type="button" data-action="reply-message" data-index="${index}" aria-label="回复到这条消息" title="回复到这条消息">${dependencies.icons.reply}</button>`;
  }

  type MessageMarkupCacheEntry = {
    message: StoredChatMessage;
    index: number;
    streaming: boolean;
    advancedActions: boolean;
    replyTarget: boolean;
    graphVersion: number;
    html: string;
  };
  const messageMarkupCache = new Map<string, MessageMarkupCacheEntry>();

  function renderMessage(message: StoredChatMessage, index: number) {
    const replyTarget = activeReplyTargetId() === message.id;
    const streamingMessage = isStreamingAssistant(message);
    // The streaming message's parts mutate in place, so it always re-renders.
    if (!streamingMessage) {
      const entry = messageMarkupCache.get(message.id);
      const graphVersion = dependencies.graphVersion();
      if (
        entry
        && entry.message === message
        && entry.index === index
        && entry.streaming === state.streaming
        && entry.advancedActions === state.advancedActions
        && entry.replyTarget === replyTarget
        && entry.graphVersion === graphVersion
      ) return entry.html;
      const html = renderMessageMarkup(message, index, replyTarget, streamingMessage);
      messageMarkupCache.set(message.id, {message, index, streaming: state.streaming, advancedActions: state.advancedActions, replyTarget, graphVersion, html});
      return html;
    }
    return renderMessageMarkup(message, index, replyTarget, streamingMessage);
  }

  function renderMessageMarkup(message: StoredChatMessage, index: number, replyTarget: boolean, streamed: boolean) {
    const messageAttributes = `data-message-index="${index}" data-message-id="${escapeHtml(message.id)}"`;
    const branches = renderBranchNavigator(message);
    if (message.role === "user") {
      return `<article class="message user-message${replyTarget ? " reply-target" : ""}" ${messageAttributes}><div class="message-content user-content"><p>${escapeHtml(messagePartText(message, "text"))}</p></div><div class="user-message-actions">${replyAction(message, index)}<button class="icon-button" type="button" data-action="edit-message" data-index="${index}" aria-label="编辑消息"${state.streaming ? " disabled" : ""}>${dependencies.icons.edit}</button>${branches}</div></article>`;
    }
    if (message.role !== "assistant") return "";
    const reasoning = messagePartText(message, "reasoning");
    const text = messagePartText(message, "text");
    const renderedText = text ? dependencies.renderMarkdownContainer(text, message.id, !streamed || finishingMarkdownMessages.has(message.id)) : null;
    const error = message.parts.find((part) => part.type === "error" && typeof part.text === "string")?.text;
    const response = message.metadata?.custom?.response;
    const modelLabel = response?.model ? `${response.providerId || state.providerId}/${response.model}` : `${state.providerId}/${state.model}`;
    const speed = typeof response?.tokensPerSecond === "number" ? `${response.tokensPerSecond.toFixed(1)} tok/s` : "速度 —";
    const detail = response?.durationMs ? `${(response.durationMs / 1000).toFixed(1)} 秒${typeof response.outputTokens === "number" ? ` · ${response.outputTokens} tokens` : ""}` : "历史回复未记录速度";
    const partial = message.completion.status === "partial" ? `<span class="partial-badge">未完成${message.completion.reason ? ` · ${escapeHtml(message.completion.reason)}` : ""}</span>` : "";
    return `<article class="message assistant-message${replyTarget ? " reply-target" : ""}" ${messageAttributes}><div class="message-content assistant-content">${reasoning ? `<details class="message-reasoning"><summary>思考过程</summary><div>${escapeHtml(reasoning)}</div></details>` : ""}${renderedText || streamed ? renderedText || '<span class="response-loader"></span>' : ""}${error ? `<div class="message-error">${escapeHtml(error)}</div>` : ""}</div><div class="message-footer"><div class="response-summary"><div class="response-meta" title="${escapeHtml(detail)}"><span>${escapeHtml(modelLabel)}</span><span>${escapeHtml(speed)}</span></div>${partial}</div><div class="message-actions">${branches}${replyAction(message, index)}<button class="icon-button" type="button" data-action="copy-message" data-index="${index}" aria-label="复制回答">${dependencies.icons.copy}</button>${state.advancedActions ? `<button class="icon-button" type="button" data-action="edit-message" data-index="${index}" aria-label="编辑回答"${state.streaming ? " disabled" : ""}>${dependencies.icons.edit}</button>` : ""}<button class="icon-button" type="button" data-action="regenerate-message" data-index="${index}" aria-label="重新生成"${state.streaming ? " disabled" : ""}>${dependencies.icons.retry}</button></div></div></article>`;
  }

  function renderBranchNavigator(message: StoredChatMessage) {
    const siblings = message.parentMessageId === null
      ? dependencies.rootEditAlternatives(message.id)
      : dependencies.messageChildren(message.parentMessageId);
    if (siblings.length < 2) return "";
    const index = siblings.findIndex((candidate) => candidate.id === message.id);
    if (index < 0) return "";
    const previous = siblings[(index - 1 + siblings.length) % siblings.length];
    const next = siblings[(index + 1) % siblings.length];
    return `<span class="branch-navigator" aria-label="分支 ${index + 1}/${siblings.length}"><button class="icon-button" type="button" data-action="switch-branch" data-id="${escapeHtml(previous.id)}" aria-label="上一个分支">‹</button><span>${index + 1} / ${siblings.length}</span><button class="icon-button" type="button" data-action="switch-branch" data-id="${escapeHtml(next.id)}" aria-label="下一个分支">›</button></span>`;
  }

  function renderMessagesMarkup() {
    const messages = dependencies.displayedMessages();
    if (!messages.length) {
      const description = state.authenticated
        ? "Provider 由当前浏览器直连；对话记录按当前身份同步。"
        : "Provider 由当前浏览器直连；对话与草稿保存在本机。";
      return `<div class="welcome"><div class="welcome-mark">TF</div><h1>今天想聊什么？</h1><p>${escapeHtml(description)}</p></div>`;
    }
    return messages.map(renderMessage).join("");
  }

  function renderBranchPreviewNotice() {
    if (!state.previewHeadId || state.previewHeadId === state.conversation?.headMessageId) return "";
    return `<div class="branch-preview-notice"><span>正在查看非当前分支</span><div><button type="button" data-action="leave-branch-preview">返回当前分支</button><button type="button" data-action="confirm-branch-preview">将当前会话切换到这里</button></div></div>`;
  }

  function renderThread() {
    const draft = dependencies.activeDraft();
    const editing = Boolean(draft?.editSourceMessageId);
    const editRole = draft?.messageRole === "assistant" ? "助手回答" : "用户消息";
    const fullscreen = state.composerFullscreen;
    const queued = draft?.id === state.queuedDraftId;
    const responseModelAvailable = Boolean(configuredResponseModel(state));
    const note = !responseModelAvailable ? "消息仍会保存；配置模型后才能请求回答。" : queued ? "已排队；会在当前回答完成后提交。" : state.offline ? "离线模式：提交保存在本地仓库，联网后自动 push。" : "草稿自动保存在此浏览器；模型可能会出错。";
    const editorLabel = editing ? `正在编辑${editRole}` : "全屏编辑";
    const fullscreenHeader = fullscreen
      ? `<header class="fullscreen-editor-header"><span><strong>${editorLabel}</strong><small>草稿自动保存在此浏览器</small></span><button type="button" data-action="toggle-composer-fullscreen" aria-label="退出全屏编辑" title="退出全屏编辑（Esc）">${dependencies.icons.close}</button></header>`
      : "";
    const placeholder = fullscreen
      ? editing ? "编辑消息；Ctrl/⌘ + Enter 提交" : "输入消息；Ctrl/⌘ + Enter 提交"
      : editing ? "编辑消息，提交后从此处继续" : "输入消息，Enter 发送，Shift + Enter 换行";
    // The message list stays empty here: renderMessages() fills it (and patches
    // it incrementally), so renderApp never re-parses the full message markup.
    return `<section class="thread-root"><div class="thread-viewport" id="thread-viewport">${renderBranchPreviewNotice()}<div id="message-list"></div><div class="thread-footer${fullscreen ? " fullscreen-editor" : ""}">${fullscreenHeader}<button class="scroll-button" type="button" data-action="scroll-bottom" aria-label="滚动到底部">${dependencies.icons.scroll}</button>${dependencies.renderWorkingPanel()}${editing ? `<div class="edit-context"><span>正在编辑${editRole}；提交后当前会话将从这里继续</span><button type="button" data-action="cancel-edit">取消</button></div>` : ""}<form class="composer" id="composer"><textarea class="composer-input" name="message" placeholder="${placeholder}" rows="1" aria-label="聊天消息">${escapeHtml(draft ? workingItemText(draft) : "")}</textarea><div class="composer-actions">${state.streaming ? `<button class="stop-button" type="button" data-action="stop" aria-label="停止生成">${dependencies.icons.stop}</button>` : ""}<button class="fullscreen-button" type="button" data-action="toggle-composer-fullscreen" aria-label="${fullscreen ? "退出全屏编辑" : "进入全屏编辑"}" title="${fullscreen ? "退出全屏编辑" : "全屏编辑"}"${fullscreen ? "" : " hidden"}>${fullscreen ? dependencies.icons.collapse : dependencies.icons.expand}</button></div>${dependencies.renderModelPicker()}<button class="send-button" type="submit" data-action="send" aria-label="${state.streaming ? "排队发送" : "发送消息"}">${dependencies.icons.send}</button></form><p class="composer-note${state.offline ? " offline" : ""}${queued ? " queued" : ""}">${note}</p></div></div></section>`;
  }

  return {renderMessage, renderMessagesMarkup, renderThread};
}
