# CONTRACT - v2 product contract

This file is the current v2 source of truth. `core/contract/v1-extraction.json`
is historical input only: useful for exact v1 behavior, not binding when it
conflicts with this document.

UltraContext v2 is an SDK for managing context and artifacts in AI
applications. It must work in three environments:

- **edge/serverless apps** such as Vercel Edge, where the SDK cannot assume a
  persistent filesystem or native SQLite;
- **local apps and agents**, where a plain local database is valuable;
- **agent workflows**, where artifacts feel like files because models and
  tools operate well with `read`, `write`, `grep`, `glob`, and paths.

The unifying rule: the node store owns truth; files, S3 objects, and mounts are
adapters.

## Product Blocks

```
UltraContext SDK
  |
  |-- local native adapter   -> SQLite node store + optional content store
  |-- remote edge adapter    -> fetch-compatible HTTP protocol
  |
Path/artifact verbs
  |
Node store                Content store
  |                       |
contexts/messages         inline text | local-dir | S3/R2/MinIO
artifacts/versions
```

Blocks must be replaceable without changing domain objects:

- **Node store**: context/message/artifact graph, versions, paths, metadata,
  conflict checks, search index.
- **Content store**: bytes behind an artifact version. Inline data is one
  content-store implementation.
- **Path projection**: maps relative paths to artifact ids.
- **Agent surface**: SDK verbs, local materialization, and optional FUSE/native
  mounts over the same path projection.

## Environments

### Local Native

Local mode uses SQLite by default. It is for Node/Bun/Python apps, CLIs,
desktop apps, local agents, tests, and development.

Requirements:

- one inspectable database file by default;
- small text artifacts inline by default;
- optional local directory or S3/R2 content store for large bytes;
- same public behavior as remote mode.

### Remote Edge

Remote mode is first-class in v2 because many AI apps run in edge/serverless
environments. The JS SDK must have a fetch-only path that works without native
bindings, filesystem access, or SQLite.

Requirements:

- `mode: 'remote'` uses `fetch` against an UltraContext-compatible endpoint;
- remote responses use the same shapes and error codes as local mode;
- hosted UltraContext and self-hosted handlers can both implement the same
  protocol;
- local/native code must not be imported in edge-only remote usage.

### Agent File Surface

Agents should be able to operate on artifacts with file verbs even when there
is no real filesystem. The canonical surface is path-based verbs over the
artifact store. A FUSE mount is the native adapter over the same verbs for
laptops, workstations, and servers that can mount filesystems.

Required path verbs for the agent surface:

- `list(ctxId, {prefix?})`
- `read(ctxId, pathOrId, {version?})`
- `write(ctxId, pathOrId, data, {kind?, metadata?, ifVersion?})`
- `move(ctxId, fromPathOrId, toPath, {ifVersion?})`
- `remove(ctxId, pathOrId, {ifVersion?})`
- `glob(ctxId, pattern)`
- `grep(ctxId, query, {prefix?})`

These are SDK helpers and can also back local materialization or FUSE/native
mounts. They are projections over `save`, `load`, `search`, and `delete`, not
separate storage semantics.

## SDK Surface

The language SDKs should expose a small flat class. Names may use language
idiom, but behavior and shapes must match.

Core context verbs:

- `create({metadata?}) -> {id, metadata, created_at}`
- `fork(sourceId, {version?, metadata?}) -> {id, metadata, created_at}`
- `append(ctxId, message | message[]) -> {data, version}`
- `get()` lists contexts
- `get(ctxId, options?)` reads one context
- `update(ctxId, updates, options?) -> {data, version}`
- `delete(ctxId, ids | {permanent: true}, options?)`
- `search(query, options?) -> {data}`

Artifact verbs:

- `save(ctxId, input) -> {id, path, kind, size, version, created_at}`
- `load(ctxId, options?) -> {data}` lists artifact metadata
- `load(ctxId, pathOrId, options?) -> artifact version with inline data or a storage descriptor`
- artifact removal uses `delete(artId, {permanent: true})` or the file-surface
  `remove` helper

`save` accepts either path identity or artifact identity:

```ts
save(ctxId, {
  path: 'draft.md',
  kind: 'text/markdown',
  data: '# Draft',
  metadata: { source: 'agent' }
})

save(ctxId, {
  id: 'art_...',
  path: 'final.md',        // optional rename
  data: '# Final',         // optional new content
  ifVersion: 3
})
```

Rules:

- `id` targets an existing artifact and preserves identity.
- `path` without `id` upserts by current path inside the context.
- changing `path` without changing data is still a new artifact version.
- `ifVersion` prevents silent overwrite; mismatch returns `conflict`.
- `path` is a relative POSIX path: no absolute path, no `..`.
- directories are prefixes in v2, not nodes.

## Message Content and Attachments

Messages are provider-neutral JSON. Provider adapters translate messages into
OpenAI, Anthropic, Gemini, or other model shapes.

Image, audio, PDF, and other non-text prompt inputs should be artifacts
referenced by message content:

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Describe this image" },
    { "type": "image", "artifact_id": "art_...", "version": 1 }
  ]
}
```

The artifact reference should pin a version whenever reproducibility matters.

## Artifact Storage

Artifact metadata lives in nodes. Artifact bytes can be inline or external.

Inline storage:

```json
{
  "path": "draft.md",
  "kind": "text/markdown",
  "size": 123,
  "sha256": "...",
  "storage": { "type": "inline" }
}
```

External storage:

```json
{
  "path": "uploads/screenshot.png",
  "kind": "image/png",
  "size": 89123,
  "sha256": "...",
  "storage": {
    "type": "ref",
    "driver": "s3",
    "key": "artifacts/art_.../v1"
  }
}
```

Defaults:

- text and markdown below the configured inline limit are inline;
- binary and large content use the configured content store;
- local mode can use inline-only and still be valid;
- remote mode may choose S3/R2/local-dir behind the endpoint;
- callers can inspect where content lives but should not depend on physical
  layout for identity.

Out of v2.0 unless explicitly pulled forward: content-addressed dedupe,
history pruning, garbage collection UI, and multipart upload ergonomics.

## Search

Search is a recall operation, not a bulk read.

- Search current message content and current text artifact versions.
- Return snippets and ids, not full content.
- Full content is a targeted `get` or `load` call.
- Metadata filters are additive later; current search is content recall over
  current messages and text artifacts.
- Image/audio/PDF search is via derived text such as OCR, captions, or
  transcripts when those derivatives exist.
- History search is additive later.

## Errors

Every operation returns or throws the same code/message in every SDK.

Core codes:

| Code | Meaning |
|---|---|
| `not_found` | context, message, artifact, version, or path does not resolve |
| `invalid_input` | bad params caught before a write |
| `conflict` | version precondition failed or concurrent write would lose data |
| `busy` | local store locked past timeout |
| `incompatible_db` | local file has an unsupported schema |
| `internal` | invariant broken or unexpected failure |

Remote transport can add HTTP/auth details around these errors, but the
domain error code must remain visible to callers.

## Binding Boundary

Language bindings must not reimplement domain rules. The Rust core exposes a
JSON dispatch boundary for local SDKs:

- input is one operation name plus one JSON object;
- output is the same JSON shape used by the remote protocol;
- failures return `UcError` with the stable domain code above;
- JS/Python wrappers map that code into language-native `UltraContextError`
  types.

This keeps local native mode and remote fetch mode aligned while allowing the
binding layer to stay thin.

## Sync and Mirrors

Do not mount S3 as the database. Do not put SQLite on FUSE. Do not use
JuiceFS as the core model.

The sync shape is:

- nodes and artifact versions are the logical replication unit;
- content refs point to blobs that can be copied separately;
- local mirrors push/pull node changes plus needed blobs;
- conflicts are explicit through `conflict` or forked artifact heads;
- remote edge mode talks to an authoritative endpoint instead of syncing a
  local filesystem.

Mirror/sync ships first as snapshot and incremental changes:

- `export_snapshot` returns all node rows plus blob content needed to recreate
  the logical store;
- `export_changes({since})` returns rows after a cursor;
- `import_snapshot` and `import_changes` are idempotent for identical rows;
- structural `node.id` collisions with different content are reported as
  conflicts instead of overwritten.

This is not CRDT merge. Concurrent same-document editing remains explicit
application policy.

## Deferred Blocks

These are important, but not required for the first shippable v2 core:

- FUSE/native mount over the same path projection;
- managed hosted service;
- local mirror daemon;
- event stream/watch for live propagation;
- CRDT/real-time collaborative text editing;
- structural sharing optimizations;
- token counting and model-specific budget helpers;
- provider adapters for prompt serialization.
