import type {
  MessageCompletion,
  MessageOrigin,
  StoredChatMessage
} from "../shared/conversation-types";
import type {GenerationSettings} from "../shared/generation-settings";
import {conversationRepository, peerSyncStateRepository, replicationRepository} from "./repository/repositories";
import {backendApiUrl, normalizeBackendUrl} from "./backend-connection";
import {HttpRepositoryPeer} from "./sync/http-repository-peer";
import {SyncEngine} from "./sync/sync-engine";
import {WebDavRepositoryPeer, type WebDavAuthentication} from "./sync/webdav-repository-peer";
const syncEngine = new SyncEngine(replicationRepository, peerSyncStateRepository);

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

export function listConversationHistory() {
  return conversationRepository.list();
}

export async function createConversationHistory(
  providerId: string,
  model: string,
  generationSettings: GenerationSettings,
  name: string,
  headMessageId: string | null = null,
  messages: StoredChatMessage[] = []
) {
  return conversationRepository.create({
    providerId,
    model,
    generationSettings,
    name,
    headMessageId,
    messages
  });
}

export async function getConversationHistory(id: string) {
  const cached = await conversationRepository.get(id);
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
  return conversationRepository.update(id, {
    providerId,
    model,
    generationSettings,
    name
  });
}

export async function commitConversationMessage(conversationId: string, input: MessageCommitInput) {
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
  return conversationRepository.commit({conversationId, expectedHeadId: input.expectedHeadId, message});
}

export function moveConversationHead(conversationId: string, headMessageId: string | null) {
  return conversationRepository.moveHead(conversationId, headMessageId);
}
export async function deleteConversationHistory(id: string) {
  await conversationRepository.remove(id);
}
export async function synchronizeConversationRepository(backendUrl: string, signal?: AbortSignal, grantToken = "") {
  const normalized = normalizeBackendUrl(backendUrl);
  const httpRepositoryPeer = new HttpRepositoryPeer(
    `server:${normalized}`,
    (pathname) => backendApiUrl(normalized, pathname),
    signal,
    grantToken
  );
  const result = await syncEngine.syncWith(httpRepositoryPeer);
  return {summaries: await conversationRepository.list(), ...result};
}

export async function synchronizeConversationWebDav(
  webdavUrl: string,
  authentication: WebDavAuthentication,
  signal?: AbortSignal
) {
  const peer = new WebDavRepositoryPeer(webdavUrl, authentication, signal);
  const result = await syncEngine.syncWith(peer);
  return {summaries: await conversationRepository.list(), ...result};
}
