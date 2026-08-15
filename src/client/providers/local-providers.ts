import type {ProviderProfile, ProviderSecret} from "../../shared/provider-types";
import {withEmbeddedProviderModels} from "./embedded-providers";

export type LocalCredential = {
  id: string;
  providerId: string;
  name: string;
  secret: ProviderSecret;
  createdAt: string;
  updatedAt: string;
};

const databaseName = "turnfold-local-vault";
const databaseVersion = 2;
const credentialStoreName = "credentials";
const providerStoreName = "providers";

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(credentialStoreName)) database.createObjectStore(credentialStoreName, {keyPath: "id"});
      if (!database.objectStoreNames.contains(providerStoreName)) database.createObjectStore(providerStoreName, {keyPath: "id"});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open local Provider store"));
  });
}

async function transaction<T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const request = operation(database.transaction(storeName, mode).objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Local Provider operation failed"));
  }).finally(() => database.close());
}

export function localCredentialId(providerId: string, name = "default") {
  return `${providerId}/${name}`;
}

export function getLocalCredential(providerId: string, name = "default") {
  return transaction<LocalCredential | undefined>(credentialStoreName, "readonly", (store) => store.get(localCredentialId(providerId, name)))
    .then((credential) => credential ? normalizeCredential(credential) : undefined);
}

export function listLocalCredentials() {
  return transaction<LocalCredential[]>(credentialStoreName, "readonly", (store) => store.getAll())
    .then((credentials) => credentials.map(normalizeCredential));
}

function normalizeCredential(value: LocalCredential): LocalCredential {
  return value;
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
  await transaction<IDBValidKey>(credentialStoreName, "readwrite", (store) => store.put(credential));
  return credential;
}

export function deleteLocalCredential(providerId: string, name = "default") {
  return transaction<undefined>(credentialStoreName, "readwrite", (store) => store.delete(localCredentialId(providerId, name)));
}

export function listLocalProviderProfiles() {
  return transaction<ProviderProfile[]>(providerStoreName, "readonly", (store) => store.getAll())
    .then((profiles) => profiles.map(withEmbeddedProviderModels));
}

export async function saveLocalProviderProfile(profile: ProviderProfile) {
  const normalized = withEmbeddedProviderModels(profile);
  await transaction<IDBValidKey>(providerStoreName, "readwrite", (store) => store.put(normalized));
  return normalized;
}

export function deleteLocalProviderProfile(id: string) {
  return transaction<undefined>(providerStoreName, "readwrite", (store) => store.delete(id));
}
