# Mount Adapters

Mount adapters are the native file surface for local agents. They are exposed
as `uc mount`. They are not the node store, not the content store, and not a
dependency of the Rust core.

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
versions, and conflicts. Blob bytes may live inline or in a local directory
through the configured content store.

## Save Semantics

Editors commonly save by writing a temp file and renaming it over the original:

1. write `draft.md.tmp`;
2. flush `draft.md.tmp`;
3. rename `draft.md.tmp` to `draft.md`.

The adapter must collapse that pattern into a new version of the existing
`draft.md` artifact when possible. It should not create a new artifact and
delete the old one unless there is no existing target artifact.

Direct overwrites save a new artifact version. If another writer advances the
artifact at the same time, the adapter surfaces that as a filesystem retry or
I/O error while preserving the underlying `conflict` domain code in logs and
diagnostics.

## Runtime Shape

The NFS adapter is the default `uc mount` backend:

```bash
cargo build -p ultracontext-cli
./target/debug/uc --db ./ultracontext.db mount ctx_... ./mnt
```

It runs an NFSv3 server bound to `127.0.0.1` on a high local port, then mounts
that export into the requested directory. On macOS this uses `/sbin/mount_nfs`;
on Linux it uses `mount -t nfs`. It does not require macFUSE or a kernel
extension.

The FUSE adapter remains available as an explicit backend behind the optional
`fuse` feature:

```bash
cargo build -p ultracontext-cli --features fuse
./target/debug/uc --db ./ultracontext.db mount ctx_... ./mnt --backend fuse
```

On macOS, the build host needs macFUSE/osxfuse available to `pkg-config`. On
Linux, the host needs libfuse/fuse3 development files. Without the feature, the
CLI still builds and `uc mount --backend fuse` returns a clear error.

Both adapters link to the Rust core and call the same operations as JS/Python
local bindings. They should never require S3-FUSE, JuiceFS, or a mounted remote
filesystem underneath.
