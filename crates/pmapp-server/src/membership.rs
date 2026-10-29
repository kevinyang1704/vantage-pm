//! Membership domain (Story 27.4, R6, D5–D6).
//!
//! Pure types and policies for guest device identities, invite links, join
//! requests, roles, and owner recovery. No I/O: the service store and HTTP layer
//! consume these. Membership is **per shared project**; there is no team object.

use serde::{Deserialize, Serialize};

/// A member's role in a shared project (D5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Editor,
    Viewer,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Editor => "editor",
            Role::Viewer => "viewer",
        }
    }

    pub fn parse(value: &str) -> Option<Role> {
        match value {
            "owner" => Some(Role::Owner),
            "editor" => Some(Role::Editor),
            "viewer" => Some(Role::Viewer),
            _ => None,
        }
    }

    /// An editor or owner may write; a viewer may not (R6).
    pub fn can_write(&self) -> bool {
        matches!(self, Role::Owner | Role::Editor)
    }

    /// Only an owner may manage members or sharing (TC-FR8).
    pub fn can_manage(&self) -> bool {
        matches!(self, Role::Owner)
    }
}

/// A device credential, verifier-only at rest (R6).
///
/// Desktop uses a random bearer credential and stores `sha256(credential)` here.
/// The browser uses public proof-of-possession material; that path stores the
/// public key bytes instead. Exactly one field is set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CredentialVerifier {
    /// Lowercase-hex SHA-256 of the bearer credential.
    BearerHash { sha256: String },
    /// Base64url public verification material for proof-of-possession.
    PublicKey { public_key_b64: String },
}

/// A member device (one row per joined device).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub device_id: String,
    pub project_id: String,
    pub actor_id: String,
    pub display_name: String,
    pub role: Role,
    /// Pending until an owner approves, unless approval is off (D5).
    pub approved: bool,
    pub verifier: CredentialVerifier,
    pub created_at_iso: String,
}

/// An invite link (D6): links only, role + expiry, single-use or multi-use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invite {
    pub invite_id: String,
    pub project_id: String,
    pub role: Role,
    pub single_use: bool,
    pub used: bool,
    pub expires_at_iso: Option<String>,
    pub replaced: bool,
    /// Verifier-only: SHA-256 of the link token, never the token itself.
    pub token_sha256: String,
    pub created_at_iso: String,
}

/// Plain-language reason a join or invite was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JoinRefusal {
    InviteNotFound,
    InviteExpired,
    InviteUsed,
    InviteReplaced,
    ApprovalRequired,
    NotAMember,
    ViewerCannotWrite,
    LastOwner,
}

/// Why a project has no remaining owner (last-owner rule).
pub fn is_last_owner(owners: usize) -> bool {
    owners <= 1
}

/// Whether an invite may be redeemed at `now_iso` (D6, R6). Expiry and
/// single-use are checked atomically by the store; this is the pure predicate.
pub fn invite_redeemable(invite: &Invite, now_iso: &str) -> Result<(), JoinRefusal> {
    if invite.replaced {
        return Err(JoinRefusal::InviteReplaced);
    }
    if invite.single_use && invite.used {
        return Err(JoinRefusal::InviteUsed);
    }
    if let Some(expiry) = &invite.expires_at_iso {
        if now_iso >= expiry.as_str() {
            return Err(JoinRefusal::InviteExpired);
        }
    }
    Ok(())
}

/// A one-time recovery code is verifier-only at rest (R6).
pub fn recovery_code_verifier(code: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(code.as_bytes());
    hex::encode(hasher.finalize())
}

/// SHA-256 of a bearer credential, lowercase hex (R6).
pub fn bearer_verifier(credential: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(credential.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_permissions() {
        assert!(Role::Owner.can_write() && Role::Owner.can_manage());
        assert!(Role::Editor.can_write() && !Role::Editor.can_manage());
        assert!(!Role::Viewer.can_write() && !Role::Viewer.can_manage());
    }

    #[test]
    fn invite_redeemable_checks_replacement_expiry_and_use() {
        let base = Invite {
            invite_id: "i".into(), project_id: "p".into(), role: Role::Editor,
            single_use: true, used: false, expires_at_iso: Some("2026-10-01T00:00:00Z".into()),
            replaced: false, token_sha256: "x".into(), created_at_iso: "2026-09-30T00:00:00Z".into(),
        };
        assert!(invite_redeemable(&base, "2026-09-30T12:00:00Z").is_ok());
        assert_eq!(invite_redeemable(&base, "2026-10-02T00:00:00Z"), Err(JoinRefusal::InviteExpired));
        let used = Invite { used: true, ..base.clone() };
        assert_eq!(invite_redeemable(&used, "2026-09-30T12:00:00Z"), Err(JoinRefusal::InviteUsed));
        let replaced = Invite { replaced: true, ..base };
        assert_eq!(invite_redeemable(&replaced, "2026-09-30T12:00:00Z"), Err(JoinRefusal::InviteReplaced));
    }

    #[test]
    fn verifiers_are_lowercase_hex_sha256() {
        let v = bearer_verifier("secret");
        assert_eq!(v.len(), 64);
        assert!(v.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(recovery_code_verifier("code"), bearer_verifier("code"));
    }

    #[test]
    fn last_owner_rule() {
        assert!(is_last_owner(1));
        assert!(is_last_owner(0));
        assert!(!is_last_owner(2));
    }
}
