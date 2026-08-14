import {createHash, randomUUID} from "node:crypto";
import {mkdirSync} from "node:fs";
import path from "node:path";
import {Database} from "bun:sqlite";
import {normalizeGenerationSettings, type GenerationSettings} from "../../shared/generation-settings";
import type {ChatIdentity} from "../identity";
import type {
  Conversation,
  ConversationRefState,
  ConversationSummary,
  MessageCompletion,
  MessageOrigin,
  ResponseMetadata,
  RepositoryFetch,
  RepositoryRefUpdate,
  StoredChatMessage
} from "../../shared/conversation-types";
import {canonicalMessage} from "../../shared/message-object";

const databasePath = process.env.CHAT_DATABASE_PATH || "/data/turnfold.db";
let database: Database | undefined;

type ConversationRow = {
  id: string;
  name: string;
  head_message_id: string | null;
  provider_id: string;
  model: string;
  settings_json: string;
  head_version: number;
  metadata_version: number;
  message_count: number;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  parent_message_id: string | null;
  role: StoredChatMessage["role"];
  parts_json: string;
  origin_json: string;
  completion_json: string;
  metadata_json: string;
  depth: number;
  created_at: string;
  completed_at: string;
};

function now() {
  return new Date().toISOString();
}

function columns(opened: Database, table: string) {
  return opened.query(`PRAGMA table_info(${table})`).all() as Array<{name: string}>;
}

function migrateLegacyMessages(opened: Database) {
  const conversations = opened.query(`
    SELECT id, owner_issuer, owner_sub FROM chat_conversation
    WHERE head_message_id IS NULL
      AND EXISTS (SELECT 1 FROM chat_message WHERE conversation_id = chat_conversation.id)
  `).all() as Array<{id: string; owner_issuer: string; owner_sub: string}>;
  if (!conversations.length) return;
  opened.run("BEGIN IMMEDIATE");
  try {
    const existingNode = opened.query("SELECT id FROM chat_message_node WHERE id = ?");
    const insertNode = opened.query(`
      INSERT INTO chat_message_node (
        id, owner_issuer, owner_sub, parent_message_id, role, parts_json, origin_json,
        completion_json, metadata_json, depth, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateHead = opened.query("UPDATE chat_conversation SET head_message_id = ? WHERE id = ?");
    for (const conversation of conversations) {
      const messages = opened.query(`
        SELECT id, role, parts_json, created_at FROM chat_message
        WHERE conversation_id = ? ORDER BY ordinal
      `).all(conversation.id) as Array<{id: string; role: StoredChatMessage["role"]; parts_json: string; created_at: string}>;
      let parentId: string | null = null;
      messages.forEach((legacy, depth) => {
        let id = legacy.id;
        if (existingNode.get(id)) id = randomUUID();
        const parsed = JSON.parse(legacy.parts_json) as StoredChatMessage["parts"];
        const metadataPart = parsed.find((part) => part.type === "data-response-metadata" && part.data && typeof part.data === "object");
        const parts = parsed.filter((part) => part.type !== "data-response-metadata");
        const metadata = metadataPart ? {custom: {response: metadataPart.data as ResponseMetadata}} : {};
        insertNode.run(
          id,
          conversation.owner_issuer,
          conversation.owner_sub,
          parentId,
          legacy.role,
          JSON.stringify(parts),
          JSON.stringify({type: "legacy"}),
          JSON.stringify({status: "complete"}),
          JSON.stringify(metadata),
          depth,
          legacy.created_at,
          legacy.created_at
        );
        parentId = id;
      });
      updateHead.run(parentId, conversation.id);
    }
    opened.run("COMMIT");
  } catch (error) {
    opened.run("ROLLBACK");
    throw error;
  }
}

function migrateConversationHeadsToContentObjects(opened: Database) {
  const conversations = opened.query(`
    SELECT id, owner_issuer, owner_sub, head_message_id
    FROM chat_conversation
    WHERE head_message_id IS NOT NULL AND head_message_id NOT LIKE 'sha256:%'
  `).all() as Array<{id: string; owner_issuer: string; owner_sub: string; head_message_id: string}>;
  if (!conversations.length) return;
  opened.run("BEGIN IMMEDIATE");
  try {
    const read = opened.query(`
      SELECT id, parent_message_id, role, parts_json, origin_json, completion_json, metadata_json,
        depth, created_at, completed_at
      FROM chat_message_node WHERE id = ? AND owner_issuer = ? AND owner_sub = ?
    `);
    const insert = opened.query(`
      INSERT OR IGNORE INTO chat_message_node (
        id, owner_issuer, owner_sub, parent_message_id, role, parts_json, origin_json,
        completion_json, metadata_json, depth, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const update = opened.query("UPDATE chat_conversation SET head_message_id = ?, head_version = head_version + 1 WHERE id = ?");
    for (const conversation of conversations) {
      const path: MessageRow[] = [];
      let cursor: string | null = conversation.head_message_id;
      while (cursor) {
        const row = read.get(cursor, conversation.owner_issuer, conversation.owner_sub) as MessageRow | undefined;
        if (!row) throw new Error(`Legacy object ${cursor} is unavailable`);
        path.push(row);
        cursor = row.parent_message_id;
      }
      path.reverse();
      const namespace = createHash("sha256").update(`${conversation.owner_issuer}\0${conversation.owner_sub}`).digest("hex").slice(0, 32);
      let parentMessageId: string | null = null;
      for (const row of path) {
        const parsed = parsedMessage(row);
        const {id: _legacyId, ...legacyContent} = parsed;
        const content: Omit<StoredChatMessage, "id"> = {...legacyContent, parentMessageId};
        const id: string = `sha256:${createHash("sha256").update(`${namespace}\0${canonicalMessage(content)}`).digest("hex")}`;
        insert.run(
          id,
          conversation.owner_issuer,
          conversation.owner_sub,
          parentMessageId,
          parsed.role,
          JSON.stringify(parsed.parts),
          JSON.stringify(parsed.origin),
          JSON.stringify(parsed.completion),
          JSON.stringify(parsed.metadata || {}),
          row.depth,
          parsed.createdAt,
          parsed.completedAt
        );
        parentMessageId = id;
      }
      update.run(parentMessageId, conversation.id);
    }
    opened.run("COMMIT");
  } catch (error) {
    opened.run("ROLLBACK");
    throw error;
  }
}

function getDatabase() {
  if (database) return database;
  mkdirSync(path.dirname(databasePath), {recursive: true});
  const opened = new Database(databasePath, {create: true, strict: true});
  opened.run(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS chat_conversation (
      id TEXT PRIMARY KEY,
      owner_issuer TEXT NOT NULL,
      owner_sub TEXT NOT NULL,
      title TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_conversation_owner_updated
      ON chat_conversation (owner_issuer, owner_sub, updated_at DESC);
    CREATE TABLE IF NOT EXISTS chat_message (
      conversation_id TEXT NOT NULL REFERENCES chat_conversation(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
      parts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, id),
      UNIQUE (conversation_id, ordinal)
    );
  `);
  const conversationColumns = columns(opened, "chat_conversation");
  if (!conversationColumns.some((column) => column.name === "settings_json")) {
    opened.run("ALTER TABLE chat_conversation ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!conversationColumns.some((column) => column.name === "name")) {
    opened.run("ALTER TABLE chat_conversation ADD COLUMN name TEXT");
    opened.run("UPDATE chat_conversation SET name = title WHERE name IS NULL");
  }
  if (!conversationColumns.some((column) => column.name === "head_message_id")) {
    opened.run("ALTER TABLE chat_conversation ADD COLUMN head_message_id TEXT");
  }
  if (!conversationColumns.some((column) => column.name === "head_version")) {
    opened.run("ALTER TABLE chat_conversation ADD COLUMN head_version INTEGER NOT NULL DEFAULT 0");
  }
  if (!conversationColumns.some((column) => column.name === "metadata_version")) {
    opened.run("ALTER TABLE chat_conversation ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 0");
  }
  opened.run(`
    CREATE TABLE IF NOT EXISTS chat_message_node (
      id TEXT PRIMARY KEY,
      owner_issuer TEXT NOT NULL,
      owner_sub TEXT NOT NULL,
      parent_message_id TEXT REFERENCES chat_message_node(id),
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
      parts_json TEXT NOT NULL,
      origin_json TEXT NOT NULL,
      completion_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      depth INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_message_node_owner_parent
      ON chat_message_node (owner_issuer, owner_sub, parent_message_id);
    CREATE INDEX IF NOT EXISTS chat_conversation_owner_name
      ON chat_conversation (owner_issuer, owner_sub, name);
  `);
  migrateLegacyMessages(opened);
  migrateConversationHeadsToContentObjects(opened);
  database = opened;
  return opened;
}

function requiredString(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim().slice(0, maximum);
}

function conversationSettingString(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value.trim().slice(0, maximum);
}

function conversationName(value: unknown) {
  if (typeof value !== "string") throw new Error("name must be a string");
  return value.trim().slice(0, 300);
}

function nullableId(value: unknown, field: string) {
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

const conversationSelect = `
  SELECT c.id, COALESCE(c.name, c.title) AS name, c.head_message_id, c.provider_id, c.model,
    c.head_version, c.metadata_version,
    c.settings_json, c.created_at, c.updated_at, COALESCE(h.depth + 1, 0) AS message_count
  FROM chat_conversation c
  LEFT JOIN chat_message_node h ON h.id = c.head_message_id
`;

function ownedConversation(identity: ChatIdentity, id: string) {
  return getDatabase().query(`${conversationSelect}
    WHERE c.id = ? AND c.owner_issuer = ? AND c.owner_sub = ?
  `).get(id, identity.issuer, identity.sub) as ConversationRow | undefined;
}

function ownedMessage(identity: ChatIdentity, id: string) {
  return getDatabase().query(`
    SELECT id, parent_message_id, role, parts_json, origin_json, completion_json, metadata_json,
      depth, created_at, completed_at
    FROM chat_message_node WHERE id = ? AND owner_issuer = ? AND owner_sub = ?
  `).get(id, identity.issuer, identity.sub) as MessageRow | undefined;
}

function parsedMessage(row: MessageRow): StoredChatMessage {
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

function normalizedParts(value: unknown) {
  if (!Array.isArray(value)) throw new Error("parts is required");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error("message is too large");
  return JSON.parse(encoded) as StoredChatMessage["parts"];
}

function normalizedOrigin(value: unknown, role: StoredChatMessage["role"]): MessageOrigin {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as {type?: unknown}).type === "string") {
    return JSON.parse(JSON.stringify(value)) as MessageOrigin;
  }
  if (role === "user") return {type: "user"};
  if (role === "system") return {type: "system", source: "chat"};
  return {type: "legacy"};
}

function normalizedCompletion(value: unknown): MessageCompletion {
  if (value && typeof value === "object" && !Array.isArray(value) && (value as {status?: unknown}).status === "partial") {
    return JSON.parse(JSON.stringify(value)) as MessageCompletion;
  }
  return {status: "complete"};
}

function normalizedMetadata(value: unknown) {
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
