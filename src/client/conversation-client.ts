import type {
  Conversation,
  ConversationRefState,
  ConversationSummary,
  MessageCompletion,
  MessageOrigin,
  RepositoryFetch,
  StoredChatMessage
} from "../shared/conversation-types";
import type {GenerationSettings} from "../shared/generation-settings";
import {
  applyRepositoryFetch,
  applyRepositoryPushResults,
  cacheConversation,
  cacheConversationSummaries,
  commitLocalMessage,
  createLocalConversation,
  deleteLocalConversation,
  listCachedObjectIds,
  loadCachedConversation,
  loadCachedConversationSummaries,
  moveLocalConversationHead,
  queueLocalRefUpdate,
  repositoryPushPayload
} from "./storage/offline-history";
import {listPendingConversationChanges, queueConversationChange, removePendingConversationChange} from "./storage/pending-changes";
import {repositoryPushBatches} from "../shared/repository-push-batches";

declare const __TURNFOLD_BASE_PATH__: string;

const chatBasePath = __TURNFOLD_BASE_PATH__;
const chatApi = (pathname: string) => `${chatBasePath}${pathname}`;

export type MessageCommitInput = {
  id: string;
  expectedHeadId: string | null;
  parentMessageId: string | null;
  role: StoredChatMessage["role"];
  parts: StoredChatMessage["parts"];
  origin: MessageOrigin;
  completion: MessageCompletion;
  createdAt: string;
  completedAt: string;
  metadata?: StoredChatMessage["metadata"];
  providerId?: string;
  model?: string;
};

class ConversationHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function conversationRequest<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: {
      "Accept": "application/json",
      ...(init?.body ? {"Content-Type": "application/json"} : {}),
      ...(init?.headers || {})
    }
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json();
  if (!response.ok) throw new ConversationHttpError(payload.error || `HTTP ${response.status}`, response.status);
  return payload as T;
}

export function listConversationHistory() {
  return loadCachedConversationSummaries();
}

export async function createConversationHistory(
  providerId: string,
  model: string,
  generationSettings: GenerationSettings,
  name: string,
  headMessageId: string | null = null,
  messages: StoredChatMessage[] = []
) {
  const timestamp = new Date().toISOString();
  const conversation: Conversation = {
    id: crypto.randomUUID(),
    name,
    headMessageId,
    upstreamHeadMessageId: null,
    providerId,
    model,
    generationSettings,
    headVersion: 0,
    metadataVersion: 0,
    messageCount: messages.length,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages
  };
  return createLocalConversation(conversation);
}

export async function getConversationHistory(id: string) {
  const cached = await loadCachedConversation(id);
  if (!cached) throw new Error("Local conversation is unavailable; fetch may still be in progress");
  return cached;
}

export async function updateConversationHistory(
  id: string,
  providerId: string,
  model: string,
  generationSettings: GenerationSettings,
  name?: string
) {
  const cached = await getConversationHistory(id);
  const updated: Conversation = {
    ...cached,
    providerId,
    model,
    generationSettings,
    ...(name === undefined ? {} : {name}),
    updatedAt: new Date().toISOString()
  };
  return queueLocalRefUpdate(updated);
}

export async function commitConversationMessage(conversationId: string, input: MessageCommitInput) {
  const cached = await getConversationHistory(conversationId);
  if (cached.headMessageId !== input.expectedHeadId || input.parentMessageId !== input.expectedHeadId) throw new Error("Local conversation head changed");
  const message: StoredChatMessage = {
    id: input.id,
    parentMessageId: input.parentMessageId,
    role: input.role,
    parts: input.parts,
    origin: input.origin,
    completion: input.completion,
    createdAt: input.createdAt,
    completedAt: input.completedAt,
    ...(input.metadata ? {metadata: input.metadata} : {})
  };
  return commitLocalMessage(conversationId, message);
}

export function moveConversationHead(conversationId: string, headMessageId: string | null) {
  return moveLocalConversationHead(conversationId, headMessageId);
}

// Compatibility for queued operations produced by an older client.
export async function saveConversationHistory(id: string, providerId: string, model: string, messages: StoredChatMessage[]) {
  const body = JSON.stringify({providerId, model, messages});
  const payload = await conversationRequest<{conversation: Conversation}>(chatApi(`/api/conversations/${encodeURIComponent(id)}`), {method: "PUT", body});
  await cacheConversation(payload.conversation);
  return payload.conversation;
}

export async function deleteConversationHistory(id: string) {
  await deleteLocalConversation(id);
}

export async function flushPendingConversationChanges() {
  const pending = await listPendingConversationChanges();
  for (const change of pending) {
    const requestPath = change.requestPath || `/api/conversations/${encodeURIComponent(change.conversationId)}`;
    try {
      await conversationRequest<void>(chatApi(requestPath), {method: change.method, body: change.body});
      await removePendingConversationChange(change.cacheKey);
    } catch (error) {
      if (error instanceof ConversationHttpError && change.method === "DELETE" && error.status === 404) {
        await removePendingConversationChange(change.cacheKey);
        continue;
      }
      throw error;
    }
  }
}

export async function synchronizeConversationRepository() {
  await flushPendingConversationChanges();
  const push = await repositoryPushPayload();
  let conflicts = 0;
  if (push.refs.length || push.objects.length) {
    for (const batch of repositoryPushBatches(push)) {
      const pushed = await conversationRequest<{
        refs: Array<{conversationId: string; status: "ok" | "conflict"; ref: ConversationRefState | null}>;
      }>(chatApi("/api/sync/push"), {method: "POST", body: JSON.stringify(batch)});
      await applyRepositoryPushResults(pushed.refs);
      conflicts += pushed.refs.filter((result) => result.status === "conflict").length;
    }
  }
  const haveObjectIds = await listCachedObjectIds();
  const fetched = await conversationRequest<RepositoryFetch>(chatApi("/api/sync/fetch"), {
    method: "POST",
    body: JSON.stringify({haveObjectIds})
  });
  await applyRepositoryFetch(fetched);
  return {summaries: await loadCachedConversationSummaries(), fetchedAt: fetched.fetchedAt, conflicts};
}

export const synchronizeOfflineConversationHistory = synchronizeConversationRepository;
