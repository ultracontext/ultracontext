<div align="center">
  <a href="https://github.com/ultracontext/ultracontext">
    <img alt="ultracontext: control what agents see" src=".github/assets/context-sdk.png" width="100%">
  </a>
</div>

<div align="center">
  <h1>ultracontext</h1>

  <a href="https://github.com/ultracontext/ultracontext"><img alt="Made by ultracontext" src="https://img.shields.io/badge/MADE%20BY-ultracontext-000000.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://www.npmjs.com/package/ultracontext"><img alt="NPM version" src="https://img.shields.io/npm/v/ultracontext.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://pypi.org/project/ultracontext/"><img alt="PyPI version" src="https://img.shields.io/pypi/v/ultracontext.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://github.com/ultracontext/ultracontext/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/ultracontext/ultracontext.svg?style=for-the-badge&labelColor=000000"></a>
</div>

UltraContext is a context SDK for AI applications. It gives apps and agents one
place to manage sessions, model-facing context windows, artifacts, and
filesystem-like project files across local, server, and edge environments.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ultracontext/ultracontext/main/install.sh | bash
```

## Getting Started

From your project folder:

```bash
uc init
```

Store a session and manage its context window:

```ts
import { createClient } from 'ultracontext/local'

// Reads ultracontext.json from the current project.
const uc = createClient()
const session = await uc.sessions.create()

// Every context change is versioned automatically.
await session.context.append({
  role: 'user',
  content: 'Draft a launch note'
})

const context = await session.context.current()
```

Mount the same workspace as files for local agents:

```bash
uc mount ./UltraContext
```

## Top-Level Overview

Public client surface:

```ts
uc.workspaces.create({ metadata? })
uc.workspaces.list()

const session = await uc.sessions.create({ workspaceId?, metadata? })
uc.sessions.get(sessionId)
uc.sessions.list()
uc.sessions.delete(sessionId)
uc.sessions.fork(sessionId, { version?, metadata? })

session.context.current({ version? })
session.context.list({ version? })
session.context.append(entry | entry[])
session.context.update(patch | patch[], { metadata? })
session.context.delete(target | target[], { metadata? })
session.context.clear({ metadata? })
session.context.history()
session.context.restore(contextId, { metadata? })

session.artifacts.create({ path, data, kind?, metadata?, ifVersion? })
session.artifacts.list()
session.artifacts.get(pathOrId, { version? })
session.artifacts.update(pathOrId, data, { kind?, metadata?, ifVersion? })
session.artifacts.delete(pathOrId, { ifVersion? })

session.fs.list({ prefix? })
session.fs.read(pathOrId, { version? })
session.fs.write(path, data, { kind?, metadata?, ifVersion? })
session.fs.move(from, to, { ifVersion? })
session.fs.remove(pathOrId, { ifVersion? })
session.fs.glob(pattern)
session.fs.grep(query, { prefix? })

uc.search.query(query)
uc.sync.exportSnapshot()
uc.sync.importSnapshot(snapshot)
uc.sync.exportChanges({ since? })
uc.sync.importChanges(changes)
```

## Storage

UltraContext is backed by a SQL-backed node store. By default, local projects use
SQLite; remote deployments can expose the same model behind an HTTP endpoint.
The SQL store owns the durable truth: sessions, context history, artifact
metadata, paths, versions, provenance, and search indexes.

Artifact bytes are stored separately when they get large. Small text can stay
inline, while images, PDFs, audio, generated files, and other blobs can live in
a local directory or an S3-compatible object store such as S3, R2, or MinIO.

The same workspace can also be mounted as a filesystem:

```bash
uc mount ./UltraContext
```

That mount is a projection over the same storage, not a second source of truth.
Agents can use normal file workflows (`read`, `write`, `grep`, `glob`,
editors), while apps use the SDK against the same sessions and artifacts.

## Auto-Versioned Context

```text
                      ┌──────────────────────┐
                      │ session  ses_4f2e... │  stable conversation handle
                      └──────────────────────┘
                                 ▲
                ┌────────────────┼────────────────┐
                │                │                │
          ┌────────────┐     ┌────────────┐     ┌────────────┐
          │ context v0 │◄────│ context v1 │◄────│ context v2 │ ◄── current model view
          │ created    │     │ edited     │     │ trimmed    │
          └────────────┘     └────────────┘     └────────────┘
               ▲                ▲                ▲
               │                │                │
          ┌──────────┐     ┌──────────┐     ┌──────────┐
          │  msg_a   │     │  msg_a   │     │  msg_b'  │
          │   "hi"   │     │   "hi"   │     │  "hbu!"  │
          └──────────┘     └──────────┘     └──────────┘
               ▲                ▲
               │                │
          ┌──────────┐     ┌──────────┐
          │  msg_b   │     │  msg_b'  │
          │  "hbu?"  │     │  "hbu!"  │
          └──────────┘     └──────────┘

  v0: first model context · v1: edited b -> b' ·
  v2: trimmed a out of the context, without deleting history
```

Every context update creates a new snapshot automatically, so agents can edit,
clear, restore, and time-travel without losing history.

A session is the durable container for one conversation, run, or agent task. It
is the permanent handle you keep in app code. It owns lifecycle metadata, an
append-only log, context snapshots, subagent links, and artifact links.

A context is the model-facing view for that session. The current context
is the latest saved context for the session. Reads use the current context by
default. Use `session.context.history()` or `session.context.current({ version })`
to inspect older contexts.

`session.context.append`, `update`, `delete`, `clear`, and `restore` advance
the current context without rewriting older snapshots. `clear()` creates a new
empty current context. `restore(contextId)` creates a new current snapshot from
an older one; it does not move time backward in place.

Session deletion is permanent. It removes the session, its log, its context
snapshots, and its artifact links. It does not delete workspace artifacts.

Compaction, provider-specific rendering, and formatting are intentionally out of
the initial public surface. They can be added later as LEGO-block extensions.

## Artifacts

Artifacts are versioned, file-like objects owned by a workspace: markdown
drafts, generated code, screenshots, images, audio, PDFs, zip files, or any
other AI input/output.

`session.artifacts.create(input)` is convenience sugar: it creates a workspace
artifact and attaches it to the session. Artifacts do not belong to sessions and
are not deleted when a session is deleted.

## Remote And Edge

The default JS client is fetch-only and works in browser and edge runtimes:

```ts
import { createClient } from 'ultracontext'

const uc = createClient('/api/ultracontext')
```

Server runtimes use `createServerClient`. Next/App Router can expose the
official HTTP protocol with `createUltraContextNextHandler`.

## S3-Compatible Blobs

Configure S3-compatible storage when generated artifacts can become too large
for inline SQL storage:

```json
{
  "storage": {
    "driver": "s3",
    "inlineLimit": 65536,
    "s3": {
      "endpoint": "https://<account>.r2.cloudflarestorage.com",
      "bucket": "ultracontext",
      "region": "auto",
      "accessKeyId": "...",
      "secretAccessKey": "...",
      "prefix": "project-a"
    }
  }
}
```

## Search

Search is a recall operation over current context entries and current text
artifact versions. It returns snippets and ids; full content is read through a
targeted context, artifact, or filesystem call.

## Layout

| Dir | What |
|---|---|
| `core/` | Rust core, model, adapters, and language bindings |
| `cli/` | `uc` command-line interface and local NFS mount adapter |
| `docs/` | Protocol and implementation notes |
| `sdks/js` | JS/TS SDK, remote edge client, local N-API binding, server helpers |
| `sdks/python` | Python SDK, remote client, local PyO3 binding |

## License

Apache-2.0
