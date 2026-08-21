import type {RepositoryInventory, RepositoryPull, RepositoryPush, RepositoryPushResult} from "../../shared/repository-types";
import type {RepositoryPeer} from "./repository-peer";

export class RepositoryPeerHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class HttpRepositoryPeer implements RepositoryPeer {
  constructor(
    readonly peerId: string,
    private readonly apiUrl: (pathname: string) => string,
    private readonly signal?: AbortSignal,
    private readonly grantToken = ""
  ) {}

  async identity() {
    return {id: this.peerId, kind: "server" as const};
  }

  pull(inventory: RepositoryInventory) {
    return this.request<RepositoryPull>("/api/sync/fetch", inventory);
  }

  push(batch: RepositoryPush) {
    return this.request<RepositoryPushResult>("/api/sync/push", batch);
  }

  async request<T>(pathname: string, body: unknown) {
    const response = await fetch(this.apiUrl(pathname), {
      method: "POST",
      cache: "no-store",
      credentials: "include",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...(this.grantToken ? {"Authorization": `Bearer ${this.grantToken}`} : {})
      },
      body: JSON.stringify(body),
      signal: this.signal
    });
    const payload = await response.json();
    if (!response.ok) throw new RepositoryPeerHttpError(payload.error || `HTTP ${response.status}`, response.status);
    return payload as T;
  }
}
