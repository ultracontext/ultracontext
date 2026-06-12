# UltraContext

The context SDK for AI: local-first SDKs backed by a single Rust core that manages the
context windows of agents and AI-powered applications.

## Language

**Local mode**:
The SDK running against an embedded SQLite file on a real filesystem, in-process.
_Avoid_: embedded mode, offline mode

**Remote mode**:
The SDK speaking the same op contract over HTTP to a server that owns the database.
_Avoid_: client mode, hosted mode

**Contract**:
The full op surface — ops, shapes, error codes, message strings — identical in every
language and mode; enforced mechanically by the fixture suite.
_Avoid_: API spec, protocol
