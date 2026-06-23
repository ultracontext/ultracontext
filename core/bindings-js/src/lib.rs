use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::{Value, json};
use ultracontext::{ContentStore, S3ContentStore, UcError, UltraContext, UltraContextOptions};

// Single documented inline-blob default (64 KiB), shared with the CLI; payloads at or
// below this size stay inline, larger ones spill to the configured backing store.
const DEFAULT_INLINE_LIMIT: usize = 64 * 1024;

#[napi]
pub struct UltraContextCore {
    inner: UltraContext,
}

// `inline_limit` is u32 here (vs usize in the Python binding): the JS binding crosses a
// napi boundary where usize is unsupported, so we take u32 and widen to usize internally.
#[napi(object)]
#[derive(Default)]
pub struct UltraContextCoreOptions {
    pub content_dir: Option<String>,
    pub inline_limit: Option<u32>,
    pub s3: Option<String>,
}

#[napi]
impl UltraContextCore {
    #[napi(constructor)]
    pub fn new(env: &Env, path: String, options: Option<UltraContextCoreOptions>) -> Result<Self> {
        let options = core_options(options);

        // On failure, throw a JS error whose `.code` carries the structured ErrorCode
        // (not a "code: message" string), so the JS SDK can read the real code.
        match UltraContext::open_with_options(path, options) {
            Ok(inner) => Ok(Self { inner }),
            Err(error) => Err(napi_error(env, error)),
        }
    }

    #[napi(js_name = "dispatchJson")]
    pub fn dispatch_json(&self, operation: String, input: String) -> String {
        let input = match serde_json::from_str::<Value>(&input) {
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

        match self.inner.dispatch_json(&operation, input) {
            Ok(output) => json!({"ok": output}).to_string(),
            Err(error) => json!({"error": error.to_json()}).to_string(),
        }
    }
}

fn core_options(options: Option<UltraContextCoreOptions>) -> UltraContextOptions {
    let options = options.unwrap_or_default();

    // One default inline limit everywhere; never the usize::MAX of bare `inline()`.
    let inline_limit = options
        .inline_limit
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_INLINE_LIMIT);

    let content_store = if let Some(s3) = options.s3 {
        let config = serde_json::from_str::<Value>(&s3).unwrap_or_else(|_| json!({}));
        ContentStore::s3(S3ContentStore::from_json(&config, inline_limit))
    } else if let Some(content_dir) = options.content_dir {
        ContentStore::local_dir(content_dir, inline_limit)
    } else {
        ContentStore::inline_with_limit(inline_limit)
    };

    UltraContextOptions { content_store }
}

// Throw a JS Error carrying `.code = <ErrorCode>` and `.message`, then hand back a
// pending-exception marker so napi rethrows the one we built instead of a generic failure.
fn napi_error(env: &Env, error: UcError) -> Error {
    let _ = env.throw_error(&error.message, Some(error.code_str()));
    Error::new(Status::PendingException, error.message)
}
