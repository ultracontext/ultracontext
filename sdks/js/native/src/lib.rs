use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::{Value, json};
use ultracontext::{ContentStore, S3ContentStore, UcError, UltraContext, UltraContextOptions};

#[napi]
pub struct UltraContextCore {
    inner: UltraContext,
}

#[napi(object)]
pub struct UltraContextCoreOptions {
    pub content_dir: Option<String>,
    pub inline_limit: Option<u32>,
    pub s3: Option<String>,
}

#[napi]
impl UltraContextCore {
    #[napi(constructor)]
    pub fn new(path: String, options: Option<UltraContextCoreOptions>) -> Result<Self> {
        let options = core_options(options);
        Ok(Self {
            inner: UltraContext::open_with_options(path, options).map_err(napi_error)?,
        })
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
    let Some(options) = options else {
        return UltraContextOptions::default();
    };
    let inline_limit = options.inline_limit.map(|value| value as usize);
    let content_store = if let Some(s3) = options.s3 {
        ContentStore::s3(parse_s3_config(&s3, inline_limit.unwrap_or(64 * 1024)))
    } else if let Some(content_dir) = options.content_dir {
        ContentStore::local_dir(content_dir, inline_limit.unwrap_or(64 * 1024))
    } else if let Some(inline_limit) = inline_limit {
        ContentStore::inline_with_limit(inline_limit)
    } else {
        ContentStore::inline()
    };
    UltraContextOptions { content_store }
}

fn parse_s3_config(input: &str, inline_limit: usize) -> S3ContentStore {
    let value = serde_json::from_str::<Value>(input).unwrap_or_else(|_| json!({}));
    S3ContentStore {
        endpoint: string_field(&value, "endpoint").unwrap_or_default(),
        bucket: string_field(&value, "bucket").unwrap_or_default(),
        region: string_field(&value, "region").unwrap_or_else(|| "auto".to_string()),
        access_key_id: string_field(&value, "accessKeyId")
            .or_else(|| string_field(&value, "access_key_id"))
            .unwrap_or_default(),
        secret_access_key: string_field(&value, "secretAccessKey")
            .or_else(|| string_field(&value, "secret_access_key"))
            .unwrap_or_default(),
        session_token: string_field(&value, "sessionToken")
            .or_else(|| string_field(&value, "session_token")),
        prefix: string_field(&value, "prefix"),
        inline_limit,
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(ToOwned::to_owned)
}

fn napi_error(error: UcError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("{}: {}", error.code_str(), error.message),
    )
}
