use pyo3::prelude::*;
use serde_json::{Value, json};
use ultracontext::{ContentStore, UcError, UltraContext, UltraContextOptions};

#[pyclass(name = "UltraContextCore")]
struct PyUltraContext {
    inner: UltraContext,
}

#[pymethods]
impl PyUltraContext {
    #[new]
    #[pyo3(signature = (path, content_dir = None, inline_limit = None))]
    fn new(path: &str, content_dir: Option<&str>, inline_limit: Option<usize>) -> PyResult<Self> {
        Ok(Self {
            inner: UltraContext::open_with_options(path, core_options(content_dir, inline_limit))
                .map_err(py_init_error)?,
        })
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

fn core_options(content_dir: Option<&str>, inline_limit: Option<usize>) -> UltraContextOptions {
    let content_store = if let Some(content_dir) = content_dir {
        ContentStore::local_dir(content_dir, inline_limit.unwrap_or(64 * 1024))
    } else if let Some(inline_limit) = inline_limit {
        ContentStore::inline_with_limit(inline_limit)
    } else {
        ContentStore::inline()
    };
    UltraContextOptions { content_store }
}

#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyUltraContext>()?;
    Ok(())
}

fn py_init_error(error: UcError) -> PyErr {
    pyo3::exceptions::PyRuntimeError::new_err(format!("{}: {}", error.code_str(), error.message))
}
