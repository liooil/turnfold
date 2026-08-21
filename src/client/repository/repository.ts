import type {Conversation, ConversationSummary, StoredChatMessage, WorkingItem} from "../../shared/conversation-types";
import type {GenerationSettings} from "../../shared/generation-settings";
import type {PeerSyncState, RepositoryInventory, RepositoryPull, RepositoryPush, RepositoryPushRefResult} from "../../shared/repository-types";

export type CreateConversationInput = {
  providerId: string;
  model: string;
  generationSettings: GenerationSettings;
  name: string;
  headMessageId?: string | null;
  messages?: StoredChatMessage[];
};

export type UpdateConversationInput = {
  providerId: string;
  model: string;
  generationSettings: GenerationSettings;
  name?: string;
};

export type CommitMessageInput = {
  conversationId: string;
  expectedHeadId: string | null;
  message: StoredChatMessage;
};

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
