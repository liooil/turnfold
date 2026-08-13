# Turnfold

Turnfold is a local-first repository for branching AI conversations.

Messages are immutable content-addressed objects. A conversation is a lightweight ref to a current message, so edits and regenerated answers create alternatives instead of overwriting history. The browser renders from its local repository first and synchronizes in the background when a server identity is available.

> Turnfold is an early open-source release extracted from a working personal deployment. Storage and sync formats may still evolve before v1.

## Highlights

- Local-first IndexedDB repository with offline rendering and an outbox.
- Immutable messages, named conversation refs, branch navigation, and reflog history.
- Multiple persistent drafts and recoverable partial assistant streams.
- Browser-direct and server-side model providers.
- OpenAI, Anthropic, Google, OpenAI-compatible, Ollama, llama.cpp, LM Studio, and vLLM support.
- Native archive plus Codex CLI, Claude Code, and OMP JSONL import/export.
- Batch import from files, ZIP archives, or a read-only local directory.
- Incremental Markdown and MathJax rendering designed for stable streaming layouts.
- Installable PWA and a small Bun/SQLite synchronization server.

Turnfold currently models a message as having one parent. The result is a branching message history, not a general multi-parent DAG and not a Git implementation.

## Quick start

Requirements: Docker with the Compose plugin, plus a model server such as Ollama or LM Studio running on the machine where you open the browser.

```sh
docker compose up --build -d
```

Open <http://localhost:3000>. In model settings, choose the local provider and adjust its browser-visible Base URL if necessary.

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

The development server listens on port `3000` by default. Set `PORT` to override it.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port. |
| `BASE_PATH` | `/` | Runtime URL prefix. It must match the Docker build argument of the same name. |
| `HOME_URL` | app root | Build-time destination of the Turnfold mark. |
| `CHAT_DATABASE_PATH` | `/data/turnfold.db` | SQLite synchronization database. |
| `PUBLIC_PROVIDER_CATALOG_FILE` | `providers.json` | Provider catalog exposed to the browser. |
| `AUTH_MODE` | `forward-auth` | `single-user` for trusted local use or `forward-auth` behind an identity-aware proxy. |
| `SINGLE_USER_NAME` | `local` | Display name used by single-user mode. |
| `AUTH_ISSUER` | `turnfold:forward-auth` | Stable issuer identifier for forwarded identities. |
| `ACCOUNT_URL` | empty | Optional account/provider-management link. |
| `PORTAL_URL` | empty | Optional compatible identity profile endpoint. |
| `KEY_VAULT_URL` | empty | Optional Turnfold-compatible backend credential service. |
| `KEY_VAULT_TOKEN_FILE` | empty | Service token file for the credential service. |

`forward-auth` accepts `X-Turnfold-Username` and `X-Turnfold-Sub`. Authentik's `X-Authentik-Username` and `X-Authentik-Uid` headers are also supported for compatibility. The reverse proxy must remove untrusted client-supplied identity headers before setting its own.

Edit [providers.json](providers.json) to change browser-direct providers. Provider credentials and endpoint overrides are stored only in the current browser.

## Hosting below a path

Build and run with the same base path:

```sh
docker build --build-arg BASE_PATH=/turnfold -t turnfold .
docker run --rm -p 3000:3000 -e BASE_PATH=/turnfold -v turnfold-data:/data turnfold
```

Then open <http://localhost:3000/turnfold/>.

## Data and compatibility

- Browser data lives in IndexedDB and remains usable without the server.
- Signed-in/single-user refs and immutable objects synchronize to SQLite.
- Full backups use `*.turnfold.json` with `type: "turnfold-archive"` and `version: 1`.
- Legacy `*.xiteng-chat.json` archives remain importable.
- Native backups include message objects, conversation refs, and working drafts.

Keep backups before upgrading an early release.

## Security

Never commit API keys, database files, proxy tokens, or exported conversation archives. Browser-direct provider keys remain in a local IndexedDB vault. Server-side keys require an external credential service and are not stored in Turnfold's conversation database.

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Turnfold is licensed under the GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).
