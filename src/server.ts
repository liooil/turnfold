import {createHash, randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import {convertToModelMessages, streamText, type UIMessage} from "ai";
import {
  appendConversationMessage,
  createConversation,
  deleteConversation,
  fetchRepository,
  getConversation,
  listConversations,
  pushRepositoryRef,
  putRepositoryObjects,
  saveConversationMessages,
  updateConversation
} from "../lib/conversations";
import {generationCallOptions, normalizeGenerationSettings} from "../lib/generation-settings";
import {identityFromHeaders, keyVaultAvailable, keyVaultFetch, type ChatIdentity} from "../lib/key-vault";
import {discoverProviderModels, testProviderConnectivity} from "../lib/provider-connectivity";
import {createProviderModel} from "../lib/provider-model";
import {createServerProviderFetch} from "../lib/server-provider-fetch";
import {publicFrontendProviders} from "../lib/public-provider-catalog";
import type {ProviderDefinition, ProviderSecret, ResolvedBackendProvider} from "../lib/provider-types";
import {responseMetadata} from "../lib/response-metadata";
import type {RepositoryRefUpdate, StoredChatMessage} from "../lib/conversation-types";
import {validMessageObjectId} from "../lib/message-object";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const portalUrl = process.env.PORTAL_URL?.trim() || "";
const accountUrl = process.env.ACCOUNT_URL?.trim() || "";
const staticRoot = path.resolve(process.env.STATIC_ROOT || "dist");
const publicProviderCatalogFile = path.resolve(process.env.PUBLIC_PROVIDER_CATALOG_FILE || "providers.json");
const encoder = new TextEncoder();

function normalizedBasePath(value: string | undefined) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

const basePath = normalizedBasePath(process.env.BASE_PATH);
const securityHeaders = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    "connect-src 'self' http: https: ws: wss:"
  ].join("; "),
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

function json(payload: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(payload, {status, headers: {...securityHeaders, "Cache-Control": "no-store", ...headers}});
}

function identityKey(identity: ChatIdentity) {
  return createHash("sha256").update(`${identity.issuer}\0${identity.sub}`).digest("hex").slice(0, 32);
}

function errorStatus(error: unknown, fallback: number) {
  return typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : fallback;
}

async function accountProfile(identity: ChatIdentity) {
  const fallback = {username: identity.username, name: identity.name || identity.username, email: identity.email};
  if (!portalUrl) return fallback;
  try {
    const response = await fetch(new URL("/api/account/identity", portalUrl), {
      headers: {
        "Accept": "application/json",
        "X-Portal-Authenticated": "1",
        "X-Authentik-Username": identity.username,
        "X-Authentik-Uid": identity.sub,
        "X-Authentik-Email": identity.email
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return fallback;
    const payload = await response.json() as {profile?: {username?: string; name?: string; email?: string}};
    return {
      username: payload.profile?.username?.trim() || fallback.username,
      name: payload.profile?.name?.trim() || fallback.name,
      email: payload.profile?.email?.trim() || fallback.email
    };
  } catch {
    return fallback;
  }
}

async function discoverBackendProvider(provider: ProviderDefinition, identity: ChatIdentity) {
  if (provider.connection.type !== "backend" || !provider.credentials.length) return {...provider, models: []};
  const credential = provider.credentials.find((item) => item.name === "default") || provider.credentials[0];
  const response = await keyVaultFetch("/v1/resolve", identity, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({providerId: provider.id, credentialName: credential.name})
  });
  const resolved = await response.json() as ResolvedBackendProvider & {error?: string};
  if (!response.ok) return {...provider, models: [], modelDiscoveryError: resolved.error || `Key Vault HTTP ${response.status}`};
  try {
    const discovery = await discoverProviderModels(
      resolved.provider,
      resolved.credential.secret,
      createServerProviderFetch(resolved.provider, resolved.credential.secret)
    );
    return {...provider, models: discovery.models};
  } catch (error) {
    return {...provider, models: [], modelDiscoveryError: error instanceof Error ? error.message : "Model discovery failed"};
  }
}

async function config(request: Request) {
  try {
    const identity = identityFromHeaders(request.headers);
    if (!keyVaultAvailable()) {
      return json({providers: configuredPublicFrontendProviders(), identityKey: identityKey(identity), profile: await accountProfile(identity), accountUrl});
    }
    const response = await keyVaultFetch("/v1/providers", identity);
    const payload = await response.json() as {providers?: ProviderDefinition[]; error?: string};
    if (!response.ok) return json({error: payload.error || `Key Vault HTTP ${response.status}`}, response.status);
    const [providers, profile] = await Promise.all([
      Promise.all((payload.providers || []).map((provider) => discoverBackendProvider(provider, identity))),
      accountProfile(identity)
    ]);
    return json({providers, identityKey: identityKey(identity), profile, accountUrl});
  } catch (error) {
    return json({error: error instanceof Error ? error.message : "Provider configuration unavailable"}, errorStatus(error, 503));
  }
}

function configuredPublicFrontendProviders(): ProviderDefinition[] {
  const definitions = JSON.parse(readFileSync(publicProviderCatalogFile, "utf8")) as Array<Record<string, unknown>>;
  return publicFrontendProviders(definitions);
}

function publicConfig() {
  try {
    return json({providers: configuredPublicFrontendProviders()});
  } catch (error) {
    return json({error: error instanceof Error ? error.message : "Public Provider configuration unavailable"}, 503);
  }
}

async function conversations(request: Request) {
  try {
    const identity = identityFromHeaders(request.headers);
    if (request.method === "GET") return json({conversations: listConversations(identity)});
    if (request.method === "POST") return json({conversation: createConversation(identity, await request.json())}, 201);
    return json({error: "Method not allowed"}, 405, {Allow: "GET, POST"});
  } catch (error) {
    return json({error: error instanceof Error ? error.message : "Conversation request failed"}, request.method === "POST" ? 400 : 500);
  }
}

async function conversation(request: Request, id: string) {
  try {
    const identity = identityFromHeaders(request.headers);
    if (request.method === "GET") {
      const value = getConversation(identity, id);
      return value ? json({conversation: value}) : json({error: "Conversation not found"}, 404);
    }
    if (request.method === "PUT") {
      const value = saveConversationMessages(identity, id, await request.json());
      return value ? json({conversation: value}) : json({error: "Conversation not found"}, 404);
    }
    if (request.method === "PATCH") {
      const value = updateConversation(identity, id, await request.json());
      return value ? json({conversation: value}) : json({error: "Conversation not found"}, 404);
    }
    if (request.method === "DELETE") {
      return deleteConversation(identity, id)
        ? new Response(null, {status: 204, headers: securityHeaders})
        : json({error: "Conversation not found"}, 404);
    }
    return json({error: "Method not allowed"}, 405, {Allow: "GET, PUT, PATCH, DELETE"});
  } catch (error) {
    return json({error: error instanceof Error ? error.message : "Conversation request failed"}, 400);
  }
}

async function conversationMessage(request: Request, id: string) {
  try {
    if (request.method !== "POST") return json({error: "Method not allowed"}, 405, {Allow: "POST"});
    const identity = identityFromHeaders(request.headers);
    const result = appendConversationMessage(identity, id, await request.json());
    if (result.status === "missing") return json({error: "Conversation not found"}, 404);
    if (result.status === "conflict") return json({error: "Conversation head changed", conversation: result.conversation}, 409);
    return json({conversation: result.conversation}, 201);
  } catch (error) {
    return json({error: error instanceof Error ? error.message : "Message commit failed"}, 400);
  }
}

async function repositoryFetch(request: Request) {
  try {
    if (request.method !== "POST") return json({error: "Method not allowed"}, 405, {Allow: "POST"});
    const identity = identityFromHeaders(request.headers);
    const input = await request.json() as {haveObjectIds?: unknown};
    return json(fetchRepository(identity, input.haveObjectIds));
  } catch (error) {
    return json({error: error instanceof Error ? error.message : "Repository fetch failed"}, 400);
  }
}

async function repositoryPush(request: Request) {
  try {
    if (request.method !== "POST") return json({error: "Method not allowed"}, 405, {Allow: "POST"});
    const identity = identityFromHeaders(request.headers);
    const input = await request.json() as {repositoryId?: unknown; objects?: unknown; refs?: unknown};
    const repositoryId = typeof input.repositoryId === "string" && /^local:[a-zA-Z0-9-]{8,160}$/.test(input.repositoryId)
      ? input.repositoryId
      : "";
    const objects = Array.isArray(input.objects) ? input.objects as StoredChatMessage[] : [];
    for (const object of objects) {
      const validForRepository = repositoryId ? await validMessageObjectId(object, repositoryId) : false;
      const validLegacyObject = validForRepository ? false : await validMessageObjectId(object, identityKey(identity));
      if (!validForRepository && !validLegacyObject) return json({error: `Object ${object?.id || "unknown"} failed content verification`}, 400);
    }
    const insertedObjects = putRepositoryObjects(identity, objects);
    const refs = Array.isArray(input.refs) ? input.refs as RepositoryRefUpdate[] : [];
    if (refs.length > 100) return json({error: "refs must contain at most 100 entries"}, 400);
    const results = refs.map((update) => ({conversationId: update.conversationId, ...pushRepositoryRef(identity, update)}));
    return json({insertedObjects, refs: results, pushedAt: new Date().toISOString()});
  } catch (error) {
    return json({error: error instanceof Error ? error.message : "Repository push failed"}, 400);
  }
}

function temporaryProvider(value: unknown): ProviderDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("provider is required");
  const input = value as Record<string, unknown>;
  const connectionInput = input.connection as Record<string, unknown> | undefined;
  const authInput = input.auth as Record<string, unknown> | undefined;
  const discoveryInput = input.discovery as Record<string, unknown> | undefined;
  const id = String(input.id || "").trim().toLowerCase();
  const name = String(input.name || "").trim();
  const api = String(input.api || "");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error("provider.id is invalid");
  if (!name) throw new Error("provider.name is required");
  if (!["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].includes(api)) throw new Error("provider.api is invalid");
  if (connectionInput?.type !== "backend") throw new Error("Only Backend Provider drafts can be tested by the Chat server");
  const baseUrl = new URL(String(connectionInput.baseUrl || ""));
  if (!["http:", "https:"].includes(baseUrl.protocol)) throw new Error("provider baseUrl is invalid");
  const proxyInput = connectionInput.proxy as Record<string, unknown> | null | undefined;
  let proxy: ProviderDefinition["connection"]["proxy"] = null;
  if (proxyInput) {
    const type = String(proxyInput.type || "") as "http" | "https" | "socks5";
    if (!["http", "https", "socks5"].includes(type)) throw new Error("provider proxy type is invalid");
    const url = new URL(String(proxyInput.url || ""));
    if (type === "socks5" ? url.protocol !== "socks5:" : !["http:", "https:"].includes(url.protocol)) throw new Error("provider proxy URL is invalid");
    proxy = {type, url: url.toString().replace(/\/$/, "")};
  }
  const defaultModel = String(input.defaultModel || "").trim().slice(0, 300);
  if (!defaultModel) throw new Error("provider.defaultModel is required");
  const authType = ["bearer", "header", "none"].includes(String(authInput?.type)) ? String(authInput?.type) as "bearer" | "header" | "none" : "bearer";
  const header = authType === "header" ? String(authInput?.header || "").trim() : "";
  if (authType === "header" && !header) throw new Error("provider auth header is required");
  const discoveryType = String(discoveryInput?.type || "");
  if (!["openai-models-list", "anthropic-models-list", "google-models-list"].includes(discoveryType)) throw new Error("provider.discovery.type is invalid");
  const discoveryUrl = new URL(String(discoveryInput?.url || ""));
  if (!["http:", "https:"].includes(discoveryUrl.protocol)) throw new Error("provider.discovery.url is invalid");
  return {
    id,
    name,
    api: api as ProviderDefinition["api"],
    connection: {type: "backend", baseUrl: baseUrl.toString().replace(/\/$/, ""), proxy},
    defaultModel,
    auth: authType === "header" ? {type: authType, header} : {type: authType},
    headers: {},
    discovery: {type: discoveryType as ProviderDefinition["discovery"]["type"], url: discoveryUrl.toString()},
    builtin: false,
    credentialState: "missing",
    credentials: []
  };
}

async function catalogFor(identity: ChatIdentity) {
  const response = await keyVaultFetch("/v1/providers", identity);
  const payload = await response.json() as {providers?: ProviderDefinition[]; error?: string};
  if (!response.ok) throw Object.assign(new Error(payload.error || `Key Vault HTTP ${response.status}`), {statusCode: response.status});
  return payload.providers || [];
}

async function savedSecret(identity: ChatIdentity, provider: ProviderDefinition, credentialName: string) {
  if (!provider.credentials.some((credential) => credential.name === credentialName)) return null;
  const response = await keyVaultFetch("/v1/resolve", identity, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({providerId: provider.id, credentialName})
  });
  const payload = await response.json() as ResolvedBackendProvider & {error?: string};
  if (!response.ok) throw Object.assign(new Error(payload.error || `Key Vault HTTP ${response.status}`), {statusCode: response.status});
  return payload.credential.secret;
}

async function providerTest(request: Request) {
  try {
    const identity = identityFromHeaders(request.headers);
    const input = await request.json() as {providerId?: string; credentialName?: string; provider?: unknown; secret?: ProviderSecret};
    const credentialName = input.credentialName?.trim() || "default";
    let provider: ProviderDefinition;
    let secret: ProviderSecret = input.secret || {};
    if (input.provider) {
      provider = temporaryProvider(input.provider);
      if (provider.auth.type !== "none" && !secret.provider?.apiKey) {
        const saved = (await catalogFor(identity)).find((item) => item.id === provider.id);
        const existingSecret = saved ? await savedSecret(identity, saved, credentialName) : null;
        if (!existingSecret) return json({error: "Temporary API Key is required for connectivity testing"}, 409);
        secret = existingSecret;
      }
    } else {
      const providerId = input.providerId?.trim();
      if (!providerId) return json({error: "providerId is required"}, 400);
      const saved = (await catalogFor(identity)).find((item) => item.id === providerId);
      if (!saved) return json({error: "Provider not found"}, 404);
      provider = saved;
      const existingSecret = await savedSecret(identity, provider, credentialName);
      if (existingSecret) secret = existingSecret;
      else if (provider.auth.type !== "none") return json({error: `Credential ${credentialName} is required for connectivity testing`}, 409);
    }
    const result = await testProviderConnectivity(provider, secret, createServerProviderFetch(provider, secret));
    return json({...result, detected: {id: provider.id, name: provider.name, api: provider.api, auth: provider.auth, connection: provider.connection, discovery: provider.discovery}});
  } catch (error) {
    return json({error: error instanceof Error ? error.message : "Provider connectivity test failed"}, errorStatus(error, 502));
  }
}

function streamEvent(controller: ReadableStreamDefaultController<Uint8Array>, event: unknown) {
  controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
}

function cleanMessages(value: unknown): StoredChatMessage[] {
  if (!Array.isArray(value)) throw new Error("messages are required");
  const timestamp = new Date().toISOString();
  let parentMessageId: string | null = null;
  return value.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("message is invalid");
    const record = message as Partial<StoredChatMessage>;
    const normalized: StoredChatMessage = {
      id: typeof record.id === "string" ? record.id : randomUUID(),
      parentMessageId: typeof record.parentMessageId === "string" ? record.parentMessageId : parentMessageId,
      role: record.role as StoredChatMessage["role"],
      parts: Array.isArray(record.parts) ? record.parts.filter((part) => part.type === "text" || part.type === "reasoning") : [],
      origin: record.origin || {type: "legacy"},
      completion: record.completion || {status: "complete"},
      createdAt: record.createdAt || timestamp,
      completedAt: record.completedAt || timestamp,
      ...(record.metadata ? {metadata: record.metadata} : {})
    };
    parentMessageId = normalized.id;
    return normalized;
  });
}

function asTokenCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value);
  if (typeof value === "bigint" && value >= 0n) return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }
  return null;
}

function extractOutputTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return;
  const record = usage as Record<string, unknown>;
  const directCandidates = [
    "outputTokens",
    "completionTokens",
    "completion_tokens",
    "output_tokens",
    "responseTokens",
    "generatedTokens",
    "textGenerationTokens"
  ];
  for (const key of directCandidates) {
    const value = asTokenCount(record[key]);
    if (value !== null) return value;
  }
  const total = asTokenCount(record.totalTokens) ?? asTokenCount(record.total_tokens) ?? asTokenCount(record.tokens);
  const prompt = asTokenCount(record.promptTokens) ?? asTokenCount(record.prompt_tokens) ?? asTokenCount(record.inputTokens) ?? asTokenCount(record.input_tokens);
  if (total !== null && prompt !== null) return Math.max(0, total - prompt);
  return;
}

function estimateOutputTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const nonWhite = trimmed.replace(/\s+/g, "");
  const chineseChars = (nonWhite.match(/\p{Script=Han}/gu) || []).length;
  const otherChars = nonWhite.length - chineseChars;
  return Math.max(0, Math.round(chineseChars + otherChars / 4));
}

async function chat(request: Request) {
  try {
    const identity = identityFromHeaders(request.headers);
    const input = await request.json() as {
      messages?: unknown;
      providerId?: string;
      credentialName?: string;
      model?: string;
      conversationId?: string;
      generationSettings?: unknown;
    };
    const messages = cleanMessages(input.messages);
    if (!messages.length) return json({error: "messages are required"}, 400);
    if (!input.providerId?.trim() || !input.model?.trim() || !input.conversationId?.trim()) {
      return json({error: "conversationId, providerId and model are required"}, 400);
    }
    const conversationId = input.conversationId.trim();
    const response = await keyVaultFetch("/v1/resolve", identity, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({providerId: input.providerId.trim(), credentialName: input.credentialName?.trim() || "default"})
    });
    const resolved = await response.json() as ResolvedBackendProvider & {error?: string};
    if (!response.ok) return json({error: resolved.error || `Key Vault HTTP ${response.status}`}, response.status);
    if (resolved.provider.connection.type !== "backend") return json({error: "Frontend Provider must run in the browser"}, 409);
    const providerFetch = createServerProviderFetch(resolved.provider, resolved.credential.secret);
    const model = await createProviderModel(resolved.provider, resolved.credential.secret, input.model.trim(), providerFetch);
    const generationSettings = normalizeGenerationSettings(input.generationSettings);
    const startedAt = performance.now();
    const result = streamText({
      model,
      messages: await convertToModelMessages(messages as UIMessage[]),
      abortSignal: request.signal,
      ...generationCallOptions(resolved.provider, generationSettings)
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let text = "";
        let reasoning = "";
        try {
          streamEvent(controller, {type: "start"});
          for await (const part of result.fullStream) {
            if (part.type === "text-delta") {
              text += part.text;
              streamEvent(controller, {type: "text-delta", text: part.text});
            } else if (part.type === "reasoning-delta") {
              reasoning += part.text;
              streamEvent(controller, {type: "reasoning-delta", text: part.text});
            } else if (part.type === "error") {
              throw part.error;
            }
          }
          const usage = await result.usage;
          const outputTokens = extractOutputTokens(usage);
          const metadata = responseMetadata(
            input.providerId!.trim(),
            input.model!.trim(),
            startedAt,
            outputTokens,
            outputTokens === undefined ? estimateOutputTokens(text) : undefined
          );
          streamEvent(controller, {type: "finish", metadata});
        } catch (error) {
          console.error("Backend Provider request failed", error instanceof Error ? error.message : error);
          streamEvent(controller, {type: "error", error: error instanceof Error ? error.message : "Chat request failed"});
        } finally {
          controller.close();
        }
      }
    });
    return new Response(body, {
      headers: {
        ...securityHeaders,
        "Cache-Control": "no-store",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Accel-Buffering": "no"
      }
    });
  } catch (error) {
    console.error("Chat request failed", error instanceof Error ? error.message : error);
    return json({error: error instanceof Error ? error.message : "Chat request failed"}, errorStatus(error, 500));
  }
}

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp"
};

async function staticResponse(pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return json({error: "Invalid path"}, 400);
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  let filePath = path.resolve(staticRoot, relative);
  if (!filePath.startsWith(`${staticRoot}${path.sep}`) && filePath !== path.join(staticRoot, "index.html")) return json({error: "Not found"}, 404);
  let file = Bun.file(filePath);
  if (!(await file.exists()) && !path.extname(relative)) {
    filePath = path.join(staticRoot, "index.html");
    file = Bun.file(filePath);
  }
  if (!(await file.exists())) return json({error: "Not found"}, 404);
  const extension = path.extname(filePath);
  const immutable = /-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(path.basename(filePath))
    || relative.startsWith("assets/mathjax/4.1.3/");
  return new Response(file, {
    headers: {
      ...securityHeaders,
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Cache-Control": extension === ".html" || path.basename(filePath) === "sw.js"
        ? "no-cache"
        : immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600"
    }
  });
}

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  idleTimeout: 255,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (basePath && url.pathname === basePath) return Response.redirect(new URL(`${basePath}/${url.search}${url.hash}`, request.url), 308);
    if (basePath && !url.pathname.startsWith(`${basePath}/`)) return json({error: "Not found"}, 404);
    const pathname = url.pathname.slice(basePath.length) || "/";
    if (pathname === "/api/health" && request.method === "GET") return json({status: "ok"});
    if (pathname === "/api/public-config" && request.method === "GET") return publicConfig();
    if (pathname === "/api/login" && request.method === "GET") return Response.redirect(new URL(`${basePath}/`, request.url), 302);
    if (pathname === "/api/config" && request.method === "GET") return config(request);
    if (pathname === "/api/sync/fetch") return repositoryFetch(request);
    if (pathname === "/api/sync/push") return repositoryPush(request);
    if (pathname === "/api/conversations") return conversations(request);
    const conversationMessageMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (conversationMessageMatch) return conversationMessage(request, decodeURIComponent(conversationMessageMatch[1]));
    const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (conversationMatch) return conversation(request, decodeURIComponent(conversationMatch[1]));
    if (pathname === "/api/provider-test" && request.method === "POST") return providerTest(request);
    if (pathname === "/api/chat" && request.method === "POST") {
      server.timeout(request, 0);
      return chat(request);
    }
    if (pathname.startsWith("/api/")) return json({error: "Not found"}, 404);
    if (request.method !== "GET" && request.method !== "HEAD") return json({error: "Method not allowed"}, 405);
    return staticResponse(pathname);
  }
});

console.log(`Turnfold Bun server listening on ${new URL(basePath ? `${basePath}/` : "/", server.url)}`);
