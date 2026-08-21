use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use anyhow::{Context, Result, anyhow, bail};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::identity::ChatIdentity;

pub const REPOSITORY_SYNC_SCOPE: &str = "repository.sync";
pub const REPOSITORY_WEBDAV_SCOPE: &str = "repository.webdav";
pub const PROVIDER_EXECUTE_SCOPE: &str = "provider.execute";
pub const VAULT_MANAGE_SCOPE: &str = "vault.manage";
const PAIRING_LIFETIME_SECONDS: i64 = 5 * 60;
const GRANT_LIFETIME_SECONDS: i64 = 90 * 24 * 60 * 60;
const MAX_PENDING_PAIRINGS: i64 = 8;

#[derive(Clone)]
pub struct PairingStore {
    connection: Arc<Mutex<Connection>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGrant {
    pub id: String,
    pub origin: String,
    pub client_name: String,
    pub scopes: Vec<String>,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug)]
pub struct PairingStart {
    pub id: String,
    pub poll_token: String,
    pub expires_at: String,
    pub poll_interval_ms: u64,
}

#[derive(Debug)]
pub struct PairingApproval {
    pub origin: String,
    pub client_name: String,
    pub scopes: Vec<String>,
    pub expires_at: String,
    pub approval_nonce: String,
}

#[derive(Debug)]
pub enum PairingPoll {
    Pending { expires_at: String },
    Denied,
    Expired,
    Approved { grant: BrowserGrant, token: String },
}

#[derive(Debug)]
struct PairingRow {
    owner_issuer: String,
    owner_sub: String,
    origin: String,
    client_name: String,
    scopes_json: String,
    status: String,
    grant_id: Option<String>,
    expires_at: i64,
}

#[derive(Debug)]
struct GrantRow {
    id: String,
    origin: String,
    client_name: String,
    scopes_json: String,
    created_at: i64,
    expires_at: i64,
}

impl PairingStore {
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
            .with_context(|| format!("unable to open pairing database {}", path.display()))?;
        connection
            .execute_batch(
                r#"
                PRAGMA journal_mode = WAL;
                PRAGMA foreign_keys = ON;
                PRAGMA busy_timeout = 5000;
                CREATE TABLE IF NOT EXISTS local_browser_grant (
                  id TEXT PRIMARY KEY,
                  owner_issuer TEXT NOT NULL,
                  owner_sub TEXT NOT NULL,
                  origin TEXT NOT NULL,
                  client_name TEXT NOT NULL,
                  scopes_json TEXT NOT NULL,
                  token_hash TEXT NOT NULL UNIQUE,
                  created_at INTEGER NOT NULL,
                  expires_at INTEGER NOT NULL,
                  last_used_at INTEGER NOT NULL,
                  revoked_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS local_browser_grant_owner_origin
                  ON local_browser_grant (owner_issuer, owner_sub, origin, expires_at);
                CREATE TABLE IF NOT EXISTS local_pairing_request (
                  id TEXT PRIMARY KEY,
                  owner_issuer TEXT NOT NULL,
                  owner_sub TEXT NOT NULL,
                  origin TEXT NOT NULL,
                  client_name TEXT NOT NULL,
                  scopes_json TEXT NOT NULL,
                  poll_token_hash TEXT NOT NULL,
                  approval_nonce_hash TEXT,
                  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
                  grant_id TEXT REFERENCES local_browser_grant(id),
                  created_at INTEGER NOT NULL,
                  expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS local_pairing_request_owner_origin
                  ON local_pairing_request (owner_issuer, owner_sub, origin, status, expires_at);
                "#,
            )
            .context("unable to initialize pairing database")?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn start(
        &self,
        identity: &ChatIdentity,
        origin: &str,
        client_name: &str,
        scopes: &[String],
    ) -> Result<PairingStart> {
        validate_scopes(scopes)?;
        let client_name = trimmed(client_name, 120);
        if client_name.is_empty() {
            bail!("clientName is required");
        }
        let now = unix_now();
        let expires_at = now + PAIRING_LIFETIME_SECONDS;
        let id = Uuid::new_v4().to_string();
        let poll_token = random_token();
        let scopes_json = serde_json::to_string(scopes)?;
        let connection = self.lock()?;
        connection.execute(
            "DELETE FROM local_pairing_request WHERE expires_at <= ?",
            [now],
        )?;
        let pending: i64 = connection.query_row(
            r#"
            SELECT COUNT(*) FROM local_pairing_request
            WHERE owner_issuer = ? AND owner_sub = ? AND origin = ?
              AND status = 'pending' AND expires_at > ?
            "#,
            params![identity.issuer, identity.sub, origin, now],
            |row| row.get(0),
        )?;
        if pending >= MAX_PENDING_PAIRINGS {
            bail!("too many pending pairing requests for this origin");
        }
        connection.execute(
            r#"
            INSERT INTO local_pairing_request (
              id, owner_issuer, owner_sub, origin, client_name, scopes_json, poll_token_hash,
              status, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
            "#,
            params![
                id,
                identity.issuer,
                identity.sub,
                origin,
                client_name,
                scopes_json,
                secret_hash(&poll_token),
                now,
                expires_at,
            ],
        )?;
        Ok(PairingStart {
            id,
            poll_token,
            expires_at: timestamp(expires_at)?,
            poll_interval_ms: 1_000,
        })
    }

    pub fn prepare_approval(
        &self,
        identity: &ChatIdentity,
        id: &str,
    ) -> Result<Option<PairingApproval>> {
        let now = unix_now();
        let approval_nonce = random_token();
        let connection = self.lock()?;
        let row = pairing_request(&connection, id, identity)?;
        let Some(row) = row.filter(|row| row.status == "pending" && row.expires_at > now) else {
            return Ok(None);
        };
        connection.execute(
            "UPDATE local_pairing_request SET approval_nonce_hash = ? WHERE id = ?",
            params![secret_hash(&approval_nonce), id],
        )?;
        Ok(Some(PairingApproval {
            origin: row.origin,
            client_name: row.client_name,
            scopes: serde_json::from_str(&row.scopes_json)?,
            expires_at: timestamp(row.expires_at)?,
            approval_nonce,
        }))
    }

    pub fn decide(
        &self,
        identity: &ChatIdentity,
        id: &str,
        approval_nonce: &str,
        approved: bool,
    ) -> Result<bool> {
        let status = if approved { "approved" } else { "denied" };
        let changed = self.lock()?.execute(
            r#"
            UPDATE local_pairing_request
            SET status = ?, approval_nonce_hash = NULL
            WHERE id = ? AND owner_issuer = ? AND owner_sub = ? AND status = 'pending'
              AND expires_at > ? AND approval_nonce_hash = ?
            "#,
            params![
                status,
                id,
                identity.issuer,
                identity.sub,
                unix_now(),
                secret_hash(approval_nonce),
            ],
        )?;
        Ok(changed == 1)
    }

    pub fn poll(
        &self,
        identity: &ChatIdentity,
        id: &str,
        origin: &str,
        poll_token: &str,
    ) -> Result<Option<PairingPoll>> {
        let now = unix_now();
        let mut connection = self.lock()?;
        let row = connection
            .query_row(
                r#"
                SELECT owner_issuer, owner_sub, origin, client_name, scopes_json, status,
                  grant_id, expires_at
                FROM local_pairing_request
                WHERE id = ? AND owner_issuer = ? AND owner_sub = ? AND origin = ?
                  AND poll_token_hash = ?
                "#,
                params![
                    id,
                    identity.issuer,
                    identity.sub,
                    origin,
                    secret_hash(poll_token),
                ],
                pairing_row,
            )
            .optional()?;
        let Some(row) = row else {
            return Ok(None);
        };
        if row.expires_at <= now {
            return Ok(Some(PairingPoll::Expired));
        }
        if row.status == "pending" {
            return Ok(Some(PairingPoll::Pending {
                expires_at: timestamp(row.expires_at)?,
            }));
        }
        if row.status == "denied" {
            return Ok(Some(PairingPoll::Denied));
        }

        let token = random_token();
        let token_hash = secret_hash(&token);
        let grant_id = row.grant_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let grant_expires_at = now + GRANT_LIFETIME_SECONDS;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            r#"
            INSERT INTO local_browser_grant (
              id, owner_issuer, owner_sub, origin, client_name, scopes_json, token_hash,
              created_at, expires_at, last_used_at, revoked_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(id) DO UPDATE SET
              token_hash = excluded.token_hash,
              expires_at = excluded.expires_at,
              last_used_at = excluded.last_used_at,
              revoked_at = NULL
            "#,
            params![
                grant_id,
                row.owner_issuer,
                row.owner_sub,
                row.origin,
                row.client_name,
                row.scopes_json,
                token_hash,
                now,
                grant_expires_at,
                now,
            ],
        )?;
        transaction.execute(
            "UPDATE local_pairing_request SET grant_id = ? WHERE id = ?",
            params![grant_id, id],
        )?;
        transaction.commit()?;
        Ok(Some(PairingPoll::Approved {
            grant: BrowserGrant {
                id: grant_id,
                origin: row.origin,
                client_name: row.client_name,
                scopes: serde_json::from_str(&row.scopes_json)?,
                created_at: timestamp(now)?,
                expires_at: timestamp(grant_expires_at)?,
            },
            token,
        }))
    }

    pub fn authorize(
        &self,
        identity: &ChatIdentity,
        origin: &str,
        token: &str,
        required_scope: &str,
    ) -> Result<Option<BrowserGrant>> {
        self.authorize_inner(identity, origin, token, Some(required_scope))
    }

    pub fn authorize_any(
        &self,
        identity: &ChatIdentity,
        origin: &str,
        token: &str,
    ) -> Result<Option<BrowserGrant>> {
        self.authorize_inner(identity, origin, token, None)
    }

    fn authorize_inner(
        &self,
        identity: &ChatIdentity,
        origin: &str,
        token: &str,
        required_scope: Option<&str>,
    ) -> Result<Option<BrowserGrant>> {
        let now = unix_now();
        let connection = self.lock()?;
        let row = connection
            .query_row(
                r#"
                SELECT id, origin, client_name, scopes_json, created_at, expires_at
                FROM local_browser_grant
                WHERE token_hash = ? AND owner_issuer = ? AND owner_sub = ? AND origin = ?
                  AND revoked_at IS NULL AND expires_at > ?
                "#,
                params![
                    secret_hash(token),
                    identity.issuer,
                    identity.sub,
                    origin,
                    now,
                ],
                grant_row,
            )
            .optional()?;
        let Some(row) = row else {
            return Ok(None);
        };
        let scopes: Vec<String> = serde_json::from_str(&row.scopes_json)?;
        if required_scope
            .is_some_and(|required_scope| !scopes.iter().any(|scope| scope == required_scope))
        {
            return Ok(None);
        }
        connection.execute(
            "UPDATE local_browser_grant SET last_used_at = ? WHERE id = ?",
            params![now, row.id],
        )?;
        Ok(Some(BrowserGrant {
            id: row.id,
            origin: row.origin,
            client_name: row.client_name,
            scopes,
            created_at: timestamp(row.created_at)?,
            expires_at: timestamp(row.expires_at)?,
        }))
    }

    pub fn revoke(&self, identity: &ChatIdentity, origin: &str, token: &str) -> Result<bool> {
        let changed = self.lock()?.execute(
            r#"
            UPDATE local_browser_grant SET revoked_at = ?
            WHERE token_hash = ? AND owner_issuer = ? AND owner_sub = ? AND origin = ?
              AND revoked_at IS NULL
            "#,
            params![
                unix_now(),
                secret_hash(token),
                identity.issuer,
                identity.sub,
                origin,
            ],
        )?;
        Ok(changed == 1)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| anyhow!("pairing database lock is unavailable"))
    }
}

fn pairing_request(
    connection: &Connection,
    id: &str,
    identity: &ChatIdentity,
) -> Result<Option<PairingRow>> {
    Ok(connection
        .query_row(
            r#"
            SELECT owner_issuer, owner_sub, origin, client_name, scopes_json, status,
              grant_id, expires_at
            FROM local_pairing_request
            WHERE id = ? AND owner_issuer = ? AND owner_sub = ?
            "#,
            params![id, identity.issuer, identity.sub],
            pairing_row,
        )
        .optional()?)
}

fn pairing_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PairingRow> {
    Ok(PairingRow {
        owner_issuer: row.get(0)?,
        owner_sub: row.get(1)?,
        origin: row.get(2)?,
        client_name: row.get(3)?,
        scopes_json: row.get(4)?,
        status: row.get(5)?,
        grant_id: row.get(6)?,
        expires_at: row.get(7)?,
    })
}

fn grant_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GrantRow> {
    Ok(GrantRow {
        id: row.get(0)?,
        origin: row.get(1)?,
        client_name: row.get(2)?,
        scopes_json: row.get(3)?,
        created_at: row.get(4)?,
        expires_at: row.get(5)?,
    })
}

fn validate_scopes(scopes: &[String]) -> Result<()> {
    if scopes.is_empty() {
        bail!("requestedScopes must not be empty");
    }
    let mut unique = scopes.to_vec();
    unique.sort();
    unique.dedup();
    if unique.len() != scopes.len()
        || unique.iter().any(|scope| {
            !matches!(
                scope.as_str(),
                REPOSITORY_SYNC_SCOPE
                    | REPOSITORY_WEBDAV_SCOPE
                    | PROVIDER_EXECUTE_SCOPE
                    | VAULT_MANAGE_SCOPE
            )
        })
    {
        bail!("requestedScopes contains an unsupported or duplicate scope");
    }
    let repository = unique.iter().any(|scope| {
        matches!(
            scope.as_str(),
            REPOSITORY_SYNC_SCOPE | REPOSITORY_WEBDAV_SCOPE
        )
    });
    if repository && unique.len() != 1 {
        bail!("repository scopes cannot be combined with other scopes");
    }
    Ok(())
}

fn trimmed(value: &str, maximum: usize) -> String {
    value.trim().chars().take(maximum).collect()
}

fn unix_now() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn timestamp(value: i64) -> Result<String> {
    Ok(OffsetDateTime::from_unix_timestamp(value)?.format(&Rfc3339)?)
}

fn random_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn secret_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
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

    #[test]
    fn approves_origin_scoped_grants_and_revokes_them() {
        let directory = tempdir().unwrap();
        let store = PairingStore::open(&directory.path().join("turnfold.db")).unwrap();
        let origin = "https://app.example.test";
        let started = store
            .start(
                &identity(),
                origin,
                "Test browser",
                &[REPOSITORY_SYNC_SCOPE.to_owned()],
            )
            .unwrap();
        assert!(matches!(
            store
                .poll(&identity(), &started.id, origin, &started.poll_token)
                .unwrap(),
            Some(PairingPoll::Pending { .. })
        ));
        let approval = store
            .prepare_approval(&identity(), &started.id)
            .unwrap()
            .unwrap();
        assert!(
            store
                .decide(&identity(), &started.id, &approval.approval_nonce, true)
                .unwrap()
        );
        let PairingPoll::Approved { token, grant } = store
            .poll(&identity(), &started.id, origin, &started.poll_token)
            .unwrap()
            .unwrap()
        else {
            panic!("pairing was not approved");
        };
        assert_eq!(grant.origin, origin);
        assert!(
            store
                .authorize(&identity(), origin, &token, REPOSITORY_SYNC_SCOPE)
                .unwrap()
                .is_some()
        );
        assert!(store.revoke(&identity(), origin, &token).unwrap());
        assert!(
            store
                .authorize(&identity(), origin, &token, REPOSITORY_SYNC_SCOPE)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn keeps_repository_and_provider_vault_scopes_in_separate_grants() {
        assert!(
            validate_scopes(&[
                PROVIDER_EXECUTE_SCOPE.to_owned(),
                VAULT_MANAGE_SCOPE.to_owned()
            ])
            .is_ok()
        );
        assert!(
            validate_scopes(&[
                REPOSITORY_SYNC_SCOPE.to_owned(),
                PROVIDER_EXECUTE_SCOPE.to_owned()
            ])
            .is_err()
        );
        assert!(validate_scopes(&[REPOSITORY_WEBDAV_SCOPE.to_owned()]).is_ok());
        assert!(
            validate_scopes(&[
                REPOSITORY_SYNC_SCOPE.to_owned(),
                REPOSITORY_WEBDAV_SCOPE.to_owned()
            ])
            .is_err()
        );
        assert!(
            validate_scopes(&[VAULT_MANAGE_SCOPE.to_owned(), VAULT_MANAGE_SCOPE.to_owned()])
                .is_err()
        );
    }
}
