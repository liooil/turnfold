import {normalizeGenerationSettings} from "../../shared/generation-settings";
import type {ConversationRefState, RepositoryFetch, RepositoryRefUpdate, StoredChatMessage} from "../../shared/conversation-types";
import type {ChatIdentity} from "../identity";
import {
  type ConversationRow,
  type MessageRow,
  conversationName,
  conversationSelect,
  conversationSettingString,
  getDatabase,
  normalizedCompletion,
  normalizedMetadata,
  normalizedOrigin,
  normalizedParts,
  now,
  nullableId,
  ownedConversation,
  ownedMessage,
  parsedMessage,
  requiredString
} from "./conversations";

function conversationRef(row: ConversationRow): ConversationRefState {
  return {
    id: row.id,
    name: row.name,
    headMessageId: row.head_message_id,
    providerId: row.provider_id,
    model: row.model,
    generationSettings: normalizeGenerationSettings(JSON.parse(row.settings_json || "{}")),
    headVersion: Number(row.head_version || 0),
    metadataVersion: Number(row.metadata_version || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function fetchRepository(identity: ChatIdentity, haveObjectIds: unknown): RepositoryFetch {
  const have = new Set(Array.isArray(haveObjectIds)
    ? haveObjectIds.filter((value): value is string => typeof value === "string").slice(0, 100_000)
    : []);
  const refs = (getDatabase().query(`${conversationSelect}
    WHERE c.owner_issuer = ? AND c.owner_sub = ? ORDER BY c.updated_at DESC
  `).all(identity.issuer, identity.sub) as ConversationRow[]).map(conversationRef);
  const objects = (getDatabase().query(`
    SELECT id, parent_message_id, role, parts_json, origin_json, completion_json, metadata_json,
      depth, created_at, completed_at
    FROM chat_message_node
    WHERE owner_issuer = ? AND owner_sub = ?
    ORDER BY depth, created_at, id
  `).all(identity.issuer, identity.sub) as MessageRow[])
    .filter((row) => !have.has(row.id))
    .map(parsedMessage);
  return {refs, objects, fetchedAt: now()};
}

export function putRepositoryObjects(identity: ChatIdentity, objects: unknown) {
  if (!Array.isArray(objects) || objects.length > 1000) throw new Error("objects must contain at most 1000 entries");
  let inserted = 0;
  getDatabase().run("BEGIN IMMEDIATE");
  try {
    const insert = getDatabase().query(`
      INSERT INTO chat_message_node (
        id, owner_issuer, owner_sub, parent_message_id, role, parts_json, origin_json,
        completion_json, metadata_json, depth, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const value of objects) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("repository object is invalid");
      const object = value as StoredChatMessage;
      if (typeof object.id !== "string" || !object.id.startsWith("sha256:")) throw new Error("repository object id is invalid");
      if (ownedMessage(identity, object.id)) continue;
      const role = object.role;
      if (!["system", "user", "assistant"].includes(role)) throw new Error("repository object role is invalid");
      const parentMessageId = nullableId(object.parentMessageId, "parentMessageId");
      const parent = parentMessageId ? ownedMessage(identity, parentMessageId) : undefined;
      if (parentMessageId && !parent) throw new Error(`parent object ${parentMessageId} is unavailable`);
      insert.run(
        object.id,
        identity.issuer,
        identity.sub,
        parentMessageId,
        role,
        JSON.stringify(normalizedParts(object.parts)),
        JSON.stringify(normalizedOrigin(object.origin, role)),
        JSON.stringify(normalizedCompletion(object.completion)),
        normalizedMetadata(object.metadata),
        parent ? parent.depth + 1 : 0,
        requiredString(object.createdAt, "createdAt", 80),
        requiredString(object.completedAt, "completedAt", 80)
      );
      inserted += 1;
    }
    getDatabase().run("COMMIT");
  } catch (error) {
    try { getDatabase().run("ROLLBACK"); } catch {}
    throw error;
  }
  return inserted;
}

export function pushRepositoryRef(identity: ChatIdentity, update: RepositoryRefUpdate) {
  const id = requiredString(update.conversationId, "conversationId", 160);
  const expectedHeadMessageId = nullableId(update.expectedHeadMessageId, "expectedHeadMessageId");
  const headMessageId = nullableId(update.headMessageId, "headMessageId");
  const existing = ownedConversation(identity, id);
  if (!existing) {
    if (expectedHeadMessageId !== null || Number(update.expectedHeadVersion || 0) !== 0 || Number(update.expectedMetadataVersion || 0) !== 0) {
      return {status: "conflict" as const, ref: null};
    }
    if (headMessageId && !ownedMessage(identity, headMessageId)) throw new Error("head object is unavailable");
    const name = conversationName(update.name);
    const providerId = conversationSettingString(update.providerId, "providerId", 80);
    const model = conversationSettingString(update.model, "model", 300);
    const timestamp = now();
    getDatabase().query(`
      INSERT INTO chat_conversation (
        id, owner_issuer, owner_sub, title, name, head_message_id, provider_id, model,
        settings_json, head_version, metadata_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
    `).run(id, identity.issuer, identity.sub, name, name, headMessageId, providerId, model, JSON.stringify(normalizeGenerationSettings(update.generationSettings)), update.createdAt || timestamp, timestamp);
    return {status: "ok" as const, ref: conversationRef(ownedConversation(identity, id)!)};
  }
  if (existing.head_message_id !== expectedHeadMessageId
    || Number(existing.head_version || 0) !== Number(update.expectedHeadVersion || 0)
    || Number(existing.metadata_version || 0) !== Number(update.expectedMetadataVersion || 0)) {
    return {status: "conflict" as const, ref: conversationRef(existing)};
  }
  if (headMessageId && !ownedMessage(identity, headMessageId)) throw new Error("head object is unavailable");
  const name = conversationName(update.name);
  const providerId = conversationSettingString(update.providerId, "providerId", 80);
  const model = conversationSettingString(update.model, "model", 300);
  const headChanged = existing.head_message_id !== headMessageId;
  const metadataChanged = existing.name !== name
    || existing.provider_id !== providerId
    || existing.model !== model
    || existing.settings_json !== JSON.stringify(normalizeGenerationSettings(update.generationSettings));
  getDatabase().query(`
    UPDATE chat_conversation SET title = ?, name = ?, head_message_id = ?, provider_id = ?, model = ?, settings_json = ?,
      head_version = head_version + ?, metadata_version = metadata_version + ?, updated_at = ?
    WHERE id = ? AND owner_issuer = ? AND owner_sub = ?
  `).run(
    name,
    name,
    headMessageId,
    providerId,
    model,
    JSON.stringify(normalizeGenerationSettings(update.generationSettings)),
    headChanged ? 1 : 0,
    metadataChanged ? 1 : 0,
    now(),
    id,
    identity.issuer,
    identity.sub
  );
  return {status: "ok" as const, ref: conversationRef(ownedConversation(identity, id)!)};
}
