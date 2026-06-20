# ultracontext (Python)

The Python SDK wraps the Rust core for local use and provides a remote HTTP
client for parity with JS remote mode.

The public surface follows `../../core/CONTRACT.md`; names may use Python
idiom, but shapes and error codes must match.

CLI:

```sh
uvx ultracontext init
# or
pipx run ultracontext init
```

The Python package exposes an `ultracontext` console script and supports
`python -m ultracontext`. Both are thin launchers: they run a packaged/native
`uc` when present, fall back to `uc` on `PATH`, or download the matching
release binary to a temporary directory. The Rust CLI remains the source of
truth for `init`.

`init` adds the `ultracontext` dependency to `pyproject.toml` or
`requirements.txt` when it detects a Python project.

Current status:

- `ultracontext/client.py` implements the public client with remote mode and
  local native mode.
- `ultracontext/cli.py` implements the Python package launcher for
  `uvx ultracontext init`, `pipx run ultracontext init`, and
  `python -m ultracontext`.
- `native/` implements a PyO3 binding that calls the Rust core JSON dispatch.
- local mode uses `ultracontext._native.UltraContextCore` when the extension is
  installed; otherwise it raises a coded `UltraContextError`.
- local mode can use `content_dir` plus `inline_limit` to keep large artifacts
  outside the SQLite database.
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
