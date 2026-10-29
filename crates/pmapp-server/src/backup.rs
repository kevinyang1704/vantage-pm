//! S3-compatible backup uploader (Story 27.5, R5, H10).
//!
//! AWS Signature Version 4 primitives for S3-compatible object storage
//! (R2/B2). The transport, pagination and bounds live in `backup_store`; the
//! signing functions here are pure and unit-tested.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};


type HmacSha256 = Hmac<Sha256>;

/// Lowercase-hex SHA-256 of bytes (shared with the auth module's contract).
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// The signing key derivation: HMAC chain of date, region, service, `aws4_request`.
pub fn signing_key(secret: &str, date: &str, region: &str) -> Vec<u8> {
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, b"s3");
    hmac(&k_service, b"aws4_request")
}

/// Hex HMAC-SHA256 of `data` under the SigV4 signing key for `date`/`region`.
pub fn signing_key_hmac(secret: &str, date: &str, region: &str, data: &[u8]) -> String {
    hex::encode(hmac(&signing_key(secret, date, region), data))
}

/// A fully-formed, signed S3 request (method, path, headers) ready to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

/// Sign an S3 request with SigV4. `payload_sha256` is the lowercase-hex SHA-256
/// of the body (the hex of the empty string for a GET/DELETE). `now` is an ISO
/// instant; `date` is `YYYYMMDD` and `amz_date` is `YYYYMMDDTHHMMSSZ`.
#[allow(clippy::too_many_arguments)]
pub fn sign_v4(
    method: &str,
    endpoint: &str,
    bucket: &str,
    key: &str,
    region: &str,
    access_key_id: &str,
    secret_access_key: &str,
    payload_sha256: &str,
    date: &str,
    amz_date: &str,
) -> SignedRequest {
    let host = endpoint.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
    let canonical_uri = format!("/{bucket}/{key}");
    // The canonical query string is empty for our object operations.
    let canonical_headers = format!(
        "host:{host}\nx-amz-content-sha256:{payload_sha256}\nx-amz-date:{amz_date}\n"
    );
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "{method}\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_sha256}"
    );
    let credential_scope = format!("{date}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let key_bytes = signing_key(secret_access_key, date, region);
    let signature = hex::encode(hmac(&key_bytes, string_to_sign.as_bytes()));
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={access_key_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );
    SignedRequest {
        url: format!("{endpoint}/{bucket}/{key}"),
        headers: vec![
            ("host".to_string(), host.to_string()),
            ("x-amz-content-sha256".to_string(), payload_sha256.to_string()),
            ("x-amz-date".to_string(), amz_date.to_string()),
            ("authorization".to_string(), authorization),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signing_is_deterministic_and_well_formed() {
        let signed = sign_v4(
            "PUT",
            "https://acct.r2.cloudflarestorage.com",
            "pmapp-backups-staging",
            "generations/g1/membership.sqlite",
            "auto",
            "AKIDEXAMPLE",
            "SECRET",
            &sha256_hex(b"body"),
            "20261004",
            "20261004T120000Z",
        );
        assert_eq!(signed.url, "https://acct.r2.cloudflarestorage.com/pmapp-backups-staging/generations/g1/membership.sqlite");
        let auth = &signed.headers.iter().find(|(k, _)| k == "authorization").unwrap().1;
        assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261004/auto/s3/aws4_request"));
        assert!(auth.contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date"));
        assert!(auth.contains("Signature="));
    }

    #[test]
    fn empty_payload_digest_is_stable() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
}
