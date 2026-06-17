# FUSE Adapter

FUSE is the native file surface for local agents. It is not the node store, not
the content store, and not a dependency of the Rust core.

The adapter mounts one context as a directory tree:

```
ctx_.../
  drafts/brief.md
  uploads/screenshot.png
```

Every filesystem operation maps to the same artifact path verbs exposed by the
SDKs:

| Filesystem | UltraContext |
|---|---|
| `readdir` | `list(ctx, { prefix })` |
| `read` | `read(ctx, path, { version? })` |
| `write` + `flush` | `write(ctx, path, bytes, { ifVersion })` |
| `rename` | `move(ctx, from, to, { ifVersion })` |
| `unlink` | `remove(ctx, path, { ifVersion })` |
| path glob | `glob(ctx, pattern)` |
| text search | `grep(ctx, query, { prefix? })` |

The node store remains authoritative for identity, history, path labels,
versions, and conflicts. Blob bytes may live inline, in a local directory, or
in S3/R2/MinIO through the configured content store.

## Save Semantics

Editors commonly save by writing a temp file and renaming it over the original:

1. write `draft.md.tmp`;
2. flush `draft.md.tmp`;
3. rename `draft.md.tmp` to `draft.md`.

The adapter must collapse that pattern into a new version of the existing
`draft.md` artifact when possible. It should not create a new artifact and
delete the old one unless there is no existing target artifact.

Direct overwrites use the mounted file's known artifact version as
`ifVersion`. If another writer has advanced the artifact, the adapter returns a
filesystem error that preserves the underlying `conflict` domain code in logs
and diagnostics.

## Runtime Shape

The adapter can be a separate native binary or package feature. It should link
to the Rust core and call the same dispatch operations as JS/Python local
bindings. It should never require S3-FUSE, JuiceFS, or a mounted remote
filesystem underneath.
