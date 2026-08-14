// Keep the original database identifiers so existing installations upgrade without losing local history.
const databaseName = "xiteng-chat-offline";
const databaseVersion = 4;
const activeProfileKey = "xiteng-chat-offline-profile";

export function openOfflineDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("profiles")) database.createObjectStore("profiles", {keyPath: "id"});
      if (!database.objectStoreNames.contains("conversations")) {
        const conversations = database.createObjectStore("conversations", {keyPath: "cacheKey"});
        conversations.createIndex("profileId", "profileId");
      }
      if (!database.objectStoreNames.contains("pending")) {
        const pending = database.createObjectStore("pending", {keyPath: "cacheKey"});
        pending.createIndex("profileId", "profileId");
      }
      if (!database.objectStoreNames.contains("messages")) {
        const messages = database.createObjectStore("messages", {keyPath: "cacheKey"});
        messages.createIndex("profileId", "profileId");
      }
      if (!database.objectStoreNames.contains("working")) {
        const working = database.createObjectStore("working", {keyPath: "cacheKey"});
        working.createIndex("profileId", "profileId");
        working.createIndex("profileConversation", ["profileId", "conversationId"]);
      }
      if (!database.objectStoreNames.contains("reflog")) {
        const reflog = database.createObjectStore("reflog", {keyPath: "cacheKey"});
        reflog.createIndex("profileConversation", ["profileId", "conversationId"]);
      }
      if (!database.objectStoreNames.contains("repositoryOutbox")) {
        const outbox = database.createObjectStore("repositoryOutbox", {keyPath: "cacheKey"});
        outbox.createIndex("profileId", "profileId");
      }
      if (!database.objectStoreNames.contains("peerSyncStates")) {
        const peers = database.createObjectStore("peerSyncStates", {keyPath: "cacheKey"});
        peers.createIndex("profileId", "profileId");
        peers.createIndex("profilePeer", ["profileId", "peerId"], {unique: true});
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open offline history"));
  });
}

export async function offlineTransaction<T>(storeName: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openOfflineDatabase();
  return new Promise<T>((resolve, reject) => {
    const current = database.transaction(storeName, mode);
    const request = run(current.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(`Offline ${storeName} operation failed`));
    current.oncomplete = () => database.close();
    current.onerror = () => reject(current.error || new Error(`Offline ${storeName} transaction failed`));
  });
}

export function activeOfflineProfileKey() {
  return window.localStorage.getItem(activeProfileKey) || "";
}

export function setActiveOfflineProfileKey(profileId: string) {
  window.localStorage.setItem(activeProfileKey, profileId);
}

export function profileCacheKey(profileId: string, id: string) {
  return `${profileId}:${id}`;
}
