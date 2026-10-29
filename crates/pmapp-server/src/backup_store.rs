//! Object storage port for backups (Story 27.5, R5).
//!
//! `ObjectStore` is the only seam the backup loop, retention and restore drill
//! use. `S3Store` talks to R2/B2 with AWS Signature Version 4 (including the
//! query canonicalization ListObjectsV2 pagination needs), bounded response and
//! object sizes, and network timeouts. `MemoryStore` is an in-process store
//! with fault injection for local fault tests; it is never composed in the
//! service binary.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use crate::backup::{sha256_hex, signing_key_hmac};
use crate::backup_config::BackupConfig;

/// Upper bound for a single ListObjectsV2 response body.
pub const MAX_LIST_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// Upper bound for keys enumerated under one prefix (fail closed beyond it).
pub const MAX_LISTED_KEYS: usize = 100_000;
/// Upper bound for any single object the service downloads.
pub const MAX_OBJECT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    NotFound,
    TooLarge,
    /// Transport/HTTP failure. Carries a code, never a credential or body.
    Failed(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::NotFound => write!(f, "OBJECT_NOT_FOUND"),
            StoreError::TooLarge => write!(f, "OBJECT_TOO_LARGE"),
            StoreError::Failed(code) => write!(f, "{code}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectInfo {
    pub key: String,
    pub size: u64,
    /// Seconds since the Unix epoch, when the store reports it.
    pub last_modified_secs: Option<i64>,
}

pub trait ObjectStore: Send + Sync {
    fn put(&self, key: &str, body: Vec<u8>) -> impl Future<Output = Result<(), StoreError>> + Send;
    /// Download an object, refusing anything larger than `max_bytes`.
    fn get(&self, key: &str, max_bytes: u64) -> impl Future<Output = Result<Vec<u8>, StoreError>> + Send;
    /// Delete an object. Deleting an absent object succeeds.
    fn delete(&self, key: &str) -> impl Future<Output = Result<(), StoreError>> + Send;
    /// Every object under `prefix`, following pagination to completion.
    fn list(&self, prefix: &str) -> impl Future<Output = Result<Vec<ObjectInfo>, StoreError>> + Send;
}

// ── SigV4 ──────────────────────────────────────────────────────────────────

/// RFC 3986 percent-encoding as SigV4 requires: unreserved characters stay,
/// everything else is `%XX` (uppercase). `/` is kept only in paths.
pub fn uri_encode(value: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if unreserved || (keep_slash && byte == b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Canonical query string: encoded keys/values, sorted by key then value.
pub fn canonical_query(query: &[(String, String)]) -> String {
    let mut pairs: Vec<(String, String)> = query
        .iter()
        .map(|(k, v)| (uri_encode(k, false), uri_encode(v, false)))
        .collect();
    pairs.sort();
    pairs.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

/// Sign a path-style S3 request. `key` may be empty for bucket operations.
#[allow(clippy::too_many_arguments)]
pub fn sign_request(
    method: &str,
    endpoint: &str,
    bucket: &str,
    key: &str,
    query: &[(String, String)],
    region: &str,
    access_key_id: &str,
    secret_access_key: &str,
    payload_sha256: &str,
    amz_date: &str,
) -> SignedRequest {
    let date = &amz_date[..8];
    let host = endpoint.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
    let path = if key.is_empty() { format!("/{bucket}") } else { format!("/{bucket}/{key}") };
    let canonical_uri = uri_encode(&path, true);
    let canonical_query = canonical_query(query);
    let canonical_headers = format!("host:{host}\nx-amz-content-sha256:{payload_sha256}\nx-amz-date:{amz_date}\n");
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_sha256}"
    );
    let scope = format!("{date}/{region}/s3/aws4_request");
    let string_to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", sha256_hex(canonical_request.as_bytes()));
    let signature = signing_key_hmac(secret_access_key, date, region, string_to_sign.as_bytes());
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );
    let url = if canonical_query.is_empty() {
        format!("{}{canonical_uri}", endpoint.trim_end_matches('/'))
    } else {
        format!("{}{canonical_uri}?{canonical_query}", endpoint.trim_end_matches('/'))
    };
    SignedRequest {
        url,
        headers: vec![
            ("x-amz-content-sha256".into(), payload_sha256.into()),
            ("x-amz-date".into(), amz_date.into()),
            ("authorization".into(), authorization),
        ],
    }
}

// ── ListObjectsV2 parsing (no XML dependency; bounded input) ───────────────

fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(&xml[start..end])
}

#[derive(Debug, PartialEq, Eq)]
pub struct ListPage {
    pub objects: Vec<ObjectInfo>,
    pub next_token: Option<String>,
}

/// Parse one ListObjectsV2 page. A truncated page without a continuation
/// token, or a malformed entry, is an error (fail closed).
pub fn parse_list_page(xml: &str) -> Result<ListPage, StoreError> {
    let bad = || StoreError::Failed("LIST_RESPONSE_INVALID".into());
    if !xml.contains("<ListBucketResult") { return Err(bad()); }
    let mut objects = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<Contents>") {
        let after = &rest[start + "<Contents>".len()..];
        let end = after.find("</Contents>").ok_or_else(bad)?;
        let entry = &after[..end];
        let key = xml_unescape(tag(entry, "Key").ok_or_else(bad)?);
        let size = tag(entry, "Size").ok_or_else(bad)?.trim().parse::<u64>().map_err(|_| bad())?;
        let last_modified_secs = tag(entry, "LastModified")
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value.trim()).ok())
            .map(|value| value.timestamp());
        if key.is_empty() { return Err(bad()); }
        objects.push(ObjectInfo { key, size, last_modified_secs });
        rest = &after[end + "</Contents>".len()..];
    }
    let truncated = tag(xml, "IsTruncated").map(|v| v.trim() == "true").unwrap_or(false);
    let next_token = if truncated {
        Some(xml_unescape(tag(xml, "NextContinuationToken").filter(|t| !t.is_empty()).ok_or_else(bad)?))
    } else {
        None
    };
    Ok(ListPage { objects, next_token })
}

// ── S3-compatible store ────────────────────────────────────────────────────

pub struct S3Store {
    config: BackupConfig,
    client: reqwest::Client,
}

impl S3Store {
    pub fn new(config: BackupConfig) -> Result<Self, StoreError> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|_| StoreError::Failed("HTTP_CLIENT_UNAVAILABLE".into()))?;
        Ok(Self { config, client })
    }

    fn signed(&self, method: &str, key: &str, query: &[(String, String)], payload_sha256: &str) -> SignedRequest {
        let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        sign_request(
            method, &self.config.endpoint, &self.config.bucket, key, query, &self.config.region,
            &self.config.access_key_id, &self.config.secret_access_key, payload_sha256, &amz_date,
        )
    }

    fn request(&self, method: reqwest::Method, signed: &SignedRequest) -> reqwest::RequestBuilder {
        let mut request = self.client.request(method, &signed.url);
        for (name, value) in &signed.headers {
            request = request.header(name.as_str(), value.as_str());
        }
        request
    }

    async fn read_bounded(mut response: reqwest::Response, max_bytes: u64) -> Result<Vec<u8>, StoreError> {
        if response.content_length().is_some_and(|len| len > max_bytes) { return Err(StoreError::TooLarge); }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| StoreError::Failed("READ_FAILED".into()))? {
            if body.len() as u64 + chunk.len() as u64 > max_bytes { return Err(StoreError::TooLarge); }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
}

fn status_error(op: &str, status: reqwest::StatusCode) -> StoreError {
    if status.as_u16() == 404 { StoreError::NotFound } else { StoreError::Failed(format!("{op}_HTTP_{}", status.as_u16())) }
}

impl ObjectStore for S3Store {
    async fn put(&self, key: &str, body: Vec<u8>) -> Result<(), StoreError> {
        let signed = self.signed("PUT", key, &[], &sha256_hex(&body));
        let response = self.request(reqwest::Method::PUT, &signed).body(body).send().await
            .map_err(|_| StoreError::Failed("PUT_TRANSPORT".into()))?;
        if !response.status().is_success() { return Err(status_error("PUT", response.status())); }
        Ok(())
    }

    async fn get(&self, key: &str, max_bytes: u64) -> Result<Vec<u8>, StoreError> {
        let signed = self.signed("GET", key, &[], &sha256_hex(b""));
        let response = self.request(reqwest::Method::GET, &signed).send().await
            .map_err(|_| StoreError::Failed("GET_TRANSPORT".into()))?;
        if !response.status().is_success() { return Err(status_error("GET", response.status())); }
        Self::read_bounded(response, max_bytes.min(MAX_OBJECT_BYTES)).await
    }

    async fn delete(&self, key: &str) -> Result<(), StoreError> {
        let signed = self.signed("DELETE", key, &[], &sha256_hex(b""));
        let response = self.request(reqwest::Method::DELETE, &signed).send().await
            .map_err(|_| StoreError::Failed("DELETE_TRANSPORT".into()))?;
        if !response.status().is_success() && response.status().as_u16() != 404 {
            return Err(status_error("DELETE", response.status()));
        }
        Ok(())
    }

    async fn list(&self, prefix: &str) -> Result<Vec<ObjectInfo>, StoreError> {
        let mut all = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut query = vec![
                ("list-type".to_string(), "2".to_string()),
                ("max-keys".to_string(), "1000".to_string()),
                ("prefix".to_string(), prefix.to_string()),
            ];
            if let Some(token) = &token { query.push(("continuation-token".to_string(), token.clone())); }
            let signed = self.signed("GET", "", &query, &sha256_hex(b""));
            let response = self.request(reqwest::Method::GET, &signed).send().await
                .map_err(|_| StoreError::Failed("LIST_TRANSPORT".into()))?;
            if !response.status().is_success() { return Err(status_error("LIST", response.status())); }
            let body = Self::read_bounded(response, MAX_LIST_RESPONSE_BYTES as u64).await?;
            let page = parse_list_page(std::str::from_utf8(&body).map_err(|_| StoreError::Failed("LIST_RESPONSE_INVALID".into()))?)?;
            all.extend(page.objects.into_iter().filter(|o| o.key.starts_with(prefix)));
            if all.len() > MAX_LISTED_KEYS { return Err(StoreError::TooLarge); }
            match page.next_token {
                Some(next) if Some(&next) != token.as_ref() => token = Some(next),
                Some(_) => return Err(StoreError::Failed("LIST_TOKEN_REPEATED".into())),
                None => return Ok(all),
            }
        }
    }
}

// ── In-memory store for fault tests ────────────────────────────────────────

#[derive(Default)]
pub struct MemoryStore {
    pub objects: Mutex<BTreeMap<String, (Vec<u8>, i64)>>,
    /// Keys whose PUT fails (simulated outage mid-generation).
    pub fail_put_keys: Mutex<Vec<String>>,
    pub fail_list: Mutex<bool>,
    /// Logical clock (seconds) recorded as each object's last-modified time.
    pub now_secs: Mutex<i64>,
    pub put_log: Mutex<Vec<String>>,
}

impl MemoryStore {
    pub fn new() -> Self { Self::default() }
    pub fn set_now(&self, secs: i64) { *self.now_secs.lock().unwrap() = secs; }
    pub fn keys(&self) -> Vec<String> { self.objects.lock().unwrap().keys().cloned().collect() }
    pub fn insert(&self, key: &str, body: Vec<u8>, modified_secs: i64) {
        self.objects.lock().unwrap().insert(key.to_string(), (body, modified_secs));
    }
}

impl ObjectStore for MemoryStore {
    async fn put(&self, key: &str, body: Vec<u8>) -> Result<(), StoreError> {
        if self.fail_put_keys.lock().unwrap().iter().any(|k| key.ends_with(k.as_str())) {
            return Err(StoreError::Failed("PUT_HTTP_503".into()));
        }
        let now = *self.now_secs.lock().unwrap();
        self.put_log.lock().unwrap().push(key.to_string());
        self.objects.lock().unwrap().insert(key.to_string(), (body, now));
        Ok(())
    }

    async fn get(&self, key: &str, max_bytes: u64) -> Result<Vec<u8>, StoreError> {
        let objects = self.objects.lock().unwrap();
        let (body, _) = objects.get(key).ok_or(StoreError::NotFound)?;
        if body.len() as u64 > max_bytes { return Err(StoreError::TooLarge); }
        Ok(body.clone())
    }

    async fn delete(&self, key: &str) -> Result<(), StoreError> {
        self.objects.lock().unwrap().remove(key);
        Ok(())
    }

    async fn list(&self, prefix: &str) -> Result<Vec<ObjectInfo>, StoreError> {
        if *self.fail_list.lock().unwrap() { return Err(StoreError::Failed("LIST_HTTP_500".into())); }
        Ok(self.objects.lock().unwrap().iter()
            .filter(|(k, _)| k.starts_with(prefix))
            .map(|(k, (body, modified))| ObjectInfo { key: k.clone(), size: body.len() as u64, last_modified_secs: Some(*modified) })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_canonicalization_sorts_and_encodes() {
        let query = vec![
            ("prefix".to_string(), "generations/a b".to_string()),
            ("list-type".to_string(), "2".to_string()),
            ("continuation-token".to_string(), "1/+=x".to_string()),
        ];
        assert_eq!(canonical_query(&query), "continuation-token=1%2F%2B%3Dx&list-type=2&prefix=generations%2Fa%20b");
    }

    #[test]
    fn aws_documented_signing_key_vector() {
        // AWS SigV4 test suite "get-vanilla" (service s3 adapted): the signed
        // request must carry a scope-bound credential and a stable signature.
        let signed = sign_request("GET", "https://example.amazonaws.com", "bucket", "", &[("list-type".into(), "2".into())],
            "us-east-1", "AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", &sha256_hex(b""), "20150830T123600Z");
        assert_eq!(signed.url, "https://example.amazonaws.com/bucket?list-type=2");
        let auth = &signed.headers.iter().find(|(k, _)| k == "authorization").unwrap().1;
        assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request"));
        let again = sign_request("GET", "https://example.amazonaws.com", "bucket", "", &[("list-type".into(), "2".into())],
            "us-east-1", "AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", &sha256_hex(b""), "20150830T123600Z");
        assert_eq!(signed, again);
        // A different query must change the signature (the query is signed).
        let other = sign_request("GET", "https://example.amazonaws.com", "bucket", "", &[("list-type".into(), "1".into())],
            "us-east-1", "AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", &sha256_hex(b""), "20150830T123600Z");
        assert_ne!(signed.headers[2], other.headers[2]);
    }

    #[test]
    fn list_page_parsing_follows_tokens_and_fails_closed() {
        let page = parse_list_page(r#"<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
            <Contents><Key>generations/a&amp;b/manifest.json</Key><LastModified>2026-10-06T00:00:00.000Z</LastModified><Size>12</Size></Contents>
            <NextContinuationToken>tok/2</NextContinuationToken></ListBucketResult>"#).unwrap();
        assert_eq!(page.objects[0].key, "generations/a&b/manifest.json");
        assert_eq!(page.objects[0].size, 12);
        assert!(page.objects[0].last_modified_secs.is_some());
        assert_eq!(page.next_token.as_deref(), Some("tok/2"));
        // Truncated without a token, a malformed size, or a non-list body fail.
        assert!(parse_list_page("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>").is_err());
        assert!(parse_list_page("<ListBucketResult><Contents><Key>k</Key><Size>x</Size></Contents></ListBucketResult>").is_err());
        assert!(parse_list_page("<Error><Code>AccessDenied</Code></Error>").is_err());
        let last = parse_list_page("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>").unwrap();
        assert!(last.objects.is_empty() && last.next_token.is_none());
    }
}
