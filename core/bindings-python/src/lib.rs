use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use serde_json::{Value, json};
use ultracontext::{ContentStore, S3ContentStore, UcError, UltraContext, UltraContextOptions};

// Single documented inline-blob default (64 KiB), shared with the CLI; payloads at or
// below this size stay inline, larger ones spill to the configured backing store.
const DEFAULT_INLINE_LIMIT: usize = 64 * 1024;

#[pyclass(name = "UltraContextCore")]
struct PyUltraContext {
    inner: UltraContext,
}

#[pymethods]
impl PyUltraContext {
    // `inline_limit` is usize here (vs u32 in the JS binding): PyO3 maps Python ints to
    // native usize directly, so no boundary widening is needed on this side.
    #[new]
    #[pyo3(signature = (path, content_dir = None, inline_limit = None, s3 = None))]
    fn new(
        py: Python<'_>,
        path: &str,
        content_dir: Option<&str>,
        inline_limit: Option<usize>,
        s3: Option<&str>,
    ) -> PyResult<Self> {
        match UltraContext::open_with_options(path, core_options(content_dir, inline_limit, s3)) {
            Ok(inner) => Ok(Self { inner }),
            Err(error) => Err(py_init_error(py, error)),
        }
    }

    fn dispatch_json(&self, operation: &str, input: &str) -> String {
        let input = match serde_json::from_str::<Value>(input) {
            Ok(input) => input,
            Err(_) => {
                return json!({
                    "error": {
                        "code": "invalid_input",
                        "message": "Input must be valid JSON"
                    }
                })
                .to_string();
            }
        };

        match self.inner.dispatch_json(operation, input) {
            Ok(output) => json!({"ok": output}).to_string(),
            Err(error) => json!({"error": error.to_json()}).to_string(),
        }
    }
}

fn core_options(
    content_dir: Option<&str>,
    inline_limit: Option<usize>,
    s3: Option<&str>,
) -> UltraContextOptions {
    // One default inline limit everywhere; never the usize::MAX of bare `inline()`.
    let inline_limit = inline_limit.unwrap_or(DEFAULT_INLINE_LIMIT);

    let content_store = if let Some(s3) = s3 {
        let config = serde_json::from_str::<Value>(s3).unwrap_or_else(|_| json!({}));
        ContentStore::s3(S3ContentStore::from_json(&config, inline_limit))
    } else if let Some(content_dir) = content_dir {
        ContentStore::local_dir(content_dir, inline_limit)
    } else {
        ContentStore::inline_with_limit(inline_limit)
    };

    UltraContextOptions { content_store }
}

#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyUltraContext>()?;
    Ok(())
}

// Raise a RuntimeError whose instance carries `.code` = the structured ErrorCode,
// so the Python SDK reads the real code off the exception instead of parsing a string.
fn py_init_error(py: Python<'_>, error: UcError) -> PyErr {
    let code = error.code_str();
    let err = PyRuntimeError::new_err(error.message);
    let _ = err.value(py).setattr("code", code);
    err
}
