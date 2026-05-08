# UltraContext Runtime Primitives

This directory documents UltraContext runtime primitives as small, versioned contracts.

The goal is to avoid architecture drift: every primitive gets its own document with purpose, version, contract, storage model, CLI/API shape, examples, validation rules, and migration notes.

## Current primitives

| Primitive | Current doc | Status |
|---|---|---|
| Event Log / Event Envelope | `event-envelope-v1.md` | Implemented contract in this worktree; validate with e2e before release |
| Outbox / Retry Buffer | TBD | Existing minimal implementation, needs contract doc |
| Drivers / Adapters | TBD | Architecture defined, needs driver contract doc |
| Subscriptions / Interrupts | TBD | Planned |
| Locks / Semaphores / Leases | TBD | Planned |
| Checkpoints | TBD | Planned |
| Scheduler | TBD | Planned |
| Derived Indexes | TBD | Planned |

## Documentation rule

Before implementing or changing a primitive:

1. Create or update the primitive doc.
2. Write/adjust tests first.
3. Implement the smallest compatible change.
4. Update README/SKILL if user-facing behavior changed.
5. Add migration notes if the contract changed.

## Naming/versioning rule

Primitive docs should use this shape:

```text
docs/primitives/<primitive-name>-v<N>.md
```

Examples:

```text
docs/primitives/event-envelope-v1.md
docs/primitives/driver-contract-v1.md
docs/primitives/subscriptions-v1.md
```

A new major version is needed when old agents/drivers cannot safely emit/read the new contract.

## Contract template

Each primitive doc should include:

```markdown
# <Primitive> v<N>

## Purpose

## Status

## Non-goals

## Contract

## Storage

## CLI/API

## Examples

## Validation rules

## Privacy/security rules

## Compatibility/migration

## Tests required
```
