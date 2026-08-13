import {createHash} from "node:crypto";
import path from "node:path";
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
import {identityFromHeaders, type ChatIdentity} from "../lib/identity";
import type {RepositoryRefUpdate, StoredChatMessage} from "../lib/conversation-types";
import {validMessageObjectId} from "../lib/message-object";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const portalUrl = process.env.PORTAL_URL?.trim() || "";
const staticRoot = path.resolve(process.env.STATIC_ROOT || "dist");

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

async function config(request: Request) {
  try {
    const identity = identityFromHeaders(request.headers);
    return json({identityKey: identityKey(identity), profile: await accountProfile(identity), capabilities: {sync: true}});
  } catch (error) {
    return json({error: error instanceof Error ? error.message : "Account configuration unavailable"}, errorStatus(error, 503));
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
    if (pathname === "/api/config" && request.method === "GET") return config(request);
    if (pathname === "/api/sync/fetch") return repositoryFetch(request);
    if (pathname === "/api/sync/push") return repositoryPush(request);
    if (pathname === "/api/conversations") return conversations(request);
    const conversationMessageMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (conversationMessageMatch) return conversationMessage(request, decodeURIComponent(conversationMessageMatch[1]));
    const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (conversationMatch) return conversation(request, decodeURIComponent(conversationMatch[1]));
    if (pathname.startsWith("/api/")) return json({error: "Not found"}, 404);
    if (request.method !== "GET" && request.method !== "HEAD") return json({error: "Method not allowed"}, 405);
    return staticResponse(pathname);
  }
});

console.log(`Turnfold Bun server listening on ${new URL(basePath ? `${basePath}/` : "/", server.url)}`);
