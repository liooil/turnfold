import type {WorkingItem, StoredChatMessage} from "../shared/conversation-types";
import type {AppState} from "./app-state";
import {configuredResponseModel} from "./app-selectors";
import {messagePartText} from "./conversation-selectors";
import {draftLabel, workingItemText} from "./draft-model";
import {reconcileElement, type DomReconcileOptions} from "./dom-reconciler";
import {escapeHtml} from "./html";

type IconSet = typeof import("./icons").icons;

type ComposerDependencies = {
  root: HTMLElement;
  icons: IconSet;
  appDomReconcileOptions: DomReconcileOptions;
  renderApp: () => void;
  activeDraft: () => WorkingItem | null;
  canStashActiveDraft: () => boolean;
  displayedMessages: () => StoredChatMessage[];
  knownMessageMap: () => Map<string, StoredChatMessage>;
};

export function createComposerView(state: AppState, dependencies: ComposerDependencies) {
  function replyTargetLabel(message: StoredChatMessage) {
    const role = message.role === "assistant" ? "助手" : message.role === "user" ? "用户" : "系统";
    const text = messagePartText(message, "text").replace(/\s+/g, " ").trim();
    const partial = message.completion.status === "partial" ? " · 未完成" : "";
    return `${role}${partial} · ${text.slice(0, 48) || "空消息"}`;
  }

  function renderComposerControls(draft: WorkingItem | null) {
    const messages = dependencies.displayedMessages();
    const targetId = draft ? draft.observedHeadId : messages.at(-1)?.id || null;
    const target = targetId ? dependencies.knownMessageMap().get(targetId) : null;
    const latestId = messages.at(-1)?.id || null;
    const showReplyContext = Boolean(draft && !draft.editSourceMessageId && targetId !== latestId);
    const replyContext = showReplyContext
      ? `<div class="reply-context" aria-label="指定回复目标"><span class="reply-context-icon" title="回复到" aria-hidden="true">${dependencies.icons.reply}</span><button type="button" data-action="jump-reply-target" data-id="${escapeHtml(targetId || "__root__")}" aria-label="跳转到回复目标：${escapeHtml(target ? replyTargetLabel(target) : "会话开头")}">${escapeHtml(target ? replyTargetLabel(target) : "会话开头")}</button><button class="reply-cancel" type="button" data-action="cancel-reply-target" aria-label="取消指定回复目标">${dependencies.icons.close}</button></div>`
      : "";
    const incompleteControl = target?.completion.status === "partial"
      ? `<label>未完成消息<select data-action="incomplete-target-action"><option value="append"${draft?.incompleteTargetAction !== "interrupt" ? " selected" : ""}>排在它下面</option><option value="interrupt"${draft?.incompleteTargetAction === "interrupt" ? " selected" : ""}>中断并替换它</option></select></label>`
      : "";
    return `<div class="composer-controls">${replyContext}${incompleteControl}</div>`;
  }

  function updateComposerControls() {
    const controls = dependencies.root.querySelector<HTMLElement>(".composer-controls");
    if (controls) reconcileElement(controls, renderComposerControls(dependencies.activeDraft()), dependencies.appDomReconcileOptions);
  }

  function renderWorkingPanel() {
    const drafts = state.workingItems.filter((item) => item.kind === "user-draft" && item.id !== state.activeDraftId);
    const unfinished = state.workingItems.filter((item) => item.kind === "assistant-stream" && item.status !== "streaming");
    const responseModelAvailable = Boolean(configuredResponseModel(state));
    const requestAssistantReply = responseModelAvailable && (dependencies.activeDraft()?.requestAssistantReply ?? true);
    const assistantReplyToggle = state.advancedActions
      ? `<label class="assistant-reply-toggle"${responseModelAvailable ? "" : ' title="请先配置并选择模型"'}><input type="checkbox" data-action="request-assistant-reply"${requestAssistantReply ? " checked" : ""}${responseModelAvailable ? "" : " disabled"}>需要回答</label>`
      : "";
    const draftRows = drafts.map((item) => {
      const text = workingItemText(item).trim().replace(/\s+/g, " ");
      return `<div class="draft-row" data-dom-key="draft:${escapeHtml(item.id)}"><button type="button" data-action="select-draft" data-id="${escapeHtml(item.id)}"><strong>${escapeHtml(text.slice(0, 36) || "空白草稿")}</strong><small>${draftLabel(item)} · ${new Date(item.updatedAt).toLocaleString()}</small></button><button type="button" data-action="delete-working" data-id="${escapeHtml(item.id)}" aria-label="删除草稿">${dependencies.icons.trash}</button></div>`;
    }).join("");
    const unfinishedRows = unfinished.map((item) => {
      const text = workingItemText(item).trim().replace(/\s+/g, " ");
      return `<div class="unfinished-row" data-dom-key="unfinished:${escapeHtml(item.id)}"><span><strong>未完成回答</strong><small>${escapeHtml(text.slice(0, 64) || "尚未输出正文")} · ${new Date(item.updatedAt).toLocaleString()}</small></span><button type="button" data-action="commit-partial" data-id="${escapeHtml(item.id)}">保留</button><button type="button" data-action="delete-working" data-id="${escapeHtml(item.id)}">清理</button></div>`;
    }).join("");
    const canStash = dependencies.canStashActiveDraft();
    return `<div class="working-panel">${assistantReplyToggle}${renderComposerControls(dependencies.activeDraft())}${unfinishedRows ? `<details class="unfinished-menu"><summary>未完成 ${unfinished.length}</summary><div>${unfinishedRows}</div></details>` : ""}<details class="draft-menu"><summary>草稿 ${drafts.length}</summary><div><button class="stash-draft" type="button" data-action="stash-draft" aria-label="将当前编辑区收起为草稿" title="${canStash ? "将当前编辑区收起到草稿列表" : "当前编辑区为空"}"${canStash ? "" : " disabled"}>${dependencies.icons.stash}收起为草稿</button>${draftRows}</div></details></div>`;
  }

  function updateDraftStashControl() {
    const button = dependencies.root.querySelector<HTMLButtonElement>('[data-action="stash-draft"]');
    if (!button) return;
    const canStash = dependencies.canStashActiveDraft();
    button.disabled = !canStash;
    button.title = canStash ? "将当前编辑区收起到草稿列表" : "当前编辑区为空";
  }

  const compactComposerLineLimit = 3;

  function syncComposerInputLayout(input = dependencies.root.querySelector<HTMLTextAreaElement>('textarea[name="message"]')) {
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
    const currentInput = dependencies.root.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    const selectionStart = currentInput?.selectionStart ?? 0;
    const selectionEnd = currentInput?.selectionEnd ?? selectionStart;
    state.composerFullscreen = fullscreen;
    dependencies.renderApp();
    window.requestAnimationFrame(() => {
      const nextInput = dependencies.root.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
      if (!fullscreen) syncComposerInputLayout(nextInput);
      nextInput?.focus();
      nextInput?.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  return {renderComposerControls, updateComposerControls, renderWorkingPanel, updateDraftStashControl, syncComposerInputLayout, setComposerFullscreen};
}
