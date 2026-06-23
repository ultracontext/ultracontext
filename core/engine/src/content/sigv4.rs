//! AWS SigV4 request signing for the S3 content driver (no AWS SDK dependency).

use sha2::{Digest, Sha256};
use url::Url;

use super::S3ContentStore;
use crate::error::{ErrorCode, UcError, UcResult};
use crate::idtime::now_iso;

type HmacSha256 = hmac::Hmac<Sha256>;
use hmac::Mac;

pub(crate) struct SignedS3Request {
    pub url: String,
    pub host: String,
    pub payload_hash: String,
    pub amz_date: String,
    pub authorization: String,
}

pub(crate) fn signed_s3_request(
    config: &S3ContentStore,
    method: &str,
    key: &str,
    payload: &[u8],
) -> UcResult<SignedS3Request> {
    let endpoint = config.endpoint.trim_end_matches('/');
    let bucket = uri_encode(&config.bucket, true);
    let encoded_key = uri_encode(key, false);
    let canonical_uri = format!("/{bucket}/{encoded_key}");
    let url = format!("{endpoint}{canonical_uri}");
    let parsed = Url::parse(&url).map_err(|error| {
        UcError::new(
            ErrorCode::InvalidInput,
            format!("Invalid S3 endpoint or key: {error}"),
        )
    })?;
    let host = match (parsed.host_str(), parsed.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        _ => {
            return Err(UcError::new(
                ErrorCode::InvalidInput,
                "Invalid S3 endpoint host",
            ));
        }
    };

    let payload_hash = sha256_hex(payload);
    let (date_stamp, amz_date) = amz_dates();
    let signed_headers = if config.session_token.is_some() {
        "host;x-amz-content-sha256;x-amz-date;x-amz-security-token"
    } else {
        "host;x-amz-content-sha256;x-amz-date"
    };
    let mut canonical_headers =
        format!("host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n");
    if let Some(token) = config.session_token.as_deref() {
        canonical_headers.push_str(&format!("x-amz-security-token:{}\n", token.trim()));
    }
    let canonical_request = format!(
        "{method}\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let credential_scope = format!("{}/{}/s3/aws4_request", date_stamp, config.region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let signing_key = s3_signing_key(&config.secret_access_key, &date_stamp, &config.region)?;
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes())?);
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        config.access_key_id, credential_scope, signed_headers, signature
    );

    Ok(SignedS3Request {
        url,
        host,
        payload_hash,
        amz_date,
        authorization,
    })
}

fn s3_signing_key(secret: &str, date_stamp: &str, region: &str) -> UcResult<Vec<u8>> {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date_stamp.as_bytes())?;
    let k_region = hmac_sha256(&k_date, region.as_bytes())?;
    let k_service = hmac_sha256(&k_region, b"s3")?;
    hmac_sha256(&k_service, b"aws4_request")
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> UcResult<Vec<u8>> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|error| UcError::new(ErrorCode::Internal, error.to_string()))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn uri_encode(value: &str, encode_slash: bool) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char)
            }
            b'/' if !encode_slash => encoded.push('/'),
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

fn amz_dates() -> (String, String) {
    let now = now_iso();
    let date_stamp = format!("{}{}{}", &now[0..4], &now[5..7], &now[8..10]);
    let amz_date = format!(
        "{}T{}{}{}Z",
        date_stamp,
        &now[11..13],
        &now[14..16],
        &now[17..19]
    );
    (date_stamp, amz_date)
}
