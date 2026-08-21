import type {RepositoryRefUpdate, StoredChatMessage} from "../shared/conversation-types";
import {validMessageObjectId, validRepositoryNamespace} from "../shared/message-object";
import {accountConfig} from "./account";
import {fetchRepository, pushRepositoryRef, putRepositoryObjects} from "./storage/repository-store";
import {identityFromHeaders} from "./identity";
import {json} from "./http";

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
    const input = await request.json() as {repositoryId?: unknown; objectRepositoryIds?: unknown; objects?: unknown; refs?: unknown};
    const repositoryId = validRepositoryNamespace(input.repositoryId) ? input.repositoryId : "";
    if (!repositoryId) return json({error: "repositoryId is required"}, 400);
    const objects = Array.isArray(input.objects) ? input.objects as StoredChatMessage[] : [];
    const objectRepositoryIds = input.objectRepositoryIds && typeof input.objectRepositoryIds === "object" && !Array.isArray(input.objectRepositoryIds)
      ? input.objectRepositoryIds as Record<string, unknown>
      : {};
    for (const object of objects) {
      const sourceRepositoryId = typeof objectRepositoryIds[object.id] === "string" ? String(objectRepositoryIds[object.id]) : repositoryId;
      if (!(await validMessageObjectId(object, sourceRepositoryId))) {
        return json({error: `Object ${object?.id || "unknown"} failed content verification`}, 400);
      }
    }
    const insertedObjects = putRepositoryObjects(identity, objects, repositoryId, objectRepositoryIds);
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
  return pathname.startsWith("/api/") ? json({error: "Not found"}, 404) : null;
}
