import type {Conversation} from "../../shared/conversation-types";
import {
  activeOfflineProfileId,
  applyRepositoryFetch,
  applyRepositoryPushResults,
  commitLocalMessage,
  createLocalConversation,
  deleteLocalConversation,
  listCachedObjectIds,
  listWorkingItems,
  loadCachedConversation,
  loadCachedConversationSummaries,
  moveLocalConversationHead,
  queueLocalRefUpdate,
  removeWorkingItem,
  repositoryPushPayload,
  saveWorkingItem
} from "../storage/offline-history";
import type {
  CommitMessageInput,
  ConversationRepository,
  CreateConversationInput,
  ReplicationRepository,
  UpdateConversationInput,
  WorkingItemRepository
} from "./repository";

export class IndexedDbConversationRepository implements ConversationRepository {
  list() {
    return loadCachedConversationSummaries();
  }

  get(id: string) {
    return loadCachedConversation(id);
  }

  create(input: CreateConversationInput) {
    const timestamp = new Date().toISOString();
    const messages = input.messages || [];
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      name: input.name,
      headMessageId: input.headMessageId ?? null,
      upstreamHeadMessageId: null,
      providerId: input.providerId,
      model: input.model,
      generationSettings: input.generationSettings,
      headVersion: 0,
      metadataVersion: 0,
      messageCount: messages.length,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages
    };
    return createLocalConversation(conversation);
  }

  async update(id: string, input: UpdateConversationInput) {
    const conversation = await this.required(id);
    return queueLocalRefUpdate({
      ...conversation,
      providerId: input.providerId,
      model: input.model,
      generationSettings: input.generationSettings,
      ...(input.name === undefined ? {} : {name: input.name}),
      updatedAt: new Date().toISOString()
    });
  }

  async commit(input: CommitMessageInput) {
    const conversation = await this.required(input.conversationId);
    if (conversation.headMessageId !== input.expectedHeadId || input.message.parentMessageId !== input.expectedHeadId) {
      throw new Error("Local conversation head changed");
    }
    return commitLocalMessage(input.conversationId, input.message);
  }

  moveHead(conversationId: string, headMessageId: string | null) {
    return moveLocalConversationHead(conversationId, headMessageId);
  }

  remove(id: string) {
    return deleteLocalConversation(id);
  }

  private async required(id: string) {
    const conversation = await this.get(id);
    if (!conversation) throw new Error("Local conversation is unavailable; fetch may still be in progress");
    return conversation;
  }
}

export class IndexedDbWorkingItemRepository implements WorkingItemRepository {
  list(conversationId?: string) {
    return listWorkingItems(conversationId);
  }

  async save(item: Parameters<typeof saveWorkingItem>[0]) {
    await saveWorkingItem(item);
  }

  remove(id: string) {
    return removeWorkingItem(id);
  }
}

export class IndexedDbReplicationRepository implements ReplicationRepository {
  async inventory(_peerId: string) {
    return {haveObjectIds: await listCachedObjectIds()};
  }

  pendingPush(peerId: string) {
    return repositoryPushPayload(peerId);
  }

  applyPush(peerId: string, results: Parameters<typeof applyRepositoryPushResults>[0]) {
    return applyRepositoryPushResults(results, peerId);
  }

  applyPull(peerId: string, pull: Parameters<typeof applyRepositoryFetch>[0]) {
    return applyRepositoryFetch(pull, peerId);
  }

  async workingSnapshot() {
    return {
      deviceId: activeOfflineProfileId(),
      snapshotAt: new Date().toISOString(),
      items: await listWorkingItems()
    };
  }
}
