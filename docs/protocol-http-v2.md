# UltraContext HTTP Protocol v2

This protocol is the remote transport shape used by the JS and Python SDKs.
It mirrors the Rust core JSON dispatch operations, but uses fetch-compatible
HTTP routes so edge/serverless apps do not need native bindings or SQLite.

## Conventions

- Base path: `/v2`
- Request body: JSON object unless the method is `GET`
- Success response: JSON value for the operation
- Error response:

```json
{
  "error": {
    "code": "not_found",
    "message": "Context not found"
  }
}
```

Domain error codes stay stable across SDKs:

| Code | HTTP status |
|---|---:|
| `invalid_input` | 400 |
| `not_found` | 404 |
| `conflict` | 409 |
| `busy` | 503 |
| `incompatible_db` | 500 |
| `internal` | 500 |

## Workspaces

### Create Workspace

`POST /v2/workspaces`

```json
{
  "metadata": {
    "name": "project"
  }
}
```

Returns `{ "id": "ws_...", "metadata": {}, "created_at": "..." }`.

### List Workspaces

`GET /v2/workspaces`

Returns `{ "data": [...] }`.

## Sessions

Sessions are append-only logs inside a workspace. Each session owns a chain of
context snapshots; the current context window is the latest snapshot in that
chain.

### Create Session

`POST /v2/workspaces/:workspaceId/sessions`

```json
{
  "metadata": {
    "name": "agent run"
  }
}
```

Returns:

```json
{
  "id": "ses_...",
  "workspace_id": "ws_...",
  "context_id": "ctx_...",
  "metadata": {},
  "created_at": "2026-06-17T00:00:00.000Z"
}
```

## Context Handles

Simple clients can keep using context-shaped routes as the main surface. Under
the hood, `POST /v2/contexts` creates a session plus an initial context
snapshot in the default workspace unless a `workspaceId` is supplied.

The route parameter is named `:contextId` for compatibility, but it accepts
either a `ses_...` session id or a `ctx_...` context snapshot id. New clients
should treat the returned `id` as an opaque session/context handle.

### Create Context

`POST /v2/contexts`

```json
{
  "workspaceId": "ws_...",
  "metadata": {
    "app": "demo"
  }
}
```

Returns:

```json
{
  "id": "ses_...",
  "metadata": {
    "app": "demo"
  },
  "created_at": "2026-06-17T00:00:00.000Z"
}
```

### List Contexts

`GET /v2/contexts`

Returns:

```json
{
  "data": [
    {
      "id": "ses_...",
      "metadata": {},
      "created_at": "2026-06-17T00:00:00.000Z"
    }
  ]
}
```

### Fork Session Context

`POST /v2/contexts/:contextId/fork`

```json
{
  "version": 0,
  "metadata": {
    "name": "fork"
  }
}
```

Returns a new session/context handle.

### Append Messages

`POST /v2/contexts/:contextId/messages`

```json
{
  "messages": [
    {
      "role": "user",
      "content": "draft this"
    }
  ]
}
```

The server also accepts a single message object as the body. The SDKs normalize
single messages into `messages: [...]`.

Returns:

```json
{
  "data": [
    {
      "id": "msg_...",
      "index": 0,
      "role": "user",
      "content": "draft this",
      "metadata": {},
      "created_at": "2026-06-17T00:00:00.000Z"
    }
  ],
  "version": 0
}
```

### Read Context

`POST /v2/contexts/:contextId/get`

```json
{
  "version": 0
}
```

`version` is optional. Omit it to read the latest context snapshot.

### Update Message

`POST /v2/contexts/:contextId/update`

```json
{
  "updates": {
    "index": 0,
    "content": "updated text"
  },
  "metadata": {
    "reason": "edit"
  }
}
```

`updates` may be a single object or an array; current alpha semantics apply
the first update.

### Delete Messages Or Session

`POST /v2/contexts/:contextId/delete`

Delete messages:

```json
{
  "target": {
    "index": 0
  },
  "metadata": {
    "reason": "cleanup"
  }
}
```

Delete a whole session permanently:

```json
{
  "target": {
    "permanent": true
  }
}
```

## Artifacts

Artifacts live in the workspace. Context-scoped artifact routes are a simple
API convenience: the server resolves the session from `:contextId`, resolves
that session's workspace, and then applies the file/artifact operation in that
workspace. Deleting a session does not delete workspace artifacts.

### Save Artifact

`POST /v2/contexts/:contextId/artifacts`

```json
{
  "path": "draft.md",
  "kind": "text/markdown",
  "data": "# Draft",
  "metadata": {
    "source": "agent"
  },
  "ifVersion": 0
}
```

To update an existing artifact identity, include `id`.

Returns artifact metadata:

```json
{
  "id": "art_...",
  "path": "draft.md",
  "kind": "text/markdown",
  "size": 7,
  "version": 0,
  "created_at": "2026-06-17T00:00:00.000Z"
}
```

### List Artifacts

`GET /v2/contexts/:contextId/artifacts`

Returns `{ "data": [...] }`.

### Load Artifact

`POST /v2/contexts/:contextId/artifacts/load`

```json
{
  "pathOrId": "draft.md",
  "version": 0
}
```

Returns artifact data:

```json
{
  "id": "art_...",
  "path": "draft.md",
  "kind": "text/markdown",
  "size": 7,
  "version": 0,
  "metadata": {},
  "storage": {
    "type": "inline"
  },
  "data": "# Draft",
  "created_at": "2026-06-17T00:00:00.000Z"
}
```

`version` here is the artifact version. It is independent from context snapshot
versions.

## File Verbs

File verbs are path projections over artifacts.

| Method | Route | Body |
|---|---|---|
| `POST` | `/v2/contexts/:contextId/files/read` | `{ "pathOrId": "draft.md", "version": 0 }` |
| `POST` | `/v2/contexts/:contextId/files/write` | `{ "path": "draft.md", "data": "...", "kind": "text/markdown", "ifVersion": 0 }` |
| `POST` | `/v2/contexts/:contextId/files/move` | `{ "fromPathOrId": "draft.md", "toPath": "final.md", "ifVersion": 0 }` |
| `POST` | `/v2/contexts/:contextId/files/remove` | `{ "pathOrId": "final.md", "ifVersion": 1 }` |
| `POST` | `/v2/contexts/:contextId/files/glob` | `{ "pattern": "notes/*.md" }` |
| `POST` | `/v2/contexts/:contextId/files/grep` | `{ "query": "launch", "prefix": "notes" }` |

## Search

`POST /v2/search`

```json
{
  "query": "launch"
}
```

Returns snippets for current message content and current text artifact
versions.

## Sync

Sync routes are for self-hosted endpoints that expose mirror operations. They
are intentionally snapshot/change based, not filesystem mounts.

### Export Snapshot

`POST /v2/sync/export_snapshot`

```json
{}
```

Returns:

```json
{
  "schema": "ultracontext.snapshot.v1",
  "cursor": 42,
  "nodes": []
}
```

### Import Snapshot

`POST /v2/sync/import_snapshot`

Request body is a snapshot. Returns:

```json
{
  "imported": 42,
  "skipped": 0,
  "conflicts": []
}
```

### Export Changes

`POST /v2/sync/export_changes`

```json
{
  "since": 42
}
```

Returns:

```json
{
  "schema": "ultracontext.changes.v1",
  "since": 42,
  "cursor": 51,
  "nodes": []
}
```

### Import Changes

`POST /v2/sync/import_changes`

Request body is a changes object. Returns an import report:

```json
{
  "imported": 9,
  "skipped": 0,
  "conflicts": [
    {
      "id": 12,
      "public_id": "art_...",
      "kind": "artifact",
      "reason": "node_id_conflict"
    }
  ]
}
```

The alpha conflict detector reports structural `node.id` collisions with
different content. It does not perform CRDT merges.
