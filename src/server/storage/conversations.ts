import type {ChatIdentity} from "../identity";
import type {
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
  return {type: "imported"};
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
