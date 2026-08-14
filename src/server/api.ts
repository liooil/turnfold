import type {RepositoryRefUpdate, StoredChatMessage} from "../shared/conversation-types";
import {validMessageObjectId} from "../shared/message-object";
import {accountConfig, identityKey} from "./account";
import {
  appendConversationMessage,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  saveConversationMessages,
  updateConversation
} from "./storage/conversations";
import {fetchRepository, pushRepositoryRef, putRepositoryObjects} from "./storage/repository-store";
import {identityFromHeaders} from "./identity";
import {json, securityHeaders} from "./http";

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

export async function apiResponse(request: Request, pathname: string): Promise<Response | null> {
  if (pathname === "/api/health" && request.method === "GET") return json({status: "ok"});
  if (pathname === "/api/config" && request.method === "GET") return accountConfig(request);
  if (pathname === "/api/sync/fetch") return repositoryFetch(request);
  if (pathname === "/api/sync/push") return repositoryPush(request);
  if (pathname === "/api/conversations") return conversations(request);
  const conversationMessageMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (conversationMessageMatch) return conversationMessage(request, decodeURIComponent(conversationMessageMatch[1]));
  const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (conversationMatch) return conversation(request, decodeURIComponent(conversationMatch[1]));
  return pathname.startsWith("/api/") ? json({error: "Not found"}, 404) : null;
}
