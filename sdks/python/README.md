# ultracontext (Python)

The Python SDK wraps the Rust core for local use and provides a remote HTTP
client for parity with JS remote mode.

The public surface follows `../../core/model/CONTRACT.md`; names may use Python
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
- `../../core/bindings-python/` implements the PyO3 binding that calls the Rust
  core JSON dispatch.
- local mode uses `ultracontext._native.UltraContextCore` when the extension is
  installed; otherwise it raises a coded `UltraContextError`.
- local mode can use `content_dir` plus `inline_limit` to keep large artifacts
  outside the SQLite database.
- local mode can use `s3={...}` to store large artifacts in S3/R2/MinIO through
  the Rust core content-store adapter.
- context-window operations are available through `session.context.*`.
- `uc.sync.export_snapshot()` / `uc.sync.export_changes()` and matching import
  calls provide a first sync/mirror path.

Example:

```py
from ultracontext import UltraContext

uc = UltraContext(mode="local", path=".ultracontext/ultracontext.db")
session = uc.sessions.create(metadata={"app": "demo"})
appended = session.context.append({"role": "user", "content": "hi"})

history = session.context.history()
session.context.clear(metadata={"reason": "reset window"})
session.context.restore(
    appended["context_id"],
    metadata={"reason": "time travel"},
)
```

S3/R2 local config:

```py
uc = UltraContext(
    mode="local",
    path=".ultracontext/ultracontext.db",
    inline_limit=64 * 1024,
    s3={
        "endpoint": "https://<account>.r2.cloudflarestorage.com",
        "bucket": "ultracontext",
        "region": "auto",
        "accessKeyId": "...",
        "secretAccessKey": "...",
        "prefix": "project-a",
    },
)
```

Build notes:

- `cargo check -p ultracontext-python-native` verifies the Rust binding crate.
- The PyO3 source crate lives at `../../core/bindings-python`; this package
  points maturin at that manifest.
- Wheel builds should use maturin from this directory so Python extension
  linker flags are applied correctly.

Local venv workflow:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install maturin
.venv/bin/maturin develop
.venv/bin/python -m unittest discover -s tests
```
