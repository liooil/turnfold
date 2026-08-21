import type {RepositoryInventory, RepositoryPeerIdentity, RepositoryPull, RepositoryPush, RepositoryPushResult, WorkingSnapshot} from "../../shared/repository-types";

export interface RepositoryPeer {
  identity(): Promise<RepositoryPeerIdentity>;
  pull(inventory: RepositoryInventory): Promise<RepositoryPull>;
  push(batch: RepositoryPush): Promise<RepositoryPushResult>;
  backupWorking?(snapshot: WorkingSnapshot): Promise<void>;
}
