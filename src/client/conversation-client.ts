import type {
  MessageCompletion,
  MessageOrigin,
  StoredChatMessage
} from "../shared/conversation-types";
import type {GenerationSettings} from "../shared/generation-settings";
import {conversationRepository, peerSyncStateRepository, replicationRepository} from "./repository/repositories";
import {HttpRepositoryPeer} from "./sync/http-repository-peer";
import {SyncEngine} from "./sync/sync-engine";
import {flushLegacyConversationChanges, saveLegacyConversation} from "./sync/legacy-conversation-sync";

declare const __TURNFOLD_BASE_PATH__: string;

const chatBasePath = __TURNFOLD_BASE_PATH__;
const chatApi = (pathname: string) => `${chatBasePath}${pathname}`;
const httpRepositoryPeer = new HttpRepositoryPeer(`server:${window.location.origin}${chatBasePath}`, chatApi);
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

// Compatibility for queued operations produced by an older client.
export async function saveConversationHistory(id: string, providerId: string, model: string, messages: StoredChatMessage[]) {
  return saveLegacyConversation(chatApi, id, providerId, model, messages);
}

export async function deleteConversationHistory(id: string) {
  await conversationRepository.remove(id);
}

export async function flushPendingConversationChanges() {
  await flushLegacyConversationChanges(chatApi);
}

export async function synchronizeConversationRepository() {
  await flushPendingConversationChanges();
  const result = await syncEngine.syncWith(httpRepositoryPeer);
  return {summaries: await conversationRepository.list(), ...result};
}

export const synchronizeOfflineConversationHistory = synchronizeConversationRepository;
