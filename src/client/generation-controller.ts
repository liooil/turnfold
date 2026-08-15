import {conversationTitlePrompt, normalizeGeneratedConversationTitle} from "../shared/conversation-title";
import type {Conversation, StoredChatMessage, WorkingItem} from "../shared/conversation-types";
import type {GenerationSettings} from "../shared/generation-settings";
import type {AppState, ChatProvider} from "./app-state";
import {configuredResponseModel} from "./app-selectors";
import {messagePartText} from "./conversation-selectors";
import {commitConversationMessage, getConversationHistory, moveConversationHead, updateConversationHistory} from "./conversation-client";
import {messageNow, requestAssistantReplyForSubmission, workingItemText} from "./draft-model";
import {finishingMarkdownMessages, streamingMarkdownCaches} from "./markdown-renderer";
import {immutableMessage} from "./message-factory";
import type {StreamEvent, StreamRequestContext} from "./provider-streaming";
import {workingItemRepository} from "./repository/repositories";
import {uuid} from "./uuid";

const titleGenerationConversationIds = new Set<string>();

type GenerationDependencies = {
  root: HTMLElement;
  reportError: (error: unknown) => void;
  activeDraft: () => WorkingItem | null;
  displayedMessages: () => StoredChatMessage[];
  knownMessageMap: () => Map<string, StoredChatMessage>;
  renderApp: () => void;
  renderMessages: (scroll?: boolean) => void;
  scheduleMessagesRender: (scroll?: boolean) => void;
  updateComposerControls: () => void;
  updateStreamingControls: () => void;
  renderHistoryItems: () => string;
  refreshConversations: () => Promise<void>;
  scheduleRepositorySync: (delay?: number) => void;
  persistWorkingItem: (item: WorkingItem, render?: boolean) => Promise<void>;
  discardWorkingItem: (id: string) => Promise<void>;
  checkpointWorkingItem: (item: WorkingItem) => void;
  streamLocalProvider: (messages: StoredChatMessage[], onEvent: (event: StreamEvent) => void, signal: AbortSignal, context?: StreamRequestContext) => Promise<void>;
  nextAvailableConversationName: (base: string) => string;
};

export function createGenerationController(state: AppState, dependencies: GenerationDependencies) {
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
      await dependencies.streamLocalProvider([promptMessage], onEvent, signal, context);
      const generated = normalizeGeneratedConversationTitle(output);
      if (!generated) return;
      const current = await getConversationHistory(conversation.id);
      if (current.name) return;
      const name = dependencies.nextAvailableConversationName(generated);
      const updated = await updateConversationHistory(current.id, current.providerId, current.model, current.generationSettings, name);
      if (state.conversation?.id === updated.id) state.conversation = updated;
      await dependencies.refreshConversations();
      const historyList = dependencies.root.querySelector<HTMLElement>(".history-list");
      if (historyList) historyList.innerHTML = dependencies.renderHistoryItems();
      dependencies.scheduleRepositorySync();
    } catch (error) {
      console.warn("Unable to generate conversation title", error);
    } finally {
      titleGenerationConversationIds.delete(conversation.id);
    }
  }

  async function generateAssistant(baseMessages: StoredChatMessage[]) {
    if (!state.conversation) return;
    const configured = configuredResponseModel(state);
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
    await dependencies.persistWorkingItem(working);
    dependencies.renderMessages(true);
    dependencies.updateComposerControls();
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
      dependencies.checkpointWorkingItem(working);
      if (event.type === "finish") dependencies.renderMessages(true);
      else dependencies.scheduleMessagesRender();
    };
    try {
      await dependencies.streamLocalProvider(baseMessages, onEvent, state.streamController.signal);
      if (!finished) throw new Error("Provider 未返回完成事件");
      const committedAssistant = await immutableMessage({
        parentMessageId: baseHeadId,
        role: "assistant",
        parts: assistant.parts,
        origin: assistant.origin,
        completion: {status: "complete"},
        metadata: assistant.metadata
      }, state.identityKey);
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
      const streamedArticle = dependencies.root.querySelector<HTMLElement>("#message-list > article.assistant-message:last-child");
      if (streamedArticle?.dataset.messageId === assistant.id) streamedArticle.dataset.messageId = committedAssistantId;
      await workingItemRepository.remove(working.id);
      state.workingItems = state.workingItems.filter((item) => item.id !== working.id);
      await dependencies.refreshConversations();
      if (!state.conversation.name) titleConversation = state.conversation;
      dependencies.scheduleRepositorySync();
    } catch (error) {
      cancelled = state.streamController.signal.aborted;
      working.status = cancelled ? "interrupted" : "failed";
      working.failureReason = cancelled ? "user-cancelled" : navigator.onLine ? "provider-error" : "connection-lost";
      working.parts = [
        ...(reasoning ? [{type: "reasoning", text: reasoning}] : []),
        ...(text ? [{type: "text", text}] : []),
        {type: "error", text: cancelled ? "已停止生成" : error instanceof Error ? error.message : "生成失败"}
      ];
      await dependencies.persistWorkingItem(working);
      state.conversation!.messages = baseMessages;
    } finally {
      window.clearTimeout(state.workingSaveTimers.get(working.id));
      state.workingSaveTimers.delete(working.id);
      state.streaming = false;
      state.streamController = null;
      if (committedAssistantId) {
        dependencies.renderMessages(true);
        const historyList = dependencies.root.querySelector<HTMLElement>(".history-list");
        if (historyList) historyList.innerHTML = dependencies.renderHistoryItems();
        finishingMarkdownMessages.delete(committedAssistantId);
      } else {
        streamingMarkdownCaches.delete(assistant.id);
        finishingMarkdownMessages.delete(assistant.id);
        dependencies.renderApp();
      }
      const queuedDraft = state.workingItems.find((item) => item.id === state.queuedDraftId && item.kind === "user-draft");
      let submitQueuedDraft = false;
      if (queuedDraft) {
        if (queuedDraft.observedHeadId === assistant.id) {
          queuedDraft.observedHeadId = committedAssistantId || baseHeadId;
          await dependencies.persistWorkingItem(queuedDraft);
        }
        submitQueuedDraft = Boolean(committedAssistantId) || cancelled && queuedDraft.incompleteTargetAction === "interrupt";
      }
      state.queuedDraftId = "";
      dependencies.updateComposerControls();
      dependencies.updateStreamingControls();
      const composerNote = dependencies.root.querySelector<HTMLElement>(".composer-note");
      if (composerNote) {
        composerNote.classList.remove("queued");
        composerNote.textContent = state.offline ? "离线模式：提交保存在本地仓库，联网后自动 push。" : "草稿自动保存在此浏览器；模型可能会出错。";
      }
      if (titleConversation) void generateConversationTitle(titleConversation, responseProvider, responseModel);
      if (queuedDraft && submitQueuedDraft) void sendMessage(workingItemText(queuedDraft)).catch(dependencies.reportError);
    }
  }

  async function sendMessage(text: string) {
    if (!state.conversation || !text.trim()) return;
    const draft = dependencies.activeDraft();
    if (state.streaming) {
      if (!draft) return;
      state.queuedDraftId = draft.id;
      await dependencies.persistWorkingItem(draft);
      const activeAssistant = state.conversation.messages.at(-1);
      if (activeAssistant?.role === "assistant" && activeAssistant.completion.status === "partial" && draft.observedHeadId === activeAssistant.id && draft.incompleteTargetAction === "interrupt") {
        state.streamController?.abort();
      }
      const note = dependencies.root.querySelector<HTMLElement>(".composer-note");
      if (note) {
        note.classList.add("queued");
        note.textContent = draft.incompleteTargetAction === "interrupt" ? "正在中断当前回答；随后会提交草稿。" : "已排队；会在当前回答完成后提交。";
      }
      return;
    }
    const editing = Boolean(draft?.editSourceMessageId);
    const messages = dependencies.knownMessageMap();
    const selectedTargetId = draft ? draft.observedHeadId : dependencies.displayedMessages().at(-1)?.id || null;
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
    }, state.identityKey);
    const input = dependencies.root.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
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
    if (draftId) await dependencies.discardWorkingItem(draftId);
    state.workingItems = state.workingItems.filter((item) => item.id !== draftId);
    state.activeDraftId = state.workingItems.find((item) => item.kind === "user-draft")?.id || "";
    state.composerFullscreen = false;
    await dependencies.refreshConversations();
    dependencies.renderApp();
    dependencies.scheduleRepositorySync();
    const requestAssistantReply = requestAssistantReplyForSubmission(
      draft,
      state.advancedActions,
      Boolean(configuredResponseModel(state))
    );
    if (requestAssistantReply) await generateAssistant(state.conversation.messages);
  }

  async function regenerate(index: number) {
    if (state.streaming || !state.conversation) return;
    const visible = dependencies.displayedMessages();
    const message = visible[index];
    if (!message || message.role !== "assistant") return;
    const base = visible.slice(0, index);
    if (!base.some((item) => item.role === "user")) return;
    const baseHead = base.at(-1)?.id || null;
    state.messageGraph = [...dependencies.knownMessageMap().values()];
    state.conversation = await moveConversationHead(state.conversation.id, baseHead);
    state.previewHeadId = "";
    await dependencies.refreshConversations();
    dependencies.scheduleRepositorySync();
    dependencies.renderApp();
    await generateAssistant(state.conversation.messages);
  }

  return {sendMessage, regenerate};
}
