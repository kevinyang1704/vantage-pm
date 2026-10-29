//! Request authentication (Story 27.4/27.5, R6, H01).
//!
//! The service must never trust a claimed `device_id`. It authenticates the
//! caller from a credential carried on the request and derives the actor from
//! the authenticated principal:
//!
//! - **Desktop:** a random bearer credential sent over TLS; the server compares
//!   `sha256(credential)` to the stored verifier using a constant-time compare.
//! - **Browser:** a non-exportable ECDSA P-256 key. The client signs a canonical
//!   payload `(method, path, bodyDigest, nonce, timestamp)`; the server verifies
//!   the signature against the stored public key, checks the timestamp is within
//!   a freshness window, and rejects a replayed nonce.
//!
//! A verifier stored at rest is never sufficient on its own: the caller must
//! prove possession (bearer) or prove possession of the private key (browser).

use base64::Engine;
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use std::collections::HashSet;
use std::sync::Mutex;
use subtle::ConstantTimeEq;

use crate::membership::CredentialVerifier;

/// The freshness window for a signed request (R6): a signature outside this
/// many seconds of server time is refused.
pub const FRESHNESS_WINDOW_SECS: i64 = 120;

/// Errors at the authentication boundary. All map to a plain HTTP 401/403 by
/// the caller and never disclose which factor failed beyond the class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    MissingCredential,
    MalformedCredential,
    VerifierMismatch,
    StaleTimestamp,
    ReplayedNonce,
}

/// The canonical payload a browser device signs (mirrors
/// `requestSigningPayload` in `src/domain/collaboration/guest-identity.ts`).
pub fn signing_payload(method: &str, path: &str, body_digest: &str, nonce: &str, timestamp: &str) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}",
        method.to_uppercase(),
        path,
        body_digest,
        nonce,
        timestamp
    )
}

/// Lowercase-hex SHA-256 of a byte slice.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Constant-time equality for two lowercase-hex digests. Falls back to a
/// non-equal result when lengths differ (without early-return timing leak on
/// the prefix).
pub fn constant_time_hex_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        // Compare against self to burn a comparison, then fail.
        let _ = a.ct_eq(a);
        return false;
    }
    a.ct_eq(b).into()
}

/// A replay guard for browser nonces: a nonce is single-use within the freshness
/// window. Bounded so it cannot grow without limit; expired entries are pruned.
pub struct NonceCache {
    seen: Mutex<HashSet<(String, i64)>>,
    capacity: usize,
}

impl NonceCache {
    pub fn new(capacity: usize) -> Self {
        Self { seen: Mutex::new(HashSet::new()), capacity }
    }

    /// Record a nonce at its timestamp. Returns false when it was already seen
    /// (a replay). Prunes entries older than the freshness window. When the cache
    /// is full it refuses new nonces until markers expire, preserving replay safety.
    pub fn record(&self, nonce: &str, timestamp_secs: i64, now_secs: i64) -> bool {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        seen.retain(|(_, ts)| now_secs - *ts <= FRESHNESS_WINDOW_SECS);
        if seen.contains(&(nonce.to_string(), timestamp_secs)) {
            return false;
        }
        if seen.len() >= self.capacity {
            // Never evict a fresh replay marker: doing so makes captured signed
            // requests reusable within the freshness window. Saturation fails
            // closed until expired markers are pruned.
            return false;
        }
        seen.insert((nonce.to_string(), timestamp_secs))
    }
}

impl Default for NonceCache {
    fn default() -> Self {
        Self::new(8192)
    }
}

/// Verify a desktop bearer credential against a stored `BearerHash` verifier.
pub fn verify_bearer(credential: &str, verifier: &CredentialVerifier) -> Result<(), AuthError> {
    let CredentialVerifier::BearerHash { sha256 } = verifier else {
        return Err(AuthError::VerifierMismatch);
    };
    let presented = sha256_hex(credential.as_bytes());
    if constant_time_hex_eq(&presented, sha256) {
        Ok(())
    } else {
        Err(AuthError::VerifierMismatch)
    }
}

/// Verify a browser proof-of-possession against a stored `PublicKey` verifier.
///
/// `signature_b64` is the unpadded base64url ECDSA signature; `public_key_b64`
/// is the stored base64url SubjectPublicKeyInfo (SPKI) DER. The nonce must not
/// have been seen before (replay guard), and the timestamp must be fresh.
#[allow(clippy::too_many_arguments)]
pub fn verify_browser_proof(
    verifier: &CredentialVerifier,
    method: &str,
    path: &str,
    body_digest: &str,
    nonce: &str,
    timestamp: &str,
    signature_b64: &str,
    now_secs: i64,
    nonces: &NonceCache,
) -> Result<(), AuthError> {
    let CredentialVerifier::PublicKey { public_key_b64 } = verifier else {
        return Err(AuthError::VerifierMismatch);
    };

    // Timestamp freshness: parse the ISO-8601 UTC instant and reject outside the
    // window (both directions, so a far-future stamp cannot pre-date a replay).
    let ts = parse_iso_to_secs(timestamp).ok_or(AuthError::StaleTimestamp)?;
    if (now_secs - ts).abs() > FRESHNESS_WINDOW_SECS {
        return Err(AuthError::StaleTimestamp);
    }

    // Decode the public key and signature.
    let spki = b64url_decode(public_key_b64).ok_or(AuthError::MalformedCredential)?;
    let verifying_key = VerifyingKey::from_public_key_der(&spki).map_err(|_| AuthError::MalformedCredential)?;
    let sig_bytes = b64url_decode(signature_b64).ok_or(AuthError::MalformedCredential)?;
    let signature = Signature::from_der(&sig_bytes)
        .or_else(|_| Signature::from_slice(&sig_bytes))
        .map_err(|_| AuthError::MalformedCredential)?;

    let payload = signing_payload(method, path, body_digest, nonce, timestamp);
    verifying_key
        .verify(payload.as_bytes(), &signature)
        .map_err(|_| AuthError::VerifierMismatch)?;

    // Replay guard AFTER a valid signature, so a forged nonce cannot poison the
    // cache for the legitimate signer.
    if !nonces.record(nonce, ts, now_secs) {
        return Err(AuthError::ReplayedNonce);
    }
    Ok(())
}

fn b64url_decode(value: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(value))
        .ok()
}

/// Minimal RFC 3339 / ISO-8601 UTC parser: `YYYY-MM-DDTHH:MM:SSZ`.
pub fn parse_iso_to_secs(value: &str) -> Option<i64> {
    // Uses chrono for a correct parse; returns Unix seconds.
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_matches_constant_time() {
        let v = CredentialVerifier::BearerHash { sha256: sha256_hex(b"secret") };
        assert!(verify_bearer("secret", &v).is_ok());
        assert_eq!(verify_bearer("wrong", &v), Err(AuthError::VerifierMismatch));
    }

    #[test]
    fn constant_time_eq_handles_length_mismatch() {
        assert!(constant_time_hex_eq("abcd", "abcd"));
        assert!(!constant_time_hex_eq("abcd", "abce"));
        assert!(!constant_time_hex_eq("abcd", "abcde"));
    }

    #[test]
    fn nonce_cache_rejects_replay() {
        let cache = NonceCache::new(8);
        assert!(cache.record("n1", 100, 100));
        assert!(!cache.record("n1", 100, 100));
        // A different nonce is fine.
        assert!(cache.record("n2", 100, 100));
    }

    #[test]
    fn saturation_does_not_remove_fresh_replay_markers() {
        let cache = NonceCache::new(2);
        assert!(cache.record("first", 100, 100));
        assert!(cache.record("second", 100, 100));
        assert!(!cache.record("third", 100, 100));
        assert!(!cache.record("first", 100, 100));
        assert!(cache.record("third", 221, 221));
    }

    #[test]
    fn nonce_cache_prunes_expired() {
        let cache = NonceCache::new(8);
        assert!(cache.record("old", 0, 0));
        // 200s later, the old nonce is pruned and the same nonce is accepted.
        assert!(cache.record("old", 200, 200));
    }

    #[test]
    fn signature_verification_round_trips() {
        use p256::ecdsa::{SigningKey, Signature};
        use p256::ecdsa::signature::Signer;
        use p256::pkcs8::EncodePublicKey;
        use rand::rngs::OsRng;

        let signing_key = SigningKey::random(&mut OsRng);
        let public_key = signing_key.verifying_key();
        let spki = public_key.to_public_key_der().unwrap();
        let public_key_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(spki.as_bytes());
        let verifier = CredentialVerifier::PublicKey { public_key_b64 };

        let now = 1_700_000_000_i64;
        let timestamp = chrono::DateTime::from_timestamp(now, 0).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let payload = signing_payload("POST", "/x", "digest", "nonce", &timestamp);
        let signature: Signature = signing_key.sign(payload.as_bytes());
        let signature_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes());

        let cache = NonceCache::default();
        assert!(verify_browser_proof(&verifier, "POST", "/x", "digest", "nonce", &timestamp, &signature_b64, now, &cache).is_ok());
        // Replay is refused.
        assert_eq!(
            verify_browser_proof(&verifier, "POST", "/x", "digest", "nonce", &timestamp, &signature_b64, now, &cache),
            Err(AuthError::ReplayedNonce)
        );
        // A stale timestamp is refused (fresh cache).
        let stale = chrono::DateTime::from_timestamp(now - 600, 0).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let stale_payload = signing_payload("POST", "/x", "digest", "nonce2", &stale);
        let stale_sig: Signature = signing_key.sign(stale_payload.as_bytes());
        let stale_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(stale_sig.to_der().as_bytes());
        let cache2 = NonceCache::default();
        assert_eq!(
            verify_browser_proof(&verifier, "POST", "/x", "digest", "nonce2", &stale, &stale_b64, now, &cache2),
            Err(AuthError::StaleTimestamp)
        );
    }
}
