import type {Conversation, StoredChatMessage} from "../../shared/conversation-types";
import {cacheConversation} from "../storage/offline-history";
import {listPendingConversationChanges, removePendingConversationChange} from "../storage/pending-changes";

class LegacyConversationHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
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
  if (!response.ok) throw new LegacyConversationHttpError(payload.error || `HTTP ${response.status}`, response.status);
  return payload as T;
}

export async function saveLegacyConversation(
  apiUrl: (pathname: string) => string,
  id: string,
  providerId: string,
  model: string,
  messages: StoredChatMessage[]
) {
  const body = JSON.stringify({providerId, model, messages});
  const payload = await request<{conversation: Conversation}>(apiUrl(`/api/conversations/${encodeURIComponent(id)}`), {method: "PUT", body});
  await cacheConversation(payload.conversation);
  return payload.conversation;
}

export async function flushLegacyConversationChanges(apiUrl: (pathname: string) => string) {
  const pending = await listPendingConversationChanges();
  for (const change of pending) {
    const requestPath = change.requestPath || `/api/conversations/${encodeURIComponent(change.conversationId)}`;
    try {
      await request<void>(apiUrl(requestPath), {method: change.method, body: change.body});
      await removePendingConversationChange(change.cacheKey);
    } catch (error) {
      if (error instanceof LegacyConversationHttpError && change.method === "DELETE" && error.status === 404) {
        await removePendingConversationChange(change.cacheKey);
        continue;
      }
      throw error;
    }
  }
}
