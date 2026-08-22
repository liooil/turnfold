# Architecture

Turnfold keeps browser and server code independent around a shared domain layer:

```text
client -> shared <- server
```

- `src/client/` contains browser-only application workflows and adapters, including IndexedDB and Provider HTTP access.
- `src/server/` contains Bun-only HTTP, identity, and SQLite adapters.
- `src/shared/` contains environment-independent conversation types, content objects, graph operations, sync payloads, and transfer formats.
- `src/client.ts` and `src/server.ts` are composition roots. They may import their platform layer and `shared`, but platform modules may not import each other.

Storage schemas, HTTP payloads, and archive formats are compatibility boundaries. Structural refactors must preserve them unless a migration is designed and tested explicitly.

The browser's IndexedDB repository remains authoritative at startup. An explicitly selected `RepositoryPeer` can synchronize it through either the native HTTP protocol or WebDAV, but only one remote transport is active at a time. Immutable objects carry their creating repository ID so every peer can verify the namespaced content hash, and mutable ref ancestry/version state is associated with the specific upstream peer rather than reused after switching transports.

The WebDAV tree and its versioned JSON envelopes are also compatibility boundaries. Device-scoped working snapshots in that tree are backup and recovery data; they are not pulled into the active editor or merged across devices.

## Toward parity: three equal repository implementations

The browser client, the Bun server, and the Rust local service are treated as equal, independent implementations of the same repository, like separate Git clones of one object model. Every implementation can operate on messages and conversations directly (through its API, CLI, or UI); differences are limited to the capabilities described in the feature matrix.

To make this concrete, a unified `Storage` abstraction (blob/KV + capability and trust declaration) and a platform-independent `RepositoryOps` contract will live in `src/shared/`. Remote storage implementations (WebDAV, S3) and local folder storage become ordinary storages rather than special sync channels, localStorage stays a UI preference store only, credentials become ordinary repository objects governed by a configurable trust model, and the sync protocol is reduced to object copy + ref CAS between storages.

See [docs/storage-architecture.md](storage-architecture.md) for the full proposal, feature matrix, and phased migration plan.
