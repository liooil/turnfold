use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use reqwest::header::{HeaderName, HeaderValue};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use url::Url;
use uuid::Uuid;

use crate::identity::ChatIdentity;

const KEY_FILE_PREFIX: &str = "turnfold-vault-key-v1:";
const KEYRING_SERVICE: &str = "io.github.liooil.turnfold.vault";
const MASTER_KEY_VERIFIER_NAME: &str = "master-key-verifier-v1";
const MASTER_KEY_VERIFIER_DOMAIN: &[u8] = b"turnfold:vault-master-key-verifier:v1\0";
const MAX_SECRET_BYTES: usize = 64 * 1024;
const MAX_HEADERS: usize = 32;

#[derive(Clone)]
pub struct VaultStore {
    connection: Arc<Mutex<Connection>>,
    master_key: Arc<[u8; 32]>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAuth {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub header: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderProfileInput {
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    pub auth: ProviderAuth,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub discovery_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    pub auth: ProviderAuth,
    pub headers: BTreeMap<String, String>,
    pub discovery_url: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSecret {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialInput {
    pub provider_id: String,
    #[serde(default = "default_credential_name")]
    pub name: String,
    pub secret: ProviderSecret,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMetadata {
    pub id: String,
    pub provider_id: String,
    pub name: String,
    pub fingerprint: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub action: String,
    pub target_type: String,
    pub target_id: String,
    pub detail: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct ProviderExecutionConfig {
    pub profile: ProviderProfile,
    pub secret: ProviderSecret,
}

struct EncryptedSecret {
    ciphertext: Vec<u8>,
    nonce: [u8; 12],
    wrapped_dek: Vec<u8>,
    wrapped_nonce: [u8; 12],
    fingerprint: String,
}

impl VaultStore {
    pub fn open(database: &Path, key_file: &Path) -> Result<Self> {
        let allow_create = !database_requires_existing_master_key(database)?;
        let master_key = load_or_create_master_key(key_file, allow_create)?;
        Self::open_with_master_key(database, master_key)
    }

    pub fn open_with_keyring(database: &Path, keyring_name: &str) -> Result<Self> {
        let allow_create = !database_requires_existing_master_key(database)?;
        let entry = SystemVaultKeyring::new(keyring_name)?;
        let master_key = load_or_create_keyring_master_key(&entry, allow_create)?;
        Self::open_with_master_key(database, master_key)
    }

    pub fn migrate_key_file_to_keyring(
        database: &Path,
        key_file: &Path,
        keyring_name: &str,
    ) -> Result<bool> {
        let master_key = read_master_key_file(key_file)?;
        let _store = Self::open_with_master_key(database, master_key)?;
        let entry = SystemVaultKeyring::new(keyring_name)?;
        store_master_key_in_keyring(&entry, &master_key)
    }

    fn open_with_master_key(database: &Path, master_key: [u8; 32]) -> Result<Self> {
        if let Some(parent) = database
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent).with_context(|| {
                format!("unable to create database directory {}", parent.display())
            })?;
        }
        let mut connection = Connection::open(database)
            .with_context(|| format!("unable to open Vault database {}", database.display()))?;
        connection
            .execute_batch(
                r#"
                PRAGMA journal_mode = WAL;
                PRAGMA foreign_keys = ON;
                PRAGMA busy_timeout = 5000;
                CREATE TABLE IF NOT EXISTS local_provider_profile (
                  owner_issuer TEXT NOT NULL,
                  owner_sub TEXT NOT NULL,
                  id TEXT NOT NULL,
                  name TEXT NOT NULL,
                  protocol TEXT NOT NULL,
                  base_url TEXT NOT NULL,
                  auth_json TEXT NOT NULL,
                  headers_json TEXT NOT NULL,
                  discovery_url TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  PRIMARY KEY (owner_issuer, owner_sub, id)
                );
                CREATE TABLE IF NOT EXISTS local_vault_credential (
                  id TEXT PRIMARY KEY,
                  owner_issuer TEXT NOT NULL,
                  owner_sub TEXT NOT NULL,
                  provider_id TEXT NOT NULL,
                  name TEXT NOT NULL,
                  ciphertext BLOB NOT NULL,
                  nonce BLOB NOT NULL,
                  wrapped_dek BLOB NOT NULL,
                  wrapped_nonce BLOB NOT NULL,
                  fingerprint TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  last_used_at INTEGER,
                  UNIQUE (owner_issuer, owner_sub, provider_id, name)
                );
                CREATE INDEX IF NOT EXISTS local_vault_credential_owner
                  ON local_vault_credential (owner_issuer, owner_sub, provider_id);
                CREATE TABLE IF NOT EXISTS local_vault_audit (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  owner_issuer TEXT NOT NULL,
                  owner_sub TEXT NOT NULL,
                  action TEXT NOT NULL,
                  target_type TEXT NOT NULL,
                  target_id TEXT NOT NULL,
                  detail TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS local_vault_audit_owner
                  ON local_vault_audit (owner_issuer, owner_sub, id DESC);
                CREATE TABLE IF NOT EXISTS local_vault_metadata (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );
                "#,
            )
            .context("unable to initialize Provider/Vault database")?;
        validate_or_record_master_key(&mut connection, &master_key)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            master_key: Arc::new(master_key),
        })
    }

    pub fn list_profiles(&self, identity: &ChatIdentity) -> Result<Vec<ProviderProfile>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, name, protocol, base_url, auth_json, headers_json, discovery_url,
              created_at, updated_at
            FROM local_provider_profile
            WHERE owner_issuer = ? AND owner_sub = ?
            ORDER BY name COLLATE NOCASE, id
            "#,
        )?;
        let rows = statement.query_map(params![identity.issuer, identity.sub], profile_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn save_profile(
        &self,
        identity: &ChatIdentity,
        id: &str,
        input: ProviderProfileInput,
    ) -> Result<ProviderProfile> {
        validate_provider_id(id)?;
        let input = normalize_profile(input)?;
        let now = unix_now();
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing_created_at = transaction
            .query_row(
                r#"
                SELECT created_at FROM local_provider_profile
                WHERE owner_issuer = ? AND owner_sub = ? AND id = ?
                "#,
                params![identity.issuer, identity.sub, id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        let created_at = existing_created_at.unwrap_or(now);
        transaction.execute(
            r#"
            INSERT INTO local_provider_profile (
              owner_issuer, owner_sub, id, name, protocol, base_url, auth_json,
              headers_json, discovery_url, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner_issuer, owner_sub, id) DO UPDATE SET
              name = excluded.name,
              protocol = excluded.protocol,
              base_url = excluded.base_url,
              auth_json = excluded.auth_json,
              headers_json = excluded.headers_json,
              discovery_url = excluded.discovery_url,
              updated_at = excluded.updated_at
            "#,
            params![
                identity.issuer,
                identity.sub,
                id,
                input.name,
                input.protocol,
                input.base_url,
                serde_json::to_string(&input.auth)?,
                serde_json::to_string(&input.headers)?,
                input.discovery_url,
                created_at,
                now,
            ],
        )?;
        audit(
            &transaction,
            identity,
            if existing_created_at.is_some() {
                "profile.replace"
            } else {
                "profile.create"
            },
            "provider",
            id,
            "Provider execution profile saved",
            now,
        )?;
        transaction.commit()?;
        Ok(ProviderProfile {
            id: id.to_owned(),
            name: input.name,
            protocol: input.protocol,
            base_url: input.base_url,
            auth: input.auth,
            headers: input.headers,
            discovery_url: input.discovery_url,
            created_at: timestamp(created_at)?,
            updated_at: timestamp(now)?,
        })
    }

    pub fn delete_profile(&self, identity: &ChatIdentity, id: &str) -> Result<bool> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let credentials: i64 = transaction.query_row(
            r#"
            SELECT COUNT(*) FROM local_vault_credential
            WHERE owner_issuer = ? AND owner_sub = ? AND provider_id = ?
            "#,
            params![identity.issuer, identity.sub, id],
            |row| row.get(0),
        )?;
        if credentials > 0 {
            bail!("delete this Provider's Vault credentials first");
        }
        let changed = transaction.execute(
            r#"
            DELETE FROM local_provider_profile
            WHERE owner_issuer = ? AND owner_sub = ? AND id = ?
            "#,
            params![identity.issuer, identity.sub, id],
        )?;
        if changed == 1 {
            audit(
                &transaction,
                identity,
                "profile.delete",
                "provider",
                id,
                "Provider execution profile deleted",
                unix_now(),
            )?;
        }
        transaction.commit()?;
        Ok(changed == 1)
    }

    pub fn list_credentials(&self, identity: &ChatIdentity) -> Result<Vec<CredentialMetadata>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, provider_id, name, fingerprint, created_at, updated_at, last_used_at
            FROM local_vault_credential
            WHERE owner_issuer = ? AND owner_sub = ?
            ORDER BY provider_id, name COLLATE NOCASE
            "#,
        )?;
        let rows = statement.query_map(params![identity.issuer, identity.sub], credential_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn save_credential(
        &self,
        identity: &ChatIdentity,
        input: CredentialInput,
    ) -> Result<CredentialMetadata> {
        validate_provider_id(&input.provider_id)?;
        let name = trimmed_required(&input.name, "credential name", 80)?;
        validate_secret(&input.secret)?;
        let plaintext = serde_json::to_vec(&input.secret)?;
        if plaintext.len() > MAX_SECRET_BYTES {
            bail!("credential secret exceeds {MAX_SECRET_BYTES} bytes");
        }
        let now = unix_now();
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_profile(&transaction, identity, &input.provider_id)?;
        let existing = transaction
            .query_row(
                r#"
                SELECT id, created_at FROM local_vault_credential
                WHERE owner_issuer = ? AND owner_sub = ? AND provider_id = ? AND name = ?
                "#,
                params![identity.issuer, identity.sub, input.provider_id, name],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        let (id, created_at) = existing
            .clone()
            .unwrap_or_else(|| (Uuid::new_v4().to_string(), now));
        let encrypted = encrypt_secret(
            self.master_key.as_ref(),
            &id,
            identity,
            &input.provider_id,
            &plaintext,
        )?;
        transaction.execute(
            r#"
            INSERT INTO local_vault_credential (
              id, owner_issuer, owner_sub, provider_id, name, ciphertext, nonce,
              wrapped_dek, wrapped_nonce, fingerprint, created_at, updated_at, last_used_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(owner_issuer, owner_sub, provider_id, name) DO UPDATE SET
              ciphertext = excluded.ciphertext,
              nonce = excluded.nonce,
              wrapped_dek = excluded.wrapped_dek,
              wrapped_nonce = excluded.wrapped_nonce,
              fingerprint = excluded.fingerprint,
              updated_at = excluded.updated_at,
              last_used_at = NULL
            "#,
            params![
                id,
                identity.issuer,
                identity.sub,
                input.provider_id,
                name,
                encrypted.ciphertext,
                encrypted.nonce.as_slice(),
                encrypted.wrapped_dek,
                encrypted.wrapped_nonce.as_slice(),
                encrypted.fingerprint,
                created_at,
                now,
            ],
        )?;
        audit(
            &transaction,
            identity,
            if existing.is_some() {
                "credential.replace"
            } else {
                "credential.create"
            },
            "credential",
            &id,
            &format!("Credential saved for Provider {}", input.provider_id),
            now,
        )?;
        transaction.commit()?;
        Ok(CredentialMetadata {
            id,
            provider_id: input.provider_id,
            name,
            fingerprint: encrypted.fingerprint,
            created_at: timestamp(created_at)?,
            updated_at: timestamp(now)?,
            last_used_at: None,
        })
    }

    pub fn delete_credential(&self, identity: &ChatIdentity, id: &str) -> Result<bool> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            r#"
            DELETE FROM local_vault_credential
            WHERE id = ? AND owner_issuer = ? AND owner_sub = ?
            "#,
            params![id, identity.issuer, identity.sub],
        )?;
        if changed == 1 {
            audit(
                &transaction,
                identity,
                "credential.delete",
                "credential",
                id,
                "Credential deleted",
                unix_now(),
            )?;
        }
        transaction.commit()?;
        Ok(changed == 1)
    }

    pub fn execution_config(
        &self,
        identity: &ChatIdentity,
        provider_id: &str,
        credential_id: Option<&str>,
        action: &str,
    ) -> Result<ProviderExecutionConfig> {
        let now = unix_now();
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let profile = load_profile(&transaction, identity, provider_id)?
            .ok_or_else(|| anyhow!("Provider execution profile is not registered"))?;
        let secret = if profile.auth.kind == "none" && credential_id.is_none() {
            ProviderSecret::default()
        } else {
            let credential_id = credential_id
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| anyhow!("credentialId is required for this Provider"))?;
            let encrypted = transaction
                .query_row(
                    r#"
                    SELECT ciphertext, nonce, wrapped_dek, wrapped_nonce
                    FROM local_vault_credential
                    WHERE id = ? AND owner_issuer = ? AND owner_sub = ? AND provider_id = ?
                    "#,
                    params![credential_id, identity.issuer, identity.sub, provider_id,],
                    |row| {
                        Ok((
                            row.get::<_, Vec<u8>>(0)?,
                            row.get::<_, Vec<u8>>(1)?,
                            row.get::<_, Vec<u8>>(2)?,
                            row.get::<_, Vec<u8>>(3)?,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(|| anyhow!("Vault credential is unavailable"))?;
            let plaintext = decrypt_secret(
                self.master_key.as_ref(),
                credential_id,
                identity,
                provider_id,
                &encrypted.0,
                &encrypted.1,
                &encrypted.2,
                &encrypted.3,
            )?;
            let secret: ProviderSecret = serde_json::from_slice(&plaintext)
                .context("Vault credential plaintext is invalid")?;
            transaction.execute(
                "UPDATE local_vault_credential SET last_used_at = ? WHERE id = ?",
                params![now, credential_id],
            )?;
            secret
        };
        audit(
            &transaction,
            identity,
            action,
            "provider",
            provider_id,
            "Provider Agent used a registered execution profile",
            now,
        )?;
        transaction.commit()?;
        Ok(ProviderExecutionConfig { profile, secret })
    }

    pub fn audit_entries(&self, identity: &ChatIdentity) -> Result<Vec<AuditEntry>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, action, target_type, target_id, detail, created_at
            FROM local_vault_audit
            WHERE owner_issuer = ? AND owner_sub = ?
            ORDER BY id DESC
            LIMIT 200
            "#,
        )?;
        let rows = statement.query_map(params![identity.issuer, identity.sub], |row| {
            let created_at = sql_timestamp(row.get(5)?)?;
            Ok(AuditEntry {
                id: row.get(0)?,
                action: row.get(1)?,
                target_type: row.get(2)?,
                target_id: row.get(3)?,
                detail: row.get(4)?,
                created_at,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| anyhow!("Vault database lock is unavailable"))
    }
}

fn database_requires_existing_master_key(database: &Path) -> Result<bool> {
    if !database.exists() {
        return Ok(false);
    }
    let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| {
            format!(
                "unable to inspect existing Vault database {}",
                database.display()
            )
        })?;
    let has_verifier = table_exists(&connection, "local_vault_metadata")?
        && connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_vault_metadata WHERE key = ?)",
            [MASTER_KEY_VERIFIER_NAME],
            |row| row.get(0),
        )?;
    let has_credentials = table_exists(&connection, "local_vault_credential")?
        && connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_vault_credential LIMIT 1)",
            [],
            |row| row.get(0),
        )?;
    Ok(has_verifier || has_credentials)
}

fn table_exists(connection: &Connection, name: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)",
        [name],
        |row| row.get(0),
    )?)
}

fn validate_or_record_master_key(connection: &mut Connection, master_key: &[u8; 32]) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let stored = transaction
        .query_row(
            "SELECT value FROM local_vault_metadata WHERE key = ?",
            [MASTER_KEY_VERIFIER_NAME],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let verifier = master_key_verifier(master_key);
    if let Some(stored) = stored {
        let stored = URL_SAFE_NO_PAD
            .decode(stored)
            .context("Vault master-key verifier is invalid")?;
        if !constant_time_equal(&stored, &verifier) {
            bail!("Vault master key does not match this database");
        }
        transaction.commit()?;
        return Ok(());
    }

    let legacy_credential = transaction
        .query_row(
            "SELECT id, wrapped_dek, wrapped_nonce FROM local_vault_credential ORDER BY id LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .optional()?;
    if let Some((id, wrapped_dek, wrapped_nonce)) = legacy_credential {
        unwrap_credential_key(master_key, &id, &wrapped_dek, &wrapped_nonce)
            .context("Vault master key does not match this legacy database")?;
    }
    transaction.execute(
        "INSERT INTO local_vault_metadata (key, value) VALUES (?, ?)",
        params![MASTER_KEY_VERIFIER_NAME, URL_SAFE_NO_PAD.encode(verifier)],
    )?;
    transaction.commit()?;
    Ok(())
}

fn master_key_verifier(master_key: &[u8; 32]) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(MASTER_KEY_VERIFIER_DOMAIN);
    digest.update(master_key);
    digest.finalize().into()
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

trait VaultKeyring {
    fn get(&self) -> Result<Option<String>>;
    fn set(&self, value: &str) -> Result<()>;
}

struct SystemVaultKeyring {
    entry: keyring::Entry,
    name: String,
}

impl SystemVaultKeyring {
    fn new(name: &str) -> Result<Self> {
        validate_keyring_name(name)?;
        let entry = keyring::Entry::new(KEYRING_SERVICE, name)
            .with_context(|| format!("unable to open OS keyring entry {name}"))?;
        Ok(Self {
            entry,
            name: name.to_owned(),
        })
    }
}

impl VaultKeyring for SystemVaultKeyring {
    fn get(&self) -> Result<Option<String>> {
        match self.entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => {
                Err(error).with_context(|| format!("unable to read OS keyring entry {}", self.name))
            }
        }
    }

    fn set(&self, value: &str) -> Result<()> {
        self.entry
            .set_password(value)
            .with_context(|| format!("unable to write OS keyring entry {}", self.name))
    }
}

fn load_or_create_master_key(path: &Path, allow_create: bool) -> Result<[u8; 32]> {
    match fs::read_to_string(path) {
        Ok(value) => {
            validate_key_file_permissions(path)?;
            parse_master_key(&value)
                .with_context(|| format!("invalid Vault key file {}", path.display()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !allow_create {
                bail!(
                    "Vault key file {} is missing but the database already contains Vault key material; restore the original key before starting",
                    path.display()
                );
            }
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                fs::create_dir_all(parent).with_context(|| {
                    format!("unable to create Vault key directory {}", parent.display())
                })?;
            }
            let key = random_master_key();
            let encoded = format!("{}\n", encoded_master_key(&key));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(path) {
                Ok(mut file) => {
                    file.write_all(encoded.as_bytes()).with_context(|| {
                        format!("unable to write Vault key file {}", path.display())
                    })?;
                    file.sync_all().with_context(|| {
                        format!("unable to sync Vault key file {}", path.display())
                    })?;
                    validate_key_file_permissions(path)?;
                    Ok(key)
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    read_master_key_file(path)
                }
                Err(error) => Err(error)
                    .with_context(|| format!("unable to create Vault key file {}", path.display())),
            }
        }
        Err(error) => {
            Err(error).with_context(|| format!("unable to read Vault key file {}", path.display()))
        }
    }
}

fn read_master_key_file(path: &Path) -> Result<[u8; 32]> {
    let value = fs::read_to_string(path)
        .with_context(|| format!("unable to read Vault key file {}", path.display()))?;
    validate_key_file_permissions(path)?;
    parse_master_key(&value).with_context(|| format!("invalid Vault key file {}", path.display()))
}

#[cfg(unix)]
fn validate_key_file_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = fs::metadata(path)
        .with_context(|| format!("unable to inspect Vault key file {}", path.display()))?
        .permissions()
        .mode();
    if mode & 0o077 != 0 {
        bail!(
            "Vault key file {} must not be readable or writable by group or other users",
            path.display()
        );
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_key_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

fn load_or_create_keyring_master_key(
    entry: &impl VaultKeyring,
    allow_create: bool,
) -> Result<[u8; 32]> {
    if let Some(value) = entry.get()? {
        return parse_master_key(&value).context("OS keyring contains an invalid Vault key");
    }
    if !allow_create {
        bail!(
            "OS keyring entry is missing but the database already contains Vault key material; migrate the original key with `turnfold vault migrate-key` or restore the keyring entry"
        );
    }
    let key = random_master_key();
    entry.set(&encoded_master_key(&key))?;
    let stored = entry
        .get()?
        .ok_or_else(|| anyhow!("OS keyring did not retain the new Vault key"))?;
    let stored = parse_master_key(&stored).context("OS keyring returned an invalid Vault key")?;
    if !constant_time_equal(&key, &stored) {
        bail!("OS keyring returned a different Vault key after creation");
    }
    Ok(stored)
}

fn store_master_key_in_keyring(entry: &impl VaultKeyring, key: &[u8; 32]) -> Result<bool> {
    if let Some(value) = entry.get()? {
        let existing =
            parse_master_key(&value).context("OS keyring contains an invalid Vault key")?;
        if !constant_time_equal(&existing, key) {
            bail!("OS keyring entry already contains a different Vault key");
        }
        return Ok(false);
    }
    entry.set(&encoded_master_key(key))?;
    let stored = entry
        .get()?
        .ok_or_else(|| anyhow!("OS keyring did not retain the migrated Vault key"))?;
    let stored = parse_master_key(&stored).context("OS keyring returned an invalid Vault key")?;
    if !constant_time_equal(&stored, key) {
        bail!("OS keyring returned a different Vault key after migration");
    }
    Ok(true)
}

fn random_master_key() -> [u8; 32] {
    let mut key = [0_u8; 32];
    OsRng.fill_bytes(&mut key);
    key
}

fn encoded_master_key(key: &[u8; 32]) -> String {
    format!("{KEY_FILE_PREFIX}{}", URL_SAFE_NO_PAD.encode(key))
}

fn validate_keyring_name(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        bail!("Vault keyring name must use 1-120 ASCII letters, digits, '.', '_', ':', or '-'");
    }
    Ok(())
}

fn parse_master_key(value: &str) -> Result<[u8; 32]> {
    let encoded = value
        .trim()
        .strip_prefix(KEY_FILE_PREFIX)
        .ok_or_else(|| anyhow!("unsupported key file format"))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .context("Vault key is not valid base64url")?;
    bytes
        .try_into()
        .map_err(|_| anyhow!("Vault key must contain exactly 32 bytes"))
}

fn normalize_profile(mut input: ProviderProfileInput) -> Result<ProviderProfileInput> {
    input.name = trimmed_required(&input.name, "Provider name", 120)?;
    if !matches!(
        input.protocol.as_str(),
        "openai-chat" | "openai-responses" | "anthropic" | "google"
    ) {
        bail!("unsupported Provider protocol");
    }
    input.base_url = normalize_provider_url(&input.base_url, false, None)?;
    input.discovery_url = if input.discovery_url.trim().is_empty() {
        String::new()
    } else {
        normalize_provider_url(&input.discovery_url, true, Some(&input.base_url))?
    };
    match input.auth.kind.as_str() {
        "none" | "bearer" => input.auth.header = None,
        "header" => {
            let name = input
                .auth
                .header
                .as_deref()
                .ok_or_else(|| anyhow!("custom auth header is required"))?;
            validate_header(name, "placeholder", true)?;
            input.auth.header = Some(name.trim().to_owned());
        }
        _ => bail!("unsupported Provider auth type"),
    }
    validate_headers(&input.headers, false)?;
    Ok(input)
}

fn normalize_provider_url(
    value: &str,
    allow_query: bool,
    same_origin: Option<&str>,
) -> Result<String> {
    let mut url = Url::parse(value.trim()).context("Provider URL is invalid")?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        bail!("Provider URL cannot contain credentials or a fragment");
    }
    if !allow_query && url.query().is_some() {
        bail!("Provider base URL cannot contain a query string");
    }
    let loopback_http = url.scheme() == "http"
        && match url.host() {
            Some(url::Host::Ipv4(address)) => address.is_loopback(),
            Some(url::Host::Ipv6(address)) => address.is_loopback(),
            Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
            None => false,
        };
    if url.scheme() != "https" && !loopback_http {
        bail!("Provider URLs must use HTTPS, except for loopback HTTP");
    }
    if let Some(base) = same_origin {
        let base = Url::parse(base)?;
        if url.origin() != base.origin() {
            bail!("model discovery URL must use the Provider base origin");
        }
    }
    if !allow_query {
        let normalized = url.path().trim_end_matches('/').to_owned();
        url.set_path(if normalized.is_empty() {
            "/"
        } else {
            &normalized
        });
    }
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

fn validate_provider_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        bail!("Provider id must use 1-80 ASCII letters, numbers, '.', '_' or '-'");
    }
    Ok(())
}

fn validate_secret(secret: &ProviderSecret) -> Result<()> {
    if secret
        .api_key
        .as_ref()
        .is_some_and(|value| value.len() > 32 * 1024)
    {
        bail!("Provider API key is too large");
    }
    validate_headers(&secret.headers, true)
}

fn validate_headers(headers: &BTreeMap<String, String>, secret: bool) -> Result<()> {
    if headers.len() > MAX_HEADERS {
        bail!("Provider headers exceed the {MAX_HEADERS} header limit");
    }
    for (name, value) in headers {
        validate_header(name, value, secret)?;
    }
    Ok(())
}

fn validate_header(name: &str, value: &str, secret: bool) -> Result<()> {
    let parsed = HeaderName::from_bytes(name.trim().as_bytes())
        .map_err(|_| anyhow!("invalid Provider header name: {name}"))?;
    HeaderValue::from_str(value)
        .map_err(|_| anyhow!("invalid value for Provider header {name}"))?;
    let name = parsed.as_str();
    if matches!(
        name,
        "host"
            | "content-length"
            | "content-type"
            | "accept"
            | "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "cookie"
            | "set-cookie"
    ) || name.starts_with("sec-")
    {
        bail!("Provider header {name} is not allowed");
    }
    if !secret && matches!(name, "authorization" | "x-api-key" | "x-goog-api-key") {
        bail!("authentication header {name} must be stored as a Vault secret");
    }
    Ok(())
}

fn encrypt_secret(
    master_key: &[u8; 32],
    id: &str,
    identity: &ChatIdentity,
    provider_id: &str,
    plaintext: &[u8],
) -> Result<EncryptedSecret> {
    let mut dek = [0_u8; 32];
    let mut nonce = [0_u8; 12];
    let mut wrapped_nonce = [0_u8; 12];
    OsRng.fill_bytes(&mut dek);
    OsRng.fill_bytes(&mut nonce);
    OsRng.fill_bytes(&mut wrapped_nonce);
    let cipher = Aes256Gcm::new_from_slice(&dek).map_err(|_| anyhow!("invalid Vault DEK"))?;
    let aad = credential_aad(id, identity, provider_id);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| anyhow!("unable to encrypt Vault credential"))?;
    let wrapper =
        Aes256Gcm::new_from_slice(master_key).map_err(|_| anyhow!("invalid Vault master key"))?;
    let wrapped_dek = wrapper
        .encrypt(
            Nonce::from_slice(&wrapped_nonce),
            Payload {
                msg: &dek,
                aad: wrapped_dek_aad(id).as_bytes(),
            },
        )
        .map_err(|_| anyhow!("unable to wrap Vault credential key"))?;
    Ok(EncryptedSecret {
        ciphertext,
        nonce,
        wrapped_dek,
        wrapped_nonce,
        fingerprint: hex(&Sha256::digest(plaintext))[..16].to_owned(),
    })
}

#[allow(clippy::too_many_arguments)]
fn decrypt_secret(
    master_key: &[u8; 32],
    id: &str,
    identity: &ChatIdentity,
    provider_id: &str,
    ciphertext: &[u8],
    nonce: &[u8],
    wrapped_dek: &[u8],
    wrapped_nonce: &[u8],
) -> Result<Vec<u8>> {
    if nonce.len() != 12 {
        bail!("Vault credential nonce is invalid");
    }
    let dek = unwrap_credential_key(master_key, id, wrapped_dek, wrapped_nonce)?;
    let cipher = Aes256Gcm::new_from_slice(&dek).map_err(|_| anyhow!("invalid Vault DEK"))?;
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: credential_aad(id, identity, provider_id).as_bytes(),
            },
        )
        .map_err(|_| anyhow!("unable to decrypt Vault credential"))
}

fn unwrap_credential_key(
    master_key: &[u8; 32],
    id: &str,
    wrapped_dek: &[u8],
    wrapped_nonce: &[u8],
) -> Result<[u8; 32]> {
    if wrapped_nonce.len() != 12 {
        bail!("Vault wrapped-key nonce is invalid");
    }
    let wrapper =
        Aes256Gcm::new_from_slice(master_key).map_err(|_| anyhow!("invalid Vault master key"))?;
    let dek = wrapper
        .decrypt(
            Nonce::from_slice(wrapped_nonce),
            Payload {
                msg: wrapped_dek,
                aad: wrapped_dek_aad(id).as_bytes(),
            },
        )
        .map_err(|_| anyhow!("unable to unwrap Vault credential key"))?;
    dek.try_into()
        .map_err(|_| anyhow!("Vault credential key has an invalid length"))
}

fn credential_aad(id: &str, identity: &ChatIdentity, provider_id: &str) -> String {
    format!(
        "credential:v1:{id}:{}:{}:{provider_id}",
        identity.issuer, identity.sub
    )
}

fn wrapped_dek_aad(id: &str) -> String {
    format!("wrapped-dek:v1:{id}")
}

fn require_profile(transaction: &Transaction<'_>, identity: &ChatIdentity, id: &str) -> Result<()> {
    let exists: bool = transaction.query_row(
        r#"
        SELECT EXISTS(
          SELECT 1 FROM local_provider_profile
          WHERE owner_issuer = ? AND owner_sub = ? AND id = ?
        )
        "#,
        params![identity.issuer, identity.sub, id],
        |row| row.get(0),
    )?;
    if !exists {
        bail!("Provider execution profile is not registered");
    }
    Ok(())
}

fn load_profile(
    connection: &Connection,
    identity: &ChatIdentity,
    id: &str,
) -> Result<Option<ProviderProfile>> {
    Ok(connection
        .query_row(
            r#"
            SELECT id, name, protocol, base_url, auth_json, headers_json, discovery_url,
              created_at, updated_at
            FROM local_provider_profile
            WHERE owner_issuer = ? AND owner_sub = ? AND id = ?
            "#,
            params![identity.issuer, identity.sub, id],
            profile_row,
        )
        .optional()?)
}

fn profile_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProviderProfile> {
    let auth_json: String = row.get(4)?;
    let headers_json: String = row.get(5)?;
    let created_at: i64 = row.get(7)?;
    let updated_at: i64 = row.get(8)?;
    Ok(ProviderProfile {
        id: row.get(0)?,
        name: row.get(1)?,
        protocol: row.get(2)?,
        base_url: row.get(3)?,
        auth: serde_json::from_str(&auth_json).map_err(sql_conversion_error)?,
        headers: serde_json::from_str(&headers_json).map_err(sql_conversion_error)?,
        discovery_url: row.get(6)?,
        created_at: sql_timestamp(created_at)?,
        updated_at: sql_timestamp(updated_at)?,
    })
}

fn credential_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CredentialMetadata> {
    let created_at: i64 = row.get(4)?;
    let updated_at: i64 = row.get(5)?;
    let last_used_at: Option<i64> = row.get(6)?;
    Ok(CredentialMetadata {
        id: row.get(0)?,
        provider_id: row.get(1)?,
        name: row.get(2)?,
        fingerprint: row.get(3)?,
        created_at: sql_timestamp(created_at)?,
        updated_at: sql_timestamp(updated_at)?,
        last_used_at: last_used_at.map(sql_timestamp).transpose()?,
    })
}

fn sql_timestamp(value: i64) -> rusqlite::Result<String> {
    let timestamp = OffsetDateTime::from_unix_timestamp(value).map_err(sql_conversion_error)?;
    timestamp.format(&Rfc3339).map_err(sql_conversion_error)
}

fn sql_conversion_error(error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn audit(
    transaction: &Transaction<'_>,
    identity: &ChatIdentity,
    action: &str,
    target_type: &str,
    target_id: &str,
    detail: &str,
    created_at: i64,
) -> Result<()> {
    transaction.execute(
        r#"
        INSERT INTO local_vault_audit (
          owner_issuer, owner_sub, action, target_type, target_id, detail, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        "#,
        params![
            identity.issuer,
            identity.sub,
            action,
            target_type,
            target_id,
            detail,
            created_at,
        ],
    )?;
    Ok(())
}

fn default_credential_name() -> String {
    "default".to_owned()
}

fn trimmed_required(value: &str, field: &str, maximum: usize) -> Result<String> {
    let value: String = value.trim().chars().take(maximum + 1).collect();
    if value.is_empty() {
        bail!("{field} is required");
    }
    if value.chars().count() > maximum {
        bail!("{field} exceeds {maximum} characters");
    }
    Ok(value)
}

fn unix_now() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn timestamp(value: i64) -> Result<String> {
    Ok(OffsetDateTime::from_unix_timestamp(value)?.format(&Rfc3339)?)
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use tempfile::TempDir;

    use super::*;

    fn identity() -> ChatIdentity {
        ChatIdentity {
            issuer: "test".to_owned(),
            sub: "alice".to_owned(),
            username: "alice".to_owned(),
            name: "Alice".to_owned(),
            email: String::new(),
        }
    }

    fn profile() -> ProviderProfileInput {
        ProviderProfileInput {
            name: "OpenAI".to_owned(),
            protocol: "openai-responses".to_owned(),
            base_url: "https://api.openai.com/v1/".to_owned(),
            auth: ProviderAuth {
                kind: "bearer".to_owned(),
                header: None,
            },
            headers: BTreeMap::new(),
            discovery_url: String::new(),
        }
    }

    #[derive(Default)]
    struct MemoryKeyring {
        value: Mutex<Option<String>>,
    }

    impl VaultKeyring for MemoryKeyring {
        fn get(&self) -> Result<Option<String>> {
            Ok(self.value.lock().unwrap().clone())
        }

        fn set(&self, value: &str) -> Result<()> {
            *self.value.lock().unwrap() = Some(value.to_owned());
            Ok(())
        }
    }

    #[test]
    fn encrypts_credentials_and_returns_metadata_only() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("turnfold.db");
        let key = directory.path().join("vault.key");
        let store = VaultStore::open(&database, &key).unwrap();
        store
            .save_profile(&identity(), "openai", profile())
            .unwrap();
        let saved = store
            .save_credential(
                &identity(),
                CredentialInput {
                    provider_id: "openai".to_owned(),
                    name: "default".to_owned(),
                    secret: ProviderSecret {
                        api_key: Some("sk-not-plaintext".to_owned()),
                        headers: BTreeMap::new(),
                    },
                },
            )
            .unwrap();
        assert_eq!(saved.fingerprint.len(), 16);
        let database_bytes = fs::read(&database).unwrap();
        assert!(
            !database_bytes
                .windows(b"sk-not-plaintext".len())
                .any(|window| window == b"sk-not-plaintext")
        );
        let execution = store
            .execution_config(&identity(), "openai", Some(&saved.id), "provider.execute")
            .unwrap();
        assert_eq!(
            execution.secret.api_key.as_deref(),
            Some("sk-not-plaintext")
        );
        assert_eq!(store.list_credentials(&identity()).unwrap().len(), 1);
    }

    #[test]
    fn rejects_insecure_non_loopback_provider_urls() {
        let mut input = profile();
        input.base_url = "http://api.example.test/v1".to_owned();
        assert!(normalize_profile(input).is_err());
        let mut input = profile();
        input.base_url = "http://127.0.0.1:11434/v1".to_owned();
        assert!(normalize_profile(input).is_ok());
    }

    #[test]
    fn refuses_to_replace_a_missing_key_for_an_initialized_database() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("turnfold.db");
        let key = directory.path().join("vault.key");
        drop(VaultStore::open(&database, &key).unwrap());
        fs::remove_file(&key).unwrap();

        let error = VaultStore::open(&database, &key).err().unwrap();
        assert!(error.to_string().contains("missing"));
        assert!(!key.exists());
    }

    #[test]
    fn rejects_a_wrong_key_even_before_credentials_exist() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("turnfold.db");
        let key = directory.path().join("vault.key");
        drop(VaultStore::open(&database, &key).unwrap());
        fs::write(
            &key,
            format!("{}\n", encoded_master_key(&random_master_key())),
        )
        .unwrap();

        let error = VaultStore::open(&database, &key).err().unwrap();
        assert!(error.to_string().contains("does not match"));
    }

    #[test]
    fn validates_a_legacy_credential_before_recording_the_verifier() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("turnfold.db");
        let key = directory.path().join("vault.key");
        let store = VaultStore::open(&database, &key).unwrap();
        store
            .save_profile(&identity(), "openai", profile())
            .unwrap();
        store
            .save_credential(
                &identity(),
                CredentialInput {
                    provider_id: "openai".to_owned(),
                    name: "default".to_owned(),
                    secret: ProviderSecret {
                        api_key: Some("sk-legacy".to_owned()),
                        headers: BTreeMap::new(),
                    },
                },
            )
            .unwrap();
        drop(store);
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "DELETE FROM local_vault_metadata WHERE key = ?",
                [MASTER_KEY_VERIFIER_NAME],
            )
            .unwrap();
        drop(connection);

        drop(VaultStore::open(&database, &key).unwrap());
        let connection = Connection::open(&database).unwrap();
        let verifier: String = connection
            .query_row(
                "SELECT value FROM local_vault_metadata WHERE key = ?",
                [MASTER_KEY_VERIFIER_NAME],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(URL_SAFE_NO_PAD.decode(verifier).unwrap().len(), 32);
    }

    #[test]
    fn keyring_creation_and_migration_are_verified_and_idempotent() {
        let keyring = MemoryKeyring::default();
        let created = load_or_create_keyring_master_key(&keyring, true).unwrap();
        assert_eq!(
            load_or_create_keyring_master_key(&keyring, false).unwrap(),
            created
        );
        assert!(!store_master_key_in_keyring(&keyring, &created).unwrap());
        assert!(
            store_master_key_in_keyring(&keyring, &random_master_key())
                .unwrap_err()
                .to_string()
                .contains("different")
        );
    }

    #[test]
    fn missing_keyring_entry_is_not_created_for_protected_data() {
        let keyring = MemoryKeyring::default();
        let error = load_or_create_keyring_master_key(&keyring, false).unwrap_err();
        assert!(error.to_string().contains("missing"));
        assert!(keyring.get().unwrap().is_none());
    }
}
