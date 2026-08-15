# Turnfold

English | [简体中文](README.zh-CN.md)

[Website](https://liooil.github.io/turnfold/) · [Documentation](README.md)

Try the complete local-first web app at <https://liooil.github.io/turnfold/app/>. It runs without a Turnfold backend; configure a browser-reachable provider to start chatting.

The provider must allow browser requests from the Pages origin. Local model servers may also require browser local-network permission and an explicit CORS/origin allowlist.

Turnfold is a local-first repository for branching AI conversations.

Messages are immutable content-addressed objects. A conversation is a lightweight ref to a current message, so edits and regenerated answers create alternatives instead of overwriting history. The browser renders from its local repository first and synchronizes in the background when a server identity is available.

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

`bun run dev` starts Bun's fullstack dev server (`Bun.serve` with `development: true`). It bundles `src/index.html` on demand, enables hot reloading for frontend changes, and prepares public/MathJax assets in `dist/` on startup.

The development server listens on port `3000` by default. Set `PORT` to override it.

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

`forward-auth` accepts `X-Turnfold-Username` and `X-Turnfold-Sub`. Authentik's `X-Authentik-Username` and `X-Authentik-Uid` headers are also supported for compatibility. The reverse proxy must remove untrusted client-supplied identity headers before setting its own.

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
- Signed-in/single-user refs and immutable objects synchronize to SQLite.
- Full backups use `*.turnfold.json` with `type: "turnfold-archive"` and `version: 1`.
- Native backups include message objects, conversation refs, and working drafts.

Keep backups before upgrading an early release.

## Security

Never commit API keys, database files, or exported conversation archives. Provider keys remain in the current browser's IndexedDB and are never sent to the Turnfold server. As with any browser-held secret, scripts running under the same origin can access it; deploy with a strict CSP and only trusted assets.

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Turnfold is licensed under the MIT License. See [LICENSE](LICENSE).
