# UltraContext

UltraContext is a context SDK for AI applications. It gives apps and agents one
place to manage sessions, model-facing context windows, artifacts, and
filesystem-like project files across local, server, and edge environments.

Why: AI apps outgrow a single prompt string quickly. They need durable history,
bounded model windows, generated files, multimodal inputs, local agent
workflows, and remote sync without forcing every app to invent its own context
store.

> Status: v2 active development. `core/MODEL.md` and `core/CONTRACT.md` are the
> product sources of truth. SDKs are thin consumers of Rust core operations.

## Quickstart

Initialize a project:

```bash
npx ultracontext init
```

This creates project-local state:

```text
ultracontext.json
.ultracontext/
  ultracontext.db
  blobs/
  .gitignore
```

Use it from a local/server runtime:

```ts
import { createServerClient } from 'ultracontext/ssr'

const uc = await createServerClient({ projectRoot: process.cwd() })
const session = await uc.sessions.create()

await session.context.append({
  role: 'user',
  content: 'Draft a launch note'
})

const entries = await session.context.current()
```

Expose it to a browser or edge app through HTTP:

```ts
// app/api/ultracontext/[...path]/route.ts
import { createUltraContextNextHandler } from 'ultracontext/next'

export const { GET, POST, PATCH, DELETE } =
  createUltraContextNextHandler({ projectRoot: process.cwd() })
```

```ts
import { createClient } from 'ultracontext'

const uc = createClient('/api/ultracontext')
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

## Sessions

A session is the durable container for one conversation, run, or agent task. It
owns lifecycle metadata, an append-only log, context snapshots, subagent links,
and session-artifact attachments.

Session deletion is permanent. It removes the session, its log, its context
snapshots, and its session-artifact attachments. It does not delete workspace
artifacts.

## Context Windows

The context window is the model-facing window for a session.
`session.context.append`, `update`, `delete`, `clear`, and `restore` advance
that window while preserving the durable session log and context revision
history.

`session.context.clear()` creates a new empty current window.
`session.context.history()` lists context-window snapshots.
`session.context.restore(contextId)` creates a new current snapshot based on an
older snapshot; it does not move time backward in place.

Compaction, provider-specific rendering, and formatting are intentionally out of
the initial public surface. They can be added later as LEGO-block extensions.

## Entries

Context entries are provider-neutral records. The common case is a chat message,
but entries can also represent system instructions, tool calls/results,
summaries, artifact references, media references, and multimodal content.

```ts
await session.context.append({
  role: 'user',
  content: [
    { type: 'text', text: 'What is wrong with this UI?' },
    { type: 'image', artifactId: 'art_...' }
  ]
})
```

## Artifacts

Artifacts are versioned, file-like objects owned by a workspace: markdown
drafts, generated code, screenshots, images, audio, PDFs, zip files, or any
other AI input/output.

`session.artifacts.create(input)` is convenience sugar: it creates a workspace
artifact and attaches it to the session. Artifacts do not belong to sessions and
are not deleted when a session is deleted.

## Filesystem API

`uc.fs.*` is a path projection over workspace artifacts. It gives agents and
edge apps familiar file verbs even when there is no real filesystem.

The same path grammar backs SDK calls and `uc mount`. Paths are relative POSIX
paths inside a workspace.

## Local Mount

`uc mount <dir>` projects a workspace into a local filesystem using the native
NFS adapter. This is for local agents, laptops, workstations, and servers that
benefit from real `read`, `write`, `grep`, `glob`, and editor workflows.

## Remote And Edge

The default JS client is fetch-only and works in browser and edge runtimes:

```ts
import { createClient } from 'ultracontext'

const uc = createClient('/api/ultracontext')
```

Server runtimes use `createServerClient`. Next/App Router can expose the
official HTTP protocol with `createUltraContextNextHandler`.

## Storage Blocks

The node store owns truth: identity, history, metadata, paths, provenance, and
content references. Content stores hold bytes behind artifact versions. Inline
text, local directories, and S3-compatible object stores are implemented in the
Rust core today.

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
| `core/` | Rust core, model, and product contract |
| `cli/` | `uc` command-line interface and local NFS mount adapter |
| `docs/` | Protocol and implementation notes |
| `sdks/js` | JS/TS SDK, remote edge client, local N-API binding, server engines |
| `sdks/python` | Python SDK, remote client, local PyO3 binding |

## License

Apache-2.0
