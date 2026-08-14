import {activeOfflineProfileKey, offlineTransaction, openOfflineDatabase} from "./offline-database";

export type PendingConversationChange = {
  cacheKey: string;
  profileId: string;
  conversationId: string;
  requestPath?: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string;
  createdAt: string;
};

export async function queueConversationChange(change: Omit<PendingConversationChange, "cacheKey" | "profileId" | "createdAt">) {
  const profileId = activeOfflineProfileKey();
  if (!profileId) return;
  const record: PendingConversationChange = {
    ...change,
    cacheKey: `${profileId}:${change.conversationId}:${change.method}:${change.requestPath || "conversation"}`,
    profileId,
    createdAt: new Date().toISOString()
  };
  await offlineTransaction<IDBValidKey>("pending", "readwrite", (store) => store.put(record));
}

export async function listPendingConversationChanges() {
  const profileId = activeOfflineProfileKey();
  if (!profileId) return [];
  const database = await openOfflineDatabase();
  return new Promise<PendingConversationChange[]>((resolve, reject) => {
    const current = database.transaction("pending", "readonly");
    const request = current.objectStore("pending").index("profileId").getAll(profileId);
    request.onsuccess = () => resolve(request.result.sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
    request.onerror = () => reject(request.error || new Error("Unable to read pending history changes"));
    current.oncomplete = () => database.close();
  });
}

export async function removePendingConversationChange(cacheKey: string) {
  await offlineTransaction<undefined>("pending", "readwrite", (store) => store.delete(cacheKey));
}
