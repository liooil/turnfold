import {createHash, randomUUID} from "node:crypto";
import {mkdirSync} from "node:fs";
import path from "node:path";
import {Database} from "bun:sqlite";
import type {ResponseMetadata, StoredChatMessage} from "../../shared/conversation-types";
import {canonicalMessage} from "../../shared/message-object";

export type ConversationRow = {
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

export type MessageRow = {
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

const databasePath = process.env.CHAT_DATABASE_PATH || "/data/turnfold.db";
let database: Database | undefined;

export function now() {
  return new Date().toISOString();
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
      const messagePath: MessageRow[] = [];
      let cursor: string | null = conversation.head_message_id;
      while (cursor) {
        const row = read.get(cursor, conversation.owner_issuer, conversation.owner_sub) as MessageRow | undefined;
        if (!row) throw new Error(`Legacy object ${cursor} is unavailable`);
        messagePath.push(row);
        cursor = row.parent_message_id;
      }
      messagePath.reverse();
      const namespace = createHash("sha256").update(`${conversation.owner_issuer}\0${conversation.owner_sub}`).digest("hex").slice(0, 32);
      let parentMessageId: string | null = null;
      for (const row of messagePath) {
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

export function getDatabase() {
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
  if (!conversationColumns.some((column) => column.name === "settings_json")) opened.run("ALTER TABLE chat_conversation ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'");
  if (!conversationColumns.some((column) => column.name === "name")) {
    opened.run("ALTER TABLE chat_conversation ADD COLUMN name TEXT");
    opened.run("UPDATE chat_conversation SET name = title WHERE name IS NULL");
  }
  if (!conversationColumns.some((column) => column.name === "head_message_id")) opened.run("ALTER TABLE chat_conversation ADD COLUMN head_message_id TEXT");
  if (!conversationColumns.some((column) => column.name === "head_version")) opened.run("ALTER TABLE chat_conversation ADD COLUMN head_version INTEGER NOT NULL DEFAULT 0");
  if (!conversationColumns.some((column) => column.name === "metadata_version")) opened.run("ALTER TABLE chat_conversation ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 0");
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
