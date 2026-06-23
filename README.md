<div align="center">
  <a href="https://github.com/ultracontext/ultracontext">
    <img alt="ultracontext: control what agents see" src=".github/assets/context-sdk.png" width="100%">
  </a>
</div>

<div align="center">
  <h1>ultracontext</h1>

  <a href="https://github.com/ultracontext/ultracontext/tree/main/docs"><img alt="Docs" src="https://img.shields.io/badge/DOCS-000000.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://www.npmjs.com/package/ultracontext"><img alt="NPM version" src="https://img.shields.io/npm/v/ultracontext.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://pypi.org/project/ultracontext/"><img alt="PyPI version" src="https://img.shields.io/pypi/v/ultracontext.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://github.com/ultracontext/ultracontext/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/ultracontext/ultracontext.svg?style=for-the-badge&labelColor=000000"></a>
</div>

ultracontext is a context SDK for AI. You get SQL-backed storage for sessions, context windows, and artifacts. Everything is auto-versioned, searchable, and mountable as a filesystem, across local, server, and edge. A Rust core with thin JavaScript and Python SDKs.

## Why

Databases and storage weren't built for AI. If we want to keep pushing the boundaries, we have to treat sessions, context windows, and artifacts as first-class citizens, not afterthoughts.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ultracontext/ultracontext/main/install.sh | bash
```

## Getting started

From your project folder, `uc init`, then open a session and build context:

```ts
import { createClient } from 'ultracontext/local'
const uc = createClient()

const session = await uc.sessions.create() // v0

// Append messages (schemaless). Appending doesn't fork the window — still v0.
await session.context.append({ role: 'user', content: '...' })
await session.context.append({ role: 'assistant', content: '...' })
```

## Edit anything, lose nothing

Edit a message and the old window doesn't vanish — it's saved as a new version. Go back to any point, or fork a branch from it.

```ts
// Edit message 0. The previous window is kept as v1.
await session.context.update({ index: 0, content: 'New system prompt' })

// Read an old version, or fork a branch from any point.
const { data } = await session.context.get({ version: 0 })
const branch = await session.fork({ version: 1 })

// Use the messages with any LLM framework or agent SDK.
const response = await generateText({ model, messages: data })
```

## Mount as a filesystem

ultracontext projects workspace artifacts into a portable filesystem. Mount it, and agents or editors work with real files — every change flows back into storage, auto-versioned.

```bash
uc mount ./UltraContext
```

Now your workspace is just folders and files:

```text
UltraContext/
├── artifacts/
│   ├── launch.md
│   ├── architecture.png
│   └── benchmarks.csv
├── skills/
│   ├── code-review/
│   │   └── SKILL.md
│   └── summarize/
│       └── SKILL.md
└── plans/
    ├── roadmap.md
    └── auth-migration.md
```

No disk? Reach the same files over the API — `read`, `write`, `grep`, `glob` — anywhere, including the edge.

```ts
await session.fs.write('plans/launch.md', '# Launch')
const plan = await session.fs.read('plans/launch.md')
```

Every change is versioned automatically, and storage and mount stay in sync.

## Offload to artifacts

Artifacts are the files models produce — plans, code, images, markdown. They live in the workspace and version themselves, so an overwritten file is never lost. Offloading bulky output keeps context windows lean and models sharp.

```ts
// Save the model's output as an artifact. Edit it later and it versions itself.
const artifact = await session.artifacts.create({ path: 'plans/launch.md', data: response.text })
```

Better still, give the model the tools and let it read and write artifacts itself through `session.artifacts.*` — or mount the workspace and let it use real files.

## Search

Full-text search across your sessions and text files, in one query.

```bash
uc search "launch notes"      # give your agents the CLI
```

```ts
await uc.search.query('launch notes')   // or the SDK
```

You get back a snippet plus an id — a message in a context, or a file path. Read the full content with a targeted `session.context` or `session.fs` read.

## Advanced context engineering

Because every version of every session is queryable on demand, context becomes programmable. Recover a window the agent compacted and hand it to a fresh subagent; let parallel subagents read each other's context live as they work. The [docs](https://github.com/ultracontext/ultracontext/tree/main/docs) have working examples.

## Under the hood

Everything is a node. Edit one and you get a new version that points back to the last — nothing is overwritten. The newest is the HEAD, what the model sees.

```text
session  ses_4f2e···                  the handle you keep
│
├─ context v0                         older versions, still readable
├─ context v1
└─ context v2  ◄── HEAD                the current window → sent to the model
      ├─ user       "summarize the spec"
      ├─ assistant  "here's a summary…"
      └─ user       "now draft the PR"
```

Workspaces, sessions, contexts, messages, and artifacts — all the same node.

That's the whole engine. It's entirely written in Rust. The full graph is in the [docs](https://github.com/ultracontext/ultracontext/tree/main/docs).

## It belongs to you

Your context is a plain SQLite file. No lock-in, no black box. It's yours.

```bash
sqlite3 .ultracontext/ultracontext.db .tables
```

Host it on Supabase, S3, R2, MinIO, or any Postgres- or S3-compatible provider, and serve the same model over HTTP for server and edge. We plan to eventually offer a managed cloud, but that's not the priority right now.

## License

Apache-2.0
