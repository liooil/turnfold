import type {ProviderModel, ProviderProfile, ProviderProtocol, ProviderSecret} from "./provider-types";
import {withProviderPresetModels} from "./provider-presets";

export type LocalCredential = {
  id: string;
  providerId: string;
  name: string;
  secret: ProviderSecret;
  createdAt: string;
  updatedAt: string;
  legacyBaseUrl?: string;
};

const databaseName = "xiteng-chat-local-vault";
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
  const rawSecret = value.secret as ProviderSecret & {provider?: ProviderSecret & {baseUrl?: string}};
  const legacyProvider = rawSecret?.provider;
  return {
    ...value,
    secret: {
      ...(rawSecret?.apiKey || legacyProvider?.apiKey ? {apiKey: rawSecret.apiKey || legacyProvider?.apiKey} : {}),
      ...(rawSecret?.headers || legacyProvider?.headers ? {headers: rawSecret.headers || legacyProvider?.headers} : {})
    },
    ...(legacyProvider?.baseUrl ? {legacyBaseUrl: legacyProvider.baseUrl} : {})
  };
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
    .then((profiles) => profiles.map(withProviderPresetModels));
}

export async function saveLocalProviderProfile(profile: ProviderProfile) {
  const normalized = withProviderPresetModels(profile);
  await transaction<IDBValidKey>(providerStoreName, "readwrite", (store) => store.put(normalized));
  return normalized;
}

export function deleteLocalProviderProfile(id: string) {
  return transaction<undefined>(providerStoreName, "readwrite", (store) => store.delete(id));
}

function legacyProtocol(value: unknown): ProviderProtocol {
  if (value === "openai-responses") return "openai-responses";
  if (value === "anthropic-messages") return "anthropic";
  if (value === "google-generative-ai") return "google";
  return "openai-chat";
}

function legacyModels(value: unknown, defaultModel: string): ProviderModel[] {
  const models = Array.isArray(value) ? value : [];
  const normalized: ProviderModel[] = models.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const input = item as Record<string, unknown>;
    const id = String(input.id || "").trim();
    if (!id) return [];
    return [{
      id,
      name: String(input.name || id),
      ...(typeof input.contextWindow === "number" ? {contextWindow: input.contextWindow} : {}),
      ...(typeof input.ownedBy === "string" ? {ownedBy: input.ownedBy} : {}),
      source: "discovered" as const
    }];
  });
  if (!normalized.length && defaultModel) normalized.push({id: defaultModel, name: defaultModel, source: "manual"});
  return normalized;
}

export function migrateLegacyProviderProfile(value: unknown): ProviderProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const connection = input.connection && typeof input.connection === "object" && !Array.isArray(input.connection)
    ? input.connection as Record<string, unknown>
    : {};
  const id = String(input.id || "").trim();
  const name = String(input.name || id).trim();
  const rawBaseUrl = String(connection.baseUrl || input.baseUrl || "").trim();
  if (!id || !name || !rawBaseUrl) return null;
  let baseUrl: string;
  try {
    const parsed = new URL(rawBaseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    baseUrl = rawBaseUrl.replace(/\/+$/, "");
  } catch {
    return null;
  }
  const authInput = input.auth && typeof input.auth === "object" && !Array.isArray(input.auth) ? input.auth as Record<string, unknown> : {};
  const authType = ["bearer", "header", "none"].includes(String(authInput.type)) ? String(authInput.type) as ProviderProfile["auth"]["type"] : "none";
  const defaultModel = String(input.defaultModel || "").trim();
  const discovery = input.discovery && typeof input.discovery === "object" && !Array.isArray(input.discovery) ? input.discovery as Record<string, unknown> : {};
  const timestamp = new Date().toISOString();
  return {
    id,
    name,
    protocol: legacyProtocol(input.api),
    baseUrl,
    auth: authType === "header" ? {type: authType, header: String(authInput.header || "Authorization")} : {type: authType},
    headers: input.headers && typeof input.headers === "object" && !Array.isArray(input.headers) ? input.headers as Record<string, string> : {},
    discoveryUrl: String(discovery.url || "").trim(),
    models: legacyModels(input.models, defaultModel),
    defaultModel,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
