import type {ProviderSecret} from "./provider-types";

export type LocalCredential = {
  id: string;
  providerId: string;
  name: string;
  secret: ProviderSecret;
  createdAt: string;
  updatedAt: string;
};

// Keep the original database identifier so upgrades retain browser-local provider credentials.
const databaseName = "xiteng-chat-local-vault";
const storeName = "credentials";

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, {keyPath: "id"});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open local credential store"));
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const request = operation(database.transaction(storeName, mode).objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Local credential operation failed"));
  }).finally(() => database.close());
}

export function localCredentialId(providerId: string, name = "default") {
  return `${providerId}/${name}`;
}

export function getLocalCredential(providerId: string, name = "default") {
  return transaction<LocalCredential | undefined>("readonly", (store) => store.get(localCredentialId(providerId, name)));
}

export async function listLocalCredentials() {
  return transaction<LocalCredential[]>("readonly", (store) => store.getAll());
}

export async function saveLocalCredential(providerId: string, name: string, secret: ProviderSecret) {
  const id = localCredentialId(providerId, name);
  const existing = await getLocalCredential(providerId, name);
  const timestamp = new Date().toISOString();
  const credential: LocalCredential = {
    id,
    providerId,
    name,
    secret,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp
  };
  await transaction("readwrite", (store) => store.put(credential));
  return credential;
}

export function deleteLocalCredential(providerId: string, name = "default") {
  return transaction("readwrite", (store) => store.delete(localCredentialId(providerId, name)));
}
