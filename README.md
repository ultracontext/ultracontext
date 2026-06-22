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

ultracontext is a context SDK for AI agents and apps. It gives you SQL-backed storage with superpowers. Manage context windows, sessions, and artifacts with auto-versioning, full-text search, and a portable filesystem you can mount anywhere.

One Rust core with thin JavaScript and Python SDKs. Same context, everywhere: local, server, or edge.

## Why

Databases and storage weren't built for AI. If we want to keep pushing the boundaries, we have to treat sessions, context windows, and artifacts as first-class citizens, not afterthoughts.

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

## Auto-versioning

Every change to a context is saved as a new snapshot. Edit, trim, clear, restore, or fork — agents move through history without ever losing it. It's version control for what the model sees.

## Files

Use `session.fs.read`, `write`, `grep`, and `glob` even when there is no real disk, or mount the workspace as a real folder so local agents and editors just work. Changes flow back as versioned artifacts.

## Search

Full-text search across your current context and text artifacts, returning snippets and ids.

## Own your data

Everything lives in SQLite locally, in plain, inspectable formats. Host it on Supabase, S3, R2, MinIO, or any Postgres- or S3-compatible provider, and serve the same model over HTTP for server and edge. No vendor lock-in.

## API

The full client surface lives in [`docs/api.md`](docs/api.md). Architecture and protocol notes are in [`docs/`](docs).

## License

Apache-2.0
