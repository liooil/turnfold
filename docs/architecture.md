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
