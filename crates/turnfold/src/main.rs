use std::{collections::HashSet, fs, net::SocketAddr, path::PathBuf, sync::Arc};

use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Form, Path, Request as AxumRequest, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{any, get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use clap::{Args, Parser, Subcommand};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{net::TcpListener, task::JoinSet};
use tokio_util::sync::CancellationToken;
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};
use tracing::info;
use tracing_subscriber::EnvFilter;
use url::Url;

use crate::{
    identity::{AuthMode, ChatIdentity, ChatProfile, IdentityConfig},
    pairing::{
        BrowserGrant, PROVIDER_EXECUTE_SCOPE, PairingPoll, PairingStore, REPOSITORY_SYNC_SCOPE,
        REPOSITORY_WEBDAV_SCOPE, VAULT_MANAGE_SCOPE,
    },
    provider_agent::{ProviderAgent, ProviderExecuteRequest},
    repository::{RepositoryFetch, RepositoryPushResult, RepositoryStore},
    service_runtime::{DatabaseLock, resolve_database_path, resolve_static_dir},
    vault::{CredentialInput, ProviderProfileInput, VaultStore},
};

mod identity;
mod pairing;
mod provider_agent;
mod repository;
mod service_runtime;
mod vault;
mod webdav;

#[derive(Debug, Parser)]
#[command(name = "turnfold", version, about = "Turnfold local-first runtime")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Serve the Turnfold web application and local-service front door.
    Serve(Box<ServeArgs>),
    /// Manage the local Provider Vault.
    Vault(VaultArgs),
}

#[derive(Debug, Args)]
struct VaultArgs {
    #[command(subcommand)]
    command: VaultCommand,
}

#[derive(Debug, Subcommand)]
enum VaultCommand {
    /// Copy a validated Vault key file into the operating-system keyring.
    MigrateKey(MigrateKeyArgs),
}

#[derive(Debug, Args)]
struct MigrateKeyArgs {
    /// Existing SQLite database whose Vault key will be validated.
    #[arg(long, env = "CHAT_DATABASE_PATH", default_value = "turnfold.db")]
    database: PathBuf,

    /// Existing file containing the Vault master key.
    #[arg(long)]
    from_key_file: PathBuf,

    /// OS keyring account name that will receive the Vault master key.
    #[arg(long)]
    to_keyring: String,
}

#[derive(Debug, Args)]
struct ServeArgs {
    /// Socket used by the static application and local API front door.
    #[arg(long, default_value = "127.0.0.1:3000")]
    listen: SocketAddr,

    /// Directory containing a built Turnfold web application.
    #[arg(long, default_value = "dist")]
    static_dir: PathBuf,

    /// SQLite database used by the optional synchronization Backend.
    #[arg(long, env = "CHAT_DATABASE_PATH", default_value = "turnfold.db")]
    database: PathBuf,

    /// Identity mode used after the browser explicitly connects this Backend.
    #[arg(long, env = "AUTH_MODE", value_enum, default_value_t = AuthMode::SingleUser)]
    auth_mode: AuthMode,

    /// Profile name exposed by single-user mode.
    #[arg(long, env = "SINGLE_USER_NAME", default_value = "local")]
    single_user_name: String,

    /// Stable issuer for identities supplied by a trusted forward-auth proxy.
    #[arg(long, env = "AUTH_ISSUER")]
    auth_issuer: Option<String>,

    /// Exact public HTTP(S) origin accepted behind a proxy. May be repeated.
    #[arg(long = "public-origin")]
    public_origins: Vec<String>,

    /// File containing the Provider Vault master key. Enables the Provider/Vault worker.
    #[arg(
        long,
        env = "TURNFOLD_VAULT_KEY_FILE",
        conflicts_with = "vault_keyring"
    )]
    vault_key_file: Option<PathBuf>,

    /// OS keyring account containing the Provider Vault master key.
    #[arg(
        long,
        env = "TURNFOLD_VAULT_KEYRING",
        conflicts_with = "vault_key_file"
    )]
    vault_keyring: Option<String>,

    /// Optional dedicated WebDAV socket for non-browser clients.
    #[arg(long, env = "TURNFOLD_WEBDAV_LISTEN")]
    webdav_listen: Option<SocketAddr>,

    /// Username accepted by the dedicated WebDAV listener.
    #[arg(long, env = "TURNFOLD_WEBDAV_USERNAME", default_value = "turnfold")]
    webdav_username: String,

    /// File containing the password for the dedicated WebDAV listener.
    #[arg(long, env = "TURNFOLD_WEBDAV_PASSWORD_FILE")]
    webdav_password_file: Option<PathBuf>,

    /// Open the application in the default browser after binding the listener.
    #[arg(long)]
    open: bool,

    /// Permit a non-loopback listener. Trusted TLS is still required outside loopback.
    #[arg(long)]
    allow_remote: bool,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    runtime: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityResponse {
    static_assets: bool,
    sync: bool,
    pairing: bool,
    vault: bool,
    provider_proxy: bool,
    webdav: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalServiceInfo {
    name: &'static str,
    version: &'static str,
    backend_connection: &'static str,
    capabilities: CapabilityResponse,
}

#[derive(Clone)]
struct AppState {
    identities: IdentityConfig,
    pairing: PairingStore,
    repository: RepositoryStore,
    provider_agent: Option<ProviderAgent>,
    trusted_origins: Arc<HashSet<String>>,
}

#[derive(Clone)]
struct DedicatedDavState {
    repository: RepositoryStore,
    identity: ChatIdentity,
    credentials: DavBasicCredentials,
}

#[derive(Clone)]
struct DavBasicCredentials {
    digest: [u8; 32],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendConfigResponse {
    identity_key: String,
    profile: ChatProfile,
    capabilities: BackendCapabilities,
}

#[derive(Serialize)]
struct BackendCapabilities {
    sync: bool,
    pairing: bool,
}

struct ApiError {
    status: StatusCode,
    code: Option<&'static str>,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingStartRequest {
    client_name: String,
    requested_scopes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingStartResponse {
    pairing_id: String,
    poll_token: String,
    expires_at: String,
    poll_interval_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingPollRequest {
    poll_token: String,
}

#[derive(Deserialize)]
struct PairingDecisionForm {
    action: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("turnfold=info")),
        )
        .init();

    match Cli::parse().command {
        Command::Serve(args) => serve(*args).await,
        Command::Vault(args) => match args.command {
            VaultCommand::MigrateKey(args) => migrate_vault_key(args),
        },
    }
}

fn migrate_vault_key(args: MigrateKeyArgs) -> Result<()> {
    let database = resolve_database_path(&args.database)?;
    if !database.is_file() {
        bail!(
            "Vault database {} does not exist; refusing to create it during key migration",
            database.display()
        );
    }
    let _database_lock = DatabaseLock::acquire(&database)?;
    let migrated =
        VaultStore::migrate_key_file_to_keyring(&database, &args.from_key_file, &args.to_keyring)?;
    if migrated {
        println!(
            "Vault key copied to OS keyring entry {}; the source key file was not deleted.",
            args.to_keyring
        );
    } else {
        println!(
            "OS keyring entry {} already contains this Vault key; the source key file was not deleted.",
            args.to_keyring
        );
    }
    Ok(())
}

async fn serve(args: ServeArgs) -> Result<()> {
    validate_listener(args.listen, args.allow_remote)?;
    if let Some(address) = args.webdav_listen {
        validate_listener(address, args.allow_remote)?;
    } else if args.webdav_password_file.is_some() {
        bail!("--webdav-password-file requires --webdav-listen");
    }
    let static_dir = resolve_static_dir(&args.static_dir)?;
    let index = static_dir.join("index.html");
    if !index.is_file() {
        bail!(
            "static directory {} does not contain index.html",
            static_dir.display()
        );
    }
    let database = resolve_database_path(&args.database)?;
    let _database_lock = DatabaseLock::acquire(&database)?;

    let listener = TcpListener::bind(args.listen)
        .await
        .with_context(|| format!("unable to listen on {}", args.listen))?;
    let local_address = listener
        .local_addr()
        .context("unable to read listener address")?;
    let trusted_origins = trusted_service_origins(local_address, &args.public_origins)?;
    if !local_address.ip().is_loopback()
        && local_address.ip().is_unspecified()
        && args.public_origins.is_empty()
    {
        bail!("--public-origin is required when listening on an unspecified non-loopback address");
    }

    let auth_issuer = args
        .auth_issuer
        .or_else(|| std::env::var("AUTHENTIK_ISSUER").ok())
        .filter(|issuer| !issuer.trim().is_empty())
        .unwrap_or_else(|| "turnfold:forward-auth".to_owned());
    let provider_agent = match (
        args.vault_key_file.as_deref(),
        args.vault_keyring.as_deref(),
    ) {
        (Some(key_file), None) => Some(
            VaultStore::open(&database, key_file)
                .and_then(ProviderAgent::new)
                .context("unable to start the Provider/Vault worker with its key file")?,
        ),
        (None, Some(keyring_name)) => Some(
            VaultStore::open_with_keyring(&database, keyring_name)
                .and_then(ProviderAgent::new)
                .context("unable to start the Provider/Vault worker with the OS keyring")?,
        ),
        (None, None) => None,
        (Some(_), Some(_)) => bail!("choose either --vault-key-file or --vault-keyring, not both"),
    };
    let identities = IdentityConfig {
        mode: args.auth_mode,
        single_user_name: args.single_user_name,
        issuer: auth_issuer,
    };
    let repository = RepositoryStore::open(&database)?;
    let dedicated_dav = if let Some(address) = args.webdav_listen {
        let password_file = args.webdav_password_file.as_deref().ok_or_else(|| {
            anyhow::anyhow!("--webdav-password-file is required with --webdav-listen")
        })?;
        let credentials = DavBasicCredentials::from_file(&args.webdav_username, password_file)?;
        let identity = identities.identity(&HeaderMap::new()).map_err(|_| {
            anyhow::anyhow!(
                "the dedicated WebDAV listener currently requires single-user auth mode"
            )
        })?;
        let listener = TcpListener::bind(address)
            .await
            .with_context(|| format!("unable to listen for WebDAV on {address}"))?;
        let local_address = listener
            .local_addr()
            .context("unable to read WebDAV listener address")?;
        Some((
            listener,
            local_address,
            dedicated_webdav_application(DedicatedDavState {
                repository: repository.clone(),
                identity,
                credentials,
            }),
        ))
    } else {
        None
    };
    let state = AppState {
        identities,
        pairing: PairingStore::open(&database)?,
        repository,
        provider_agent,
        trusted_origins: Arc::new(trusted_origins),
    };
    let application = application(&static_dir, index, state);

    let application_url = format!("http://{local_address}/");
    info!(url = %application_url, static_dir = %static_dir.display(), database = %database.display(), "Turnfold is serving");
    println!("Turnfold: {application_url}");
    if let Some((_, address, _)) = &dedicated_dav {
        info!(url = %format!("http://{address}/"), "Turnfold WebDAV is serving");
        println!("WebDAV: http://{address}/");
    }

    if args.open {
        webbrowser::open(&application_url).context("unable to open the default browser")?;
    }

    let shutdown = CancellationToken::new();
    let mut servers = JoinSet::new();
    spawn_server(
        &mut servers,
        "Turnfold",
        listener,
        application,
        shutdown.clone(),
    );
    if let Some((listener, _, application)) = dedicated_dav {
        spawn_server(
            &mut servers,
            "Turnfold WebDAV",
            listener,
            application,
            shutdown.clone(),
        );
    }

    tokio::select! {
        signal = shutdown_signal() => {
            info!("Turnfold is shutting down");
            shutdown.cancel();
            let drained = drain_servers(&mut servers).await;
            signal?;
            drained
        }
        completed = servers.join_next() => {
            let failure = match completed {
                Some(Ok(Ok(name))) => anyhow::anyhow!("{name} listener stopped unexpectedly"),
                Some(Ok(Err(error))) => error,
                Some(Err(error)) => anyhow::anyhow!("Turnfold listener task failed: {error}"),
                None => anyhow::anyhow!("Turnfold has no active listeners"),
            };
            shutdown.cancel();
            let drained = drain_servers(&mut servers).await;
            if let Err(error) = drained {
                return Err(failure.context(format!("another listener also failed: {error:#}")));
            }
            Err(failure)
        }
    }
}

fn spawn_server(
    servers: &mut JoinSet<Result<&'static str>>,
    name: &'static str,
    listener: TcpListener,
    application: Router,
    shutdown: CancellationToken,
) {
    servers.spawn(async move {
        axum::serve(listener, application)
            .with_graceful_shutdown(shutdown.cancelled_owned())
            .await
            .with_context(|| format!("{name} listener failed"))?;
        Ok(name)
    });
}

async fn drain_servers(servers: &mut JoinSet<Result<&'static str>>) -> Result<()> {
    let mut failure = None;
    while let Some(completed) = servers.join_next().await {
        let result = match completed {
            Ok(result) => result.map(|_| ()),
            Err(error) => Err(anyhow::anyhow!("Turnfold listener task failed: {error}")),
        };
        if failure.is_none() {
            failure = result.err();
        }
    }
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(())
}

fn dedicated_webdav_application(state: DedicatedDavState) -> Router {
    Router::new()
        .route("/", any(dedicated_repository_webdav))
        .route("/{*path}", any(dedicated_repository_webdav))
        .with_state(state)
}

fn application(static_dir: &std::path::Path, index: PathBuf, state: AppState) -> Router {
    let static_files = ServeDir::new(static_dir).fallback(ServeFile::new(index));
    let guard_state = state.clone();
    Router::new()
        .route("/api/health", get(health))
        .route("/api/local/v1/info", get(local_service_info))
        .route("/api/local/v1/pairings", post(pairing_start))
        .route("/api/local/v1/pairings/{id}/poll", post(pairing_poll))
        .route(
            "/api/local/v1/grant",
            get(current_browser_grant).delete(revoke_browser_grant),
        )
        .route(
            "/api/local/v1/provider/profiles",
            get(provider_profiles),
        )
        .route(
            "/api/local/v1/provider/profiles/{id}",
            post(save_provider_profile).delete(delete_provider_profile),
        )
        .route(
            "/api/local/v1/vault/credentials",
            get(vault_credentials).post(save_vault_credential),
        )
        .route(
            "/api/local/v1/vault/credentials/{id}",
            axum::routing::delete(delete_vault_credential),
        )
        .route("/api/local/v1/vault/audit", get(vault_audit))
        .route(
            "/api/local/v1/provider/execute",
            post(execute_provider),
        )
        .route("/api/config", get(backend_config))
        .route("/api/sync/fetch", post(repository_fetch))
        .route("/api/sync/push", post(repository_push))
        .route("/api/{*path}", any(api_not_found))
        .route("/dav", any(repository_webdav))
        .route("/dav/{*path}", any(repository_webdav))
        .route(
            "/local/pair/{id}",
            get(pairing_approval).post(pairing_decision),
        )
        .fallback_service(static_files)
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; manifest-src 'self'; worker-src 'self' blob:; connect-src 'self' http: https: ws: wss:",
            ),
        ))
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn(api_cors))
        .layer(middleware::from_fn_with_state(
            guard_state,
            trusted_origin_guard,
        ))
        .with_state(state)
}

fn validate_listener(address: SocketAddr, allow_remote: bool) -> Result<()> {
    if !address.ip().is_loopback() && !allow_remote {
        bail!(
            "refusing non-loopback listener {address}; pass --allow-remote to acknowledge the unsupported exposure"
        );
    }
    Ok(())
}

fn trusted_service_origins(address: SocketAddr, configured: &[String]) -> Result<HashSet<String>> {
    let mut origins = HashSet::new();
    origins.insert(format!("http://{address}"));
    if address.ip().is_loopback() {
        origins.insert(format!("http://localhost:{}", address.port()));
        origins.insert(format!("http://127.0.0.1:{}", address.port()));
        origins.insert(format!("http://[::1]:{}", address.port()));
    }
    for value in configured {
        let origin = normalized_origin(value)
            .filter(|origin| origin == value.trim())
            .ok_or_else(|| {
                anyhow::anyhow!("invalid --public-origin {value}; expected an exact HTTP(S) origin")
            })?;
        origins.insert(origin);
    }
    Ok(origins)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        runtime: "rust",
    })
}

async fn local_service_info(State(state): State<AppState>) -> Json<LocalServiceInfo> {
    let provider_agent = state.provider_agent.is_some();
    Json(LocalServiceInfo {
        name: "turnfold",
        version: env!("CARGO_PKG_VERSION"),
        backend_connection: "explicit",
        capabilities: CapabilityResponse {
            static_assets: true,
            sync: true,
            pairing: true,
            vault: provider_agent,
            provider_proxy: provider_agent,
            webdav: true,
        },
    })
}

async fn backend_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<BackendConfigResponse>, ApiError> {
    let identity = authorize_repository(&state, &headers)?;
    Ok(Json(BackendConfigResponse {
        identity_key: identity.key(),
        profile: identity.profile(),
        capabilities: BackendCapabilities {
            sync: true,
            pairing: true,
        },
    }))
}

async fn repository_fetch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Result<Json<RepositoryFetch>, ApiError> {
    let identity = authorize_repository(&state, &headers)?;
    let repository = state.repository;
    let fetched = tokio::task::spawn_blocking(move || repository.fetch(&identity, &input))
        .await
        .map_err(|error| ApiError::internal(format!("repository fetch task failed: {error}")))?
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(Json(fetched))
}

async fn repository_push(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Result<Json<RepositoryPushResult>, ApiError> {
    let identity = authorize_repository(&state, &headers)?;
    let repository = state.repository;
    let pushed = tokio::task::spawn_blocking(move || repository.push(&identity, input))
        .await
        .map_err(|error| ApiError::internal(format!("repository push task failed: {error}")))?
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(Json(pushed))
}

async fn repository_webdav(State(state): State<AppState>, request: AxumRequest) -> Response {
    let identity = match authorize_browser_scope(&state, request.headers(), REPOSITORY_WEBDAV_SCOPE)
    {
        Ok(identity) => identity,
        Err(error) => return error.into_response(),
    };
    webdav::handle(state.repository, identity, request, "/dav").await
}

async fn dedicated_repository_webdav(
    State(state): State<DedicatedDavState>,
    request: AxumRequest,
) -> Response {
    if request.headers().contains_key(header::ORIGIN) {
        return ApiError::forbidden("Browser WebDAV requests must use the scoped /dav front door")
            .into_response();
    }
    if !state.credentials.authorizes(request.headers()) {
        let mut response =
            ApiError::unauthorized("WebDAV credentials are required").into_response();
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Basic realm=\"Turnfold WebDAV\", charset=\"UTF-8\""),
        );
        return response;
    }
    webdav::handle(state.repository, state.identity, request, "").await
}

impl DavBasicCredentials {
    fn from_file(username: &str, password_file: &std::path::Path) -> Result<Self> {
        let username = username.trim();
        if username.is_empty() || username.contains(':') || username.chars().count() > 120 {
            bail!("--webdav-username must be 1-120 characters and must not contain ':'");
        }
        let password = fs::read_to_string(password_file).with_context(|| {
            format!(
                "unable to read WebDAV password file {}",
                password_file.display()
            )
        })?;
        let password = password.trim_end_matches(['\r', '\n']);
        if password.chars().count() < 12 || password.contains(['\r', '\n']) {
            bail!("WebDAV password file must contain one password of at least 12 characters");
        }
        Ok(Self {
            digest: webdav_credential_digest(username, password),
        })
    }

    fn authorizes(&self, headers: &HeaderMap) -> bool {
        let Some(value) = header_text(headers, header::AUTHORIZATION) else {
            return false;
        };
        let Some((scheme, encoded)) = value.split_once(' ') else {
            return false;
        };
        if !scheme.eq_ignore_ascii_case("basic") {
            return false;
        }
        let Ok(decoded) = STANDARD.decode(encoded.trim()) else {
            return false;
        };
        let Ok(decoded) = String::from_utf8(decoded) else {
            return false;
        };
        let Some((username, password)) = decoded.split_once(':') else {
            return false;
        };
        constant_time_equal(&self.digest, &webdav_credential_digest(username, password))
    }
}

fn webdav_credential_digest(username: &str, password: &str) -> [u8; 32] {
    Sha256::digest(format!("{username}\0{password}").as_bytes()).into()
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

async fn provider_profiles(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let identity = authorize_browser_scope(&state, &headers, VAULT_MANAGE_SCOPE)?;
    let agent = require_provider_agent(&state)?;
    let profiles = tokio::task::spawn_blocking(move || agent.vault().list_profiles(&identity))
        .await
        .map_err(|error| ApiError::internal(format!("Provider profile task failed: {error}")))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(serde_json::json!({"profiles": profiles})))
}

async fn save_provider_profile(
    Path(id): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ProviderProfileInput>,
) -> Result<Json<Value>, ApiError> {
    let identity = authorize_browser_scope(&state, &headers, VAULT_MANAGE_SCOPE)?;
    let agent = require_provider_agent(&state)?;
    let profile =
        tokio::task::spawn_blocking(move || agent.vault().save_profile(&identity, &id, input))
            .await
            .map_err(|error| ApiError::internal(format!("Provider profile task failed: {error}")))?
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(Json(serde_json::json!({"profile": profile})))
}

async fn delete_provider_profile(
    Path(id): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let identity = authorize_browser_scope(&state, &headers, VAULT_MANAGE_SCOPE)?;
    let agent = require_provider_agent(&state)?;
    let deleted = tokio::task::spawn_blocking(move || agent.vault().delete_profile(&identity, &id))
        .await
        .map_err(|error| ApiError::internal(format!("Provider profile task failed: {error}")))?
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(Json(serde_json::json!({"deleted": deleted})))
}

async fn vault_credentials(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let identity = authorize_browser_scope(&state, &headers, VAULT_MANAGE_SCOPE)?;
    let agent = require_provider_agent(&state)?;
    let credentials =
        tokio::task::spawn_blocking(move || agent.vault().list_credentials(&identity))
            .await
            .map_err(|error| ApiError::internal(format!("Vault list task failed: {error}")))?
            .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(serde_json::json!({"credentials": credentials})))
}

async fn save_vault_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CredentialInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let identity = authorize_browser_scope(&state, &headers, VAULT_MANAGE_SCOPE)?;
    let agent = require_provider_agent(&state)?;
    let credential =
        tokio::task::spawn_blocking(move || agent.vault().save_credential(&identity, input))
            .await
            .map_err(|error| ApiError::internal(format!("Vault save task failed: {error}")))?
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({"credential": credential})),
    ))
}

async fn delete_vault_credential(
    Path(id): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let identity = authorize_browser_scope(&state, &headers, VAULT_MANAGE_SCOPE)?;
    let agent = require_provider_agent(&state)?;
    let deleted =
        tokio::task::spawn_blocking(move || agent.vault().delete_credential(&identity, &id))
            .await
            .map_err(|error| ApiError::internal(format!("Vault delete task failed: {error}")))?
            .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(serde_json::json!({"deleted": deleted})))
}

async fn vault_audit(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let identity = authorize_browser_scope(&state, &headers, VAULT_MANAGE_SCOPE)?;
    let agent = require_provider_agent(&state)?;
    let entries = tokio::task::spawn_blocking(move || agent.vault().audit_entries(&identity))
        .await
        .map_err(|error| ApiError::internal(format!("Vault audit task failed: {error}")))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(serde_json::json!({"entries": entries})))
}

async fn execute_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ProviderExecuteRequest>,
) -> Result<Response, ApiError> {
    let identity = authorize_browser_scope(&state, &headers, PROVIDER_EXECUTE_SCOPE)?;
    let agent = require_provider_agent(&state)?;
    let upstream = agent
        .execute(&identity, input)
        .await
        .map_err(|error| ApiError::bad_gateway(error.to_string()))?;
    let status = StatusCode::from_u16(upstream.status().as_u16())
        .map_err(|error| ApiError::internal(format!("invalid Provider status: {error}")))?;
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let cache_control = upstream.headers().get(header::CACHE_CONTROL).cloned();
    let stream = upstream.bytes_stream().map_err(std::io::Error::other);
    let mut response = Response::builder()
        .status(status)
        .body(Body::from_stream(stream))
        .map_err(|error| {
            ApiError::internal(format!("unable to stream Provider response: {error}"))
        })?;
    if let Some(value) = content_type {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    if let Some(value) = cache_control {
        response.headers_mut().insert(header::CACHE_CONTROL, value);
    }
    Ok(response)
}

async fn pairing_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<PairingStartRequest>,
) -> Result<(StatusCode, Json<PairingStartResponse>), ApiError> {
    let origin = browser_origin(&headers)?
        .ok_or_else(|| ApiError::bad_request("Browser Origin is required for pairing"))?;
    let identity = request_identity(&state, &headers)?;
    let started = state
        .pairing
        .start(
            &identity,
            &origin.value,
            &input.client_name,
            &input.requested_scopes,
        )
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok((
        StatusCode::CREATED,
        Json(PairingStartResponse {
            pairing_id: started.id,
            poll_token: started.poll_token,
            expires_at: started.expires_at,
            poll_interval_ms: started.poll_interval_ms,
        }),
    ))
}

async fn pairing_poll(
    Path(id): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<PairingPollRequest>,
) -> Result<Response, ApiError> {
    let origin = browser_origin(&headers)?
        .ok_or_else(|| ApiError::bad_request("Browser Origin is required for pairing"))?;
    let identity = request_identity(&state, &headers)?;
    let outcome = state
        .pairing
        .poll(&identity, &id, &origin.value, &input.poll_token)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::unauthorized("Pairing request is unavailable"))?;
    Ok(match outcome {
        PairingPoll::Pending { expires_at } => (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({"status": "pending", "expiresAt": expires_at})),
        )
            .into_response(),
        PairingPoll::Denied => Json(serde_json::json!({"status": "denied"})).into_response(),
        PairingPoll::Expired => (
            StatusCode::GONE,
            Json(serde_json::json!({"status": "expired"})),
        )
            .into_response(),
        PairingPoll::Approved { grant, token } => Json(serde_json::json!({
            "status": "approved",
            "token": token,
            "grant": grant,
        }))
        .into_response(),
    })
}

async fn current_browser_grant(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<BrowserGrant>, ApiError> {
    let (_, grant) = authorize_browser_grant(&state, &headers)?;
    Ok(Json(grant))
}

async fn revoke_browser_grant(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let (authorization, _) = authorize_browser_grant(&state, &headers)?;
    let revoked = state
        .pairing
        .revoke(
            &authorization.identity,
            &authorization.origin,
            &authorization.token,
        )
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(serde_json::json!({"revoked": revoked})))
}

async fn pairing_approval(
    Path(id): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let identity = match request_identity(&state, &headers) {
        Ok(identity) => identity,
        Err(error) => {
            return approval_message(error.status, "Authentication required", &error.message);
        }
    };
    let approval = match state.pairing.prepare_approval(&identity, &id) {
        Ok(Some(approval)) => approval,
        Ok(None) => {
            return approval_message(
                StatusCode::NOT_FOUND,
                "Pairing unavailable",
                "This pairing request is missing, expired, or already decided.",
            );
        }
        Err(error) => {
            return approval_message(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Pairing unavailable",
                &error.to_string(),
            );
        }
    };
    let scope_items = approval
        .scopes
        .iter()
        .map(|scope| {
            let label = match scope.as_str() {
                REPOSITORY_SYNC_SCOPE => "Synchronize conversation objects and refs",
                REPOSITORY_WEBDAV_SCOPE => {
                    "Read and write the repository through the scoped WebDAV front door"
                }
                PROVIDER_EXECUTE_SCOPE => {
                    "Execute requests using registered Providers and saved credentials"
                }
                VAULT_MANAGE_SCOPE => {
                    "Create, replace, and delete Provider profiles and Vault credentials"
                }
                _ => scope,
            };
            format!("<li>{}</li>", html_escape(label))
        })
        .collect::<String>();
    let body = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair with Turnfold</title><style>{}</style></head><body><main><header><strong>Turnfold</strong><span>Local service pairing</span></header><h1>Allow the requested access?</h1><dl><dt>Requesting page</dt><dd><code>{}</code></dd><dt>Client</dt><dd>{}</dd><dt>Expires</dt><dd>{}</dd></dl><h2>Requested access</h2><ul>{}</ul><form method="post"><button class="deny" type="submit" name="action" value="deny">Deny</button><button class="approve" type="submit" name="action" value="approve">Approve</button></form></main></body></html>"#,
        approval_styles(),
        html_escape(&approval.origin),
        html_escape(&approval.client_name),
        html_escape(&approval.expires_at),
        scope_items,
    );
    let cookie_name = approval_cookie_name(&id);
    let secure = if request_protocol(&headers) == "https" {
        "; Secure"
    } else {
        ""
    };
    let cookie = format!(
        "{cookie_name}={}; Path=/; Max-Age=300; HttpOnly; SameSite=Strict{secure}",
        approval.approval_nonce
    );
    let mut response = Html(body).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

async fn pairing_decision(
    Path(id): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(input): Form<PairingDecisionForm>,
) -> Response {
    let origin = match browser_origin(&headers) {
        Ok(Some(origin)) if origin.same_origin => origin,
        _ => {
            return approval_message(
                StatusCode::FORBIDDEN,
                "Request rejected",
                "Pairing decisions must be submitted from the Backend approval page.",
            );
        }
    };
    let _ = origin;
    let identity = match request_identity(&state, &headers) {
        Ok(identity) => identity,
        Err(error) => {
            return approval_message(error.status, "Authentication required", &error.message);
        }
    };
    let cookie_name = approval_cookie_name(&id);
    let Some(nonce) = request_cookie(&headers, &cookie_name) else {
        return approval_message(
            StatusCode::FORBIDDEN,
            "Request rejected",
            "The approval session is missing or expired.",
        );
    };
    let approved = match input.action.as_str() {
        "approve" => true,
        "deny" => false,
        _ => {
            return approval_message(
                StatusCode::BAD_REQUEST,
                "Request rejected",
                "The pairing decision is invalid.",
            );
        }
    };
    match state.pairing.decide(&identity, &id, &nonce, approved) {
        Ok(true) => {
            let title = if approved {
                "Pairing approved"
            } else {
                "Pairing denied"
            };
            let detail = if approved {
                "Return to the requesting Turnfold page. This window can now be closed."
            } else {
                "No browser grant was issued. This window can now be closed."
            };
            let mut response = approval_message(StatusCode::OK, title, detail);
            let expired = format!("{cookie_name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict");
            if let Ok(value) = HeaderValue::from_str(&expired) {
                response.headers_mut().insert(header::SET_COOKIE, value);
            }
            response
        }
        Ok(false) => approval_message(
            StatusCode::CONFLICT,
            "Pairing unavailable",
            "This pairing request is missing, expired, or already decided.",
        ),
        Err(error) => approval_message(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Pairing unavailable",
            &error.to_string(),
        ),
    }
}

async fn api_not_found() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({"error": "API capability is not implemented"})),
    )
}

#[derive(Debug)]
struct BrowserOrigin {
    value: String,
    same_origin: bool,
}

struct BrowserAuthorization {
    identity: ChatIdentity,
    origin: String,
    token: String,
}

fn request_identity(state: &AppState, headers: &HeaderMap) -> Result<ChatIdentity, ApiError> {
    state
        .identities
        .identity(headers)
        .map_err(|error| ApiError::unauthorized(error.to_string()))
}

fn authorize_repository(state: &AppState, headers: &HeaderMap) -> Result<ChatIdentity, ApiError> {
    let identity = request_identity(state, headers)?;
    let Some(origin) = browser_origin(headers)? else {
        return Ok(identity);
    };
    if origin.same_origin {
        return Ok(identity);
    }
    let token = bearer_token(headers).ok_or_else(ApiError::pairing_required)?;
    let allowed = state
        .pairing
        .authorize(&identity, &origin.value, token, REPOSITORY_SYNC_SCOPE)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .is_some();
    if !allowed {
        return Err(ApiError::pairing_required());
    }
    Ok(identity)
}

fn authorize_browser_grant(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(BrowserAuthorization, BrowserGrant), ApiError> {
    let identity = request_identity(state, headers)?;
    let origin = scoped_browser_origin(headers)?;
    let token = bearer_token(headers)
        .ok_or_else(|| ApiError::unauthorized("Browser grant token is required"))?;
    let grant = state
        .pairing
        .authorize_any(&identity, &origin, token)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::unauthorized("Browser grant is invalid or expired"))?;
    Ok((
        BrowserAuthorization {
            identity,
            origin,
            token: token.to_owned(),
        },
        grant,
    ))
}

fn authorize_browser_scope(
    state: &AppState,
    headers: &HeaderMap,
    required_scope: &str,
) -> Result<ChatIdentity, ApiError> {
    let identity = request_identity(state, headers)?;
    let origin = scoped_browser_origin(headers)?;
    let token = bearer_token(headers).ok_or_else(ApiError::pairing_required)?;
    let allowed = state
        .pairing
        .authorize(&identity, &origin, token, required_scope)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .is_some();
    if !allowed {
        return Err(ApiError::pairing_required());
    }
    Ok(identity)
}

fn scoped_browser_origin(headers: &HeaderMap) -> Result<String, ApiError> {
    if let Some(origin) = browser_origin(headers)? {
        return Ok(origin.value);
    }
    if !header_text(headers, "sec-fetch-site")
        .is_some_and(|site| site.eq_ignore_ascii_case("same-origin"))
    {
        return Err(ApiError::bad_request("Browser Origin is required"));
    }
    request_service_origin(headers)
}

fn require_provider_agent(state: &AppState) -> Result<ProviderAgent, ApiError> {
    state.provider_agent.clone().ok_or_else(|| {
        ApiError::service_unavailable(
            "Provider/Vault worker is disabled; start turnfold with --vault-keyring or --vault-key-file",
        )
    })
}

fn browser_origin(headers: &HeaderMap) -> Result<Option<BrowserOrigin>, ApiError> {
    let Some(value) = header_text(headers, header::ORIGIN) else {
        if header_text(headers, "sec-fetch-site")
            .is_some_and(|site| site.eq_ignore_ascii_case("cross-site"))
        {
            return Err(ApiError::forbidden(
                "Cross-site browser requests must include Origin",
            ));
        }
        return Ok(None);
    };
    let origin = normalized_origin(value)
        .filter(|normalized| normalized == value)
        .ok_or_else(|| ApiError::forbidden("Request Origin is invalid"))?;
    let request_origin = request_service_origin(headers)?;
    Ok(Some(BrowserOrigin {
        same_origin: origin == request_origin,
        value: origin,
    }))
}

fn request_service_origin(headers: &HeaderMap) -> Result<String, ApiError> {
    let host = header_text(headers, header::HOST)
        .ok_or_else(|| ApiError::forbidden("Request Host is required"))?;
    normalized_origin(&format!("{}://{host}", request_protocol(headers)))
        .ok_or_else(|| ApiError::forbidden("Request Host is invalid"))
}

fn request_protocol(headers: &HeaderMap) -> &str {
    header_text(headers, "x-forwarded-proto")
        .and_then(|value| value.split(',').next().map(str::trim))
        .filter(|value| matches!(*value, "http" | "https"))
        .unwrap_or("http")
}

fn normalized_origin(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = header_text(headers, header::AUTHORIZATION)?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") || token.trim().is_empty() {
        return None;
    }
    Some(token.trim())
}

async fn trusted_origin_guard(
    State(state): State<AppState>,
    request: AxumRequest,
    next: Next,
) -> Response {
    let Some(host) = header_text(request.headers(), header::HOST) else {
        return ApiError::forbidden("Request Host is required").into_response();
    };
    let Some(origin) =
        normalized_origin(&format!("{}://{host}", request_protocol(request.headers())))
    else {
        return ApiError::forbidden("Request Host is invalid").into_response();
    };
    if !state.trusted_origins.contains(&origin) {
        return ApiError::forbidden("Request Host is not configured for this Backend")
            .into_response();
    }
    next.run(request).await
}

async fn api_cors(request: AxumRequest, next: Next) -> Response {
    if !request.uri().path().starts_with("/api/")
        && request.uri().path() != "/dav"
        && !request.uri().path().starts_with("/dav/")
    {
        return next.run(request).await;
    }
    let origin = match header_text(request.headers(), header::ORIGIN) {
        Some(value) => match normalized_origin(value).filter(|normalized| normalized == value) {
            Some(origin) => Some(origin),
            None => return ApiError::forbidden("Request Origin is invalid").into_response(),
        },
        None => None,
    };
    if request.method() == Method::OPTIONS
        && request
            .headers()
            .contains_key("access-control-request-method")
    {
        return cors_preflight(request.headers(), origin.as_deref());
    }
    let mut response = next.run(request).await;
    apply_cors_headers(response.headers_mut(), origin.as_deref());
    response
}

fn cors_preflight(headers: &HeaderMap, origin: Option<&str>) -> Response {
    let Some(origin) = origin else {
        return ApiError::forbidden("Browser Origin is required for CORS").into_response();
    };
    let method = header_text(headers, "access-control-request-method").unwrap_or_default();
    if !matches!(
        method,
        "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "PROPFIND" | "MKCOL"
    ) {
        return ApiError::forbidden("CORS method is not allowed").into_response();
    }
    let requested_headers = header_text(headers, "access-control-request-headers")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty());
    if requested_headers.clone().any(|name| {
        !matches!(
            name.to_ascii_lowercase().as_str(),
            "accept" | "authorization" | "content-type" | "depth" | "if-match" | "if-none-match"
        )
    }) {
        return ApiError::forbidden("CORS header is not allowed").into_response();
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    apply_cors_headers(response.headers_mut(), Some(origin));
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, HEAD, POST, PUT, DELETE, PROPFIND, MKCOL, OPTIONS"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(
            "Accept, Authorization, Content-Type, Depth, If-Match, If-None-Match",
        ),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    if header_text(headers, "access-control-request-private-network")
        .is_some_and(|value| value.eq_ignore_ascii_case("true"))
    {
        response.headers_mut().insert(
            "access-control-allow-private-network",
            HeaderValue::from_static("true"),
        );
    }
    append_vary(
        response.headers_mut(),
        &[
            "Origin",
            "Access-Control-Request-Method",
            "Access-Control-Request-Headers",
            "Access-Control-Request-Private-Network",
        ],
    );
    response
}

fn apply_cors_headers(headers: &mut HeaderMap, origin: Option<&str>) {
    append_vary(headers, &["Origin"]);
    let Some(origin) = origin else {
        return;
    };
    if let Ok(value) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("DAV, ETag"),
    );
}

fn append_vary(headers: &mut HeaderMap, values: &[&str]) {
    let current = headers
        .get(header::VARY)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let mut names = current
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for value in values {
        if !names.iter().any(|name| name.eq_ignore_ascii_case(value)) {
            names.push((*value).to_owned());
        }
    }
    if let Ok(value) = HeaderValue::from_str(&names.join(", ")) {
        headers.insert(header::VARY, value);
    }
}

fn approval_cookie_name(id: &str) -> String {
    format!("turnfold_pair_{}", id.replace('-', ""))
}

fn request_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    header_text(headers, header::COOKIE)?
        .split(';')
        .filter_map(|entry| entry.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then(|| value.to_owned()))
}

fn approval_styles() -> &'static str {
    "*{box-sizing:border-box}body{margin:0;background:#f7f7f5;color:#171717;font:15px/1.5 system-ui,sans-serif}main{width:min(640px,calc(100% - 32px));margin:0 auto;padding:48px 0}header{display:flex;justify-content:space-between;border-bottom:1px solid #d8d8d2;padding-bottom:14px;color:#595957}h1{margin:36px 0 24px;font-size:28px;letter-spacing:0}h2{margin:28px 0 10px;font-size:14px}dl{display:grid;grid-template-columns:130px minmax(0,1fr);gap:10px 16px;margin:0}dt{color:#696965}dd{min-width:0;margin:0;overflow-wrap:anywhere}code{font:13px ui-monospace,monospace}ul{margin:0;padding-left:20px}form{display:flex;justify-content:flex-end;gap:10px;margin-top:36px}button{border:1px solid #c9c9c3;border-radius:6px;padding:10px 16px;background:#fff;color:#171717;font:inherit;cursor:pointer}.approve{border-color:#176b45;background:#176b45;color:#fff}.deny{color:#8c2c2c}@media(max-width:520px){main{padding-top:28px}dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:10px}form{display:grid;grid-template-columns:1fr 1fr}button{width:100%}}"
}

fn approval_message(status: StatusCode, title: &str, detail: &str) -> Response {
    let body = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{}</title><style>{}</style></head><body><main><header><strong>Turnfold</strong><span>Backend pairing</span></header><h1>{}</h1><p>{}</p></main></body></html>"#,
        html_escape(title),
        approval_styles(),
        html_escape(title),
        html_escape(detail),
    );
    let mut response = (status, Html(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn header_text(headers: &HeaderMap, name: impl axum::http::header::AsHeaderName) -> Option<&str> {
    headers.get(name)?.to_str().ok().map(str::trim)
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: None,
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: None,
            message: message.into(),
        }
    }

    fn pairing_required() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: Some("pairing_required"),
            message: "This browser Origin must be paired for the requested scope".to_owned(),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: None,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: None,
            message: message.into(),
        }
    }

    fn bad_gateway(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: None,
            message: message.into(),
        }
    }

    fn service_unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: Some("capability_disabled"),
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut payload = serde_json::json!({"error": self.message});
        if let Some(code) = self.code {
            payload["code"] = Value::String(code.to_owned());
        }
        (self.status, Json(payload)).into_response()
    }
}

#[cfg(unix)]
async fn shutdown_signal() -> Result<()> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut terminate =
        signal(SignalKind::terminate()).context("unable to register the SIGTERM handler")?;
    tokio::select! {
        result = tokio::signal::ctrl_c() => {
            result.context("unable to register the Ctrl+C handler")?;
        }
        _ = terminate.recv() => {}
    }
    Ok(())
}

#[cfg(not(unix))]
async fn shutdown_signal() -> Result<()> {
    tokio::signal::ctrl_c()
        .await
        .context("unable to register the Ctrl+C handler")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::{Method, Request},
    };
    use serde_json::{Value, json};
    use std::{
        fs,
        net::{IpAddr, Ipv4Addr},
    };
    use tempfile::TempDir;
    use tower::ServiceExt;

    #[test]
    fn cli_rejects_two_vault_key_sources() {
        let parsed = Cli::try_parse_from([
            "turnfold",
            "serve",
            "--vault-key-file",
            "vault.key",
            "--vault-keyring",
            "default",
        ]);
        assert!(parsed.is_err());
    }

    #[test]
    fn cli_accepts_the_explicit_vault_key_migration() {
        let parsed = Cli::try_parse_from([
            "turnfold",
            "vault",
            "migrate-key",
            "--database",
            "turnfold.db",
            "--from-key-file",
            "vault.key",
            "--to-keyring",
            "default",
        ])
        .unwrap();
        let Command::Vault(VaultArgs {
            command: VaultCommand::MigrateKey(args),
        }) = parsed.command
        else {
            panic!("unexpected command")
        };
        assert_eq!(args.to_keyring, "default");
    }

    #[tokio::test]
    async fn cancellation_stops_every_listener_task() {
        let shutdown = CancellationToken::new();
        let mut servers = JoinSet::new();
        for name in ["application test", "WebDAV test"] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            spawn_server(
                &mut servers,
                name,
                listener,
                Router::new(),
                shutdown.clone(),
            );
        }
        shutdown.cancel();
        drain_servers(&mut servers).await.unwrap();
        assert!(servers.is_empty());
    }

    #[test]
    fn loopback_is_allowed_by_default() {
        let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3000);
        assert!(validate_listener(address, false).is_ok());
    }

    #[test]
    fn remote_listener_requires_an_explicit_override() {
        let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 3000);
        assert!(validate_listener(address, false).is_err());
        assert!(validate_listener(address, true).is_ok());
    }

    #[test]
    fn loopback_origins_are_explicitly_bounded() {
        let address: SocketAddr = "127.0.0.1:43113".parse().unwrap();
        let origins = trusted_service_origins(address, &[]).unwrap();
        assert!(origins.contains("http://127.0.0.1:43113"));
        assert!(origins.contains("http://localhost:43113"));
        assert!(!origins.contains("http://attacker.example"));
        assert!(
            trusted_service_origins(address, &["https://turnfold.example.test".to_owned()])
                .unwrap()
                .contains("https://turnfold.example.test")
        );
    }

    fn test_application(mode: AuthMode) -> (Router, TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let static_dir = directory.path().join("dist");
        fs::create_dir(&static_dir).unwrap();
        let index = static_dir.join("index.html");
        fs::write(&index, "<!doctype html><title>Turnfold test</title>").unwrap();
        let state = AppState {
            identities: IdentityConfig {
                mode,
                single_user_name: "local".to_owned(),
                issuer: "https://issuer.example".to_owned(),
            },
            pairing: PairingStore::open(&directory.path().join("turnfold.db")).unwrap(),
            repository: RepositoryStore::open(&directory.path().join("turnfold.db")).unwrap(),
            provider_agent: None,
            trusted_origins: Arc::new(HashSet::from(["http://turnfold.test".to_owned()])),
        };
        (application(&static_dir, index, state), directory)
    }

    fn test_application_with_provider_agent(origin: &str) -> (Router, TempDir, String) {
        let directory = tempfile::tempdir().unwrap();
        let static_dir = directory.path().join("dist");
        fs::create_dir(&static_dir).unwrap();
        let index = static_dir.join("index.html");
        fs::write(&index, "<!doctype html><title>Turnfold test</title>").unwrap();
        let database = directory.path().join("turnfold.db");
        let pairing = PairingStore::open(&database).unwrap();
        let identities = IdentityConfig {
            mode: AuthMode::SingleUser,
            single_user_name: "local".to_owned(),
            issuer: "ignored".to_owned(),
        };
        let identity = identities.identity(&HeaderMap::new()).unwrap();
        let started = pairing
            .start(
                &identity,
                origin,
                "Provider Agent test",
                &[
                    PROVIDER_EXECUTE_SCOPE.to_owned(),
                    VAULT_MANAGE_SCOPE.to_owned(),
                ],
            )
            .unwrap();
        let approval = pairing
            .prepare_approval(&identity, &started.id)
            .unwrap()
            .unwrap();
        assert!(
            pairing
                .decide(&identity, &started.id, &approval.approval_nonce, true)
                .unwrap()
        );
        let token = match pairing
            .poll(&identity, &started.id, origin, &started.poll_token)
            .unwrap()
            .unwrap()
        {
            PairingPoll::Approved { token, .. } => token,
            outcome => panic!("unexpected pairing outcome: {outcome:?}"),
        };
        let vault = VaultStore::open(&database, &directory.path().join("vault.key")).unwrap();
        let state = AppState {
            identities,
            pairing,
            repository: RepositoryStore::open(&database).unwrap(),
            provider_agent: Some(ProviderAgent::new(vault).unwrap()),
            trusted_origins: Arc::new(HashSet::from(["http://turnfold.test".to_owned()])),
        };
        (application(&static_dir, index, state), directory, token)
    }

    fn test_application_with_scope(origin: &str, scope: &str) -> (Router, TempDir, String) {
        let directory = tempfile::tempdir().unwrap();
        let static_dir = directory.path().join("dist");
        fs::create_dir(&static_dir).unwrap();
        let index = static_dir.join("index.html");
        fs::write(&index, "<!doctype html><title>Turnfold test</title>").unwrap();
        let database = directory.path().join("turnfold.db");
        let pairing = PairingStore::open(&database).unwrap();
        let identities = IdentityConfig {
            mode: AuthMode::SingleUser,
            single_user_name: "local".to_owned(),
            issuer: "ignored".to_owned(),
        };
        let identity = identities.identity(&HeaderMap::new()).unwrap();
        let started = pairing
            .start(&identity, origin, "Repository test", &[scope.to_owned()])
            .unwrap();
        let approval = pairing
            .prepare_approval(&identity, &started.id)
            .unwrap()
            .unwrap();
        pairing
            .decide(&identity, &started.id, &approval.approval_nonce, true)
            .unwrap();
        let token = match pairing
            .poll(&identity, &started.id, origin, &started.poll_token)
            .unwrap()
            .unwrap()
        {
            PairingPoll::Approved { token, .. } => token,
            outcome => panic!("unexpected pairing outcome: {outcome:?}"),
        };
        let state = AppState {
            identities,
            pairing,
            repository: RepositoryStore::open(&database).unwrap(),
            provider_agent: None,
            trusted_origins: Arc::new(HashSet::from(["http://turnfold.test".to_owned()])),
        };
        (application(&static_dir, index, state), directory, token)
    }

    async fn response_json(response: Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
    }

    fn sync_request(path: &str, body: Value, origin: &str) -> Request<Body> {
        Request::builder()
            .method(Method::POST)
            .uri(path)
            .header(header::HOST, "turnfold.test")
            .header(header::ORIGIN, origin)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap()
    }

    fn repository_push() -> Value {
        json!({
            "repositoryId": "local:test-client",
            "objects": [{
                "id": "sha256:e78a7964f25f6bf9782a6b7f456ff86954dc8d779b9a7d494e83fd316010dcc2",
                "parentMessageId": null,
                "role": "user",
                "parts": [{"type": "text", "text": "hello"}],
                "origin": {"type": "user"},
                "completion": {"status": "complete"},
                "createdAt": "2026-01-01T00:00:00.000Z",
                "completedAt": "2026-01-01T00:00:00.000Z"
            }],
            "refs": [{
                "conversationId": "conversation-1",
                "expectedHeadMessageId": null,
                "expectedHeadVersion": 0,
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

    #[tokio::test]
    async fn complete_router_exposes_explicit_repository_sync() {
        let (app, _directory) = test_application(AuthMode::SingleUser);

        let info = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/local/v1/info")
                    .header(header::HOST, "turnfold.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(info.status(), StatusCode::OK);
        let info = response_json(info).await;
        assert_eq!(info["backendConnection"], "explicit");
        assert_eq!(info["capabilities"]["sync"], true);
        assert_eq!(info["capabilities"]["pairing"], true);
        assert_eq!(info["capabilities"]["vault"], false);

        let config = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .header(header::HOST, "turnfold.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(config.status(), StatusCode::OK);
        let config = response_json(config).await;
        assert_eq!(config["identityKey"], "8daac02ed9a886768394ae58c97a63b9");
        assert_eq!(config["capabilities"]["sync"], true);

        let pushed = app
            .clone()
            .oneshot(sync_request(
                "/api/sync/push",
                repository_push(),
                "http://turnfold.test",
            ))
            .await
            .unwrap();
        assert_eq!(pushed.status(), StatusCode::OK);
        let pushed = response_json(pushed).await;
        assert_eq!(pushed["insertedObjects"], 1);
        assert_eq!(pushed["refs"][0]["status"], "ok");

        let fetched = app
            .clone()
            .oneshot(sync_request(
                "/api/sync/fetch",
                json!({"haveObjectIds": []}),
                "http://turnfold.test",
            ))
            .await
            .unwrap();
        assert_eq!(fetched.status(), StatusCode::OK);
        let fetched = response_json(fetched).await;
        assert_eq!(fetched["refs"].as_array().unwrap().len(), 1);
        assert_eq!(fetched["objects"].as_array().unwrap().len(), 1);

        let hostile = app
            .clone()
            .oneshot(sync_request(
                "/api/sync/fetch",
                json!({"haveObjectIds": []}),
                "https://hostile.example",
            ))
            .await
            .unwrap();
        assert_eq!(hostile.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response_json(hostile).await["code"],
            Value::String("pairing_required".to_owned())
        );

        let rebound = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .header(header::HOST, "attacker.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rebound.status(), StatusCode::FORBIDDEN);

        let cross_site = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/sync/fetch")
                    .header(header::HOST, "turnfold.test")
                    .header("sec-fetch-site", "cross-site")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"haveObjectIds":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cross_site.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn webdav_uses_an_independent_grant_and_the_canonical_repository() {
        let browser_origin = "https://app.example.test";
        let (app, _directory, webdav_token) =
            test_application_with_scope(browser_origin, REPOSITORY_WEBDAV_SCOPE);

        let same_origin_without_grant = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/dav/.turnfold-repository.json")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, "http://turnfold.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(same_origin_without_grant.status(), StatusCode::UNAUTHORIZED);

        let descriptor = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/dav/.turnfold-repository.json")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, browser_origin)
                    .header(header::AUTHORIZATION, format!("Bearer {webdav_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(descriptor.status(), StatusCode::OK);
        assert!(descriptor.headers().contains_key(header::ETAG));

        let object_id = repository_push()["objects"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let object = repository_push()["objects"][0].clone();
        let object_put = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri(format!("/dav/objects/{}.json", &object_id[7..]))
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, browser_origin)
                    .header(header::AUTHORIZATION, format!("Bearer {webdav_token}"))
                    .header(header::IF_NONE_MATCH, "*")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "type": "turnfold-message-object",
                            "version": 1,
                            "repositoryId": "local:test-client",
                            "object": object,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(object_put.status(), StatusCode::CREATED);

        let ref_value = json!({
            "id": "conversation-1",
            "name": "First conversation",
            "headMessageId": object_id,
            "providerId": "openai",
            "model": "gpt-test",
            "generationSettings": {"reasoning": "auto", "showReasoningSummary": false, "temperature": null, "maxOutputTokens": null},
            "headVersion": 1,
            "metadataVersion": 1,
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        });
        let ref_put = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/dav/refs/Y29udmVyc2F0aW9uLTE.json")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, browser_origin)
                    .header(
                        header::AUTHORIZATION,
                        format!("Bearer {webdav_token}"),
                    )
                    .header(header::IF_NONE_MATCH, "*")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"type": "turnfold-conversation-ref", "version": 1, "ref": ref_value})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ref_put.status(), StatusCode::CREATED);

        let stale_ref = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/dav/refs/Y29udmVyc2F0aW9uLTE.json")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, browser_origin)
                    .header(
                        header::AUTHORIZATION,
                        format!("Bearer {webdav_token}"),
                    )
                    .header(header::IF_MATCH, "\"stale\"")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"type": "turnfold-conversation-ref", "version": 1, "ref": ref_value})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale_ref.status(), StatusCode::PRECONDITION_FAILED);

        let listed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::from_bytes(b"PROPFIND").unwrap())
                    .uri("/dav/objects/")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, browser_origin)
                    .header(header::AUTHORIZATION, format!("Bearer {webdav_token}"))
                    .header("depth", "1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::MULTI_STATUS);
        let listed_body = to_bytes(listed.into_body(), 1024 * 1024).await.unwrap();
        assert!(String::from_utf8_lossy(&listed_body).contains(&object_id[7..]));

        let fetched = app
            .oneshot(sync_request(
                "/api/sync/fetch",
                json!({"haveObjectIds": []}),
                "http://turnfold.test",
            ))
            .await
            .unwrap();
        assert_eq!(fetched.status(), StatusCode::OK);
        let fetched = response_json(fetched).await;
        assert_eq!(fetched["refs"].as_array().unwrap().len(), 1);
        assert_eq!(
            fetched["objectRepositoryIds"][&object_id],
            "local:test-client"
        );
    }

    #[tokio::test]
    async fn dedicated_webdav_listener_requires_basic_auth_and_rejects_browsers() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("turnfold.db");
        let password_file = directory.path().join("webdav.password");
        fs::write(&password_file, "correct horse battery staple\n").unwrap();
        let identities = IdentityConfig {
            mode: AuthMode::SingleUser,
            single_user_name: "local".to_owned(),
            issuer: "ignored".to_owned(),
        };
        let app = dedicated_webdav_application(DedicatedDavState {
            repository: RepositoryStore::open(&database).unwrap(),
            identity: identities.identity(&HeaderMap::new()).unwrap(),
            credentials: DavBasicCredentials::from_file("turnfold", &password_file).unwrap(),
        });

        let missing = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/.turnfold-repository.json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            missing.headers()[header::WWW_AUTHENTICATE],
            "Basic realm=\"Turnfold WebDAV\", charset=\"UTF-8\""
        );

        let invalid = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/.turnfold-repository.json")
                    .header(
                        header::AUTHORIZATION,
                        format!("Basic {}", STANDARD.encode("turnfold:wrong password")),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::UNAUTHORIZED);

        let authorization = format!(
            "Basic {}",
            STANDARD.encode("turnfold:correct horse battery staple")
        );
        let authorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/.turnfold-repository.json")
                    .header(header::AUTHORIZATION, &authorization)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(authorized.status(), StatusCode::OK);

        let browser = app
            .oneshot(
                Request::builder()
                    .uri("/.turnfold-repository.json")
                    .header(header::ORIGIN, "https://app.example.test")
                    .header(header::AUTHORIZATION, authorization)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(browser.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn cross_origin_pairing_issues_and_revokes_a_scoped_grant() {
        let (app, _directory) = test_application(AuthMode::SingleUser);
        let browser_origin = "https://app.example.test";

        let preflight = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/api/config")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, browser_origin)
                    .header("access-control-request-method", "GET")
                    .header(
                        "access-control-request-headers",
                        "authorization, content-type",
                    )
                    .header("access-control-request-private-network", "true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            browser_origin
        );
        assert_eq!(
            preflight.headers()["access-control-allow-private-network"],
            "true"
        );

        let unpaired = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, browser_origin)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unpaired.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            unpaired.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            browser_origin
        );
        assert_eq!(response_json(unpaired).await["code"], "pairing_required");

        let started = app
            .clone()
            .oneshot(sync_request(
                "/api/local/v1/pairings",
                json!({
                    "clientName": "Test browser",
                    "requestedScopes": ["repository.sync"]
                }),
                browser_origin,
            ))
            .await
            .unwrap();
        assert_eq!(started.status(), StatusCode::CREATED);
        let started = response_json(started).await;
        let pairing_id = started["pairingId"].as_str().unwrap();
        let poll_token = started["pollToken"].as_str().unwrap();

        let approval = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/local/pair/{pairing_id}"))
                    .header(header::HOST, "turnfold.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(approval.status(), StatusCode::OK);
        let cookie = approval.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();

        let decided = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/local/pair/{pairing_id}"))
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, "http://turnfold.test")
                    .header(header::COOKIE, cookie)
                    .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                    .body(Body::from("action=approve"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(decided.status(), StatusCode::OK);

        let polled = app
            .clone()
            .oneshot(sync_request(
                &format!("/api/local/v1/pairings/{pairing_id}/poll"),
                json!({"pollToken": poll_token}),
                browser_origin,
            ))
            .await
            .unwrap();
        assert_eq!(polled.status(), StatusCode::OK);
        let polled = response_json(polled).await;
        assert_eq!(polled["grant"]["scopes"][0], "repository.sync");
        let grant_token = polled["token"].as_str().unwrap();

        let configured = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, browser_origin)
                    .header(header::AUTHORIZATION, format!("Bearer {grant_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(configured.status(), StatusCode::OK);
        assert_eq!(
            configured.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            browser_origin
        );

        let wrong_origin = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, "https://other.example.test")
                    .header(header::AUTHORIZATION, format!("Bearer {grant_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong_origin.status(), StatusCode::UNAUTHORIZED);

        let revoked = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::DELETE)
                    .uri("/api/local/v1/grant")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, browser_origin)
                    .header(header::AUTHORIZATION, format!("Bearer {grant_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::OK);
        assert_eq!(response_json(revoked).await["revoked"], true);

        let after_revoke = app
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, browser_origin)
                    .header(header::AUTHORIZATION, format!("Bearer {grant_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(after_revoke.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn provider_vault_requires_its_own_grant_and_never_resolves_plaintext() {
        let browser_origin = "https://app.example.test";
        let (app, _directory, grant_token) = test_application_with_provider_agent(browser_origin);

        let same_origin_without_grant = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/local/v1/provider/profiles")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, "http://turnfold.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(same_origin_without_grant.status(), StatusCode::UNAUTHORIZED);

        let provider = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/local/v1/provider/profiles/openai")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, browser_origin)
                    .header(header::AUTHORIZATION, format!("Bearer {grant_token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "name": "OpenAI",
                            "protocol": "openai-responses",
                            "baseUrl": "https://api.openai.com/v1",
                            "auth": {"type": "bearer"},
                            "headers": {},
                            "discoveryUrl": ""
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(provider.status(), StatusCode::OK);

        let credential = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/local/v1/vault/credentials")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, browser_origin)
                    .header(header::AUTHORIZATION, format!("Bearer {grant_token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "providerId": "openai",
                            "name": "default",
                            "secret": {"apiKey": "sk-never-return-this"}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(credential.status(), StatusCode::CREATED);
        let credential = response_json(credential).await;
        assert_eq!(credential["credential"]["providerId"], "openai");
        assert!(
            credential
                .to_string()
                .find("sk-never-return-this")
                .is_none()
        );
        assert!(credential["credential"].get("secret").is_none());

        let repository_with_agent_grant = app
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .header(header::HOST, "turnfold.test")
                    .header(header::ORIGIN, browser_origin)
                    .header(header::AUTHORIZATION, format!("Bearer {grant_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            repository_with_agent_grant.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            response_json(repository_with_agent_grant).await["code"],
            "pairing_required"
        );
    }

    #[tokio::test]
    async fn same_origin_agent_get_derives_the_browser_origin_from_fetch_metadata() {
        let (app, _directory, grant_token) =
            test_application_with_provider_agent("http://turnfold.test");
        let listed = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/local/v1/provider/profiles")
                    .header(header::HOST, "turnfold.test")
                    .header("sec-fetch-site", "same-origin")
                    .header(header::AUTHORIZATION, format!("Bearer {grant_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);

        let missing_browser_context = app
            .oneshot(
                Request::builder()
                    .uri("/api/local/v1/provider/profiles")
                    .header(header::HOST, "turnfold.test")
                    .header(header::AUTHORIZATION, format!("Bearer {grant_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_browser_context.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn forward_auth_config_requires_trusted_identity_headers() {
        let (app, _directory) = test_application(AuthMode::ForwardAuth);
        let missing = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .header(header::HOST, "turnfold.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);

        let configured = app
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .header(header::HOST, "turnfold.test")
                    .header("x-turnfold-username", "alice")
                    .header("x-turnfold-sub", "user-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(configured.status(), StatusCode::OK);
        assert_eq!(
            response_json(configured).await["profile"]["username"],
            "alice"
        );
    }
}
