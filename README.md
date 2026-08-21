# Turnfold

English | [简体中文](README.zh-CN.md)

[Website](https://liooil.github.io/turnfold/) · [Documentation](README.md)

Try the complete local-first web app at <https://liooil.github.io/turnfold/app/>. It runs without a Turnfold backend; configure a browser-reachable provider to start chatting.

The provider must allow browser requests from the Pages origin. Local model servers may also require browser local-network permission and an explicit CORS/origin allowlist.

Turnfold is a local-first repository for branching AI conversations.

Messages are immutable content-addressed objects. A conversation is a lightweight ref to a current message, so edits and regenerated answers create alternatives instead of overwriting history. The browser renders from its local repository first. A Backend is used only after the user explicitly connects to its URL.

> Turnfold is an early open-source release extracted from a working personal deployment. Storage and sync formats may still evolve before v1.

## Highlights

- Local-first IndexedDB repository with offline rendering and an outbox.
- Immutable messages, named conversation refs, branch navigation, and reflog history.
- Multiple persistent drafts and recoverable partial assistant streams.
- Credential-free Provider connection profiles derived from the embedded Models.dev subset, all disabled by default.
- An embedded twelve-model Models.dev subset, with an explicit browser-only action to download or update the complete catalog.
- Browser-direct custom and embedded Provider profiles; credentials never enter the embedded catalog.
- A two-path simple Provider setup by default: choose a catalog Provider and enter credentials, or supply only a URL and key for automatic detection; the previous full form remains available as advanced configuration.
- Handwritten SSE clients for OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and Google Generative AI protocols.
- Native archive plus Codex CLI, Claude Code, and OMP JSONL import/export.
- Batch import from files, ZIP archives, or a read-only local directory.
- Incremental Markdown and MathJax rendering designed for stable streaming layouts.
- Installable PWA and a small Bun/SQLite synchronization server.
- Explicit, URL-based Backend connections; serving the page never grants its Backend access to browser data.

Turnfold currently models a message as having one parent. The result is a branching message history, not a general multi-parent DAG and not a Git implementation.

## Quick start

Requirements: Docker with the Compose plugin, plus an AI endpoint that permits requests from the browser where you open Turnfold.

```sh
docker compose up --build -d
```

Open <http://localhost:3000>, then enable an embedded Provider by reviewing and saving its local connection profile, or add a custom Provider. You can enter a model ID manually or refresh the model list.

The default Compose configuration uses `AUTH_MODE=single-user`. It is intended for localhost or a trusted private network. Do not expose this mode to the public internet.

## Development

```sh
bun install
bun run dev
```

Useful checks:

```sh
bun run typecheck
bun test
bun run build
docker compose config
```

`bun run build:pages` assembles the handwritten site in `docs/` and the web app in `pages-dist/app/`. The ignored `pages-dist/` directory is the GitHub Pages deployment artifact; generated application files are not committed.

The source dependency direction is `client -> shared <- server`. See [docs/architecture.md](docs/architecture.md) for the module and compatibility boundaries.

The Rust executable, Backend consent model, Provider/Vault boundary, and WebDAV adapter are specified in [docs/local-service.md](docs/local-service.md).

`bun run dev` starts Bun's fullstack dev server (`Bun.serve` with `development: true`). It serves `src/index.html` through Bun's HTML bundle and public/MathJax assets directly from source dependencies, so frontend changes hot reload without running `build` or `build:pages`.

The development server listens on port `3000` by default. Set `PORT` to override it.

The Rust runtime serves a production frontend and a SQLite synchronization Backend without implicitly connecting the frontend to it:

```sh
bun run build
cargo run -p turnfold -- serve --listen 127.0.0.1:3000 --static-dir dist --database turnfold.db --vault-keyring default
```

Its capability endpoint is `/api/local/v1/info`. Repository sync is available only after the user explicitly connects either a native Backend or a WebDAV root; serving the page does not connect either transport. Cross-origin native sync and the Turnfold `/dav` front door use separate Origin-scoped grants (`repository.sync` and `repository.webdav`). Standard remote WebDAV roots can use Basic or no authentication and must provide browser-compatible CORS. Supplying `--vault-keyring` enables the separately paired Provider Agent and encrypted Vault without exposing plaintext credential resolution. `--vault-key-file` remains an explicit fallback, but the runtime never silently falls back between key sources. The Rust runtime defaults to loopback, `single-user` authentication, and `turnfold.db`.

To move an existing key file into the OS keyring, stop the service and run the non-destructive migration below. Turnfold validates the key against the database and does not delete the source file:

```sh
turnfold vault migrate-key --database turnfold.db \
  --from-key-file turnfold.vault.key --to-keyring default
```

Release archives contain `turnfold` (`turnfold.exe` on Windows), the built `dist/`, and a `service/` installer. Run `service/install-task.ps1` on Windows, `service/install-systemd-user.sh` on Linux, or `service/install-launchagent.sh` on macOS. The installers use a per-user OS keyring and service manager; their uninstall scripts remove supervision while preserving the database and keyring by default. A packaged executable finds the sibling `dist/` automatically.

An optional root-mounted DAV listener is available for non-browser clients:

```sh
cargo run -p turnfold -- serve --webdav-listen 127.0.0.1:3001 \
  --webdav-username turnfold --webdav-password-file webdav.password
```

It requires `single-user` mode and Basic authentication, rejects browser `Origin` requests, and is suitable over plain HTTP only on loopback. Run `turnfold serve --help` for all listener, database, Vault, and authentication options. The DAV namespace, ETag rules, and working-snapshot policy are documented in [docs/local-service.md](docs/local-service.md#repository-service-and-webdav).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port. |
| `BASE_PATH` | `/` | Runtime URL prefix. It must match the Docker build argument of the same name. |
| `HOME_URL` | app root | Build-time destination of the Turnfold mark. |
| `CHAT_DATABASE_PATH` | `/data/turnfold.db` | SQLite synchronization database. |
| `AUTH_MODE` | `forward-auth` | `single-user` for trusted local use or `forward-auth` behind an identity-aware proxy. |
| `SINGLE_USER_NAME` | `local` | Display name used by single-user mode. |
| `AUTH_ISSUER` | `turnfold:forward-auth` | Stable issuer identifier for forwarded identities. |
| `PORTAL_URL` | empty | Optional compatible identity profile endpoint. |
| `BACKEND_ALLOWED_ORIGINS` | empty | Comma-separated exact browser origins allowed to connect to this Bun Backend. |

`forward-auth` accepts `X-Turnfold-Username` and `X-Turnfold-Sub`. Authentik's `X-Authentik-Username` and `X-Authentik-Uid` headers are also supported for compatibility. The reverse proxy must remove untrusted client-supplied identity headers before setting its own.

The table describes the existing Bun/Docker deployment defaults. Rust accepts `CHAT_DATABASE_PATH`, `AUTH_MODE`, `SINGLE_USER_NAME`, and `AUTH_ISSUER`; its local defaults are `turnfold.db` and `single-user`, and its listen address is configured with `--listen`.

Cross-origin Backend access is denied unless the page origin is listed exactly, for example `BACKEND_ALLOWED_ORIGINS=https://liooil.github.io`. Allowed responses use credentialed CORS with that exact origin; wildcard origins are rejected. Same-origin access and non-browser clients that omit `Origin` continue to work.

The Rust Backend permits same-origin explicit connections and pairs cross-origin browsers through a separate Backend approval page. Grants contain only `repository.sync`, bind the exact page Origin and Backend identity, expire after 90 days, and can be revoked from Backend settings. Reverse-proxy deployments must declare their exact external origin with `--public-origin` and provide trusted HTTPS.

Embedded Providers and their models are derived entirely from the embedded Models.dev subset; Turnfold adds only the protocol, authentication mode, and API endpoint required by its browser runtime. They contain no credentials and are all disabled by default. Simple setup can select an embedded or downloaded catalog Provider and enter its credential, or accept only a URL and key, detect the protocol and models, and derive the identifier and name from the page title or domain. Advanced setup retains the full identifier, protocol, authentication, endpoint, default-model, and header controls. Provider profiles, model overrides, custom profiles, discovered model lists, headers, and credentials are stored only in the current browser. Model and detection requests go directly from that browser to the configured endpoint; the Bun server is not involved. The Provider must therefore allow the Turnfold origin through CORS. Browsers may also ask for local-network access before reaching a LAN endpoint.

Turnfold embeds metadata for twelve curated models from [Models.dev](https://models.dev/). The complete Models.dev catalog is never fetched automatically: users can explicitly download or update it in Provider settings, where it is stored in a separate browser IndexedDB database. Downloaded catalog entries are offered as templates when adding a model to a matching Provider and never contain credentials.

## Hosting below a path

Build and run with the same base path:

```sh
docker build --build-arg BASE_PATH=/turnfold -t turnfold .
docker run --rm -p 3000:3000 -e BASE_PATH=/turnfold -v turnfold-data:/data turnfold
```

Then open <http://localhost:3000/turnfold/>.

## Data and compatibility

- Browser data, Provider profiles, and credentials live in IndexedDB and remain usable without the server.
- After an explicit Backend connection, refs and immutable objects synchronize to that Backend. No Backend is contacted automatically at startup.
- After an explicit WebDAV connection, refs and immutable objects synchronize through the selected DAV root; the current device's working items are backed up as a recovery snapshot and are not merged into another device's active editor.
- Full backups use `*.turnfold.json` with `type: "turnfold-archive"` and `version: 1`.
- Native backups include message objects, conversation refs, and working drafts.

Keep backups before upgrading an early release.

## FAQ

### Why does Turnfold on GitHub Pages report Mixed Content when I connect to a LAN model over HTTP?

GitHub Pages is HTTPS, so browsers block requests to insecure HTTP resources such as `http://192.168.x.x:11434`. A service worker cannot bypass this restriction.

Recommended solutions:

- Set up an HTTPS reverse proxy (for example Caddy/Nginx with mkcert) for the LAN model and use an `https://` URL in Turnfold.
- For local debugging only, allow insecure content for the site in your browser.
- If you mainly use Turnfold on your LAN, run it locally and open `http://<lan-ip>:3000` instead of GitHub Pages.

Even after fixing Mixed Content, the LAN model or proxy must allow CORS from the Pages origin and may need `Access-Control-Allow-Private-Network: true`.


## Security

Never commit API keys, database files, or exported conversation archives. Provider keys remain in the current browser's IndexedDB and are never sent to the Turnfold server. As with any browser-held secret, scripts running under the same origin can access it; deploy with a strict CSP and only trusted assets.

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Turnfold is licensed under the MIT License. See [LICENSE](LICENSE).
