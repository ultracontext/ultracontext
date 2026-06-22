# CONTRACT - v2 product contract

This file is the current v2 source of truth.
`core/model/contract/v1-extraction.json` is historical input only: useful for
exact v1 behavior, not binding when it conflicts with this document.

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
workspaces/sessions       inline text | local-dir | S3/R2/MinIO
contexts/messages
artifacts/versions
```

Blocks must be replaceable without changing domain objects:

- **Node store**: workspace/session/context/message/artifact graph, versions,
  paths, metadata, conflict checks, search index.
- **Content store**: bytes behind an artifact version. Inline, local-dir, and
  S3-compatible object stores are current Rust core implementations.
- **Path projection**: maps relative paths to artifact ids.
- **Agent surface**: SDK verbs, local materialization, and optional native
  mounts over the same path projection.

## Environments

### Local Native

Local mode uses SQLite by default. It is for Node/Bun/Python apps, CLIs,
desktop apps, local agents, tests, and development.

Requirements:

- one inspectable database file by default;
- small text artifacts inline by default;
- optional local directory or S3-compatible content store for large bytes;
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
artifact store. The native NFS mount adapter exposes the same verbs for
laptops, workstations, and servers that can mount filesystems.

Required path verbs for the agent surface:

- `list(handle, {prefix?})`
- `read(handle, pathOrId, {version?})`
- `write(handle, pathOrId, data, {kind?, metadata?, ifVersion?})`
- `move(handle, fromPathOrId, toPath, {ifVersion?})`
- `remove(handle, pathOrId, {ifVersion?})`
- `glob(handle, pattern)`
- `grep(handle, query, {prefix?})`

These are SDK helpers and can also back local materialization or native
mounts. They are projections over `save`, `load`, `search`, and `delete`, not
separate storage semantics.

Artifact paths are scoped by workspace. The simple SDK accepts a session or
context handle for file/artifact verbs and resolves the workspace from that
session. Advanced callers may target a workspace directly.

## SDK Surface

The language SDKs expose a session-first handle API. Names may use language
idiom, but behavior and shapes must match. SDK methods must stay thin wrappers
over Rust core/protocol operations.

Progressive disclosure rule:

- simple apps create or load a session and operate on `session.context`;
- project-aware apps create workspaces explicitly and create sessions inside
  them;
- a session is the durable container for lifecycle, metadata, artifacts,
  subagents, a session log, and context snapshots;
- `session.context` is the current model-facing window for that session;
- mutations through `session.context.*` advance the current context while
  preserving the durable session log and context revision history.

Current handle SDK surface:

- `uc.sessions.create({workspaceId?, metadata?}) -> Session`
- `uc.sessions.get(id) -> Session`
- `uc.sessions.list() -> {data}`
- `uc.sessions.delete(id) -> {deleted, id}`. Session deletion is permanent and
  removes the session, its log, its context snapshots, and its session-artifact
  attachments. It does not delete workspace artifacts.
- `uc.sessions.fork(id, {version?, metadata?}) -> Session`
- `uc.workspaces.create({metadata?}) -> Workspace`
- `uc.workspaces.list() -> {data}`
- `uc.artifacts.session(sessionId) -> session.artifacts`
- `uc.fs.session(sessionId) -> session.fs`
- `uc.search.query(query) -> {data}`
- `uc.sync.exportSnapshot()`, `uc.sync.importSnapshot(snapshot)`,
  `uc.sync.exportChanges({since?})`, `uc.sync.importChanges(changes)`

Session handle surface:

- `session.id`
- `session.workspaceId` / `session.workspace_id`
- `session.metadata`
- `session.createdAt` / `session.created_at`
- `session.delete() -> {deleted, id}`. Session deletion is permanent.
- `session.fork({version?, metadata?}) -> Session`
- `session.context.get({version?}) -> {data, context_id, version}`
- `session.context.append(entry | entry[]) -> ContextMutation`
- `session.context.update(patch | patch[], {metadata?}) -> ContextMutation`
- `session.context.delete(entryId | entryId[], {metadata?}) -> ContextMutation`
- `session.context.clear() -> ContextMutation`
- `session.context.history() -> {data}`
- `session.context.restore(contextId) -> ContextMutation`
- `session.artifacts.list() -> {data}`
- `session.artifacts.get(pathOrId, {version?}) -> Artifact`
- `session.artifacts.update(pathOrId, data, {kind?, metadata?, ifVersion?}) -> Artifact`
- `session.artifacts.delete(pathOrId, {ifVersion?}) -> {deleted, id}`
- `session.artifacts.create(input) -> Artifact` creates a workspace artifact
- `session.fs.list({prefix?})`, `read`, `write`, `move`, `remove`, `glob`,
  and `grep` expose the workspace path projection.

Context mutation rules:

- `session.context.append` appends entries to the durable session log and
  advances the current context window.
- `session.context.get` returns the context at the latest version by default,
  or a specific version when `version` is supplied, including its context id,
  version, and entries.
- `session.context.entries({contextId})` reads entries from the current window
  by default, or from a specific context snapshot when `contextId` is supplied.
- `session.context.update`, `remove`, `clear`, and `restore` create a new
  context snapshot. They never mutate an old snapshot in place.
- `session.context.remove` removes entries from the current model-facing
  window; it does not purge the session log.
- `session.context.clear` creates a new empty current context window while
  preserving the session log.
- `session.context.restore` creates a new current snapshot based on an older
  snapshot; it does not move time backward by repointing current.
- `session.context.history` is the history of context-window snapshots only.
  The session log and artifact versions have separate history surfaces.
- Compaction, provider-specific rendering, and formatting are intentionally out
  of the initial public surface. They can be added later as LEGO-block
  extensions once provider adapters and custom compaction strategies are
  designed.

Context entries are provider-neutral records. `message` is the common case,
but the entry model must allow system instructions, tool calls/results,
summaries, artifact references, media references, and provider-neutral
multimodal content.

Artifact verbs:

- `save(handle, input) -> {id, path, kind, size, version, created_at}`
- `load(handle, options?) -> {data}` lists artifact metadata
- `load(handle, pathOrId, options?) -> artifact version with inline data or a storage descriptor`
- artifact removal uses `delete(artId, {permanent: true})` or the file-surface
  `remove` helper

`save` accepts either path identity or artifact identity:

```ts
save(handle, {
  path: 'draft.md',
  kind: 'text/markdown',
  data: '# Draft',
  metadata: { source: 'agent' }
})

save(handle, {
  id: 'art_...',
  path: 'final.md',        // optional rename
  data: '# Final',         // optional new content
  ifVersion: 3
})
```

Rules:

- `id` targets an existing artifact and preserves identity.
- `path` without `id` upserts by current path inside the resolved workspace.
- changing `path` without changing data is still a new artifact version.
- `ifVersion` prevents silent overwrite; mismatch returns `conflict`.
- `path` is a relative POSIX path: no absolute path, no `..`.
- directories are prefixes in v2, not nodes.
- artifacts time travel through their own version chain; this is independent
  from session/context time travel.

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
    "bucket": "ultracontext",
    "endpoint": "https://<account>.r2.cloudflarestorage.com",
    "region": "auto",
    "key": "project-a/artifacts/art_.../v1"
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

Do not mount S3 as the database. Do not put SQLite on a remote or virtual
filesystem mount. Do not use JuiceFS as the core model.

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

- native NFS mount adapter over the same path projection;
- managed hosted service;
- local mirror daemon;
- event stream/watch for live propagation;
- CRDT/real-time collaborative text editing;
- structural sharing optimizations;
- token counting and model-specific budget helpers;
- provider adapters for prompt serialization.
