//! Authenticated principals (Story 27.4/27.5, R6, H01/H06).
//!
//! The service derives the caller's actor from a credential it verifies — never
//! from a claimed body/query `device_id`. Desktop sends a bearer in
//! `x-pmapp-bearer`; the browser signs the request and sends
//! `x-pmapp-device`, `x-pmapp-nonce`, `x-pmapp-timestamp`, `x-pmapp-signature`
//! (the signature covers method, path, body digest, nonce and timestamp).
//!
//! `resolve_principal` is the single admission point: it looks up the device's
//! verifier, verifies possession, and returns an authenticated principal whose
//! `actor_id` is authoritative.

use axum::http::HeaderMap;

use crate::auth::{
    sha256_hex, verify_bearer, verify_browser_proof, AuthError, NonceCache,
};
use crate::membership_store::{AuthContext, MembershipStore};
use crate::membership::Role;

/// An authenticated caller. `actor_id` comes from the verified device, not the
/// request body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub device_id: String,
    pub actor_id: String,
    pub role: Role,
    pub approved: bool,
}

/// Header names the transport uses (mirror `collaboration-transport.ts`).
pub const H_BEARER: &str = "x-pmapp-bearer";
pub const H_DEVICE: &str = "x-pmapp-device";
pub const H_NONCE: &str = "x-pmapp-nonce";
pub const H_TIMESTAMP: &str = "x-pmapp-timestamp";
pub const H_SIGNATURE: &str = "x-pmapp-signature";

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// Verify the caller's bearer/browser proof against `project_id`, then return
/// the authoritative membership context (actor id + role from the store, never
/// from the request). This is the single admission point for every operation.
pub fn principal_for_project(
    store: &MembershipStore,
    nonces: &NonceCache,
    headers: &HeaderMap,
    method: &str,
    path: &str,
    body_bytes: &[u8],
    project_id: &str,
) -> Result<AuthContext, AuthError> {
    let device_id = header(headers, H_DEVICE).ok_or(AuthError::MissingCredential)?;
    let verifier = store
        .device_verifier(device_id, project_id)
        .ok()
        .flatten()
        .ok_or(AuthError::VerifierMismatch)?;
    match &verifier {
        crate::membership::CredentialVerifier::BearerHash { .. } => {
            let bearer = header(headers, H_BEARER).ok_or(AuthError::MissingCredential)?;
            verify_bearer(bearer, &verifier)?;
        }
        crate::membership::CredentialVerifier::PublicKey { .. } => {
            let nonce = header(headers, H_NONCE).ok_or(AuthError::MissingCredential)?;
            let timestamp = header(headers, H_TIMESTAMP).ok_or(AuthError::MissingCredential)?;
            let signature = header(headers, H_SIGNATURE).ok_or(AuthError::MissingCredential)?;
            let digest = sha256_hex(body_bytes);
            let now = chrono::Utc::now().timestamp();
            verify_browser_proof(&verifier, method, path, &digest, nonce, timestamp, signature, now, nonces)?;
        }
    }
    store
        .auth_context(device_id, project_id)
        .ok()
        .flatten()
        .ok_or(AuthError::VerifierMismatch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use crate::auth::sha256_hex;
    use crate::membership::Role as MRole;
    use crate::membership_store as ms;

    fn store_with_bearer(device: &str, project: &str, actor: &str, secret: &str) -> MembershipStore {
        let s = ms::MembershipStore::open_in_memory().unwrap();
        s.upsert_device(device, project, actor, "Hera", MRole::Owner, true, "bearerHash", &sha256_hex(secret.as_bytes()), "2026-10-04T00:00:00Z").unwrap();
        s
    }

    #[test]
    fn bearer_principal_resolves_from_verified_credential() {
        let store = store_with_bearer("d1", "p1", "actor-a", "sekret");
        let mut headers = HeaderMap::new();
        headers.insert(H_DEVICE, HeaderValue::from_static("d1"));
        headers.insert(H_BEARER, HeaderValue::from_static("sekret"));
        let cache = NonceCache::default();
        let ctx = principal_for_project(&store, &cache, &headers, "POST", "/projects/p1/commands", b"{}", "p1").unwrap();
        assert_eq!(ctx.actor_id, "actor-a");
        assert_eq!(ctx.role, MRole::Owner);
    }

    #[test]
    fn a_claimed_device_without_a_credential_is_refused() {
        let store = store_with_bearer("d1", "p1", "actor-a", "sekret");
        let mut headers = HeaderMap::new();
        headers.insert(H_DEVICE, HeaderValue::from_static("d1"));
        // No bearer.
        let cache = NonceCache::default();
        assert_eq!(
            principal_for_project(&store, &cache, &headers, "POST", "/projects/p1/commands", b"{}", "p1"),
            Err(AuthError::MissingCredential)
        );
    }

    #[test]
    fn a_wrong_bearer_is_refused() {
        let store = store_with_bearer("d1", "p1", "actor-a", "sekret");
        let mut headers = HeaderMap::new();
        headers.insert(H_DEVICE, HeaderValue::from_static("d1"));
        headers.insert(H_BEARER, HeaderValue::from_static("nope"));
        let cache = NonceCache::default();
        assert_eq!(
            principal_for_project(&store, &cache, &headers, "POST", "/projects/p1/commands", b"{}", "p1"),
            Err(AuthError::VerifierMismatch)
        );
    }

    #[test]
    fn a_non_member_device_is_refused() {
        let store = store_with_bearer("d1", "p1", "actor-a", "sekret");
        let mut headers = HeaderMap::new();
        headers.insert(H_DEVICE, HeaderValue::from_static("d-other"));
        headers.insert(H_BEARER, HeaderValue::from_static("x"));
        let cache = NonceCache::default();
        assert_eq!(
            principal_for_project(&store, &cache, &headers, "POST", "/projects/p1/commands", b"{}", "p1"),
            Err(AuthError::VerifierMismatch)
        );
    }
}
