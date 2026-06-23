//! S3 blob driver: PUT/GET/DELETE over a SigV4-signed `ureq` request.

use std::io::Read;

use super::sigv4::signed_s3_request;
use super::{S3ContentStore, content_key};
use crate::error::{ErrorCode, UcError, UcResult};

pub(crate) fn s3_ref_key(config: &S3ContentStore, artifact_id: &str, version: usize) -> String {
    let key = content_key(artifact_id, version);
    match config
        .prefix
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(prefix) => format!("{}/{}", prefix.trim_matches('/'), key),
        None => key,
    }
}

pub(crate) fn s3_put(config: &S3ContentStore, key: &str, bytes: &[u8], kind: &str) -> UcResult<()> {
    let request = signed_s3_request(config, "PUT", key, bytes)?;
    let response = ureq::put(&request.url)
        .set("host", &request.host)
        .set("authorization", &request.authorization)
        .set("x-amz-content-sha256", &request.payload_hash)
        .set("x-amz-date", &request.amz_date)
        .set("content-type", kind);
    let response = if let Some(token) = config.session_token.as_deref() {
        response.set("x-amz-security-token", token)
    } else {
        response
    };
    response.send_bytes(bytes).map(|_| ()).map_err(s3_error)
}

pub(crate) fn s3_get(config: &S3ContentStore, key: &str) -> UcResult<Vec<u8>> {
    let request = signed_s3_request(config, "GET", key, &[])?;
    let response = ureq::get(&request.url)
        .set("host", &request.host)
        .set("authorization", &request.authorization)
        .set("x-amz-content-sha256", &request.payload_hash)
        .set("x-amz-date", &request.amz_date);
    let response = if let Some(token) = config.session_token.as_deref() {
        response.set("x-amz-security-token", token)
    } else {
        response
    };
    let response = response.call().map_err(s3_error)?;
    let mut reader = response.into_reader();
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).map_err(super::io_error)?;
    Ok(bytes)
}

pub(crate) fn s3_delete(config: &S3ContentStore, key: &str) -> UcResult<()> {
    let request = signed_s3_request(config, "DELETE", key, &[])?;
    let response = ureq::delete(&request.url)
        .set("host", &request.host)
        .set("authorization", &request.authorization)
        .set("x-amz-content-sha256", &request.payload_hash)
        .set("x-amz-date", &request.amz_date);
    let response = if let Some(token) = config.session_token.as_deref() {
        response.set("x-amz-security-token", token)
    } else {
        response
    };
    match response.call() {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(404, _)) => Ok(()),
        Err(error) => Err(s3_error(error)),
    }
}

fn s3_error(error: ureq::Error) -> UcError {
    match error {
        // A missing object is a real NotFound, not an internal assert.
        ureq::Error::Status(404, _) => {
            UcError::new(ErrorCode::NotFound, "Content ref points to a missing blob")
        }
        // Other HTTP statuses are server-side and retryable from the caller's view.
        ureq::Error::Status(status, response) => {
            let body = response
                .into_string()
                .unwrap_or_else(|_| "S3 request failed".to_string());
            UcError::new(
                ErrorCode::Busy,
                format!("S3 request failed with HTTP {status}: {body}"),
            )
        }
        // Network/transport faults are transient; surface them as retryable.
        ureq::Error::Transport(error) => UcError::new(ErrorCode::Busy, error.to_string()),
    }
}
