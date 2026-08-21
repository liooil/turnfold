import type {ServerChatConfig} from "./app-state";

export const backendUrlStorageKey = "turnfold-backend-url";
export const backendGrantStorageKey = "turnfold-backend-grants-v1";
export const repositorySyncScope = "repository.sync";
export const providerExecuteScope = "provider.execute";
export const vaultManageScope = "vault.manage";

type BackendFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type BackendUrlStorage = Pick<Storage, "getItem">;
type BackendGrantStorage = Pick<Storage, "getItem" | "setItem">;

type StoredBackendGrant = {
  token: string;
  expiresAt: string;
};

export type BackendPairingStart = {
  pairingId: string;
  pollToken: string;
  expiresAt: string;
  pollIntervalMs: number;
};

export type BackendBrowserGrant = {
  id: string;
  origin: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
};

export type BackendPairingPoll =
  | {status: "pending"; expiresAt: string}
  | {status: "denied"}
  | {status: "expired"}
  | {status: "approved"; token: string; grant: BackendBrowserGrant};

export class BackendPairingRequiredError extends Error {
  constructor() {
    super("此页面 Origin 需要先在 Backend 上完成配对");
    this.name = "BackendPairingRequiredError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeBackendUrl(value: string, baseUrl?: string) {
  const input = value.trim();
  if (!input) throw new Error("请输入 Backend URL");
  let url: URL;
  try {
    url = new URL(input, baseUrl);
  } catch {
    throw new Error("Backend URL 无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Backend URL 必须使用 http 或 https");
  if (url.username || url.password) throw new Error("Backend URL 不能包含用户名或密码");
  if (url.search || url.hash) throw new Error("Backend URL 不能包含查询参数或片段");
  const pathname = url.pathname.replace(/\/+$/, "");
  return pathname ? `${url.origin}${pathname}` : url.origin;
}

export function backendApiUrl(backendUrl: string, pathname: string) {
  const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${normalizeBackendUrl(backendUrl)}${suffix}`;
}

export function defaultBackendUrl(pageUrl: string, basePath: string) {
  const applicationPath = basePath ? `${basePath}/` : "/";
  return normalizeBackendUrl(new URL(applicationPath, pageUrl).href);
}

export function suggestedBackendUrl(storage: BackendUrlStorage, pageUrl: string, basePath: string) {
  const stored = storage.getItem(backendUrlStorageKey);
  if (stored) {
    try {
      return normalizeBackendUrl(stored);
    } catch {}
  }
  return defaultBackendUrl(pageUrl, basePath);
}

function storedBackendGrants(storage: BackendUrlStorage, storageKey = backendGrantStorageKey) {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) || "{}");
    return record(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function backendGrantToken(storage: BackendUrlStorage, backendUrl: string, storageKey = backendGrantStorageKey) {
  const grants = storedBackendGrants(storage, storageKey);
  const stored = grants[normalizeBackendUrl(backendUrl)];
  if (!record(stored) || typeof stored.token !== "string" || !stored.token.trim()) return "";
  if (typeof stored.expiresAt === "string" && Date.parse(stored.expiresAt) <= Date.now()) return "";
  return stored.token.trim();
}

export function saveBackendGrant(storage: BackendGrantStorage, backendUrl: string, token: string, grant: BackendBrowserGrant, storageKey = backendGrantStorageKey) {
  const normalized = normalizeBackendUrl(backendUrl);
  const grants = storedBackendGrants(storage, storageKey);
  grants[normalized] = {token: token.trim(), expiresAt: grant.expiresAt} satisfies StoredBackendGrant;
  storage.setItem(storageKey, JSON.stringify(grants));
}

export function removeBackendGrant(storage: BackendGrantStorage, backendUrl: string, storageKey = backendGrantStorageKey) {
  const normalized = normalizeBackendUrl(backendUrl);
  const grants = storedBackendGrants(storage, storageKey);
  delete grants[normalized];
  storage.setItem(storageKey, JSON.stringify(grants));
}

function serverConfig(value: unknown): ServerChatConfig {
  if (!record(value)) throw new Error("Backend 返回了无效配置");
  const identityKey = typeof value.identityKey === "string" ? value.identityKey.trim() : "";
  const profile = record(value.profile) ? value.profile : {};
  const username = typeof profile.username === "string" ? profile.username.trim() : "";
  const name = typeof profile.name === "string" ? profile.name.trim() : "";
  const email = typeof profile.email === "string" ? profile.email.trim() : "";
  if (!identityKey || !username) throw new Error("Backend 配置缺少身份信息");
  const capabilities = record(value.capabilities) ? {sync: value.capabilities.sync === true} : undefined;
  if (!capabilities?.sync) throw new Error("Backend 不支持 Turnfold 仓库同步");
  return {identityKey, profile: {username, name: name || username, email}, capabilities};
}

function authorizationHeaders(token: string, contentType = false) {
  return {
    "Accept": "application/json",
    ...(contentType ? {"Content-Type": "application/json"} : {}),
    ...(token ? {"Authorization": `Bearer ${token}`} : {})
  };
}

async function responsePayload(response: Response, description: string) {
  try {
    return await response.json() as unknown;
  } catch {
    throw new Error(`${description} 没有返回 JSON（HTTP ${response.status}）`);
  }
}

function responseError(response: Response, payload: unknown, fallback: string) {
  if (record(payload) && typeof payload.error === "string") return payload.error;
  return `${fallback} HTTP ${response.status}`;
}

export async function fetchBackendConfig(
  backendUrl: string,
  backendFetch: BackendFetch = fetch,
  signal?: AbortSignal,
  grantToken = ""
) {
  let response: Response;
  try {
    response = await backendFetch(backendApiUrl(backendUrl, "/api/config"), {
      cache: "no-store",
      credentials: "include",
      headers: authorizationHeaders(grantToken),
      redirect: "manual",
      signal
    });
  } catch {
    throw new Error("无法连接 Backend；请检查 URL、CORS 与网络状态");
  }
  if (response.type === "opaqueredirect" || response.status === 0 || response.status >= 300 && response.status < 400) {
    throw new Error("Backend 需要先完成登录或禁止了跨域连接");
  }
  const payload = await responsePayload(response, "Backend 配置接口");
  if (response.status === 401 && record(payload) && payload.code === "pairing_required") {
    throw new BackendPairingRequiredError();
  }
  if (!response.ok) {
    throw new Error(responseError(response, payload, "Backend"));
  }
  return serverConfig(payload);
}

export function backendApprovalUrl(backendUrl: string, pairingId: string) {
  return backendApiUrl(backendUrl, `/local/pair/${encodeURIComponent(pairingId)}`);
}

export async function startBackendPairing(
  backendUrl: string,
  clientName: string,
  backendFetch: BackendFetch = fetch,
  signal?: AbortSignal,
  requestedScopes: string[] = [repositorySyncScope]
): Promise<BackendPairingStart> {
  let response: Response;
  try {
    response = await backendFetch(backendApiUrl(backendUrl, "/api/local/v1/pairings"), {
      method: "POST",
      cache: "no-store",
      credentials: "include",
      headers: authorizationHeaders("", true),
      redirect: "manual",
      body: JSON.stringify({clientName, requestedScopes}),
      signal
    });
  } catch {
    throw new Error("无法发起 Backend 配对；请检查 HTTPS、CORS 与本地网络权限");
  }
  const payload = await responsePayload(response, "Backend 配对接口");
  if (!response.ok) throw new Error(responseError(response, payload, "Backend 配对"));
  if (!record(payload)) throw new Error("Backend 返回了无效的配对请求");
  const pairingId = typeof payload.pairingId === "string" ? payload.pairingId : "";
  const pollToken = typeof payload.pollToken === "string" ? payload.pollToken : "";
  const expiresAt = typeof payload.expiresAt === "string" ? payload.expiresAt : "";
  const pollIntervalMs = typeof payload.pollIntervalMs === "number"
    ? Math.min(5_000, Math.max(500, Math.floor(payload.pollIntervalMs)))
    : 1_000;
  if (!pairingId || !pollToken || !expiresAt) throw new Error("Backend 返回了无效的配对请求");
  return {pairingId, pollToken, expiresAt, pollIntervalMs};
}

function browserGrant(value: unknown, requiredScopes: string[]): BackendBrowserGrant {
  if (!record(value)) throw new Error("Backend 返回了无效的浏览器授权");
  const id = typeof value.id === "string" ? value.id : "";
  const origin = typeof value.origin === "string" ? value.origin : "";
  const clientName = typeof value.clientName === "string" ? value.clientName : "";
  const scopes = Array.isArray(value.scopes) ? value.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  const expiresAt = typeof value.expiresAt === "string" ? value.expiresAt : "";
  if (!id || !origin || !clientName || !requiredScopes.every((scope) => scopes.includes(scope)) || !createdAt || !expiresAt) {
    throw new Error("Backend 返回了无效的浏览器授权");
  }
  return {id, origin, clientName, scopes, createdAt, expiresAt};
}

export async function pollBackendPairing(
  backendUrl: string,
  pairing: Pick<BackendPairingStart, "pairingId" | "pollToken">,
  backendFetch: BackendFetch = fetch,
  signal?: AbortSignal,
  requiredScopes: string[] = [repositorySyncScope]
): Promise<BackendPairingPoll> {
  let response: Response;
  try {
    response = await backendFetch(backendApiUrl(backendUrl, `/api/local/v1/pairings/${encodeURIComponent(pairing.pairingId)}/poll`), {
      method: "POST",
      cache: "no-store",
      credentials: "include",
      headers: authorizationHeaders("", true),
      redirect: "manual",
      body: JSON.stringify({pollToken: pairing.pollToken}),
      signal
    });
  } catch {
    throw new Error("Backend 配对状态不可用");
  }
  const payload = await responsePayload(response, "Backend 配对状态接口");
  if (!record(payload) || !["pending", "denied", "expired", "approved"].includes(String(payload.status))) {
    if (!response.ok) throw new Error(responseError(response, payload, "Backend 配对"));
    throw new Error("Backend 返回了无效的配对状态");
  }
  if (payload.status === "pending") {
    return {status: "pending", expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : ""};
  }
  if (payload.status === "denied" || payload.status === "expired") return {status: payload.status};
  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  if (!response.ok || !token) throw new Error(responseError(response, payload, "Backend 配对"));
  return {status: "approved", token, grant: browserGrant(payload.grant, requiredScopes)};
}

export async function revokeBackendGrant(
  backendUrl: string,
  grantToken: string,
  backendFetch: BackendFetch = fetch,
  signal?: AbortSignal
) {
  const response = await backendFetch(backendApiUrl(backendUrl, "/api/local/v1/grant"), {
    method: "DELETE",
    cache: "no-store",
    credentials: "include",
    headers: authorizationHeaders(grantToken),
    redirect: "manual",
    signal
  });
  const payload = await responsePayload(response, "Backend 授权接口");
  if (!response.ok) throw new Error(responseError(response, payload, "Backend 授权"));
  if (!record(payload) || payload.revoked !== true) throw new Error("Backend 未确认撤销配对");
}
