# ultracontext (JS)

The JS/TS SDK has two modes:

- remote fetch-only mode for edge/serverless runtimes;
- local native mode for Node/Bun apps, CLIs, and agents.

Both modes expose the same UltraContext surface from `../../core/CONTRACT.md`.
Remote mode must not import native bindings.

Current status:

- `src/index.js` implements the fetch-only remote client.
- `src/index.js` also supports local mode by lazily loading the N-API binding.
- `src/server.js` implements a fetch-compatible handler that dispatches the
  remote protocol to an injected engine/store.
- `src/sqlite-engine.js` implements a server-only reference engine using
  Node's built-in `node:sqlite`.
- `src/postgres-engine.js` implements a server-only Postgres engine over an
  injected `pool.query(sql, params)` interface.
- `src/content-store.js` implements local-dir, injected S3-compatible, and
  cached hybrid content stores.
- `src/materialize.js` writes artifact paths to a real local directory and can
  sync edited files back as artifact versions.
- `native/` implements a napi-rs binding that calls the Rust core JSON
  dispatch.

Remote client:

```js
import { UltraContext } from 'ultracontext'

const uc = new UltraContext({
    mode: 'remote',
    baseUrl: 'https://your-ultracontext-endpoint.example'
})
```

Self-hosted handler with SQLite:

```js
import { createUltraContextHandler } from 'ultracontext/server'
import { createSqliteEngine } from 'ultracontext/sqlite'
import { createLocalDirContentStore } from 'ultracontext/content-store'

const handler = createUltraContextHandler({
    engine: createSqliteEngine({
        path: './uc.sqlite',
        contentStore: createLocalDirContentStore({ root: './uc-blobs' }),
        inlineLimit: 64 * 1024
    })
})
```

Self-hosted handler with Postgres:

```js
import { Pool } from 'pg'
import { createUltraContextHandler } from 'ultracontext/server'
import { createHybridContentStore, createLocalDirContentStore, createS3ContentStore } from 'ultracontext/content-store'
import { createPostgresEngine } from 'ultracontext/postgres'

const remoteStore = createS3ContentStore({
    client: s3CompatibleClient,
    bucket: 'uc-artifacts'
})

const engine = createPostgresEngine({
    pool: new Pool({ connectionString: process.env.DATABASE_URL }),
    contentStore: createHybridContentStore({
        cache: createLocalDirContentStore({ root: './uc-cache' }),
        remote: remoteStore
    }),
    inlineLimit: 64 * 1024
})

await engine.install()

const handler = createUltraContextHandler({ engine })
```

Local native workflow:

```sh
npm install
npm run build:native
npm test
```

Local mode:

```js
import { UltraContext } from 'ultracontext'

const uc = new UltraContext({
    mode: 'local',
    path: './uc.sqlite',
    contentDir: './uc-blobs',
    inlineLimit: 64 * 1024
})
```

Materialization:

```js
import { materializeContext, syncDirectoryToContext } from 'ultracontext/materialize'

await materializeContext(uc, ctx.id, './workspace')
await syncDirectoryToContext(uc, ctx.id, './workspace')
```

Sync:

```js
const snapshot = await source.exportSnapshot()
await mirror.importSnapshot(snapshot)

const changes = await source.exportChanges({ since: snapshot.cursor })
await mirror.importChanges(changes)
```
