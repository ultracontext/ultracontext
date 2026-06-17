# MODEL - everything important is a node

UltraContext is a context and artifact store for AI applications. The core
model is not a filesystem and not an object-store wrapper. It is a small node
graph that can be projected into SDK calls, remote HTTP, local
materialization, and optional FUSE/native mounts.

The database is the source of truth for identity, history, metadata,
provenance, paths, and content references. Small text can live inline in the
database. Large bytes can live in a content store such as S3, R2, MinIO, or a
local directory, but those stores are never authoritative by themselves.

```
SDK / HTTP / local materialization / optional FUSE mount
              |
        path projection
              |
        node store
              |
   inline data or storage ref -> blob store
```

## The node

```
node {
    public_id   ctx_... | msg_... | art_...   // stable public handle
    kind        'context' | 'message' | 'artifact'
    content     {}                            // domain payload
    metadata    {}                            // caller labels
    prev        -> node before me in a list    // order / version chain
    parent      -> node I came from            // provenance / fork
    owner       -> owning root or head         // membership / cascade
    created_at  ISO-8601 UTC ms
}
```

There are four logical node roles, using three `kind` values:

| Role | `kind` | `owner` | Meaning |
|---|---|---|---|
| Root | `context` | `null` | Permanent context identity |
| Head | `context` | root id | One version of that context |
| Message | `message` | head id | One entry in one context version |
| Artifact | `artifact` | root id | A versioned file-like object owned by the context |

The whole model is two pointers:

- `prev` is order. Heads form a context version chain. Messages form the
  ordered list inside one head. Artifact versions form their own chain.
- `parent` is provenance. It points to the node this node was copied,
  forked, derived, cropped, regenerated, or edited from.

## Contexts and messages

A context root is the stable id callers hold. Reads choose a head: latest by
default, or an older head for time travel. Writes never edit an existing head.

- `append` adds messages to the current head without a version bump. Message
  streams are not history-worthy by themselves.
- `update` and soft `delete` create a new head. Old heads remain readable.
- `fork` creates a new root and copies the chosen source version, preserving
  provenance through `parent`.

Message content is provider-neutral JSON. A text-only prompt can be a simple
object. A multimodal prompt can reference artifacts:

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "What is wrong with this UI?" },
    { "type": "image", "artifact_id": "art_0123...", "version": 1 }
  ]
}
```

Provider adapters translate this shape into OpenAI, Anthropic, Gemini, or any
other model format. The core does not depend on provider payloads.

## Artifacts

Artifacts are file-like objects: markdown drafts, generated code, screenshots,
images, audio, PDFs, zip files, or any other AI input/output.

An artifact node's `content` carries the file-facing metadata:

```json
{
  "path": "drafts/brief.md",
  "kind": "text/markdown",
  "size": 1234,
  "sha256": "...",
  "storage": {
    "type": "inline"
  }
}
```

For larger or binary content:

```json
{
  "path": "uploads/screenshot.png",
  "kind": "image/png",
  "size": 89123,
  "sha256": "...",
  "storage": {
    "type": "ref",
    "driver": "s3",
    "key": "artifacts/art_.../v3"
  }
}
```

`art_` is the identity. `path` is a mutable label used by SDK file verbs,
agent tools, and filesystem projections. This matters:

- editing `draft.md` creates a new version of the same `art_`;
- renaming `draft.md` to `final.md` preserves history;
- editor save dances such as `draft.md.tmp` plus rename can be mapped back to
  a new version of the original artifact;
- two writers racing on the same artifact must produce a conflict or fork,
  never silent data loss.

Text artifacts usually store data inline. Images and large binaries usually
store bytes in a content store and keep only the `storage` ref in the node.
Either way, versioning and ownership are node-store responsibilities.

## Path Projection

The filesystem-like namespace is a projection over artifacts, not the storage
primitive. Paths are relative POSIX paths inside a context:

- normalize `/` separators;
- reject absolute paths and `..`;
- treat directories as prefixes in v2;
- keep path lookup separate from artifact identity.

The same path grammar must be used by SDK calls, local materialization, and
the native FUSE mount. A model can think in `read`, `write`, `grep`, and
`glob`; the only difference is whether the environment exposes those verbs as
API calls, a synced directory, or a mounted filesystem.

## Storage Blocks

The node store and content store are separate blocks.

Node store:

- local SQLite for local apps, CLIs, and agents;
- remote HTTP for edge runtimes such as Vercel Edge;
- future adapters can sit behind the same contract, but must preserve node
  invariants.

Content store:

- inline database content for small text and markdown;
- local directory for local cache or large local files;
- S3/R2/MinIO for shared blobs;
- cached hybrid local plus remote.

The content store can be swapped. The node store remains the source of truth.

## Invariants

- Public ids are stable handles. A caller should not need to know storage
  layout to hold an id.
- Existing rows are immutable. New versions append nodes.
- Time travel is a read concern: choose an older head or artifact version.
- Destructive delete is explicit and cascades through ownership.
- Blob stores never define existence. A blob without a node is garbage; a node
  with a missing blob is an integrity error.
- Provider-specific prompt shapes stay outside the model.
- File ergonomics are projections over artifacts, not a reason to make the
  core a distributed filesystem.
