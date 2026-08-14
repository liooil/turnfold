import {IndexedDbConversationRepository, IndexedDbReplicationRepository, IndexedDbWorkingItemRepository} from "./indexeddb-repository";
import {IndexedDbPeerSyncStateRepository} from "./indexeddb-peer-sync-state";

export const conversationRepository = new IndexedDbConversationRepository();
export const workingItemRepository = new IndexedDbWorkingItemRepository();
export const replicationRepository = new IndexedDbReplicationRepository();
export const peerSyncStateRepository = new IndexedDbPeerSyncStateRepository();
