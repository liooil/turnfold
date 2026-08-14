import type {PeerSyncState} from "../../shared/repository-types";
import {activeOfflineProfileKey, offlineTransaction, profileCacheKey} from "../storage/offline-database";
import type {PeerSyncStateRepository} from "./repository";

type StoredPeerSyncState = PeerSyncState & {
  cacheKey: string;
  profileId: string;
};

function emptyPeerSyncState(peerId: string): PeerSyncState {
  return {peerId, lastSyncAt: "", lastPullAt: "", lastPushAt: "", lastError: ""};
}

export class IndexedDbPeerSyncStateRepository implements PeerSyncStateRepository {
  async get(peerId: string) {
    const profileId = activeOfflineProfileKey();
    if (!profileId) return emptyPeerSyncState(peerId);
    const stored = await offlineTransaction<StoredPeerSyncState | undefined>("peerSyncStates", "readonly", (store) => store.get(profileCacheKey(profileId, peerId)));
    return stored ? {
      peerId: stored.peerId,
      lastSyncAt: stored.lastSyncAt,
      lastPullAt: stored.lastPullAt,
      lastPushAt: stored.lastPushAt,
      lastError: stored.lastError
    } : emptyPeerSyncState(peerId);
  }

  async save(state: PeerSyncState) {
    const profileId = activeOfflineProfileKey();
    if (!profileId) return;
    await offlineTransaction<IDBValidKey>("peerSyncStates", "readwrite", (store) => store.put({
      ...state,
      cacheKey: profileCacheKey(profileId, state.peerId),
      profileId
    } satisfies StoredPeerSyncState));
  }
}
