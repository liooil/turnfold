import type {ConversationRefState, RepositoryFetch, RepositoryRefUpdate, StoredChatMessage, WorkingItem} from "./conversation-types";

export type RepositoryPush = {
  repositoryId: string;
  objects: StoredChatMessage[];
  objectRepositoryIds?: Record<string, string>;
  refs: RepositoryRefUpdate[];
};

export type RepositoryPushRefResult = {
  conversationId: string;
  status: "ok" | "conflict";
  ref: ConversationRefState | null;
};

export type RepositoryPushResult = {
  refs: RepositoryPushRefResult[];
  pushedAt?: string;
};

export type RepositoryInventory = {
  haveObjectIds: string[];
};

export type RepositoryPull = RepositoryFetch;

export type RepositoryPeerIdentity = {
  id: string;
  kind: "server" | "client";
  label?: string;
};

export type WorkingSnapshot = {
  deviceId: string;
  snapshotAt: string;
  items: WorkingItem[];
};

export type PeerSyncState = {
  peerId: string;
  lastSyncAt: string;
  lastPullAt: string;
  lastPushAt: string;
  lastError: string;
};
