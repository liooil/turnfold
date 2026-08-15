import {untitledConversationLabel} from "../shared/conversation-title";
import type {HashNavigationMode} from "./app-state";
import {providerOf, configuredResponseModel} from "./app-selectors";
import {
  commitConversationMessage,
  createConversationHistory,
  deleteConversationHistory,
  getConversationHistory,
  listConversationHistory,
  moveConversationHead,
  updateConversationHistory
} from "./conversation-client";
import {immutableMessage} from "./message-factory";
import {updateConversationHash} from "./navigation";
import type {MessageCompletion, StoredChatMessage} from "../shared/conversation-types";
import {workingItemRepository} from "./repository/repositories";
import type {AppState, ChatProvider} from "./app-state";

type ConversationActionDependencies = {
  renderApp: () => void;
  refreshConversations: () => Promise<void>;
  scheduleRepositorySync: (delay?: number) => void;
  loadConversationWorkingItems: (conversationId: string) => Promise<void>;
  settingsForProvider: (provider: ChatProvider) => {model: string};
  rememberModel: (providerId: string, model: string) => void;
  knownMessageMap: () => Map<string, StoredChatMessage>;
  newestBranchTip: (startId: string) => string;
};

export function createConversationActions(state: AppState, dependencies: ConversationActionDependencies) {
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

  function closeHistoryOnMobile() {
    if (window.matchMedia("(max-width: 680px)").matches) state.historyOpen = false;
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
      : selectedProvider ? dependencies.settingsForProvider(selectedProvider).model : selected.model;
    state.generationSettings = selected.generationSettings;
    await dependencies.loadConversationWorkingItems(selected.id);
    if (selectedProvider) dependencies.rememberModel(state.providerId, state.model);
    closeHistoryOnMobile();
    if (navigation !== "none") updateConversationHash(selected.id, navigation);
    dependencies.renderApp();
  }

  function switchBranch(messageId: string) {
    if (state.streaming || !dependencies.knownMessageMap().has(messageId)) return;
    const tip = dependencies.newestBranchTip(messageId);
    state.previewHeadId = tip === state.conversation?.headMessageId ? "" : tip;
    dependencies.renderApp();
  }

  async function confirmBranchPreview() {
    if (!state.conversation || !state.previewHeadId) return;
    state.messageGraph = [...dependencies.knownMessageMap().values()];
    state.conversation = await moveConversationHead(state.conversation.id, state.previewHeadId);
    state.previewHeadId = "";
    await dependencies.refreshConversations();
    dependencies.renderApp();
    dependencies.scheduleRepositorySync();
  }

  async function newConversation() {
    const item = providerOf(state);
    const configured = configuredResponseModel(state);
    const created = await createConversationHistory(item?.id || "", configured?.model || "", state.generationSettings, "");
    state.conversation = created;
    state.workingItems = [];
    state.activeDraftId = "";
    state.composerFullscreen = false;
    state.generationSettings = created.generationSettings;
    await dependencies.refreshConversations();
    closeHistoryOnMobile();
    updateConversationHash(created.id, "push");
    dependencies.renderApp();
    dependencies.scheduleRepositorySync();
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
    dependencies.renderApp();
    dependencies.scheduleRepositorySync();
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
    await dependencies.refreshConversations();
    dependencies.renderApp();
    dependencies.scheduleRepositorySync();
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
    }, state.identityKey);
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
    state.messageGraph = [...dependencies.knownMessageMap().values()];
    await dependencies.refreshConversations();
    updateConversationHash(state.conversation.id, "push");
    dependencies.renderApp();
    dependencies.scheduleRepositorySync();
  }

  return {
    nextAvailableConversationName,
    selectConversation,
    switchBranch,
    confirmBranchPreview,
    newConversation,
    removeConversation,
    renameConversation,
    commitPartial
  };
}
