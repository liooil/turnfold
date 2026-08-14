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
