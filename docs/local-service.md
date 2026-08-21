# Local Service Architecture

## Status

This document defines the implemented architecture for the Rust `turnfold` executable and the trust contract between the browser application and any Backend. Delivery stages 1 through 7 are complete: the browser requires explicit Backend, Provider Agent, and WebDAV connections; the executable serves the application; the native repository API persists to SQLite; cross-origin repository access uses scoped browser pairing; the Provider/Vault worker executes requests without resolving plaintext credentials to the browser; WebDAV is available as both a scoped local front door and a browser repository adapter; and portable packages integrate with per-user OS keyrings and service managers. A capability must not be advertised by the executable or UI until its endpoint and security boundary exist.

## Local-first invariant

In Turnfold, "local" means the current browser profile, not the process that served the page.

- IndexedDB is the default repository and the only repository used at startup.
- Serving the static application does not authorize the serving Backend to read or receive browser data.
- The application does not probe `/api/config`, synchronize, or send credentials to a Backend during startup.
- A Backend URL is only a suggestion until the user explicitly connects to it.
- Disconnecting a Backend never deletes local conversations, objects, drafts, Provider profiles, or credentials.
- Provider requests remain browser-direct unless the user separately connects a Provider Agent, registers that Provider, stores or explicitly migrates a credential, and selects Agent execution for that Provider.

The page may suggest the Backend that served it. For example, a page loaded from `http://127.0.0.1:3000/` defaults the connection field to `http://127.0.0.1:3000`. This is a convenience value, not an implicit grant.

Same-origin approval remains session-scoped. A successful cross-origin pairing stores an Origin-bound grant in that browser, but it does not auto-connect: a page reload still requires an explicit connection action. Disconnecting retains the grant for later use; revoking the pairing invalidates it at the Backend and removes the browser copy.

## User-facing executable

The installed program is named `turnfold` (`turnfold.exe` on Windows). Its primary command serves the built web application and the local-service front door:

```text
turnfold serve --listen 127.0.0.1:3000 --static-dir dist --database turnfold.db \
  --vault-keyring default
```

The executable is one distribution unit. That does not require every capability to share a process or privilege boundary.

```text
turnfold serve
|-- static application and local API front door
|-- Provider/Vault worker (enabled by one explicit key source)
`-- repository/WebDAV adapter
```

The default listener is loopback-only. Binding a non-loopback address requires an explicit option. Remote listeners will require authentication and trusted TLS before they are considered supported.

The product therefore uses one executable and one installation/configuration surface, while keeping two security domains: Provider/Vault and repository/WebDAV. They are modules in one process, but use separate grants, SQLite connections, and routing namespaces. The optional WebDAV listener has its own router and credentials. The repository module never receives the Vault master key. Service supervision does not claim OS process isolation between these modules, and the shipped service definitions remain loopback-only; trusted remote transport still belongs at an explicitly configured TLS reverse proxy.

## Backend connection model

Only one Backend is active in the browser at a time. The connection flow is:

1. Initialize and render the browser repository without network access to a Backend.
2. Suggest a normalized Backend base URL in Settings.
3. Wait for the user to submit the connection form.
4. Fetch `<backend>/api/config`; if it returns `pairing_required`, offer a separate pairing action.
5. Open the Backend approval page and wait for the user to approve the exact requesting Origin and `repository.sync` scope.
6. Store the resulting grant in the requesting page Origin and retry `/api/config` with its bearer token.
7. Create a `RepositoryPeer` for that exact base URL and token.
8. Synchronize immutable objects and mutable refs while keeping IndexedDB as the active repository.
9. Stop all Backend synchronization immediately when the user disconnects.

A Backend base URL may include a path prefix, such as `https://example.test/turnfold`. Query strings, fragments, and URL credentials are rejected. API paths are appended below the configured prefix.

The Backend identity is remote metadata. It does not replace the browser repository identifier used for content-addressed objects.

### Current repository API

```text
GET  /api/config
POST /api/sync/fetch
POST /api/sync/push
POST /api/local/v1/pairings
POST /api/local/v1/pairings/{id}/poll
GET, DELETE /api/local/v1/grant
GET, POST /local/pair/{id}
```

`GET /api/local/v1/info` advertises `vault` and `providerProxy` only when `turnfold serve` was started with exactly one Vault key source: `--vault-keyring` (`TURNFOLD_VAULT_KEYRING`) or `--vault-key-file` (`TURNFOLD_VAULT_KEY_FILE`). The two options are mutually exclusive and Turnfold never silently falls back from an unavailable keyring to a file. A new source receives a random 256-bit key, but a missing source is never recreated after the database contains a master-key verifier or wrapped credential key. The master key is never stored in SQLite.

The current `RepositoryPeer` contract and object/ref conflict behavior remain the synchronization compatibility boundary. Supporting an arbitrary Backend URL changes transport selection, not repository ownership.

The Rust and Bun implementations use the same `chat_conversation` and `chat_message_node` SQLite schema. Rust can open an existing Bun database directly. It verifies every namespaced message SHA-256 before a transaction, requires parents to be present in depth order, deduplicates immutable objects, and preserves the head/metadata version compare-and-swap behavior for refs.

Object provenance accepts current `local:<repository-id>` namespaces and the 32-lowercase-hex identity namespaces produced by earlier Turnfold versions. Fetch responses return provenance only for objects absent from the caller's `haveObjectIds`, so compatibility metadata remains bounded by the transferred object batch.

Push requests retain the protocol limits of 1,000 objects and 100 refs. The browser also splits batches at a 48 MiB encoded-body budget, below the Rust HTTP request limit of 64 MiB, so a valid count-limited batch cannot fail only because many messages are near their individual size limit. A single object that cannot fit the transport budget is rejected before network I/O.

`turnfold serve` defaults to `single-user` identity mode for loopback use. `--auth-mode forward-auth` retains the existing trusted-proxy header contract for deployments that need it. `--database`, `--auth-mode`, `--single-user-name`, and `--auth-issuer` also accept the existing `CHAT_DATABASE_PATH`, `AUTH_MODE`, `SINGLE_USER_NAME`, and `AUTH_ISSUER` environment variables. Loopback listeners trust only their bound address plus `localhost`, `127.0.0.1`, and `[::1]` at that port. Reverse-proxy deployments declare each externally visible exact origin with a repeated `--public-origin https://turnfold.example.test`; an unspecified non-loopback listener requires at least one such origin.

## Provider agent and Vault

The Provider agent combines credential storage with constrained Provider execution. It does not expose an endpoint equivalent to `/v1/resolve` that returns plaintext credentials.

- The browser refers to a saved credential by identifier.
- The agent injects authentication and performs the outbound request.
- Requests are limited to an explicitly registered Provider origin and approved relative paths.
- Redirect targets are validated again.
- Hop-by-hop and caller-supplied authentication headers are removed.
- Streaming responses are forwarded without buffering the full response.

Vault management and Provider execution use separate scoped grants. CORS is a browser isolation mechanism, not authentication.

The homelab Key Vault provides useful storage invariants that remain part of this design: each credential has a random data-encryption key; AES-256-GCM authenticates the ciphertext and binds credential identity, owner, and Provider as associated data; and a master key wraps only the data keys. This layout permits future master-key rotation to rewrap data keys without re-encrypting every Provider secret. Metadata APIs omit plaintext, records are owner-scoped, and profile/credential lifecycle and use are audited. Secret JSON is limited to 64 KiB and metadata exposes only a 16-hex SHA-256 fingerprint.

The trust boundary differs from homelab. There, an internal `/v1/resolve` call can return plaintext to a specifically authenticated Chat service on a private container network. A user-installed local service has no equivalent permanently trusted browser caller. After decrypting a credential, the Provider worker therefore performs the approved outbound request itself and returns only the Provider response. Portable installations use the platform credential store under service `io.github.liooil.turnfold.vault`; the configured `--vault-keyring` value is its account name. The key is never placed in SQLite or the WebDAV tree. An explicitly selected fallback key file is created with mode `0600` on Unix. On Windows, the packaged service uses the OS keyring rather than claiming that a portable key file has an owner-only ACL.

Each initialized Vault database stores a domain-separated SHA-256 verifier for its random master key. This detects a wrong key before the first credential is used. A database created before the verifier existed is upgraded only after the supplied key successfully unwraps an existing credential DEK. To migrate a key file, stop every process using the database and run:

```text
turnfold vault migrate-key --database turnfold.db \
  --from-key-file turnfold.vault.key --to-keyring default
```

The migration acquires the database instance lock, validates the file key against the database, refuses to replace a different keyring value, verifies the stored result, and leaves the source key file untouched. The user can remove that file only after separately confirming the service starts and existing credentials decrypt through `--vault-keyring`.

### Agent API

All routes below require an Origin-bound grant. Same-origin static serving does not bypass this requirement.

```text
GET          /api/local/v1/provider/profiles
POST, DELETE /api/local/v1/provider/profiles/{providerId}
GET, POST    /api/local/v1/vault/credentials
DELETE       /api/local/v1/vault/credentials/{credentialId}
GET          /api/local/v1/vault/audit
POST         /api/local/v1/provider/execute
```

Profile and credential management requires `vault.manage`; execution requires `provider.execute`. A repository grant cannot call these routes, and a Provider/Vault grant cannot synchronize a cross-origin repository. The browser stores the Agent grant separately from Backend repository grants.

A registered execution profile fixes the Provider ID, protocol, HTTPS or loopback-HTTP base URL, authentication mode, static headers, and optional same-origin discovery URL. Authentication material is rejected from profile metadata and must be supplied as an encrypted Vault secret. Hop-by-hop, cookie, host, content-length, fetch-metadata, accept, and content-type headers are rejected. Redirect following and implicit environment proxy discovery are disabled; a future outbound proxy option must be explicitly configured and trusted.

`provider/execute` accepts only `stream` and `discover`. The caller supplies a Provider ID, optional credential ID, model, and protocol payload; it never supplies a target URL or outbound headers. The worker derives the exact path from the registered protocol, forces the selected model and streaming flag where applicable, injects a single authentication value, and streams the upstream response. Discovery similarly uses either the fixed registered URL or a protocol-derived models path.

### Browser workflow

Connecting a repository Backend does not enable the Agent. The Provider settings flow is deliberately separate:

1. Enter or accept the suggested Agent URL and click Connect.
2. Approve the exact `provider.execute` and `vault.manage` scopes on the Agent-origin pairing page.
3. Register or update each browser Provider profile on the Agent.
4. Enter a new Agent credential, or explicitly choose to migrate an existing IndexedDB credential. Migration never happens during connection, startup, profile save, or mode selection; the browser copy remains until the user deletes it.
5. Select Agent execution for that Provider. Other Providers remain browser-direct.

Reloading the page performs no Agent request. It restores only the suggested URL, saved-grant indicator, and per-Provider mode preferences; the user must explicitly connect again before Agent execution is available.

Same-origin browser `GET` requests commonly omit `Origin`. Agent management routes accept that case only when the browser supplies `Sec-Fetch-Site: same-origin`; the service derives the page Origin from its already validated effective `Host` and still requires a bearer grant bound to that exact Origin. An Origin-less request without this browser context remains rejected.

## Repository service and WebDAV

The native repository protocol remains the application synchronization protocol. WebDAV is an adapter, not the canonical conversation model.

- Immutable message objects retain content verification and deduplication.
- Conversation refs retain expected-head and version conflict checks.
- WebDAV writes use ETags as compare-and-swap preconditions for mutable refs and working snapshots.
- Vault files, master keys, and Provider credentials never appear in a WebDAV namespace.
- A browser can activate either the native Backend transport or WebDAV for repository synchronization, never both at once.

### DAV tree and envelopes

The adapter implements the WebDAV Class 1 methods needed by Turnfold: `OPTIONS`, `PROPFIND` with `Depth: 0` or `1`, `GET`, `HEAD`, `PUT`, `DELETE`, and `MKCOL`. Its version 1 virtual tree is:

```text
/.turnfold-repository.json
/objects/<64-lowercase-hex-sha256>.json
/refs/<base64url-utf8-conversation-id>.json
/working/<base64url-utf8-device-id>.json
```

The descriptor is `{"type":"turnfold-webdav-repository","version":1,"id":"..."}`. Resource bodies use explicit envelopes:

```text
objects: {"type":"turnfold-message-object","version":1,"repositoryId":"...","object":{...}}
refs:    {"type":"turnfold-conversation-ref","version":1,"ref":{...}}
working: {"type":"turnfold-working-snapshot","version":1,"snapshot":{...}}
```

An object retains the `repositoryId` of the browser repository that created it. Readers recompute its namespaced SHA-256 using that provenance and reject a path, body, or hash mismatch. Immutable object creation requires `If-None-Match: *`. Creating a mutable ref or working snapshot also requires `If-None-Match: *`; replacing or deleting one requires its current `If-Match` ETag. A stale write returns `412 Precondition Failed` rather than silently overwriting another client.

Working items are backed up as one complete snapshot per browser device. They are recovery data: synchronization writes the current device snapshot, but does not pull another device's snapshot into the active editor, merge drafts, or continuously publish partial `assistant-stream` state. Native `*.turnfold.json` archives remain the interactive import/export format.

### Browser adapter and consent

The WebDAV `RepositoryPeer` has three explicit connection modes in Settings:

- **Turnfold authorization:** the user enters a Turnfold Service URL; the browser derives its `/dav` root and pairs for exactly `repository.webdav`.
- **Standard WebDAV with Basic authentication:** the user enters a DAV root, username, and password.
- **Standard WebDAV without authentication:** the user enters a DAV root.

`repository.webdav` and `repository.sync` are intentionally separate grants and cannot be requested together. Neither can be combined with `provider.execute` or `vault.manage`. Native Backend and WebDAV grants use different browser storage slots, so granting one transport does not authorize the other.

Serving the page still grants nothing. Startup only restores suggested fields and saved-grant indicators; it performs no DAV request. Connecting, pairing, and synchronizing require explicit user actions. The standard WebDAV modes depend on that server allowing the exact Turnfold page Origin through CORS, including the DAV methods and the `Authorization`, `Content-Type`, `Depth`, `If-Match`, and `If-None-Match` request headers, and exposing `ETag` to browser JavaScript. An HTTPS page cannot connect to an ordinary remote HTTP DAV root because browser mixed-content rules still apply.

### Dedicated non-browser listener

`turnfold serve` can expose the same SQLite-backed DAV tree on an optional second socket for native backup tools and WebDAV clients:

```text
turnfold serve --webdav-listen 127.0.0.1:3001 \
  --webdav-username turnfold --webdav-password-file webdav.password
```

The password file must contain one password of at least 12 characters. This listener currently requires `single-user` identity mode, mounts the DAV tree at `/`, and requires HTTP Basic authentication. It rejects every request carrying an `Origin` header and deliberately emits no browser CORS policy; browsers must use the scoped `/dav` front door or a correctly configured standard remote WebDAV service. Plain HTTP Basic authentication is suitable only on loopback. Non-loopback exposure remains unsupported without a trusted TLS reverse proxy.

## Origin, CORS, and pairing

Same-origin static serving removes CORS from the normal local UI path, but it does not create Backend consent. State-changing local APIs still validate `Origin`, `Host`, and fetch metadata to resist cross-site requests and DNS rebinding.

Cross-origin Backend connections require a grant for the exact Turnfold page Origin. Wildcard credentialed CORS is not supported. Repository pairing requests only `repository.sync`; Provider Agent pairing separately requests `provider.execute` and `vault.manage`. Repository scope cannot be combined with Provider/Vault scopes in one pairing request.

Pairing requests expire after five minutes. Approval occurs on a Backend-origin page protected by a short-lived `HttpOnly; SameSite=Strict` cookie, so the requesting page can open the approval surface but cannot submit the decision. An approved grant expires after 90 days and binds the Backend identity, requesting Origin, client label, and exact scope. The bearer token is returned only to the polling browser; SQLite stores its SHA-256 digest. Polling may rotate an undelivered token without widening its grant. The browser never places the token in a URL and sends it only to the normalized Backend base URL.

Preflight responses reflect one validated HTTP(S) Origin. API routes permit their existing `GET`, `POST`, and `DELETE` operations; the scoped `/dav` front door additionally permits `HEAD`, `PUT`, `PROPFIND`, and `MKCOL`, DAV conditional headers, and exposes `DAV` and `ETag`. Private Network Access preflights receive `Access-Control-Allow-Private-Network: true`; this enables the network attempt but does not bypass grant authorization. Native repository responses require either same-origin access or a valid Origin-bound grant, while `/dav` requires its `repository.webdav` grant even when same-origin. Origin-less native repository requests remain available to non-browser clients; Agent routes follow the stricter grant rule above, and cross-site Fetch Metadata without `Origin` is rejected everywhere.

The listener separately validates the effective service Origin against its bound loopback names and configured `--public-origin` values. This prevents a rebinding hostname from becoming trusted merely because its attacker-controlled `Origin` matches its `Host` header.

The existing Bun Backend accepts a comma-separated exact allowlist through `BACKEND_ALLOWED_ORIGINS`. This remains a compatibility deployment control rather than a persistent grant. A Bun Backend that already allows the requesting Origin continues to work with the new browser client without implementing pairing.

The Rust Backend accepts same-origin browser synchronization, non-browser native-sync requests without `Origin`, and paired cross-origin requests carrying a `repository.sync` token. Its browser WebDAV front door always requires a separate `repository.webdav` token. Unpaired requests receive a readable `pairing_required` response but no repository data.

Loopback HTTP is the initial default. Modern browsers treat loopback specially, while LAN HTTP targets from an HTTPS page are commonly blocked as mixed content. Trusted HTTPS is required before exposing a service beyond loopback.

## Packaging and service supervision

Git tags matching `v*` build native portable archives for Windows x86-64, Linux x86-64, macOS x86-64, and macOS arm64. Each archive contains the native `turnfold` executable, the production `dist/`, license and architecture documentation, and one platform-specific `service/` directory. Every archive has a companion `.sha256` file containing its SHA-256 checksum. A manually dispatched release workflow builds and retains the same archives and checksum files as workflow artifacts without publishing a GitHub release.

The executable first resolves an explicitly supplied static directory. When the unchanged default `--static-dir dist` is unavailable in the current working directory, it also checks for `dist/` beside the executable. This makes portable archives independent of the shell or service manager's initial directory without weakening explicit path validation.

The bundled per-user service integrations use these defaults:

| Platform | Service manager | Runtime | Database |
| --- | --- | --- | --- |
| Windows | Task Scheduler at logon | `%LOCALAPPDATA%\Programs\Turnfold` | `%LOCALAPPDATA%\Turnfold\turnfold.db` |
| Linux | `systemd --user` | `~/.local/lib/turnfold` | `~/.local/share/turnfold/turnfold.db` |
| macOS | LaunchAgent | `~/Library/Application Support/Turnfold/runtime` | `~/Library/Application Support/Turnfold/data/turnfold.db` |

From an extracted archive, run the matching installer:

```text
Windows: .\service\install-task.ps1
Linux:   ./service/install-systemd-user.sh
macOS:   ./service/install-launchagent.sh
```

All three definitions listen on `127.0.0.1:3000`, use keyring account `default`, restart failed processes, and keep runtime files separate from data. Linux additionally applies a restrictive umask and systemd filesystem/process hardening. The installers do not enable the dedicated DAV listener or remote access. OS keyring availability is mandatory when this configuration is selected; a headless Linux session without a usable Secret Service fails closed instead of writing a fallback key file.

Every `turnfold serve` process resolves the database to a stable absolute path and holds an exclusive OS lock on `<database>.lock` before opening any SQLite stores. A second current-version process targeting the same database fails immediately. The migration command uses the same lock. Ctrl+C on every platform and SIGTERM on Unix cancel both the application and dedicated DAV listeners, then wait for all in-flight Axum services to finish before releasing the database lock.

The uninstall scripts first remove service supervision. Application removal is optional, and the database plus OS keyring entry are preserved by default. Removing either key material or the database remains a separate, explicit user operation because deleting one without the other can make credentials unrecoverable.

## Delivery stages

1. [x] Remove implicit same-origin Backend discovery and add explicit URL connection/disconnection.
2. [x] Add the Rust `turnfold serve` command for loopback static serving and honest capability discovery.
3. [x] Move the existing repository API and SQLite store behind the Rust executable.
4. [x] Add scoped browser pairing and configurable exact-origin CORS.
5. [x] Add the Provider/Vault worker without plaintext credential resolution.
6. [x] Add the repository WebDAV adapter and define working-item synchronization.
7. [x] Add packaging, OS keystore integration, service supervision, and platform installers.
