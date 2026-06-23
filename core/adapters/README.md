# Adapters

This directory marks the adapter boundary for pluggable infrastructure:

- node stores: SQLite today, Postgres later;
- content stores: inline, local directory, S3/R2/MinIO today;
- search stores: FTS5 is the live primary path, with a substring scan fallback when FTS5 is unavailable;
- sync transports: snapshot/change import/export today, remote sync later.

The concrete implementations still live in `core/engine` for now. Split them
into real Rust crates here only when the engine becomes hard to reason about or
a backend needs independent testing/release boundaries.
