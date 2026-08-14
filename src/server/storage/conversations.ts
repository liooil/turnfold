import {randomUUID} from "node:crypto";
import {normalizeGenerationSettings, type GenerationSettings} from "../../shared/generation-settings";
import type {ChatIdentity} from "../identity";
import type {
  Conversation,
  ConversationSummary,
  MessageCompletion,
  MessageOrigin,
  StoredChatMessage
} from "../../shared/conversation-types";
import {getDatabase, now, type ConversationRow, type MessageRow} from "./database";
export {getDatabase, now, type ConversationRow, type MessageRow} from "./database";

export function requiredString(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim().slice(0, maximum);
}

export function conversationSettingString(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value.trim().slice(0, maximum);
}

export function conversationName(value: unknown) {
  if (typeof value !== "string") throw new Error("name must be a string");
  return value.trim().slice(0, 300);
}

export function nullableId(value: unknown, field: string) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is invalid`);
  return value.trim().slice(0, 160);
}

function conversationSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    name: row.name,
    headMessageId: row.head_message_id,
    providerId: row.provider_id,
    model: row.model,
    messageCount: Number(row.message_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    upstreamHeadMessageId: row.head_message_id,
    headVersion: Number(row.head_version || 0),
    metadataVersion: Number(row.metadata_version || 0)
  };
}

export const conversationSelect = `
  SELECT c.id, COALESCE(c.name, c.title) AS name, c.head_message_id, c.provider_id, c.model,
    c.head_version, c.metadata_version,
    c.settings_json, c.created_at, c.updated_at, COALESCE(h.depth + 1, 0) AS message_count
  FROM chat_conversation c
  LEFT JOIN chat_message_node h ON h.id = c.head_message_id
`;

export function ownedConversation(identity: ChatIdentity, id: string) {
  return getDatabase().query(`${conversationSelect}
    WHERE c.id = ? AND c.owner_issuer = ? AND c.owner_sub = ?
  `).get(id, identity.issuer, identity.sub) as ConversationRow | undefined;
}

export function ownedMessage(identity: ChatIdentity, id: string) {
  return getDatabase().query(`
    SELECT id, parent_message_id, role, parts_json, origin_json, completion_json, metadata_json,
      depth, created_at, completed_at
    FROM chat_message_node WHERE id = ? AND owner_issuer = ? AND owner_sub = ?
  `).get(id, identity.issuer, identity.sub) as MessageRow | undefined;
}

export function parsedMessage(row: MessageRow): StoredChatMessage {
  const metadata = JSON.parse(row.metadata_json || "{}") as StoredChatMessage["metadata"];
  return {
    id: row.id,
    parentMessageId: row.parent_message_id,
    role: row.role,
    parts: JSON.parse(row.parts_json),
    origin: JSON.parse(row.origin_json),
    completion: JSON.parse(row.completion_json),
    createdAt: row.created_at,
    completedAt: row.completed_at,
    ...(metadata && Object.keys(metadata).length ? {metadata} : {})
  };
}

function messagePath(identity: ChatIdentity, headId: string | null) {
  const reversed: StoredChatMessage[] = [];
  const seen = new Set<string>();
  let id = headId;
  while (id) {
    if (seen.has(id)) throw new Error("Message history is cyclic");
    seen.add(id);
    const row = ownedMessage(identity, id);
    if (!row) throw new Error("Conversation points to an unavailable message");
    reversed.push(parsedMessage(row));
    id = row.parent_message_id;
  }
  return reversed.reverse();
}

export function normalizedParts(value: unknown) {
  if (!Array.isArray(value)) throw new Error("parts is required");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error("message is too large");
  return JSON.parse(encoded) as StoredChatMessage["parts"];
}

export function normalizedOrigin(value: unknown, role: StoredChatMessage["role"]): MessageOrigin {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as {type?: unknown}).type === "string") {
    return JSON.parse(JSON.stringify(value)) as MessageOrigin;
  }
  if (role === "user") return {type: "user"};
  if (role === "system") return {type: "system", source: "chat"};
  return {type: "legacy"};
}

export function normalizedCompletion(value: unknown): MessageCompletion {
  if (value && typeof value === "object" && !Array.isArray(value) && (value as {status?: unknown}).status === "partial") {
    return JSON.parse(JSON.stringify(value)) as MessageCompletion;
  }
  return {status: "complete"};
}

export function normalizedMetadata(value: unknown) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const encoded = JSON.stringify(metadata);
  if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error("message metadata is too large");
  return encoded;
}

export function listConversations(identity: ChatIdentity): ConversationSummary[] {
  return (getDatabase().query(`${conversationSelect}
    WHERE c.owner_issuer = ? AND c.owner_sub = ?
    ORDER BY c.updated_at DESC LIMIT 100
  `).all(identity.issuer, identity.sub) as ConversationRow[]).map(conversationSummary);
}

export function createConversation(identity: ChatIdentity, input: {
  providerId: unknown;
  model: unknown;
  generationSettings?: unknown;
  name?: unknown;
  headMessageId?: unknown;
}): Conversation {
  const providerId = conversationSettingString(input.providerId, "providerId", 80);
  const model = conversationSettingString(input.model, "model", 300);
  const name = input.name === undefined ? "" : conversationName(input.name);
  const headMessageId = nullableId(input.headMessageId, "headMessageId");
  if (headMessageId && !ownedMessage(identity, headMessageId)) throw new Error("headMessageId is unavailable");
  const generationSettings = normalizeGenerationSettings(input.generationSettings);
  const timestamp = now();
  const id = randomUUID();
  getDatabase().query(`
    INSERT INTO chat_conversation (
      id, owner_issuer, owner_sub, title, name, head_message_id, provider_id, model,
      settings_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, identity.issuer, identity.sub, name, name, headMessageId, providerId, model, JSON.stringify(generationSettings), timestamp, timestamp);
  return getConversation(identity, id)!;
}

export function getConversation(identity: ChatIdentity, id: string): Conversation | null {
  const row = ownedConversation(identity, id);
  if (!row) return null;
  return {
    ...conversationSummary(row),
    generationSettings: normalizeGenerationSettings(JSON.parse(row.settings_json || "{}")),
    messages: messagePath(identity, row.head_message_id)
  };
}

export function updateConversation(identity: ChatIdentity, id: string, input: {
  providerId?: unknown;
  model?: unknown;
  generationSettings?: unknown;
  name?: unknown;
}) {
  const existing = ownedConversation(identity, id);
  if (!existing) return null;
  const providerId = input.providerId === undefined ? existing.provider_id : conversationSettingString(input.providerId, "providerId", 80);
  const model = input.model === undefined ? existing.model : conversationSettingString(input.model, "model", 300);
  const name = input.name === undefined ? existing.name : conversationName(input.name);
  const generationSettings = input.generationSettings === undefined
    ? normalizeGenerationSettings(JSON.parse(existing.settings_json || "{}"))
    : normalizeGenerationSettings(input.generationSettings);
  getDatabase().query(`
    UPDATE chat_conversation SET title = ?, name = ?, provider_id = ?, model = ?, settings_json = ?, metadata_version = metadata_version + 1, updated_at = ?
    WHERE id = ? AND owner_issuer = ? AND owner_sub = ?
  `).run(name, name, providerId, model, JSON.stringify(generationSettings), now(), id, identity.issuer, identity.sub);
  return getConversation(identity, id);
}

export function appendConversationMessage(identity: ChatIdentity, conversationId: string, input: {
  id?: unknown;
  expectedHeadId?: unknown;
  parentMessageId?: unknown;
  role?: unknown;
  parts?: unknown;
  origin?: unknown;
  completion?: unknown;
  metadata?: unknown;
  providerId?: unknown;
  model?: unknown;
}) {
  const role = String(input.role || "") as StoredChatMessage["role"];
  if (!["system", "user", "assistant"].includes(role)) throw new Error("role is invalid");
  const id = input.id === undefined ? randomUUID() : requiredString(input.id, "id", 160);
  const expectedHeadId = nullableId(input.expectedHeadId, "expectedHeadId");
  const parentMessageId = nullableId(input.parentMessageId, "parentMessageId");
  const parts = normalizedParts(input.parts);
  const origin = normalizedOrigin(input.origin, role);
  const completion = normalizedCompletion(input.completion);
  const metadataJson = normalizedMetadata(input.metadata);
  const timestamp = now();

  getDatabase().run("BEGIN IMMEDIATE");
  try {
    const existing = ownedConversation(identity, conversationId);
    if (!existing) {
      getDatabase().run("ROLLBACK");
      return {status: "missing" as const};
    }
    if (existing.head_message_id !== expectedHeadId) {
      getDatabase().run("ROLLBACK");
      return {status: "conflict" as const, conversation: getConversation(identity, conversationId)!};
    }
    const parent = parentMessageId ? ownedMessage(identity, parentMessageId) : undefined;
    if (parentMessageId && !parent) throw new Error("parentMessageId is unavailable");
    const depth = parent ? parent.depth + 1 : 0;
    const already = ownedMessage(identity, id);
    if (already) {
      const same = already.parent_message_id === parentMessageId
        && already.role === role
        && already.parts_json === JSON.stringify(parts)
        && already.origin_json === JSON.stringify(origin)
        && already.completion_json === JSON.stringify(completion)
        && already.metadata_json === metadataJson;
      if (!same) throw new Error("message id already exists with different content");
    } else {
      getDatabase().query(`
        INSERT INTO chat_message_node (
          id, owner_issuer, owner_sub, parent_message_id, role, parts_json, origin_json,
          completion_json, metadata_json, depth, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        identity.issuer,
        identity.sub,
        parentMessageId,
        role,
        JSON.stringify(parts),
        JSON.stringify(origin),
        JSON.stringify(completion),
        metadataJson,
        depth,
        timestamp,
        timestamp
      );
    }
    const providerId = input.providerId === undefined ? existing.provider_id : conversationSettingString(input.providerId, "providerId", 80);
    const model = input.model === undefined ? existing.model : conversationSettingString(input.model, "model", 300);
    const name = existing.name;
    getDatabase().query(`
      UPDATE chat_conversation SET title = ?, name = ?, head_message_id = ?, provider_id = ?, model = ?, head_version = head_version + 1, updated_at = ?
      WHERE id = ? AND owner_issuer = ? AND owner_sub = ?
    `).run(name, name, id, providerId, model, timestamp, conversationId, identity.issuer, identity.sub);
    getDatabase().run("COMMIT");
    return {status: "ok" as const, conversation: getConversation(identity, conversationId)!};
  } catch (error) {
    try { getDatabase().run("ROLLBACK"); } catch {}
    throw error;
  }
}

function normalizeLegacyMessages(value: unknown): StoredChatMessage[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error("messages must contain at most 500 entries");
  const timestamp = now();
  let parentMessageId: string | null = null;
  return value.map((message, index) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error(`messages[${index}] is invalid`);
    const record = message as Record<string, unknown>;
    const role = String(record.role) as StoredChatMessage["role"];
    if (!["system", "user", "assistant"].includes(role)) throw new Error(`messages[${index}].role is invalid`);
    const normalized: StoredChatMessage = {
      id: typeof record.id === "string" && record.id.trim() ? record.id.trim().slice(0, 160) : randomUUID(),
      parentMessageId,
      role,
      parts: normalizedParts(record.parts),
      origin: normalizedOrigin(record.origin, role),
      completion: normalizedCompletion(record.completion),
      createdAt: typeof record.createdAt === "string" ? record.createdAt : timestamp,
      completedAt: typeof record.completedAt === "string" ? record.completedAt : timestamp,
      ...(record.metadata ? {metadata: JSON.parse(normalizedMetadata(record.metadata))} : {})
    };
    parentMessageId = normalized.id;
    return normalized;
  });
}

// Compatibility for pending writes created by the previous client. New code commits one immutable message at a time.
export function saveConversationMessages(identity: ChatIdentity, id: string, input: {providerId: unknown; model: unknown; messages: unknown}) {
  const existing = ownedConversation(identity, id);
  if (!existing) return null;
  const messages = normalizeLegacyMessages(input.messages);
  let expectedHeadId = existing.head_message_id;
  for (const message of messages) {
    const already = ownedMessage(identity, message.id);
    if (already) {
      expectedHeadId = message.id;
      continue;
    }
    const result = appendConversationMessage(identity, id, {
      ...message,
      expectedHeadId,
      providerId: input.providerId,
      model: input.model
    });
    if (result.status !== "ok") throw new Error("Unable to import legacy conversation path");
    expectedHeadId = message.id;
  }
  if (!messages.length && existing.head_message_id) {
    getDatabase().query(`
      UPDATE chat_conversation SET head_message_id = NULL, provider_id = ?, model = ?, updated_at = ?
      WHERE id = ? AND owner_issuer = ? AND owner_sub = ?
    `).run(conversationSettingString(input.providerId, "providerId", 80), conversationSettingString(input.model, "model", 300), now(), id, identity.issuer, identity.sub);
  }
  return getConversation(identity, id);
}

export function deleteConversation(identity: ChatIdentity, id: string) {
  const result = getDatabase().query(`
    DELETE FROM chat_conversation WHERE id = ? AND owner_issuer = ? AND owner_sub = ?
  `).run(id, identity.issuer, identity.sub);
  return result.changes > 0;
}
