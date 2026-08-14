import {repositoryPushBatches} from "../../shared/repository-push-batches";
import type {PeerSyncStateRepository, ReplicationRepository} from "../repository/repository";
import type {RepositoryPeer} from "./repository-peer";

export class SyncEngine {
  constructor(
    private readonly repository: ReplicationRepository,
    private readonly peerStates: PeerSyncStateRepository
  ) {}

  async syncWith(peer: RepositoryPeer) {
    const {id: peerId} = await peer.identity();
    const previous = await this.peerStates.get(peerId);
    try {
      const push = await this.repository.pendingPush(peerId);
      let conflicts = 0;
      let lastPushAt = previous.lastPushAt;
      if (push.refs.length || push.objects.length) {
        for (const batch of repositoryPushBatches(push)) {
          const pushed = await peer.push(batch);
          await this.repository.applyPush(peerId, pushed.refs);
          conflicts += pushed.refs.filter((result) => result.status === "conflict").length;
          lastPushAt = pushed.pushedAt || new Date().toISOString();
        }
      }
      const pull = await peer.pull(await this.repository.inventory(peerId));
      await this.repository.applyPull(peerId, pull);
      const lastSyncAt = new Date().toISOString();
      await this.peerStates.save({peerId, lastSyncAt, lastPullAt: pull.fetchedAt, lastPushAt, lastError: ""});
      return {fetchedAt: pull.fetchedAt, conflicts};
    } catch (error) {
      await this.peerStates.save({...previous, peerId, lastError: error instanceof Error ? error.message : "Peer synchronization failed"});
      throw error;
    }
  }
}
