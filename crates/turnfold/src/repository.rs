use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use anyhow::{Context, Result, anyhow, bail};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, macros::format_description};

use crate::identity::ChatIdentity;

const MAX_OBJECTS: usize = 1_000;
const MAX_REFS: usize = 100;
const MAX_HAVE_OBJECT_IDS: usize = 100_000;

#[derive(Clone)]
pub struct RepositoryStore {
    connection: Arc<Mutex<Connection>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationSettings {
    reasoning: String,
    show_reasoning_summary: bool,
    temperature: Option<f64>,
    max_output_tokens: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRefState {
    id: String,
    name: String,
    head_message_id: Option<String>,
    provider_id: String,
    model: String,
    generation_settings: GenerationSettings,
    head_version: i64,
    metadata_version: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryFetch {
    refs: Vec<ConversationRefState>,
    objects: Vec<Value>,
    object_repository_ids: BTreeMap<String, String>,
    fetched_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryPushResult {
    inserted_objects: usize,
    refs: Vec<RepositoryPushRefResult>,
    pushed_at: String,
}

#[derive(Clone, Debug)]
pub enum DavPrecondition {
    Create,
    Match(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DavWriteResult {
    Created { etag: String },
    Updated { etag: String },
    PreconditionFailed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DavDeleteResult {
    Deleted,
    NotFound,
    PreconditionFailed,
}

#[derive(Clone, Debug)]
pub struct DavObject {
    pub repository_id: String,
    pub object: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryPushRefResult {
    conversation_id: String,
    status: &'static str,
    r#ref: Option<ConversationRefState>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryPushInput {
    repository_id: String,
    #[serde(default)]
    object_repository_ids: BTreeMap<String, String>,
    #[serde(default)]
    objects: Vec<Value>,
    #[serde(default)]
    refs: Vec<RepositoryRefUpdate>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryRefUpdate {
    conversation_id: String,
    #[serde(default)]
    expected_head_message_id: Option<String>,
    #[serde(default)]
    expected_head_version: i64,
    #[serde(default)]
    expected_metadata_version: i64,
    #[serde(default)]
    head_message_id: Option<String>,
    name: String,
    provider_id: String,
    model: String,
    #[serde(default)]
    generation_settings: Value,
    #[serde(default)]
    created_at: String,
}

#[derive(Debug)]
struct ValidatedMessage {
    id: String,
    repository_id: String,
    parent_message_id: Option<String>,
    role: String,
    parts_json: String,
    origin_json: String,
    completion_json: String,
    metadata_json: String,
    created_at: String,
    completed_at: String,
}

#[derive(Debug)]
struct ConversationRow {
    id: String,
    name: String,
    head_message_id: Option<String>,
    provider_id: String,
    model: String,
    settings_json: String,
    head_version: i64,
    metadata_version: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug)]
struct MessageRow {
    id: String,
    repository_id: String,
    parent_message_id: Option<String>,
    role: String,
    parts_json: String,
    origin_json: String,
    completion_json: String,
    metadata_json: String,
    created_at: String,
    completed_at: String,
}

impl Default for GenerationSettings {
    fn default() -> Self {
        Self {
            reasoning: "auto".to_owned(),
            show_reasoning_summary: false,
            temperature: None,
            max_output_tokens: None,
        }
    }
}

impl RepositoryStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent).with_context(|| {
                format!("unable to create database directory {}", parent.display())
            })?;
        }
        let connection = Connection::open(path)
            .with_context(|| format!("unable to open repository database {}", path.display()))?;
        connection
            .execute_batch(
                r#"
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
                CREATE TABLE IF NOT EXISTS chat_working_snapshot (
                  owner_issuer TEXT NOT NULL,
                  owner_sub TEXT NOT NULL,
                  device_id TEXT NOT NULL,
                  snapshot_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY (owner_issuer, owner_sub, device_id)
                );
                "#,
            )
            .context("unable to initialize repository database")?;
        ensure_column(
            &connection,
            "chat_message_node",
            "source_repository_id",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn fetch(&self, identity: &ChatIdentity, input: &Value) -> Result<RepositoryFetch> {
        let have = input
            .get("haveObjectIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .take(MAX_HAVE_OBJECT_IDS)
            .map(str::to_owned)
            .collect::<HashSet<_>>();
        let connection = self.lock()?;

        let mut ref_statement = connection.prepare(
            r#"
            SELECT c.id, COALESCE(c.name, c.title), c.head_message_id, c.provider_id, c.model,
              c.settings_json, c.head_version, c.metadata_version, c.created_at, c.updated_at
            FROM chat_conversation c
            WHERE c.owner_issuer = ? AND c.owner_sub = ?
            ORDER BY c.updated_at DESC
            "#,
        )?;
        let rows =
            ref_statement.query_map(params![identity.issuer, identity.sub], conversation_row)?;
        let mut refs = Vec::new();
        for row in rows {
            refs.push(conversation_ref(row?)?);
        }
        drop(ref_statement);

        let mut object_statement = connection.prepare(
            r#"
            SELECT id, source_repository_id, parent_message_id, role, parts_json, origin_json, completion_json,
              metadata_json, created_at, completed_at
            FROM chat_message_node
            WHERE owner_issuer = ? AND owner_sub = ?
            ORDER BY depth, created_at, id
            "#,
        )?;
        let rows =
            object_statement.query_map(params![identity.issuer, identity.sub], message_row)?;
        let mut objects = Vec::new();
        let mut object_repository_ids = BTreeMap::new();
        for row in rows {
            let row = row?;
            if !have.contains(&row.id) {
                if !row.repository_id.is_empty() {
                    object_repository_ids.insert(row.id.clone(), row.repository_id.clone());
                }
                objects.push(message_value(row)?);
            }
        }
        Ok(RepositoryFetch {
            refs,
            objects,
            object_repository_ids,
            fetched_at: now()?,
        })
    }

    pub fn push(&self, identity: &ChatIdentity, input: Value) -> Result<RepositoryPushResult> {
        let input: RepositoryPushInput =
            serde_json::from_value(input).context("repository push payload is invalid")?;
        validate_repository_id(&input.repository_id)?;
        if input.objects.len() > MAX_OBJECTS {
            bail!("objects must contain at most {MAX_OBJECTS} entries");
        }
        if input.refs.len() > MAX_REFS {
            bail!("refs must contain at most {MAX_REFS} entries");
        }
        let objects = input
            .objects
            .iter()
            .map(|object| {
                let repository_id = object
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|id| input.object_repository_ids.get(id))
                    .unwrap_or(&input.repository_id);
                validate_message(object, repository_id)
            })
            .collect::<Result<Vec<_>>>()?;

        let mut connection = self.lock()?;
        let inserted_objects = insert_objects(&mut connection, identity, &objects)?;
        let refs = input
            .refs
            .into_iter()
            .map(|update| push_ref(&connection, identity, update))
            .collect::<Result<Vec<_>>>()?;
        Ok(RepositoryPushResult {
            inserted_objects,
            refs,
            pushed_at: now()?,
        })
    }

    pub fn dav_object_ids(&self, identity: &ChatIdentity) -> Result<Vec<String>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            r#"
            SELECT id FROM chat_message_node
            WHERE owner_issuer = ? AND owner_sub = ? AND source_repository_id != ''
            ORDER BY depth, created_at, id
            "#,
        )?;
        let rows = statement.query_map(params![identity.issuer, identity.sub], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn dav_object(&self, identity: &ChatIdentity, id: &str) -> Result<Option<DavObject>> {
        let connection = self.lock()?;
        let row = connection
            .query_row(
                r#"
                SELECT id, source_repository_id, parent_message_id, role, parts_json, origin_json,
                  completion_json, metadata_json, created_at, completed_at
                FROM chat_message_node
                WHERE id = ? AND owner_issuer = ? AND owner_sub = ?
                  AND source_repository_id != ''
                "#,
                params![id, identity.issuer, identity.sub],
                message_row,
            )
            .optional()?;
        row.map(|row| {
            let repository_id = row.repository_id.clone();
            Ok(DavObject {
                repository_id,
                object: message_value(row)?,
            })
        })
        .transpose()
    }

    pub fn dav_put_object(
        &self,
        identity: &ChatIdentity,
        repository_id: &str,
        object: &Value,
    ) -> Result<bool> {
        let object = validate_message(object, repository_id)?;
        let mut connection = self.lock()?;
        let existed = owned_message_depth_connection(&connection, identity, &object.id)?.is_some();
        insert_objects(&mut connection, identity, &[object])?;
        Ok(!existed)
    }

    pub fn dav_refs(&self, identity: &ChatIdentity) -> Result<Vec<Value>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            r#"
            SELECT c.id, COALESCE(c.name, c.title), c.head_message_id, c.provider_id, c.model,
              c.settings_json, c.head_version, c.metadata_version, c.created_at, c.updated_at
            FROM chat_conversation c
            WHERE c.owner_issuer = ? AND c.owner_sub = ?
            ORDER BY c.updated_at DESC, c.id
            "#,
        )?;
        let rows = statement.query_map(params![identity.issuer, identity.sub], conversation_row)?;
        rows.map(|row| serde_json::to_value(conversation_ref(row?)?).map_err(Into::into))
            .collect()
    }

    pub fn dav_ref(&self, identity: &ChatIdentity, id: &str) -> Result<Option<Value>> {
        let connection = self.lock()?;
        owned_conversation(&connection, identity, id)?
            .map(|row| serde_json::to_value(conversation_ref(row)?).map_err(Into::into))
            .transpose()
    }

    pub fn dav_put_ref(
        &self,
        identity: &ChatIdentity,
        id: &str,
        value: &Value,
        precondition: &DavPrecondition,
    ) -> Result<DavWriteResult> {
        let state = validated_dav_ref(id, value)?;
        let connection = self.lock()?;
        let existing = owned_conversation(&connection, identity, id)?;
        if !dav_precondition_matches_ref(precondition, existing.as_ref())? {
            return Ok(DavWriteResult::PreconditionFailed);
        }
        ensure_owned_head(&connection, identity, state.head_message_id.as_deref())?;
        let created = existing.is_none();
        let settings_json = serde_json::to_string(&state.generation_settings)?;
        if created {
            connection.execute(
                r#"
                INSERT INTO chat_conversation (
                  id, owner_issuer, owner_sub, title, name, head_message_id, provider_id, model,
                  settings_json, head_version, metadata_version, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                "#,
                params![
                    state.id,
                    identity.issuer,
                    identity.sub,
                    state.name,
                    state.name,
                    state.head_message_id,
                    state.provider_id,
                    state.model,
                    settings_json,
                    state.head_version,
                    state.metadata_version,
                    state.created_at,
                    state.updated_at,
                ],
            )?;
        } else {
            connection.execute(
                r#"
                UPDATE chat_conversation SET title = ?, name = ?, head_message_id = ?,
                  provider_id = ?, model = ?, settings_json = ?, head_version = ?,
                  metadata_version = ?, created_at = ?, updated_at = ?
                WHERE id = ? AND owner_issuer = ? AND owner_sub = ?
                "#,
                params![
                    state.name,
                    state.name,
                    state.head_message_id,
                    state.provider_id,
                    state.model,
                    settings_json,
                    state.head_version,
                    state.metadata_version,
                    state.created_at,
                    state.updated_at,
                    state.id,
                    identity.issuer,
                    identity.sub,
                ],
            )?;
        }
        let stored = owned_conversation(&connection, identity, id)?
            .ok_or_else(|| anyhow!("stored WebDAV ref is unavailable"))?;
        let etag = dav_etag(&serde_json::to_value(conversation_ref(stored)?)?)?;
        Ok(if created {
            DavWriteResult::Created { etag }
        } else {
            DavWriteResult::Updated { etag }
        })
    }

    pub fn dav_delete_ref(
        &self,
        identity: &ChatIdentity,
        id: &str,
        precondition: &DavPrecondition,
    ) -> Result<DavDeleteResult> {
        let connection = self.lock()?;
        let existing = owned_conversation(&connection, identity, id)?;
        if existing.is_none() {
            return Ok(DavDeleteResult::NotFound);
        }
        if !dav_precondition_matches_ref(precondition, existing.as_ref())? {
            return Ok(DavDeleteResult::PreconditionFailed);
        }
        connection.execute(
            "DELETE FROM chat_conversation WHERE id = ? AND owner_issuer = ? AND owner_sub = ?",
            params![id, identity.issuer, identity.sub],
        )?;
        Ok(DavDeleteResult::Deleted)
    }

    pub fn dav_working_ids(&self, identity: &ChatIdentity) -> Result<Vec<String>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            r#"
            SELECT device_id FROM chat_working_snapshot
            WHERE owner_issuer = ? AND owner_sub = ? ORDER BY device_id
            "#,
        )?;
        let rows = statement.query_map(params![identity.issuer, identity.sub], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn dav_working(&self, identity: &ChatIdentity, device_id: &str) -> Result<Option<Value>> {
        let connection = self.lock()?;
        let value = connection
            .query_row(
                r#"
                SELECT snapshot_json FROM chat_working_snapshot
                WHERE owner_issuer = ? AND owner_sub = ? AND device_id = ?
                "#,
                params![identity.issuer, identity.sub, device_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }

    pub fn dav_put_working(
        &self,
        identity: &ChatIdentity,
        device_id: &str,
        value: &Value,
        precondition: &DavPrecondition,
    ) -> Result<DavWriteResult> {
        validate_working_snapshot(device_id, value)?;
        let encoded = serde_json::to_string(value)?;
        let connection = self.lock()?;
        let existing = connection
            .query_row(
                r#"
                SELECT snapshot_json FROM chat_working_snapshot
                WHERE owner_issuer = ? AND owner_sub = ? AND device_id = ?
                "#,
                params![identity.issuer, identity.sub, device_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if !dav_precondition_matches_value(precondition, existing.as_deref())? {
            return Ok(DavWriteResult::PreconditionFailed);
        }
        let created = existing.is_none();
        connection.execute(
            r#"
            INSERT INTO chat_working_snapshot (
              owner_issuer, owner_sub, device_id, snapshot_json, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(owner_issuer, owner_sub, device_id) DO UPDATE SET
              snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at
            "#,
            params![identity.issuer, identity.sub, device_id, encoded, now()?],
        )?;
        let etag = dav_etag(value)?;
        Ok(if created {
            DavWriteResult::Created { etag }
        } else {
            DavWriteResult::Updated { etag }
        })
    }

    pub fn dav_delete_working(
        &self,
        identity: &ChatIdentity,
        device_id: &str,
        precondition: &DavPrecondition,
    ) -> Result<DavDeleteResult> {
        let connection = self.lock()?;
        let existing = connection
            .query_row(
                r#"
                SELECT snapshot_json FROM chat_working_snapshot
                WHERE owner_issuer = ? AND owner_sub = ? AND device_id = ?
                "#,
                params![identity.issuer, identity.sub, device_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(existing) = existing else {
            return Ok(DavDeleteResult::NotFound);
        };
        if !dav_precondition_matches_value(precondition, Some(&existing))? {
            return Ok(DavDeleteResult::PreconditionFailed);
        }
        connection.execute(
            r#"
            DELETE FROM chat_working_snapshot
            WHERE owner_issuer = ? AND owner_sub = ? AND device_id = ?
            "#,
            params![identity.issuer, identity.sub, device_id],
        )?;
        Ok(DavDeleteResult::Deleted)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| anyhow!("repository database lock is unavailable"))
    }
}

pub fn dav_etag(value: &Value) -> Result<String> {
    let canonical = serde_json_canonicalizer::to_vec(value)
        .context("WebDAV resource cannot be canonicalized")?;
    Ok(format!("\"sha256:{}\"", hex(&Sha256::digest(canonical))))
}

fn validated_dav_ref(id: &str, value: &Value) -> Result<ConversationRefState> {
    let mut state: ConversationRefState =
        serde_json::from_value(value.clone()).context("WebDAV ref is invalid")?;
    let path_id = required_text(id, "conversationId", 160)?;
    state.id = required_text(&state.id, "id", 160)?;
    if state.id != path_id {
        bail!("WebDAV ref id does not match its path");
    }
    state.head_message_id = nullable_text(state.head_message_id.as_deref(), "headMessageId", 160)?;
    if state.head_version < 0 || state.metadata_version < 0 {
        bail!("WebDAV ref versions must not be negative");
    }
    state.name = trimmed_text(&state.name, 300);
    state.provider_id = trimmed_text(&state.provider_id, 80);
    state.model = trimmed_text(&state.model, 300);
    state.generation_settings =
        normalize_generation_settings(&serde_json::to_value(&state.generation_settings)?);
    state.created_at = required_text(&state.created_at, "createdAt", 80)?;
    state.updated_at = required_text(&state.updated_at, "updatedAt", 80)?;
    Ok(state)
}

fn validate_working_snapshot(device_id: &str, value: &Value) -> Result<()> {
    let device_id = required_text(device_id, "deviceId", 180)?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("WebDAV working snapshot is invalid"))?;
    if object.get("deviceId").and_then(Value::as_str) != Some(device_id.as_str()) {
        bail!("WebDAV working snapshot deviceId does not match its path");
    }
    required_string(object.get("snapshotAt"), "snapshotAt", 80)?;
    let items = object
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("WebDAV working snapshot items are required"))?;
    if items.len() > 1_000 {
        bail!("WebDAV working snapshot has too many items");
    }
    for item in items {
        let item = item
            .as_object()
            .ok_or_else(|| anyhow!("WebDAV working item is invalid"))?;
        required_string(item.get("id"), "working item id", 180)?;
        required_string(
            item.get("conversationId"),
            "working item conversationId",
            180,
        )?;
        if !matches!(
            item.get("kind").and_then(Value::as_str),
            Some("user-draft" | "assistant-stream")
        ) || !item.get("parts").is_some_and(Value::is_array)
        {
            bail!("WebDAV working item is invalid");
        }
    }
    if serde_json::to_vec(value)?.len() > 4 * 1024 * 1024 {
        bail!("WebDAV working snapshot is too large");
    }
    Ok(())
}

fn dav_precondition_matches_ref(
    precondition: &DavPrecondition,
    existing: Option<&ConversationRow>,
) -> Result<bool> {
    match precondition {
        DavPrecondition::Create => Ok(existing.is_none()),
        DavPrecondition::Match(expected) => existing
            .map(|row| {
                let value = serde_json::to_value(conversation_ref(ConversationRow {
                    id: row.id.clone(),
                    name: row.name.clone(),
                    head_message_id: row.head_message_id.clone(),
                    provider_id: row.provider_id.clone(),
                    model: row.model.clone(),
                    settings_json: row.settings_json.clone(),
                    head_version: row.head_version,
                    metadata_version: row.metadata_version,
                    created_at: row.created_at.clone(),
                    updated_at: row.updated_at.clone(),
                })?)?;
                Ok(dav_etag(&value)? == *expected)
            })
            .transpose()
            .map(|matches| matches.unwrap_or(false)),
    }
}

fn dav_precondition_matches_value(
    precondition: &DavPrecondition,
    existing_json: Option<&str>,
) -> Result<bool> {
    match precondition {
        DavPrecondition::Create => Ok(existing_json.is_none()),
        DavPrecondition::Match(expected) => existing_json
            .map(|value| -> Result<bool> {
                Ok(dav_etag(&serde_json::from_str(value)?)? == *expected)
            })
            .transpose()
            .map(|matches| matches.unwrap_or(false)),
    }
}

fn owned_message_depth_connection(
    connection: &Connection,
    identity: &ChatIdentity,
    id: &str,
) -> Result<Option<i64>> {
    Ok(connection
        .query_row(
            "SELECT depth FROM chat_message_node WHERE id = ? AND owner_issuer = ? AND owner_sub = ?",
            params![id, identity.issuer, identity.sub],
            |row| row.get(0),
        )
        .optional()?)
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(());
        }
    }
    drop(statement);
    connection.execute_batch(&format!(
        "ALTER TABLE {table} ADD COLUMN {column} {declaration}"
    ))?;
    Ok(())
}

fn validate_repository_id(value: &str) -> Result<()> {
    let current = value.strip_prefix("local:").is_some_and(|suffix| {
        (8..=160).contains(&suffix.len())
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    });
    let legacy = value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !current && !legacy {
        bail!("repositoryId is invalid");
    }
    Ok(())
}

fn validate_message(value: &Value, repository_id: &str) -> Result<ValidatedMessage> {
    validate_repository_id(repository_id)?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("repository object is invalid"))?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| id.starts_with("sha256:"))
        .ok_or_else(|| anyhow!("repository object id is invalid"))?;
    let mut content = object.clone();
    content.remove("id");
    let canonical = serde_json_canonicalizer::to_vec(&Value::Object(content))
        .context("repository object cannot be canonicalized")?;
    let mut hasher = Sha256::new();
    hasher.update(repository_id.as_bytes());
    hasher.update([0]);
    hasher.update(canonical);
    let expected = format!("sha256:{}", hex(&hasher.finalize()));
    if id != expected {
        bail!("Object {id} failed content verification");
    }

    let role = object
        .get("role")
        .and_then(Value::as_str)
        .filter(|role| matches!(*role, "system" | "user" | "assistant"))
        .ok_or_else(|| anyhow!("repository object role is invalid"))?;
    let parent_message_id = nullable_id(object.get("parentMessageId"), "parentMessageId")?;
    let parts = object
        .get("parts")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("parts is required"))?;
    let parts_json = serde_json::to_string(parts)?;
    if parts_json.len() > 1024 * 1024 {
        bail!("message is too large");
    }
    let origin = object
        .get("origin")
        .filter(|origin| {
            origin
                .as_object()
                .and_then(|origin| origin.get("type"))
                .and_then(Value::as_str)
                .is_some()
        })
        .cloned()
        .unwrap_or_else(|| match role {
            "user" => json!({"type": "user"}),
            "system" => json!({"type": "system", "source": "chat"}),
            _ => json!({"type": "imported"}),
        });
    let completion = object
        .get("completion")
        .filter(|completion| completion.get("status").and_then(Value::as_str) == Some("partial"))
        .cloned()
        .unwrap_or_else(|| json!({"status": "complete"}));
    let metadata = object
        .get("metadata")
        .filter(|metadata| metadata.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let metadata_json = serde_json::to_string(&metadata)?;
    if metadata_json.len() > 64 * 1024 {
        bail!("message metadata is too large");
    }

    Ok(ValidatedMessage {
        id: id.to_owned(),
        repository_id: repository_id.to_owned(),
        parent_message_id,
        role: role.to_owned(),
        parts_json,
        origin_json: serde_json::to_string(&origin)?,
        completion_json: serde_json::to_string(&completion)?,
        metadata_json,
        created_at: required_string(object.get("createdAt"), "createdAt", 80)?,
        completed_at: required_string(object.get("completedAt"), "completedAt", 80)?,
    })
}

fn insert_objects(
    connection: &mut Connection,
    identity: &ChatIdentity,
    objects: &[ValidatedMessage],
) -> Result<usize> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("unable to start repository object transaction")?;
    let result = insert_objects_in_transaction(&transaction, identity, objects);
    match result {
        Ok(inserted) => {
            transaction.commit()?;
            Ok(inserted)
        }
        Err(error) => {
            let _ = transaction.rollback();
            Err(error)
        }
    }
}

fn insert_objects_in_transaction(
    transaction: &Transaction<'_>,
    identity: &ChatIdentity,
    objects: &[ValidatedMessage],
) -> Result<usize> {
    let mut inserted = 0;
    for object in objects {
        if owned_message_depth(transaction, identity, &object.id)?.is_some() {
            transaction.execute(
                r#"
                UPDATE chat_message_node SET source_repository_id = ?
                WHERE id = ? AND owner_issuer = ? AND owner_sub = ?
                  AND source_repository_id = ''
                "#,
                params![
                    object.repository_id,
                    object.id,
                    identity.issuer,
                    identity.sub
                ],
            )?;
            continue;
        }
        let parent_depth = match &object.parent_message_id {
            Some(parent_id) => owned_message_depth(transaction, identity, parent_id)?
                .ok_or_else(|| anyhow!("parent object {parent_id} is unavailable"))?,
            None => -1,
        };
        transaction.execute(
            r#"
            INSERT INTO chat_message_node (
              id, owner_issuer, owner_sub, source_repository_id, parent_message_id, role, parts_json, origin_json,
              completion_json, metadata_json, depth, created_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            params![
                object.id,
                identity.issuer,
                identity.sub,
                object.repository_id,
                object.parent_message_id,
                object.role,
                object.parts_json,
                object.origin_json,
                object.completion_json,
                object.metadata_json,
                parent_depth + 1,
                object.created_at,
                object.completed_at,
            ],
        )?;
        inserted += 1;
    }
    Ok(inserted)
}

fn push_ref(
    connection: &Connection,
    identity: &ChatIdentity,
    update: RepositoryRefUpdate,
) -> Result<RepositoryPushRefResult> {
    let id = required_text(&update.conversation_id, "conversationId", 160)?;
    let expected_head_message_id = nullable_text(
        update.expected_head_message_id.as_deref(),
        "expectedHeadMessageId",
        160,
    )?;
    let head_message_id = nullable_text(update.head_message_id.as_deref(), "headMessageId", 160)?;
    let existing = owned_conversation(connection, identity, &id)?;
    if existing.is_none() {
        if expected_head_message_id.is_some()
            || update.expected_head_version != 0
            || update.expected_metadata_version != 0
        {
            return Ok(RepositoryPushRefResult {
                conversation_id: id,
                status: "conflict",
                r#ref: None,
            });
        }
        ensure_owned_head(connection, identity, head_message_id.as_deref())?;
        let name = trimmed_text(&update.name, 300);
        let provider_id = trimmed_text(&update.provider_id, 80);
        let model = trimmed_text(&update.model, 300);
        let settings = normalize_generation_settings(&update.generation_settings);
        let settings_json = serde_json::to_string(&settings)?;
        let timestamp = now()?;
        let created_at = if update.created_at.is_empty() {
            timestamp.clone()
        } else {
            update.created_at
        };
        connection.execute(
            r#"
            INSERT INTO chat_conversation (
              id, owner_issuer, owner_sub, title, name, head_message_id, provider_id, model,
              settings_json, head_version, metadata_version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
            "#,
            params![
                id,
                identity.issuer,
                identity.sub,
                name,
                name,
                head_message_id,
                provider_id,
                model,
                settings_json,
                created_at,
                timestamp,
            ],
        )?;
        return Ok(RepositoryPushRefResult {
            conversation_id: id.clone(),
            status: "ok",
            r#ref: Some(conversation_ref(
                owned_conversation(connection, identity, &id)?
                    .ok_or_else(|| anyhow!("created conversation is unavailable"))?,
            )?),
        });
    }

    let existing = existing.expect("checked above");
    if existing.head_message_id != expected_head_message_id
        || existing.head_version != update.expected_head_version
        || existing.metadata_version != update.expected_metadata_version
    {
        return Ok(RepositoryPushRefResult {
            conversation_id: id,
            status: "conflict",
            r#ref: Some(conversation_ref(existing)?),
        });
    }
    ensure_owned_head(connection, identity, head_message_id.as_deref())?;
    let name = trimmed_text(&update.name, 300);
    let provider_id = trimmed_text(&update.provider_id, 80);
    let model = trimmed_text(&update.model, 300);
    let settings = normalize_generation_settings(&update.generation_settings);
    let previous_settings = normalize_generation_settings(
        &serde_json::from_str(&existing.settings_json).context("stored settings are invalid")?,
    );
    let head_changed = existing.head_message_id != head_message_id;
    let metadata_changed = existing.name != name
        || existing.provider_id != provider_id
        || existing.model != model
        || previous_settings != settings;
    connection.execute(
        r#"
        UPDATE chat_conversation
        SET title = ?, name = ?, head_message_id = ?, provider_id = ?, model = ?, settings_json = ?,
          head_version = head_version + ?, metadata_version = metadata_version + ?, updated_at = ?
        WHERE id = ? AND owner_issuer = ? AND owner_sub = ?
        "#,
        params![
            name,
            name,
            head_message_id,
            provider_id,
            model,
            serde_json::to_string(&settings)?,
            i64::from(head_changed),
            i64::from(metadata_changed),
            now()?,
            id,
            identity.issuer,
            identity.sub,
        ],
    )?;
    Ok(RepositoryPushRefResult {
        conversation_id: id.clone(),
        status: "ok",
        r#ref: Some(conversation_ref(
            owned_conversation(connection, identity, &id)?
                .ok_or_else(|| anyhow!("updated conversation is unavailable"))?,
        )?),
    })
}

fn owned_message_depth(
    transaction: &Transaction<'_>,
    identity: &ChatIdentity,
    id: &str,
) -> Result<Option<i64>> {
    Ok(transaction
        .query_row(
            "SELECT depth FROM chat_message_node WHERE id = ? AND owner_issuer = ? AND owner_sub = ?",
            params![id, identity.issuer, identity.sub],
            |row| row.get(0),
        )
        .optional()?)
}

fn ensure_owned_head(
    connection: &Connection,
    identity: &ChatIdentity,
    id: Option<&str>,
) -> Result<()> {
    let Some(id) = id else {
        return Ok(());
    };
    let exists = connection
        .query_row(
            "SELECT 1 FROM chat_message_node WHERE id = ? AND owner_issuer = ? AND owner_sub = ?",
            params![id, identity.issuer, identity.sub],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        bail!("head object is unavailable");
    }
    Ok(())
}

fn owned_conversation(
    connection: &Connection,
    identity: &ChatIdentity,
    id: &str,
) -> Result<Option<ConversationRow>> {
    Ok(connection
        .query_row(
            r#"
            SELECT c.id, COALESCE(c.name, c.title), c.head_message_id, c.provider_id, c.model,
              c.settings_json, c.head_version, c.metadata_version, c.created_at, c.updated_at
            FROM chat_conversation c
            WHERE c.id = ? AND c.owner_issuer = ? AND c.owner_sub = ?
            "#,
            params![id, identity.issuer, identity.sub],
            conversation_row,
        )
        .optional()?)
}

fn conversation_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationRow> {
    Ok(ConversationRow {
        id: row.get(0)?,
        name: row.get(1)?,
        head_message_id: row.get(2)?,
        provider_id: row.get(3)?,
        model: row.get(4)?,
        settings_json: row.get(5)?,
        head_version: row.get(6)?,
        metadata_version: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn conversation_ref(row: ConversationRow) -> Result<ConversationRefState> {
    let settings = serde_json::from_str(&row.settings_json).unwrap_or_else(|_| json!({}));
    Ok(ConversationRefState {
        id: row.id,
        name: row.name,
        head_message_id: row.head_message_id,
        provider_id: row.provider_id,
        model: row.model,
        generation_settings: normalize_generation_settings(&settings),
        head_version: row.head_version,
        metadata_version: row.metadata_version,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        id: row.get(0)?,
        repository_id: row.get(1)?,
        parent_message_id: row.get(2)?,
        role: row.get(3)?,
        parts_json: row.get(4)?,
        origin_json: row.get(5)?,
        completion_json: row.get(6)?,
        metadata_json: row.get(7)?,
        created_at: row.get(8)?,
        completed_at: row.get(9)?,
    })
}

fn message_value(row: MessageRow) -> Result<Value> {
    let mut object = Map::new();
    object.insert("id".to_owned(), Value::String(row.id));
    object.insert(
        "parentMessageId".to_owned(),
        row.parent_message_id.map_or(Value::Null, Value::String),
    );
    object.insert("role".to_owned(), Value::String(row.role));
    object.insert("parts".to_owned(), serde_json::from_str(&row.parts_json)?);
    object.insert("origin".to_owned(), serde_json::from_str(&row.origin_json)?);
    object.insert(
        "completion".to_owned(),
        serde_json::from_str(&row.completion_json)?,
    );
    object.insert("createdAt".to_owned(), Value::String(row.created_at));
    object.insert("completedAt".to_owned(), Value::String(row.completed_at));
    let metadata: Value = serde_json::from_str(&row.metadata_json)?;
    if metadata
        .as_object()
        .is_some_and(|metadata| !metadata.is_empty())
    {
        object.insert("metadata".to_owned(), metadata);
    }
    Ok(Value::Object(object))
}

fn normalize_generation_settings(value: &Value) -> GenerationSettings {
    let Some(input) = value.as_object() else {
        return GenerationSettings::default();
    };
    let reasoning = input
        .get("reasoning")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "auto" | "none" | "low" | "medium" | "high"))
        .unwrap_or("auto")
        .to_owned();
    let temperature = input
        .get("temperature")
        .and_then(Value::as_f64)
        .map(|value| value.clamp(0.0, 2.0));
    let max_output_tokens = input
        .get("maxOutputTokens")
        .and_then(Value::as_f64)
        .map(|value| value.floor().clamp(1.0, 1_000_000.0) as i64);
    GenerationSettings {
        reasoning,
        show_reasoning_summary: input.get("showReasoningSummary").and_then(Value::as_bool)
            == Some(true),
        temperature,
        max_output_tokens,
    }
}

fn nullable_id(value: Option<&Value>, field: &str) -> Result<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => nullable_text(Some(value), field, 160),
        _ => bail!("{field} is invalid"),
    }
}

fn nullable_text(value: Option<&str>, field: &str, maximum: usize) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_empty() {
        return Ok(None);
    }
    if value.trim().is_empty() {
        bail!("{field} is invalid");
    }
    Ok(Some(trimmed_text(value, maximum)))
}

fn required_string(value: Option<&Value>, field: &str, maximum: usize) -> Result<String> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{field} is required"))?;
    required_text(value, field, maximum)
}

fn required_text(value: &str, field: &str, maximum: usize) -> Result<String> {
    if value.trim().is_empty() {
        bail!("{field} is required");
    }
    Ok(trimmed_text(value, maximum))
}

fn trimmed_text(value: &str, maximum: usize) -> String {
    let mut units = 0;
    value
        .trim()
        .chars()
        .take_while(|character| {
            let next = units + character.len_utf16();
            if next > maximum {
                false
            } else {
                units = next;
                true
            }
        })
        .collect()
}

fn now() -> Result<String> {
    Ok(OffsetDateTime::now_utc().format(format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    ))?)
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn identity() -> ChatIdentity {
        ChatIdentity {
            issuer: "turnfold:single-user".to_owned(),
            sub: "default".to_owned(),
            username: "local".to_owned(),
            name: "local".to_owned(),
            email: String::new(),
        }
    }

    fn message() -> Value {
        json!({
            "id": "sha256:e78a7964f25f6bf9782a6b7f456ff86954dc8d779b9a7d494e83fd316010dcc2",
            "parentMessageId": null,
            "role": "user",
            "parts": [{"type": "text", "text": "hello"}],
            "origin": {"type": "user"},
            "completion": {"status": "complete"},
            "createdAt": "2026-01-01T00:00:00.000Z",
            "completedAt": "2026-01-01T00:00:00.000Z"
        })
    }

    fn legacy_message() -> Value {
        json!({
            "id": "sha256:f86d83b562076f230bfa0abaea9461cf46cd6c8f218eb845a1d7f43d5bbc7898",
            "parentMessageId": null,
            "role": "user",
            "parts": [{"type": "text", "text": "legacy"}],
            "origin": {"type": "user"},
            "completion": {"status": "complete"},
            "createdAt": "2026-01-01T00:00:00.000Z",
            "completedAt": "2026-01-01T00:00:00.000Z"
        })
    }

    fn push_payload(expected_head_version: i64) -> Value {
        json!({
            "repositoryId": "local:test-client",
            "objects": [message()],
            "refs": [{
                "conversationId": "conversation-1",
                "expectedHeadMessageId": null,
                "expectedHeadVersion": expected_head_version,
                "expectedMetadataVersion": 0,
                "headMessageId": "sha256:e78a7964f25f6bf9782a6b7f456ff86954dc8d779b9a7d494e83fd316010dcc2",
                "name": "First conversation",
                "providerId": "openai",
                "model": "gpt-test",
                "generationSettings": {"reasoning": "auto", "showReasoningSummary": false, "temperature": null, "maxOutputTokens": null},
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z"
            }]
        })
    }

    #[test]
    fn accepts_browser_hashes_and_round_trips_repository_state() {
        let directory = tempdir().unwrap();
        let store = RepositoryStore::open(&directory.path().join("turnfold.db")).unwrap();
        let pushed = store.push(&identity(), push_payload(0)).unwrap();
        assert_eq!(pushed.inserted_objects, 1);
        assert_eq!(pushed.refs[0].status, "ok");
        assert_eq!(pushed.refs[0].r#ref.as_ref().unwrap().head_version, 1);

        let fetched = store
            .fetch(&identity(), &json!({"haveObjectIds": []}))
            .unwrap();
        assert_eq!(fetched.refs.len(), 1);
        assert_eq!(fetched.objects, vec![message()]);
        assert_eq!(
            fetched
                .object_repository_ids
                .get("sha256:e78a7964f25f6bf9782a6b7f456ff86954dc8d779b9a7d494e83fd316010dcc2")
                .map(String::as_str),
            Some("local:test-client")
        );

        let fetched = store
            .fetch(
                &identity(),
                &json!({
                    "haveObjectIds": [
                        "sha256:e78a7964f25f6bf9782a6b7f456ff86954dc8d779b9a7d494e83fd316010dcc2"
                    ]
                }),
            )
            .unwrap();
        assert!(fetched.objects.is_empty());
        assert!(fetched.object_repository_ids.is_empty());
    }

    #[test]
    fn rejects_invalid_hashes_and_stale_ref_versions() {
        let directory = tempdir().unwrap();
        let store = RepositoryStore::open(&directory.path().join("turnfold.db")).unwrap();
        store.push(&identity(), push_payload(0)).unwrap();

        let conflict = store.push(&identity(), push_payload(0)).unwrap();
        assert_eq!(conflict.inserted_objects, 0);
        assert_eq!(conflict.refs[0].status, "conflict");
        assert_eq!(conflict.refs[0].r#ref.as_ref().unwrap().head_version, 1);

        let mut invalid = push_payload(1);
        invalid["objects"][0]["parts"][0]["text"] = json!("tampered");
        assert!(store.push(&identity(), invalid).is_err());
    }

    #[test]
    fn round_trips_legacy_repository_provenance() {
        let directory = tempdir().unwrap();
        let store = RepositoryStore::open(&directory.path().join("turnfold.db")).unwrap();
        let object = legacy_message();
        let object_id = object["id"].as_str().unwrap();
        let legacy_repository_id = "8daac02ed9a886768394ae58c97a63b9";
        let pushed = store
            .push(
                &identity(),
                json!({
                    "repositoryId": "local:test-client",
                    "objectRepositoryIds": {object_id: legacy_repository_id},
                    "objects": [object],
                    "refs": []
                }),
            )
            .unwrap();
        assert_eq!(pushed.inserted_objects, 1);

        let fetched = store
            .fetch(&identity(), &json!({"haveObjectIds": []}))
            .unwrap();
        assert_eq!(fetched.objects, vec![legacy_message()]);
        assert_eq!(
            fetched
                .object_repository_ids
                .get(object_id)
                .map(String::as_str),
            Some(legacy_repository_id)
        );
    }
}
