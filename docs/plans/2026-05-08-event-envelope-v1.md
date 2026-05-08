# Event Envelope v1 Implementation Plan

> **For Hermes:** Use strict TDD. Do not change production event behavior before a failing test proves the required behavior.

**Goal:** Finalize UltraContext native events as a small, versioned, privacy-safe, server-authoritative contract that agents, drivers, plugins, subscriptions, and the future scheduler can depend on.

**Architecture:** Keep the event log append-only and server-authoritative. Every event is a canonical `uc.event.v1` envelope. Large or sensitive payloads live as artifacts referenced by `payload_ref`; events carry only metadata, counts, labels, hashes, and causal IDs.

**Tech Stack:** Rust CLI in `src/lib.rs`, e2e tests in `tests/e2e.rs`, JSONL storage under `<remote_root>/events/events.jsonl`, local retry outbox under `~/.ultracontext/events/outbox/`.

---

## Non-negotiables

- Events are facts, not state dumps.
- Event schema is versioned from now on: `schema_version = "uc.event.v1"`.
- Native UC events are server-authoritative; local outbox is only retry/durability.
- Payloads larger than small metadata go to artifacts and are referenced by `payload_ref`.
- Never store raw prompts, transcripts, passwords, tokens, cookies, API keys, auth headers, or secret values inside event JSON.
- Every behavior change starts with a failing test.
- Keep v1 small. Do not build subscriptions, scheduler, plugin marketplace, or HTTP webhook server in this patch.

## Event Envelope v1

### Required fields

```text
schema_version
event_id
kind
source
subject
occurred_at
received_at
host
privacy
```

### Optional fields

```text
actor
run_id
trace_id
parent_event_id
priority
ok
payload_ref
payload_hash
counts
labels
error
```

### Required field meaning

- `schema_version`: event contract version. Initial value: `uc.event.v1`.
- `event_id`: globally unique event identity for idempotency/dedupe.
- `kind`: what happened, in simple dotted form, e.g. `agent.run.completed`, `session.closed`, `sync.failed`.
- `source`: component/driver/agent that emitted or observed the event, e.g. `hermes`, `chatgpt-ios-shortcut`, `github-webhook`.
- `subject`: stable thing the event is about, e.g. `repo:ultracontext`, `chatgpt:session:abc123`, `agent-run:hermes:xyz`.
- `occurred_at`: when it happened in the source system.
- `received_at`: when UltraContext accepted/committed it.
- `host`: machine/server/client that emitted or committed the event.
- `privacy`: one of `public`, `internal`, `metadata_only`, `sensitive_ref`.

## Initial canonical event kinds

Keep this list small for v1 docs and examples:

```text
uc.event.committed
uc.outbox.flush.started
uc.outbox.flush.completed
uc.outbox.flush.failed

agent.run.started
agent.run.completed
agent.run.failed
agent.artifact.created

session.opened
session.closed
sync.started
sync.completed
sync.failed

file.changed
git.commit.created
github.pr.opened

test.run.started
test.run.passed
test.run.failed
build.started
build.completed
build.failed
```

Provider-specific detail should usually be in `source`, `subject`, and `labels`, not in 500 different `kind` values.

Example:

```json
{
  "schema_version": "uc.event.v1",
  "kind": "session.closed",
  "source": "chatgpt-ios-shortcut",
  "subject": "chatgpt:session:abc123",
  "labels": { "provider": "chatgpt", "driver": "ios-shortcut" }
}
```

## External driver rule

A driver is any component that talks to a system outside UltraContext.

Driver contract:

```text
external input -> optional artifact -> canonical UC event envelope
```

Examples:

- GitHub webhook driver receives webhook JSON, stores raw webhook as artifact, emits `github.pr.opened` or `github.pr.updated`.
- ChatGPT iOS Shortcut driver observes open/close lifecycle, performs bounded sync, stores transcript artifact, emits `session.closed` / `sync.completed`.
- Claude/Codex watcher observes local session JSONL, writes derived markdown artifact, emits `session.closed` / `agent.artifact.created`.

External payloads do not go inline inside the event. Store them as artifacts and point via `payload_ref` + optional `payload_hash`.

## Task 1: Add schema/validation tests

**Objective:** Define Event Envelope v1 behavior in tests before implementation.

**Files:**
- Modify: `tests/e2e.rs`

**Tests to add:**

1. `event_emit_writes_schema_version_privacy_and_occurred_at`
   - Emits an event with `--privacy metadata_only` and `--occurred-at <timestamp>`.
   - Asserts emitted JSON contains:
     - `schema_version: "uc.event.v1"`
     - `occurred_at` equal to provided timestamp
     - `received_at` present
     - `privacy: "metadata_only"`
     - existing required fields still present.

2. `event_emit_rejects_invalid_event_envelope`
   - Missing/invalid required values fail cleanly.
   - Invalid `priority` outside 0-100 fails.
   - Invalid `privacy` fails.
   - Invalid `payload_hash` not starting with `sha256:` fails.

3. `event_emit_supports_labels_and_structured_error`
   - Emits labels via repeated flags, e.g. `--label provider=chatgpt --label driver=ios-shortcut`.
   - Emits structured error via `--error-class timeout --error-message "remote append timed out" --error-retryable true`.
   - Asserts output JSON has `labels` object and `error` object.

**Verification commands:**

```bash
cargo test --test e2e event_emit_writes_schema_version_privacy_and_occurred_at -- --nocapture
cargo test --test e2e event_emit_rejects_invalid_event_envelope -- --nocapture
cargo test --test e2e event_emit_supports_labels_and_structured_error -- --nocapture
```

Expected before implementation: FAIL for missing CLI flags/fields/validation.

## Task 2: Implement minimal Event Envelope v1

**Objective:** Make the tests pass with minimal changes.

**Files:**
- Modify: `src/lib.rs`

**Implementation notes:**

- Add fields to event rendering:
  - `schema_version`
  - `occurred_at`
  - `actor`
  - `trace_id`
  - `parent_event_id`
  - `payload_hash`
  - `privacy`
  - `labels`
  - structured `error` object.
- Preserve compatibility with existing flags:
  - `--error-class` may continue to work, but should render inside `error.class`.
- Default values:
  - `schema_version`: `uc.event.v1`
  - `occurred_at`: same generated timestamp as event creation if not provided
  - `privacy`: `metadata_only`
  - `priority`: existing default, but validated 0-100

**Verification commands:**

```bash
cargo test --test e2e event_emit_writes_schema_version_privacy_and_occurred_at -- --nocapture
cargo test --test e2e event_emit_rejects_invalid_event_envelope -- --nocapture
cargo test --test e2e event_emit_supports_labels_and_structured_error -- --nocapture
```

Expected after implementation: PASS.

## Task 3: Add idempotency/dedupe test

**Objective:** Prevent duplicated committed events by `event_id`.

**Files:**
- Modify: `tests/e2e.rs`

**Test to add:**

- `event_emit_is_idempotent_by_event_id`
  - Emits event with explicit `--event-id evt_test_duplicate`.
  - Emits same event id again.
  - Asserts server log contains exactly one line with that event id.
  - CLI should treat duplicate as success/idempotent, not fatal corruption.

**Verification command:**

```bash
cargo test --test e2e event_emit_is_idempotent_by_event_id -- --nocapture
```

Expected before implementation: FAIL if duplicate lines are appended.

## Task 4: Implement server-side/local dedupe

**Objective:** Make duplicate event append idempotent for local server root.

**Files:**
- Modify: `src/lib.rs`

**Implementation notes:**

- Before appending locally, scan current event log for matching `event_id`.
- If already present, return success and move outbox entry to sent if needed.
- Keep implementation simple for v1; stronger concurrent append locking can be a separate task.
- For SSH remote, document current limitation if dedupe cannot be safely implemented yet.

**Verification:**

```bash
cargo test --test e2e event_emit_is_idempotent_by_event_id -- --nocapture
cargo test
```

## Task 5: Update docs/versioning

**Objective:** Make the contract discoverable and maintainable.

**Files:**
- Modify: `README.md`
- Modify: `skills/ultracontext/SKILL.md`
- Modify or create: `docs/event-envelope-v1.md`
- Optionally update: `/Users/fabioroma/Documents/ultracontext-agent-runtime-architecture.md`

**Required docs content:**

- Event Envelope v1 fields.
- Required vs optional fields.
- External driver rule.
- Privacy rule.
- Initial canonical event kinds.
- Example events:
  - Hermes agent run completed.
  - ChatGPT iOS Shortcut session closed.
  - GitHub webhook PR opened.

**Verification:**

```bash
cargo test
cargo build --release
```

Manual smoke:

```bash
home=$(mktemp -d /tmp/uc-events-v1-home.XXXXXX)
root="$home/server-root"
HOME="$home" target/release/ultracontext init local --host-id events-v1-test --remote-root "$root" --no-sync --yes
HOME="$home" target/release/ultracontext event emit \
  --kind session.closed \
  --source chatgpt-ios-shortcut \
  --subject chatgpt:session:abc123 \
  --actor user:fabio \
  --privacy metadata_only \
  --label provider=chatgpt \
  --label driver=ios-shortcut \
  --payload-ref uc://artifacts/chatgpt/sessions/abc123.md
HOME="$home" target/release/ultracontext event tail --limit 1
HOME="$home" target/release/ultracontext event status
```

Expected:

- Event has `schema_version = uc.event.v1`.
- Event has privacy and labels.
- No real user config is mutated.
- Pending outbox is zero after successful local commit.

## Stop line

Stop after Event Envelope v1 + validation + docs + smoke test.

Do not implement subscriptions, interrupts, scheduler, external HTTP webhook server, plugin framework, or distributed locks in this pass.
