import {modelsDevApiUrl, normalizeModelsDevCatalog, type StoredModelsDevCatalog} from "./models-dev-catalog";

const databaseName = "turnfold-models-dev-catalog";
const databaseVersion = 1;
const storeName = "catalogs";
const recordId = "current";

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, {keyPath: "id"});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开 models.dev 本地目录"));
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const request = operation(database.transaction(storeName, mode).objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("models.dev 本地目录操作失败"));
  }).finally(() => database.close());
}

export async function loadStoredModelsDevCatalog() {
  const stored = await transaction<StoredModelsDevCatalog | undefined>("readonly", (store) => store.get(recordId));
  if (!stored) return null;
  try {
    return {...stored, catalog: normalizeModelsDevCatalog(stored.catalog)};
  } catch {
    return null;
  }
}

export async function downloadModelsDevCatalog(providerFetch: typeof fetch = fetch) {
  const response = await providerFetch(modelsDevApiUrl, {
    cache: "no-cache",
    credentials: "omit",
    headers: {Accept: "application/json"},
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
  const stored: StoredModelsDevCatalog = {
    id: recordId,
    fetchedAt: new Date().toISOString(),
    catalog: normalizeModelsDevCatalog(await response.json())
  };
  await transaction<IDBValidKey>("readwrite", (store) => store.put(stored));
  return stored;
}

export function deleteStoredModelsDevCatalog() {
  return transaction<undefined>("readwrite", (store) => store.delete(recordId));
}
