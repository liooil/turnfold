import type {Conversation, ConversationSummary, WorkingItem} from "../../shared/conversation-types";
import type {PeerSyncState, RepositoryInventory, RepositoryPull, RepositoryPush, RepositoryPushRefResult} from "../../shared/repository-types";

import type {CommitMessageInput, CreateConversationInput, UpdateConversationInput} from "../../shared/repository-ops";
// 契约输入类型统一来自 shared（三端同语义）：本文件保留组合根的接口落地形态。
export type {CommitMessageInput, CreateConversationInput, UpdateConversationInput} from "../../shared/repository-ops";

export interface ConversationRepository {
  list(): Promise<ConversationSummary[]>;
  get(id: string): Promise<Conversation | null>;
  create(input: CreateConversationInput): Promise<Conversation>;
  update(id: string, input: UpdateConversationInput): Promise<Conversation>;
  commit(input: CommitMessageInput): Promise<Conversation>;
  moveHead(conversationId: string, headMessageId: string | null): Promise<Conversation>;
  remove(id: string): Promise<void>;
}

export interface WorkingItemRepository {
  list(conversationId?: string): Promise<WorkingItem[]>;
  save(item: WorkingItem): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface ReplicationRepository {
  inventory(peerId: string): Promise<RepositoryInventory>;
  pendingPush(peerId: string): Promise<RepositoryPush>;
  applyPush(peerId: string, results: RepositoryPushRefResult[]): Promise<void>;
  applyPull(peerId: string, pull: RepositoryPull): Promise<void>;
  workingSnapshot(): Promise<import("../../shared/repository-types").WorkingSnapshot>;
}

export interface PeerSyncStateRepository {
  get(peerId: string): Promise<PeerSyncState>;
  save(state: PeerSyncState): Promise<void>;
}
