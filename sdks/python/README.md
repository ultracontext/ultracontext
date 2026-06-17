# ultracontext (Python)

The Python SDK wraps the Rust core for local use and provides a remote HTTP
client for parity with JS remote mode.

The public surface follows `../../core/CONTRACT.md`; names may use Python
idiom, but shapes and error codes must match.

Current status:

- `ultracontext/client.py` implements the public client with remote mode and
  local native mode.
- `native/` implements a PyO3 binding that calls the Rust core JSON dispatch.
- local mode uses `ultracontext._native.UltraContextCore` when the extension is
  installed; otherwise it raises a coded `UltraContextError`.
- local mode can use `content_dir` plus `inline_limit` to keep large artifacts
  outside the SQLite database.
- `materialize()` writes artifacts to a real directory and `sync_directory()`
  imports edited files back as new artifact versions.
- `export_snapshot()` / `export_changes()` and matching import calls provide a
  first sync/mirror path.

Build notes:

- `cargo check -p ultracontext-python-native` verifies the Rust binding crate.
- Wheel builds should use maturin from this directory so Python extension
  linker flags are applied correctly.

Local venv workflow:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install maturin
.venv/bin/maturin develop
.venv/bin/python -m unittest discover -s tests
```
