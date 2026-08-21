import type {ProviderProfile, ProviderSecret} from "../../shared/provider-types";
import {
  backendApiUrl,
  normalizeBackendUrl,
  type BackendBrowserGrant
} from "../backend-connection";

export const providerAgentUrlStorageKey = "turnfold-provider-agent-url";
export const providerAgentGrantStorageKey = "turnfold-provider-agent-grants-v1";
export const providerAgentModesStorageKey = "turnfold-provider-agent-modes-v1";

type AgentFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type AgentStorage = Pick<Storage, "getItem" | "setItem">;

export type AgentProviderProfile = Pick<ProviderProfile, "id" | "name" | "protocol" | "baseUrl" | "auth" | "headers" | "discoveryUrl" | "createdAt" | "updatedAt">;

export type AgentCredentialMetadata = {
  id: string;
  providerId: string;
  name: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

export type ProviderAgentResources = {
  profiles: AgentProviderProfile[];
  credentials: AgentCredentialMetadata[];
};

export class ProviderAgentPairingRequiredError extends Error {
  constructor() {
    super("此页面 Origin 需要先获得 Provider/Vault 授权");
    this.name = "ProviderAgentPairingRequiredError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function storedAgentGrants(storage: Pick<Storage, "getItem">) {
  try {
    const parsed = JSON.parse(storage.getItem(providerAgentGrantStorageKey) || "{}");
    return record(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function providerAgentGrantToken(storage: Pick<Storage, "getItem">, agentUrl: string) {
  const stored = storedAgentGrants(storage)[normalizeBackendUrl(agentUrl)];
  if (!record(stored) || typeof stored.token !== "string" || !stored.token.trim()) return "";
  if (typeof stored.expiresAt === "string" && Date.parse(stored.expiresAt) <= Date.now()) return "";
  return stored.token.trim();
}

export function saveProviderAgentGrant(storage: AgentStorage, agentUrl: string, token: string, grant: BackendBrowserGrant) {
  const normalized = normalizeBackendUrl(agentUrl);
  const grants = storedAgentGrants(storage);
  grants[normalized] = {token: token.trim(), expiresAt: grant.expiresAt};
  storage.setItem(providerAgentGrantStorageKey, JSON.stringify(grants));
}

export function removeProviderAgentGrant(storage: AgentStorage, agentUrl: string) {
  const normalized = normalizeBackendUrl(agentUrl);
  const grants = storedAgentGrants(storage);
  delete grants[normalized];
  storage.setItem(providerAgentGrantStorageKey, JSON.stringify(grants));
}

export function loadProviderAgentModes(storage: Pick<Storage, "getItem">) {
  try {
    const parsed = JSON.parse(storage.getItem(providerAgentModesStorageKey) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set<string>();
  }
}

export function saveProviderAgentModes(storage: Pick<Storage, "setItem">, providerIds: Set<string>) {
  storage.setItem(providerAgentModesStorageKey, JSON.stringify([...providerIds].sort()));
}

function authorizationHeaders(token: string, contentType = false) {
  return {
    "Accept": "application/json",
    ...(contentType ? {"Content-Type": "application/json"} : {}),
    ...(token ? {"Authorization": `Bearer ${token}`} : {})
  };
}

async function jsonPayload(response: Response, description: string) {
  try {
    return await response.json() as unknown;
  } catch {
    throw new Error(`${description} 没有返回 JSON（HTTP ${response.status}）`);
  }
}

function responseError(response: Response, payload: unknown, fallback: string) {
  return record(payload) && typeof payload.error === "string" ? payload.error : `${fallback} HTTP ${response.status}`;
}

async function agentJson(
  agentUrl: string,
  token: string,
  pathname: string,
  init: RequestInit = {},
  agentFetch: AgentFetch = fetch
) {
  let response: Response;
  try {
    response = await agentFetch(backendApiUrl(agentUrl, pathname), {
      cache: "no-store",
      credentials: "include",
      redirect: "manual",
      ...init,
      headers: {
        ...authorizationHeaders(token, Boolean(init.body)),
        ...(init.headers || {})
      }
    });
  } catch {
    throw new Error("无法连接 Provider Agent；请检查 URL、HTTPS/CORS 与本地网络权限");
  }
  if (response.type === "opaqueredirect" || response.status === 0 || response.status >= 300 && response.status < 400) {
    throw new Error("Provider Agent 返回了不允许的重定向");
  }
  const payload = await jsonPayload(response, "Provider Agent");
  if (response.status === 401 && record(payload) && payload.code === "pairing_required") {
    throw new ProviderAgentPairingRequiredError();
  }
  if (!response.ok) throw new Error(responseError(response, payload, "Provider Agent"));
  return payload;
}

export async function fetchProviderAgentInfo(agentUrl: string, agentFetch: AgentFetch = fetch, signal?: AbortSignal) {
  const payload = await agentJson(agentUrl, "", "/api/local/v1/info", {signal}, agentFetch);
  if (!record(payload) || !record(payload.capabilities) || payload.capabilities.vault !== true || payload.capabilities.providerProxy !== true) {
    throw new Error("该 Turnfold 服务未启用 Provider/Vault worker");
  }
  return payload;
}

function agentProfile(value: unknown): AgentProviderProfile {
  if (!record(value) || typeof value.id !== "string" || typeof value.name !== "string"
    || !["openai-chat", "openai-responses", "anthropic", "google"].includes(String(value.protocol))
    || typeof value.baseUrl !== "string" || !record(value.auth) || !record(value.headers)
    || typeof value.discoveryUrl !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new Error("Provider Agent 返回了无效的 Provider profile");
  }
  const authType = String(value.auth.type);
  if (!["none", "bearer", "header"].includes(authType)) throw new Error("Provider Agent 返回了无效的认证方式");
  const headers = Object.fromEntries(Object.entries(value.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return {
    id: value.id,
    name: value.name,
    protocol: value.protocol as ProviderProfile["protocol"],
    baseUrl: value.baseUrl,
    auth: authType === "header" ? {type: "header", header: typeof value.auth.header === "string" ? value.auth.header : ""} : {type: authType as "none" | "bearer"},
    headers,
    discoveryUrl: value.discoveryUrl,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function agentCredential(value: unknown): AgentCredentialMetadata {
  if (!record(value) || typeof value.id !== "string" || typeof value.providerId !== "string"
    || typeof value.name !== "string" || typeof value.fingerprint !== "string"
    || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string"
    || value.lastUsedAt !== null && typeof value.lastUsedAt !== "string") {
    throw new Error("Provider Agent 返回了无效的凭据 metadata");
  }
  return value as AgentCredentialMetadata;
}

export async function fetchProviderAgentResources(
  agentUrl: string,
  token: string,
  agentFetch: AgentFetch = fetch,
  signal?: AbortSignal
): Promise<ProviderAgentResources> {
  const [profilePayload, credentialPayload] = await Promise.all([
    agentJson(agentUrl, token, "/api/local/v1/provider/profiles", {signal}, agentFetch),
    agentJson(agentUrl, token, "/api/local/v1/vault/credentials", {signal}, agentFetch)
  ]);
  if (!record(profilePayload) || !Array.isArray(profilePayload.profiles)
    || !record(credentialPayload) || !Array.isArray(credentialPayload.credentials)) {
    throw new Error("Provider Agent 返回了无效的资源列表");
  }
  return {
    profiles: profilePayload.profiles.map(agentProfile),
    credentials: credentialPayload.credentials.map(agentCredential)
  };
}

export async function saveProviderAgentProfile(
  agentUrl: string,
  token: string,
  profile: ProviderProfile,
  agentFetch: AgentFetch = fetch,
  signal?: AbortSignal
) {
  const payload = await agentJson(agentUrl, token, `/api/local/v1/provider/profiles/${encodeURIComponent(profile.id)}`, {
    method: "POST",
    signal,
    body: JSON.stringify({
      name: profile.name,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      auth: profile.auth,
      headers: profile.headers,
      discoveryUrl: profile.discoveryUrl
    })
  }, agentFetch);
  if (!record(payload)) throw new Error("Provider Agent 未返回 Provider profile");
  return agentProfile(payload.profile);
}

export async function saveProviderAgentCredential(
  agentUrl: string,
  token: string,
  providerId: string,
  secret: ProviderSecret,
  agentFetch: AgentFetch = fetch,
  signal?: AbortSignal
) {
  const payload = await agentJson(agentUrl, token, "/api/local/v1/vault/credentials", {
    method: "POST",
    signal,
    body: JSON.stringify({providerId, name: "default", secret})
  }, agentFetch);
  if (!record(payload)) throw new Error("Provider Agent 未返回凭据 metadata");
  return agentCredential(payload.credential);
}

export async function deleteProviderAgentProfile(
  agentUrl: string,
  token: string,
  providerId: string,
  agentFetch: AgentFetch = fetch,
  signal?: AbortSignal
) {
  await agentJson(agentUrl, token, `/api/local/v1/provider/profiles/${encodeURIComponent(providerId)}`, {method: "DELETE", signal}, agentFetch);
}

export async function deleteProviderAgentCredential(
  agentUrl: string,
  token: string,
  credentialId: string,
  agentFetch: AgentFetch = fetch,
  signal?: AbortSignal
) {
  await agentJson(agentUrl, token, `/api/local/v1/vault/credentials/${encodeURIComponent(credentialId)}`, {method: "DELETE", signal}, agentFetch);
}

export async function executeProviderAgent(
  agentUrl: string,
  token: string,
  input: {providerId: string; credentialId?: string; operation: "stream" | "discover"; model?: string; body?: unknown},
  agentFetch: AgentFetch = fetch,
  signal?: AbortSignal
) {
  let response: Response;
  try {
    response = await agentFetch(backendApiUrl(agentUrl, "/api/local/v1/provider/execute"), {
      method: "POST",
      cache: "no-store",
      credentials: "include",
      redirect: "manual",
      headers: authorizationHeaders(token, true),
      body: JSON.stringify(input),
      signal
    });
  } catch {
    throw new Error("Provider Agent 请求失败；请检查 Agent 连接与本地网络权限");
  }
  if (response.type === "opaqueredirect" || response.status === 0 || response.status >= 300 && response.status < 400) {
    throw new Error("Provider Agent 返回了不允许的重定向");
  }
  return response;
}
