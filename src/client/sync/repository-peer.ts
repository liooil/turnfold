import type {RepositoryInventory, RepositoryPeerIdentity, RepositoryPull, RepositoryPush, RepositoryPushResult} from "../../shared/repository-types";

export interface RepositoryPeer {
  identity(): Promise<RepositoryPeerIdentity>;
  pull(inventory: RepositoryInventory): Promise<RepositoryPull>;
  push(batch: RepositoryPush): Promise<RepositoryPushResult>;
}
