# MODEL — everything is a node

The whole engine is one table and two pointers. If you understand this page,
you understand UltraContext.

```
                      ┌──────────────────────┐
                      │   root   ctx_4f2e…   │   the permanent id — what you hold
                      └──────────────────────┘
                                 ▲
                ┌────────────────┼────────────────┐  context_id (membership)
                │                │                │
          ┌──────────┐     ┌──────────┐     ┌──────────┐
          │ head  v0 │◄────│ head  v1 │◄────│ head  v2 │ ◄── CURRENT
          │ {create} │ prev│ {update} │ prev│ {delete} │     (nothing points at it)
          └──────────┘     └──────────┘     └──────────┘
                ▲                ▲                ▲          context_id (membership)
                │                │                │
          msg_a ← msg_b    msg_a ← msg_b'       msg_b'
            (prev chain)         │
                                 └─ parent_id → msg_b  ("I came from b")
```

Reads walk left to right in time; every write adds a new head on the right.
Nothing is ever mutated — old heads keep their old message lists forever.

## The node

```
node {
    public_id   ctx_… | msg_…     // 24 lowercase hex chars after the prefix
    type        'context' | 'message'
    content     {}                 // free-form JSON — yours
    metadata    {}                 // free-form JSON — yours
    prev_id     →  the node before me in a list      (order)
    parent_id   →  the node I was derived from       (provenance)
    context_id  →  which chain I belong to           (membership)
    created_at
}
```

Three kinds of node, distinguished by two fields:

| Kind | `type` | `context_id` |
|---|---|---|
| **Root** — the context's permanent identity | `context` | `null` |
| **Head** — one version of that context | `context` | root's id |
| **Message** — one entry in a version | `message` | head's id |

## The two pointers

**`prev_id` is order** — for any list. Messages in a version form a
singly-linked list, and the heads of a context form the version chain the
same way:

```
null ← msg_a ← msg_b ← msg_c        (messages within a version)
null ← head v0 ← head v1 ← head v2  (versions within a context)
```

No position numbers stored — `index` and `version` are computed by walking.
The CURRENT head is the one no other head points at.

**`parent_id` is provenance** — "where I came from", across lists:

- a forked root's `parent_id` → the source root
- a copied/patched message's `parent_id` → the original message
- a plain create / a brand-new message → `null`

## Everything falls out of the two pointers

- **Version** = a head = an edit checkpoint. `append` extends the CURRENT
  head's list (no new head — the stream is not history-worthy); `update` and
  `delete` create a new head. The version log = walking the head chain
  (index 0 = create, ascending). A version freezes the moment it is
  superseded by the next head.
- **Time-travel** = read from an older head: `get(id, {version: 1})`,
  `{at: index}`, `{before: timestamp}`.
- **Fork** = a new root (`parent_id` → source root) with the chosen version's
  messages copied under its first head — each copy's `parent_id` points at
  the source message, so provenance survives.
- **Soft delete** = just another version: a new head without the deleted
  messages. Recover by reading the previous head. No tombstones, no flags.
- **Update** = copy-on-write: a new head with the full message list re-issued
  under it — every copy's `parent_id` → its original (the patched ones carry
  the new content). Storage trades space for dead-simple reads; edits are
  rare in agent workloads, and structural sharing (git's tree trick) can
  replace the copy later without touching the API.

## The one destructive op — and why nothing is left behind

`delete({permanent: true})` is the only thing that ever removes rows: the
root, every head, every message — scrubbed from all versions. Forks of the
deleted context survive, orphaned (`parent_id` cleared to `null`).

No-orphans is enforced by the SCHEMA, not by op code:

- `context_id` is a self-referential foreign key with **ON DELETE CASCADE** —
  deleting the root cascades to every head, and each head cascades to its
  messages. The database cannot represent a member of a deleted chain.
- `parent_id` is a foreign key with **ON DELETE SET NULL** — provenance
  pointers to scrubbed nodes become `null` automatically. Forks orphan
  cleanly, never dangle.
- The whole scrub runs in one transaction (`foreign_keys=ON` always set),
  and a cargo test pins the invariant: after any permanent delete, zero
  nodes whose `context_id` resolves to nothing.

## Invariants (port these exactly)

- A root never changes: id and `created_at` are set at create; list/get read
  them from the root, not the head.
- `update`/`delete` = one new head = one version bump. `append` never bumps —
  it extends the current head's list (an array appends atomically, in order).
- Head selection: the head no other head points at; ties broken by newest
  `created_at`.
- Broken chain (can't walk all nodes from `null`): fall back to `created_at`
  ascending, log loudly, never drop nodes, never error.
- Heads' `metadata` carries the reserved keys `operation` + `affected`; user
  version-metadata lives alongside them and is returned without the reserved
  keys.

## Why this model

One concept instead of five tables. Append-only, so history is free instead
of being a feature. The file stays plain SQLite — open it, walk the pointers
yourself, audit everything. It's git for context: a content log + cheap
pointers.
