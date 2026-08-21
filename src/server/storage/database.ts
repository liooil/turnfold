import {mkdirSync} from "node:fs";
import path from "node:path";
import {Database} from "bun:sqlite";
import type {StoredChatMessage} from "../../shared/conversation-types";

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
  source_repository_id: string;
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
      name TEXT NOT NULL,
      head_message_id TEXT,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      head_version INTEGER NOT NULL DEFAULT 0,
      metadata_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_conversation_owner_updated
      ON chat_conversation (owner_issuer, owner_sub, updated_at DESC);
    CREATE INDEX IF NOT EXISTS chat_conversation_owner_name
      ON chat_conversation (owner_issuer, owner_sub, name);
    CREATE TABLE IF NOT EXISTS chat_message_node (
      id TEXT PRIMARY KEY,
      owner_issuer TEXT NOT NULL,
      owner_sub TEXT NOT NULL,
      source_repository_id TEXT NOT NULL DEFAULT '',
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
  `);
  const messageColumns = opened.query("PRAGMA table_info(chat_message_node)").all() as Array<{name: string}>;
  if (!messageColumns.some((column) => column.name === "source_repository_id")) {
    opened.run("ALTER TABLE chat_message_node ADD COLUMN source_repository_id TEXT NOT NULL DEFAULT ''");
  }
  database = opened;
  return opened;
}
