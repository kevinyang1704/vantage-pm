//! Membership store (Story 27.4, R6, D5–D6).
//!
//! One SQLite database holding device credentials, invites, join requests and
//! the owner recovery verifier. Membership is per project; a device may belong
//! to many projects independently (R6 project-scoped revocation).
//!
//! Invite redemption and join creation are idempotent and atomic: a single
//! transaction re-checks `redeemable` and marks the invite used, so concurrent
//! redemption cannot defeat single use (R6).

use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

use crate::membership::{invite_redeemable, CredentialVerifier, Invite, JoinRefusal, Role};

pub const MEMBERSHIP_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS devices(
  device_id     TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL,
  approved      INTEGER NOT NULL DEFAULT 0,
  verifier_kind TEXT NOT NULL,
  verifier      TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  PRIMARY KEY (project_id, device_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_by_project_actor ON devices(project_id, actor_id);
CREATE INDEX IF NOT EXISTS devices_by_project ON devices(project_id);

CREATE TABLE IF NOT EXISTS invites(
  invite_id     TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  role          TEXT NOT NULL,
  single_use    INTEGER NOT NULL,
  used          INTEGER NOT NULL DEFAULT 0,
  expires_at_iso TEXT,
  replaced      INTEGER NOT NULL DEFAULT 0,
  token_sha256  TEXT NOT NULL,
  created_at_iso TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS invites_by_token ON invites(token_sha256);

CREATE TABLE IF NOT EXISTS join_requests(
  request_id   TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL,
  approved     INTEGER NOT NULL DEFAULT 0,
  denied       INTEGER NOT NULL DEFAULT 0,
  created_at_iso TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS join_requests_by_project ON join_requests(project_id, created_at_iso);

CREATE TABLE IF NOT EXISTS recovery(
  project_id    TEXT PRIMARY KEY,
  code_sha256   TEXT NOT NULL,
  used          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS share_state(
  project_id   TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_at_iso TEXT NOT NULL
);

-- Story 27.5: a transactionally maintained membership revision. Triggers run
-- inside the writing statement's transaction, so every durable membership
-- change (including future write paths) advances it atomically and a backup
-- cut reads it from the captured copy rather than inventing a value.
CREATE TABLE IF NOT EXISTS membership_meta(
  singleton      INTEGER PRIMARY KEY CHECK(singleton = 1),
  revision       INTEGER NOT NULL CHECK(revision >= 0),
  schema_version INTEGER NOT NULL
);
INSERT OR IGNORE INTO membership_meta(singleton, revision, schema_version) VALUES(1, 0, 1);
CREATE TRIGGER IF NOT EXISTS membership_revision_devices_insert AFTER INSERT ON devices
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_devices_update AFTER UPDATE ON devices
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_devices_delete AFTER DELETE ON devices
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_invites_insert AFTER INSERT ON invites
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_invites_update AFTER UPDATE ON invites
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_invites_delete AFTER DELETE ON invites
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_join_requests_insert AFTER INSERT ON join_requests
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_join_requests_update AFTER UPDATE ON join_requests
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_join_requests_delete AFTER DELETE ON join_requests
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_recovery_insert AFTER INSERT ON recovery
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_recovery_update AFTER UPDATE ON recovery
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_recovery_delete AFTER DELETE ON recovery
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_share_state_insert AFTER INSERT ON share_state
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_share_state_update AFTER UPDATE ON share_state
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_share_state_delete AFTER DELETE ON share_state
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;

-- Story 27.4 (AC 27.4-4): per-project owner approval. Absent row = required
-- (the D5 default). Durable so a restart never silently turns approval back
-- on or off.
CREATE TABLE IF NOT EXISTS project_settings(
  project_id        TEXT PRIMARY KEY,
  approval_required INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS membership_revision_project_settings_insert AFTER INSERT ON project_settings
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS membership_revision_project_settings_update AFTER UPDATE ON project_settings
BEGIN UPDATE membership_meta SET revision = revision + 1 WHERE singleton = 1; END;

-- Story 27.5: a restored membership database is quarantined before any
-- credential, invitation, approval or recovery code can admit an operation.
CREATE TABLE IF NOT EXISTS membership_restore_quarantine(
  singleton          INTEGER PRIMARY KEY CHECK(singleton = 1),
  reason             TEXT NOT NULL,
  quarantined_at_iso TEXT NOT NULL
);
"#;

/// Version of `MEMBERSHIP_SCHEMA` recorded in `membership_meta`.
pub const MEMBERSHIP_SCHEMA_VERSION: i64 = 1;

pub struct MembershipStore {
    conn: Connection,
}

/// Story 27.4: a join request carries the joiner's own device and credential
/// verifier from redemption, so approval activates exactly the credential the
/// joiner proved and an owner never handles a joiner's secret.
fn ensure_join_binding_columns(conn: &Connection) -> rusqlite::Result<()> {
    let mut statement = conn.prepare("PRAGMA table_info(join_requests)")?;
    let columns = statement.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    for column in ["device_id", "verifier_kind", "verifier"] {
        if !columns.iter().any(|c| c == column) {
            conn.execute_batch(&format!("ALTER TABLE join_requests ADD COLUMN {column} TEXT"))?;
        }
    }
    Ok(())
}

/// A member as the owner's Share dialog shows it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberRow {
    pub device_id: String,
    pub display_name: String,
    pub role: Role,
}

/// A pending join request as the owner sees it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequestRow {
    pub request_id: String,
    pub display_name: String,
    pub role: Role,
}

/// A joiner's view of their own request, with the bound credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinRequestState {
    pub project_id: String,
    pub role: Role,
    pub approved: bool,
    pub denied: bool,
    pub device_id: Option<String>,
    pub verifier: Option<CredentialVerifier>,
}

/// Result of a first-owner claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimOutcome {
    Claimed,
    /// Identical retry by the same device and credential.
    AlreadyOwner,
    /// The project already has members or a share record.
    AlreadyClaimed,
    /// The store is a quarantined restore.
    Unavailable,
}

/// A resolved role for an authenticated actor on a project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthContext {
    pub device_id: String,
    pub actor_id: String,
    pub role: Role,
    pub approved: bool,
}

impl MembershipStore {
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        conn.execute_batch(MEMBERSHIP_SCHEMA)?;
        ensure_join_binding_columns(&conn)?;
        Ok(Self { conn })
    }

    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        conn.execute_batch(MEMBERSHIP_SCHEMA)?;
        ensure_join_binding_columns(&conn)?;
        Ok(Self { conn })
    }

    /// Register (or update) a device as a pending or approved member.
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_device(
        &self,
        device_id: &str,
        project_id: &str,
        actor_id: &str,
        display_name: &str,
        role: Role,
        approved: bool,
        verifier_kind: &str,
        verifier: &str,
        now_iso: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO devices(device_id, project_id, actor_id, display_name, role, approved, verifier_kind, verifier, created_at_iso)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(project_id, device_id) DO UPDATE SET
               display_name = excluded.display_name,
               role = excluded.role,
               approved = excluded.approved",
            rusqlite::params![device_id, project_id, actor_id, display_name, role.as_str(), approved as i64, verifier_kind, verifier, now_iso],
        )?;
        Ok(())
    }

    /// The authenticated context for a device on a project, if a member.
    pub fn auth_context(&self, device_id: &str, project_id: &str) -> rusqlite::Result<Option<AuthContext>> {
        if self.quarantined()? { return Ok(None); }
        self.conn
            .query_row(
                "SELECT device_id, actor_id, role, approved FROM devices WHERE device_id = ?1 AND project_id = ?2",
                rusqlite::params![device_id, project_id],
                |r| {
                    let role: String = r.get(2)?;
                    Ok(AuthContext {
                        device_id: r.get(0)?,
                        actor_id: r.get(1)?,
                        role: Role::parse(&role).unwrap_or(Role::Viewer),
                        approved: r.get::<_, i64>(3)? != 0,
                    })
                },
            )
            .optional()
    }

    /// Explicit provisioning/stopped records deny all collaboration data access.
    /// Missing records also deny access; qualification fixtures activate explicitly.
    pub fn project_is_active(&self, project_id: &str) -> rusqlite::Result<bool> {
        Ok(self.share_record(project_id)?.map(|r| r.status == crate::share_routes::ShareStatus::Shared).unwrap_or(false))
    }

    /// The verifier for a device on a project (for proof-of-possession checks).
    /// Returns None when the device is not a member of that project.
    pub fn device_verifier(
        &self,
        device_id: &str,
        project_id: &str,
    ) -> rusqlite::Result<Option<CredentialVerifier>> {
        if self.quarantined()? { return Ok(None); }
        self.conn
            .query_row(
                "SELECT verifier_kind, verifier FROM devices WHERE device_id = ?1 AND project_id = ?2",
                rusqlite::params![device_id, project_id],
                |r| {
                    let kind: String = r.get(0)?;
                    let value: String = r.get(1)?;
                    Ok(match kind.as_str() {
                        "publicKey" | "public-key" => CredentialVerifier::PublicKey { public_key_b64: value },
                        _ => CredentialVerifier::BearerHash { sha256: value },
                    })
                },
            )
            .optional()
    }

    /// The display name a device registered on a project, if a member.
    pub fn display_name(&self, device_id: &str, project_id: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT display_name FROM devices WHERE device_id = ?1 AND project_id = ?2",
                rusqlite::params![device_id, project_id],
                |r| r.get(0),
            )
            .optional()
    }

    /// Read a project's share record, if any (R7).
    pub fn share_record(&self, project_id: &str) -> rusqlite::Result<Option<crate::share_routes::ShareRecord>> {
        self.conn
            .query_row(
                "SELECT project_id, operation_id, status, created_at_iso FROM share_state WHERE project_id = ?1",
                rusqlite::params![project_id],
                |r| {
                    let status: String = r.get(2)?;
                    Ok(crate::share_routes::ShareRecord {
                        project_id: r.get(0)?,
                        operation_id: r.get(1)?,
                        status: match status.as_str() {
                            "shared" => crate::share_routes::ShareStatus::Shared,
                            "local" => crate::share_routes::ShareStatus::Local,
                            _ => crate::share_routes::ShareStatus::Provisioning,
                        },
                        created_at_iso: r.get(3)?,
                    })
                },
            )
            .optional()
    }

    /// Upsert a project's share record (R7).
    pub fn upsert_share(&self, project_id: &str, operation_id: &str, status: &str, now_iso: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO share_state(project_id, operation_id, status, created_at_iso)
             VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(project_id) DO UPDATE SET operation_id = excluded.operation_id, status = excluded.status",
            rusqlite::params![project_id, operation_id, status, now_iso],
        )?;
        Ok(())
    }

    /// Whether a device may write (approved editor/owner).
    pub fn can_write(&self, device_id: &str, project_id: &str) -> rusqlite::Result<bool> {
        Ok(self
            .auth_context(device_id, project_id)?
            .map(|c| c.approved && c.role.can_write())
            .unwrap_or(false))
    }

    /// Whether a device may manage membership (approved owner).
    pub fn can_manage(&self, device_id: &str, project_id: &str) -> rusqlite::Result<bool> {
        Ok(self
            .auth_context(device_id, project_id)?
            .map(|c| c.approved && c.role.can_manage())
            .unwrap_or(false))
    }

    /// Count approved owners on a project (last-owner rule).
    pub fn owner_count(&self, project_id: &str) -> rusqlite::Result<usize> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(1) FROM devices WHERE project_id = ?1 AND role = 'owner' AND approved = 1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )?;
        Ok(count as usize)
    }

    /// Insert an invite (verifier-only token).
    #[allow(clippy::too_many_arguments)]
    pub fn insert_invite(
        &self,
        invite_id: &str,
        project_id: &str,
        role: Role,
        single_use: bool,
        expires_at_iso: Option<&str>,
        token_sha256: &str,
        now_iso: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO invites(invite_id, project_id, role, single_use, used, expires_at_iso, replaced, token_sha256, created_at_iso)
             VALUES(?1, ?2, ?3, ?4, 0, ?5, 0, ?6, ?7)",
            rusqlite::params![invite_id, project_id, role.as_str(), single_use as i64, expires_at_iso, token_sha256, now_iso],
        )?;
        Ok(())
    }

    fn read_invite_by_token(&self, token_sha256: &str) -> rusqlite::Result<Option<Invite>> {
        self.conn
            .query_row(
                "SELECT invite_id, project_id, role, single_use, used, expires_at_iso, replaced, token_sha256, created_at_iso
                 FROM invites WHERE token_sha256 = ?1",
                rusqlite::params![token_sha256],
                |r| {
                    let role: String = r.get(2)?;
                    Ok(Invite {
                        invite_id: r.get(0)?,
                        project_id: r.get(1)?,
                        role: Role::parse(&role).unwrap_or(Role::Viewer),
                        single_use: r.get::<_, i64>(3)? != 0,
                        used: r.get::<_, i64>(4)? != 0,
                        expires_at_iso: r.get(5)?,
                        replaced: r.get::<_, i64>(6)? != 0,
                        token_sha256: r.get(7)?,
                        created_at_iso: r.get(8)?,
                    })
                },
            )
            .optional()
    }

    /// Replace an invite's link: invalidate the old one (R6). Returns the role.
    /// The project an invite belongs to (for project-scoped replacement).
    pub fn invite_project(&self, invite_id: &str) -> rusqlite::Result<Option<String>> {
        self.conn.query_row("SELECT project_id FROM invites WHERE invite_id = ?1", [invite_id], |r| r.get(0)).optional()
    }

    pub fn replace_invite(&self, invite_id: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE invites SET replaced = 1 WHERE invite_id = ?1",
            rusqlite::params![invite_id],
        )?;
        Ok(())
    }

    /// Atomically redeem an invite: re-check redeemable inside one transaction,
    /// mark it used (single-use), and create a pending join request. Concurrent
    /// redemption cannot defeat single use (R6).
    pub fn redeem_invite(
        &mut self,
        token_sha256: &str,
        request_id: &str,
        actor_id: &str,
        display_name: &str,
        now_iso: &str,
    ) -> Result<(String, Role), JoinRefusal> {
        self.redeem_invite_bound(token_sha256, request_id, actor_id, display_name, None, now_iso)
    }

    /// Redeem and bind the joiner's device + credential verifier in the same
    /// transaction that consumes the invite (Story 27.4).
    pub fn redeem_invite_bound(
        &mut self,
        token_sha256: &str,
        request_id: &str,
        actor_id: &str,
        display_name: &str,
        binding: Option<(&str, &str, &str)>,
        now_iso: &str,
    ) -> Result<(String, Role), JoinRefusal> {
        if self.quarantined().map_err(|_| JoinRefusal::InviteNotFound)? { return Err(JoinRefusal::InviteNotFound); }
        let tx = self.conn.transaction().map_err(|_| JoinRefusal::InviteNotFound)?;
        let invite = {
            let read = tx
                .query_row(
                    "SELECT invite_id, project_id, role, single_use, used, expires_at_iso, replaced, token_sha256, created_at_iso
                     FROM invites WHERE token_sha256 = ?1",
                    rusqlite::params![token_sha256],
                    |r| {
                        let role: String = r.get(2)?;
                        Ok(Invite {
                            invite_id: r.get(0)?,
                            project_id: r.get(1)?,
                            role: Role::parse(&role).unwrap_or(Role::Viewer),
                            single_use: r.get::<_, i64>(3)? != 0,
                            used: r.get::<_, i64>(4)? != 0,
                            expires_at_iso: r.get(5)?,
                            replaced: r.get::<_, i64>(6)? != 0,
                            token_sha256: r.get(7)?,
                            created_at_iso: r.get(8)?,
                        })
                    },
                )
                .optional()
                .map_err(|_| JoinRefusal::InviteNotFound)?;
            read.ok_or(JoinRefusal::InviteNotFound)?
        };

        invite_redeemable(&invite, now_iso)?;

        tx.execute(
            "UPDATE invites SET used = 1 WHERE invite_id = ?1",
            rusqlite::params![invite.invite_id],
        )
        .map_err(|_| JoinRefusal::InviteNotFound)?;
        let (device_id, verifier_kind, verifier) = match binding {
            Some((device, kind, value)) => (Some(device), Some(kind), Some(value)),
            None => (None, None, None),
        };
        tx.execute(
            "INSERT INTO join_requests(request_id, project_id, actor_id, display_name, role, approved, denied, created_at_iso, device_id, verifier_kind, verifier)
             VALUES(?1, ?2, ?3, ?4, ?5, 0, 0, ?6, ?7, ?8, ?9)",
            rusqlite::params![request_id, invite.project_id, actor_id, display_name, invite.role.as_str(), now_iso, device_id, verifier_kind, verifier],
        )
        .map_err(|_| JoinRefusal::InviteNotFound)?;
        tx.commit().map_err(|_| JoinRefusal::InviteNotFound)?;
        Ok((invite.project_id, invite.role))
    }

    /// The project a join request belongs to (for project-scoped approval, R6).
    pub fn join_request_project(&self, request_id: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT project_id FROM join_requests WHERE request_id = ?1",
                rusqlite::params![request_id],
                |r| r.get(0),
            )
            .optional()
    }

    /// Approve a pending join request: bind the exact requesting device and role.
    #[allow(clippy::too_many_arguments)]
    pub fn approve_join(
        &self,
        request_id: &str,
        device_id: &str,
        verifier_kind: &str,
        verifier: &str,
        now_iso: &str,
    ) -> rusqlite::Result<Option<Role>> {
        #[allow(clippy::type_complexity)]
        let request: Option<(String, String, String, String, i64, i64, Option<String>, Option<String>, Option<String>)> = self
            .conn
            .query_row(
                "SELECT project_id, actor_id, display_name, role, denied, approved, device_id, verifier_kind, verifier FROM join_requests WHERE request_id = ?1",
                rusqlite::params![request_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
            )
            .optional()?;
        let Some((project_id, actor_id, display_name, role, denied, approved, bound_device, bound_kind, bound_verifier)) = request else {
            return Ok(None);
        };
        // A credential bound at redemption always wins: approval activates the
        // device the joiner proved, never one named by the approver.
        let (device_id, verifier_kind, verifier) = match (&bound_device, &bound_kind, &bound_verifier) {
            (Some(d), Some(k), Some(v)) => (d.as_str(), k.as_str(), v.as_str()),
            _ => (device_id, verifier_kind, verifier),
        };
        if device_id.is_empty() || verifier.is_empty() { return Ok(None); }
        // A denied or already-approved request is not re-approved (replay-safe).
        if denied != 0 || approved != 0 {
            return Ok(None);
        }
        let role = Role::parse(&role).unwrap_or(Role::Viewer);
        self.upsert_device(device_id, &project_id, &actor_id, &display_name, role, true, verifier_kind, verifier, now_iso)?;
        self.conn.execute(
            "UPDATE join_requests SET approved = 1 WHERE request_id = ?1",
            rusqlite::params![request_id],
        )?;
        Ok(Some(role))
    }

    /// Deny a pending join request.
    pub fn deny_join(&self, request_id: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE join_requests SET denied = 1 WHERE request_id = ?1",
            rusqlite::params![request_id],
        )?;
        Ok(())
    }

    /// Remove a device from a project only (R6: project-scoped revocation).
    /// Refuses to remove the last owner.
    pub fn remove_device(&self, device_id: &str, project_id: &str) -> Result<(), JoinRefusal> {
        let ctx = self
            .auth_context(device_id, project_id)
            .map_err(|_| JoinRefusal::NotAMember)?;
        let Some(ctx) = ctx else {
            return Err(JoinRefusal::NotAMember);
        };
        if ctx.role == Role::Owner && self.owner_count(project_id).map_err(|_| JoinRefusal::NotAMember)? <= 1 {
            return Err(JoinRefusal::LastOwner);
        }
        self.conn
            .execute(
                "DELETE FROM devices WHERE device_id = ?1 AND project_id = ?2",
                rusqlite::params![device_id, project_id],
            )
            .map_err(|_| JoinRefusal::NotAMember)?;
        Ok(())
    }

    /// Change a device's role, refusing to demote the last owner.
    pub fn set_role(&self, device_id: &str, project_id: &str, role: Role) -> Result<(), JoinRefusal> {
        let ctx = self
            .auth_context(device_id, project_id)
            .map_err(|_| JoinRefusal::NotAMember)?
            .ok_or(JoinRefusal::NotAMember)?;
        if ctx.role == Role::Owner && role != Role::Owner && self.owner_count(project_id).map_err(|_| JoinRefusal::NotAMember)? <= 1 {
            return Err(JoinRefusal::LastOwner);
        }
        self.conn
            .execute(
                "UPDATE devices SET role = ?1 WHERE device_id = ?2 AND project_id = ?3",
                rusqlite::params![role.as_str(), device_id, project_id],
            )
            .map_err(|_| JoinRefusal::NotAMember)?;
        Ok(())
    }

    /// Store the one-time owner recovery code verifier for a project.
    pub fn set_recovery(&self, project_id: &str, code_sha256: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO recovery(project_id, code_sha256, used) VALUES(?1, ?2, 0)
             ON CONFLICT(project_id) DO UPDATE SET code_sha256 = excluded.code_sha256, used = 0",
            rusqlite::params![project_id, code_sha256],
        )?;
        Ok(())
    }

    /// Atomically redeem a recovery code: single-use and replay-resistant.
    #[allow(clippy::too_many_arguments)]
    pub fn redeem_recovery(
        &mut self,
        project_id: &str,
        code_sha256: &str,
        device_id: &str,
        actor_id: &str,
        display_name: &str,
        verifier_kind: &str,
        verifier: &str,
        now_iso: &str,
    ) -> Result<Role, JoinRefusal> {
        if self.quarantined().map_err(|_| JoinRefusal::NotAMember)? { return Err(JoinRefusal::NotAMember); }
        let tx = self.conn.transaction().map_err(|_| JoinRefusal::NotAMember)?;
        let stored: Option<(String, i64)> = tx
            .query_row(
                "SELECT code_sha256, used FROM recovery WHERE project_id = ?1",
                rusqlite::params![project_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| JoinRefusal::NotAMember)?;
        let Some((stored_hash, used)) = stored else {
            return Err(JoinRefusal::NotAMember);
        };
        if used != 0 || stored_hash != code_sha256 {
            return Err(JoinRefusal::NotAMember);
        }
        tx.execute("UPDATE recovery SET used = 1 WHERE project_id = ?1", rusqlite::params![project_id])
            .map_err(|_| JoinRefusal::NotAMember)?;
        tx.execute(
            "INSERT INTO devices(device_id, project_id, actor_id, display_name, role, approved, verifier_kind, verifier, created_at_iso)
             VALUES(?1, ?2, ?3, ?4, 'owner', 1, ?5, ?6, ?7)
             ON CONFLICT(project_id, device_id) DO UPDATE SET role = 'owner', approved = 1",
            rusqlite::params![device_id, project_id, actor_id, display_name, verifier_kind, verifier, now_iso],
        )
        .map_err(|_| JoinRefusal::NotAMember)?;
        tx.commit().map_err(|_| JoinRefusal::NotAMember)?;
        Ok(Role::Owner)
    }

    /// Find an invite by its token verifier (test/inspection helper).
    pub fn invite_by_token(&self, token_sha256: &str) -> rusqlite::Result<Option<Invite>> {
        if self.quarantined()? { return Ok(None); }
        self.read_invite_by_token(token_sha256)
    }

    /// Claim an unclaimed project for its first owner (Story 27.4/27.6
    /// first-share registration). One transaction: a project that already has
    /// any member or share record is refused; an identical retry by the same
    /// device and verifier succeeds idempotently.
    #[allow(clippy::too_many_arguments)]
    pub fn claim_project_owner(
        &mut self,
        project_id: &str,
        device_id: &str,
        actor_id: &str,
        display_name: &str,
        verifier_kind: &str,
        verifier: &str,
        now_iso: &str,
    ) -> Result<ClaimOutcome, rusqlite::Error> {
        if self.quarantined()? { return Ok(ClaimOutcome::Unavailable); }
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let shared: bool = tx.query_row("SELECT 1 FROM share_state WHERE project_id = ?1", [project_id], |_| Ok(())).optional()?.is_some();
        let mut statement = tx.prepare("SELECT device_id, actor_id, role, approved, verifier_kind, verifier FROM devices WHERE project_id = ?1")?;
        let members = statement
            .query_map([project_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        if let [(existing_device, existing_actor, role, approved, kind, existing_verifier)] = members.as_slice() {
            let same = existing_device == device_id && existing_actor == actor_id && role == "owner" && *approved == 1
                && kind == verifier_kind && crate::auth::constant_time_hex_eq(existing_verifier, verifier);
            // The sole owner retrying with the same device, actor and proven
            // credential is idempotent even after the share completed: the
            // client may have lost the share response (network drop, redeploy)
            // and must be able to finish. Nothing new is granted.
            if same { return Ok(ClaimOutcome::AlreadyOwner); }
            return Ok(ClaimOutcome::AlreadyClaimed);
        }
        if !members.is_empty() || shared { return Ok(ClaimOutcome::AlreadyClaimed); }
        tx.execute(
            "INSERT INTO devices(device_id, project_id, actor_id, display_name, role, approved, verifier_kind, verifier, created_at_iso)
             VALUES(?1, ?2, ?3, ?4, 'owner', 1, ?5, ?6, ?7)",
            rusqlite::params![device_id, project_id, actor_id, display_name, verifier_kind, verifier, now_iso],
        )?;
        tx.commit()?;
        Ok(ClaimOutcome::Claimed)
    }

    /// Approved members of a project, for the owner's Share dialog.
    pub fn list_members(&self, project_id: &str) -> rusqlite::Result<Vec<MemberRow>> {
        if self.quarantined()? { return Ok(Vec::new()); }
        let mut statement = self.conn.prepare(
            "SELECT device_id, display_name, role FROM devices WHERE project_id = ?1 AND approved = 1 ORDER BY created_at_iso, device_id",
        )?;
        let rows = statement.query_map([project_id], |r| {
            let role: String = r.get(2)?;
            Ok(MemberRow { device_id: r.get(0)?, display_name: r.get(1)?, role: Role::parse(&role).unwrap_or(Role::Viewer) })
        })?;
        rows.collect()
    }

    /// Every actor who is or was an approved member, with their display name,
    /// so attribution keeps resolving names for history (Story 27.8).
    pub fn people(&self, project_id: &str) -> rusqlite::Result<Vec<(String, String)>> {
        if self.quarantined()? { return Ok(Vec::new()); }
        let mut statement = self.conn.prepare(
            "SELECT actor_id, display_name FROM devices WHERE project_id = ?1 AND approved = 1
             UNION SELECT actor_id, display_name FROM join_requests WHERE project_id = ?1 AND approved = 1
             ORDER BY 2, 1",
        )?;
        let rows = statement.query_map([project_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    /// Pending (neither approved nor denied) join requests for a project.
    pub fn list_pending_requests(&self, project_id: &str) -> rusqlite::Result<Vec<JoinRequestRow>> {
        if self.quarantined()? { return Ok(Vec::new()); }
        let mut statement = self.conn.prepare(
            "SELECT request_id, display_name, role FROM join_requests WHERE project_id = ?1 AND approved = 0 AND denied = 0 ORDER BY created_at_iso, request_id",
        )?;
        let rows = statement.query_map([project_id], |r| {
            let role: String = r.get(2)?;
            Ok(JoinRequestRow { request_id: r.get(0)?, display_name: r.get(1)?, role: Role::parse(&role).unwrap_or(Role::Viewer) })
        })?;
        rows.collect()
    }

    /// A join request with its bound credential (for the joiner's status).
    pub fn join_request_state(&self, request_id: &str) -> rusqlite::Result<Option<JoinRequestState>> {
        if self.quarantined()? { return Ok(None); }
        self.conn
            .query_row(
                "SELECT project_id, role, approved, denied, device_id, verifier_kind, verifier FROM join_requests WHERE request_id = ?1",
                [request_id],
                |r| {
                    let role: String = r.get(1)?;
                    let kind: Option<String> = r.get(5)?;
                    let value: Option<String> = r.get(6)?;
                    Ok(JoinRequestState {
                        project_id: r.get(0)?,
                        role: Role::parse(&role).unwrap_or(Role::Viewer),
                        approved: r.get::<_, i64>(2)? != 0,
                        denied: r.get::<_, i64>(3)? != 0,
                        device_id: r.get(4)?,
                        verifier: match (kind.as_deref(), value) {
                            (Some("publicKey"), Some(v)) => Some(CredentialVerifier::PublicKey { public_key_b64: v }),
                            (Some("bearerHash"), Some(v)) => Some(CredentialVerifier::BearerHash { sha256: v }),
                            _ => None,
                        },
                    })
                },
            )
            .optional()
    }

    /// Whether joining this project needs owner approval (default true).
    pub fn approval_required(&self, project_id: &str) -> rusqlite::Result<bool> {
        Ok(self.conn
            .query_row("SELECT approval_required FROM project_settings WHERE project_id = ?1", [project_id], |r| r.get::<_, i64>(0))
            .optional()?
            .map_or(true, |v| v != 0))
    }

    pub fn set_approval_required(&self, project_id: &str, required: bool) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO project_settings(project_id, approval_required) VALUES(?1, ?2)
             ON CONFLICT(project_id) DO UPDATE SET approval_required = excluded.approval_required",
            rusqlite::params![project_id, required as i64],
        )?;
        Ok(())
    }

    /// The transactionally maintained membership revision (Story 27.5).
    pub fn revision(&self) -> rusqlite::Result<i64> {
        self.conn.query_row("SELECT revision FROM membership_meta WHERE singleton = 1", [], |r| r.get(0))
    }

    /// Whether this database is a quarantined restore (Story 27.5). A
    /// quarantined store admits no credential, invitation or recovery code.
    pub fn quarantined(&self) -> rusqlite::Result<bool> {
        self.conn
            .query_row("SELECT 1 FROM membership_restore_quarantine WHERE singleton = 1", [], |_| Ok(()))
            .optional()
            .map(|row| row.is_some())
    }

    /// Quarantine a restored membership database before it can serve.
    pub fn quarantine(&self, reason: &str, now_iso: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO membership_restore_quarantine(singleton, reason, quarantined_at_iso) VALUES(1, ?1, ?2)",
            rusqlite::params![reason, now_iso],
        )?;
        Ok(())
    }

    /// Copy this database to `dest` with SQLite's online backup API, through
    /// the held connection. Callers hold the store lock, so no write can land
    /// mid-copy (Story 27.5 coherent cut).
    pub fn backup_to(&self, dest: &Path) -> rusqlite::Result<()> {
        let mut target = Connection::open(dest)?;
        let backup = rusqlite::backup::Backup::new(&self.conn, &mut target)?;
        backup.run_to_completion(256, std::time::Duration::from_millis(0), None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> MembershipStore {
        MembershipStore::open_in_memory().unwrap()
    }

    const P: &str = "019ff600-0000-7000-8000-000000000001";
    const NOW: &str = "2026-09-30T00:00:00Z";

    #[test]
    fn every_membership_write_advances_the_revision_transactionally() {
        let mut s = store();
        assert_eq!(s.revision().unwrap(), 0);
        s.insert_invite("inv1", P, Role::Editor, true, None, "tokhash", NOW).unwrap();
        let after_invite = s.revision().unwrap();
        assert!(after_invite > 0);
        s.redeem_invite("tokhash", "req1", "actor-b", "Milo", NOW).unwrap();
        let after_redeem = s.revision().unwrap();
        assert!(after_redeem > after_invite);
        // A refused redemption commits nothing and leaves the revision alone.
        assert!(s.redeem_invite("tokhash", "req2", "actor-c", "Ada", NOW).is_err());
        assert_eq!(s.revision().unwrap(), after_redeem);
        s.upsert_share(P, "op", "shared", NOW).unwrap();
        assert!(s.revision().unwrap() > after_redeem);
    }

    #[test]
    fn quarantined_restore_admits_no_credential_invite_or_recovery() {
        let mut s = store();
        s.upsert_device("dev1", P, "actor-a", "Owner", Role::Owner, true, "bearerHash", "ab", NOW).unwrap();
        s.insert_invite("inv1", P, Role::Editor, true, None, "tokhash", NOW).unwrap();
        s.set_recovery(P, "codehash").unwrap();
        assert!(s.auth_context("dev1", P).unwrap().is_some());
        s.quarantine("RESTORE_DRILL", NOW).unwrap();
        assert!(s.quarantined().unwrap());
        assert!(s.auth_context("dev1", P).unwrap().is_none());
        assert!(s.device_verifier("dev1", P).unwrap().is_none());
        assert!(s.invite_by_token("tokhash").unwrap().is_none());
        assert!(s.redeem_invite("tokhash", "req1", "actor-b", "Milo", NOW).is_err());
        assert!(s.redeem_recovery(P, "codehash", "dev2", "actor-c", "Ada", "bearerHash", "cd", NOW).is_err());
    }

    #[test]
    fn first_owner_claim_is_exclusive_and_idempotent() {
        let mut s = store();
        assert_eq!(s.claim_project_owner(P, "dev1", "actor-a", "Hera", "bearerHash", &"a".repeat(64), NOW).unwrap(), ClaimOutcome::Claimed);
        assert_eq!(s.auth_context("dev1", P).unwrap().unwrap().role, Role::Owner);
        assert_eq!(s.claim_project_owner(P, "dev1", "actor-a", "Hera", "bearerHash", &"a".repeat(64), NOW).unwrap(), ClaimOutcome::AlreadyOwner);
        // A different device, actor or credential can never take the project.
        assert_eq!(s.claim_project_owner(P, "dev2", "actor-b", "Mallory", "bearerHash", &"b".repeat(64), NOW).unwrap(), ClaimOutcome::AlreadyClaimed);
        assert_eq!(s.claim_project_owner(P, "dev1", "actor-a", "Hera", "bearerHash", &"b".repeat(64), NOW).unwrap(), ClaimOutcome::AlreadyClaimed);
        // The same owner retrying after the share completed (lost response)
        // is still idempotent; anyone else is still refused.
        s.upsert_share(P, "op-1", "shared", NOW).unwrap();
        assert_eq!(s.claim_project_owner(P, "dev1", "actor-a", "Hera", "bearerHash", &"a".repeat(64), NOW).unwrap(), ClaimOutcome::AlreadyOwner);
        assert_eq!(s.claim_project_owner(P, "dev2", "actor-b", "Mallory", "bearerHash", &"b".repeat(64), NOW).unwrap(), ClaimOutcome::AlreadyClaimed);
        assert_eq!(s.claim_project_owner(P, "dev1", "actor-a", "Hera", "bearerHash", &"b".repeat(64), NOW).unwrap(), ClaimOutcome::AlreadyClaimed);
        // A project with a share record and no owner is already claimed.
        let other = "019ff600-0000-7000-8000-000000000002";
        s.upsert_share(other, "op", "provisioning", NOW).unwrap();
        assert_eq!(s.claim_project_owner(other, "dev1", "actor-a", "Hera", "bearerHash", &"a".repeat(64), NOW).unwrap(), ClaimOutcome::AlreadyClaimed);
        // Quarantined restores accept no claims.
        s.quarantine("RESTORE_DRILL", NOW).unwrap();
        let third = "019ff600-0000-7000-8000-000000000003";
        assert_eq!(s.claim_project_owner(third, "dev1", "actor-a", "Hera", "bearerHash", &"a".repeat(64), NOW).unwrap(), ClaimOutcome::Unavailable);
    }

    #[test]
    fn bound_redemption_is_what_approval_activates() {
        let mut s = store();
        s.insert_invite("inv1", P, Role::Editor, true, None, "tokhash", NOW).unwrap();
        s.redeem_invite_bound("tokhash", "req1", "actor-b", "Milo", Some(("dev-joiner", "bearerHash", &"c".repeat(64))), NOW).unwrap();
        assert_eq!(s.list_pending_requests(P).unwrap(), vec![JoinRequestRow { request_id: "req1".into(), display_name: "Milo".into(), role: Role::Editor }]);
        let state = s.join_request_state("req1").unwrap().unwrap();
        assert!(!state.approved && !state.denied);
        assert_eq!(state.device_id.as_deref(), Some("dev-joiner"));
        // The approver's body cannot substitute another device or verifier.
        assert_eq!(s.approve_join("req1", "dev-mallory", "bearerHash", &"d".repeat(64), NOW).unwrap(), Some(Role::Editor));
        assert!(s.auth_context("dev-mallory", P).unwrap().is_none());
        assert_eq!(s.auth_context("dev-joiner", P).unwrap().unwrap().role, Role::Editor);
        assert_eq!(s.device_verifier("dev-joiner", P).unwrap(), Some(CredentialVerifier::BearerHash { sha256: "c".repeat(64) }));
        assert!(s.list_pending_requests(P).unwrap().is_empty());
        assert_eq!(s.list_members(P).unwrap(), vec![MemberRow { device_id: "dev-joiner".into(), display_name: "Milo".into(), role: Role::Editor }]);
        // An unbound legacy request without approver binding cannot be approved.
        s.insert_invite("inv2", P, Role::Viewer, true, None, "tok2", NOW).unwrap();
        s.redeem_invite("tok2", "req2", "actor-c", "Ada", NOW).unwrap();
        assert_eq!(s.approve_join("req2", "", "", "", NOW).unwrap(), None);
    }

    #[test]
    fn invite_redemption_is_single_use_and_creates_a_pending_request() {
        let mut s = store();
        s.insert_invite("inv1", P, Role::Editor, true, None, "tokhash", NOW).unwrap();
        let (project, role) = s.redeem_invite("tokhash", "req1", "actor-b", "Milo", NOW).unwrap();
        assert_eq!(project, P);
        assert_eq!(role, Role::Editor);
        // A second redemption of a single-use invite is refused.
        assert_eq!(s.redeem_invite("tokhash", "req2", "actor-c", "Sam", NOW), Err(JoinRefusal::InviteUsed));
    }

    #[test]
    fn expired_and_replaced_invites_are_refused() {
        let mut s = store();
        s.insert_invite("inv1", P, Role::Editor, false, Some("2026-09-01T00:00:00Z"), "tok1", NOW).unwrap();
        assert_eq!(s.redeem_invite("tok1", "req1", "a", "A", NOW).unwrap_err(), JoinRefusal::InviteExpired);
        s.insert_invite("inv2", P, Role::Editor, false, None, "tok2", NOW).unwrap();
        s.replace_invite("inv2").unwrap();
        assert_eq!(s.redeem_invite("tok2", "req2", "a", "A", NOW).unwrap_err(), JoinRefusal::InviteReplaced);
    }

    #[test]
    fn approval_binds_the_requesting_device_and_role() {
        let mut s = store();
        s.insert_invite("inv1", P, Role::Editor, true, None, "tok", NOW).unwrap();
        s.redeem_invite("tok", "req1", "actor-b", "Milo", NOW).unwrap();
        // Before approval the joiner cannot write.
        assert!(!s.can_write("dev-b", P).unwrap());
        assert_eq!(s.approve_join("req1", "dev-b", "bearerHash", "hash", NOW).unwrap(), Some(Role::Editor));
        assert!(s.can_write("dev-b", P).unwrap());
        assert!(!s.can_manage("dev-b", P).unwrap());
    }

    #[test]
    fn authorization_is_per_project_and_role_scoped() {
        let s = store();
        s.upsert_device("dev-owner", P, "actor-owner", "Hera", Role::Owner, true, "bearerHash", "h", NOW).unwrap();
        s.upsert_device("dev-viewer", P, "actor-v", "Sam", Role::Viewer, true, "bearerHash", "h", NOW).unwrap();
        s.upsert_device("dev-owner", "other-project", "actor-owner", "Hera", Role::Owner, true, "bearerHash", "h", NOW).unwrap();
        assert!(s.can_write("dev-owner", P).unwrap());
        assert!(s.can_manage("dev-owner", P).unwrap());
        assert!(!s.can_write("dev-viewer", P).unwrap());
        // Not a member of this project.
        assert!(!s.can_write("dev-none", P).unwrap());
        // A second project is independent: removing a viewer there leaves P intact.
        s.upsert_device("dev-viewer", "other-project", "actor-v", "Sam", Role::Viewer, true, "bearerHash", "h", NOW).unwrap();
        assert!(s.can_write("dev-owner", "other-project").unwrap());
        s.remove_device("dev-viewer", "other-project").unwrap();
        assert!(!s.can_write("dev-viewer", "other-project").unwrap());
        assert!(!s.can_write("dev-viewer", P).unwrap());
        assert!(s.can_write("dev-owner", P).unwrap());
    }

    #[test]
    fn last_owner_cannot_be_removed_or_demoted() {
        let s = store();
        s.upsert_device("dev-owner", P, "actor-owner", "Hera", Role::Owner, true, "bearerHash", "h", NOW).unwrap();
        assert_eq!(s.remove_device("dev-owner", P).unwrap_err(), JoinRefusal::LastOwner);
        assert_eq!(s.set_role("dev-owner", P, Role::Viewer).unwrap_err(), JoinRefusal::LastOwner);
        // With a second owner, removal is allowed.
        s.upsert_device("dev-owner2", P, "actor-o2", "Milo", Role::Owner, true, "bearerHash", "h", NOW).unwrap();
        assert!(s.set_role("dev-owner2", P, Role::Owner).is_ok());
        assert!(s.remove_device("dev-owner", P).is_ok());
    }

    #[test]
    fn recovery_code_is_single_use_and_replay_resistant() {
        let mut s = store();
        let verifier = crate::membership::recovery_code_verifier("SECRET-CODE");
        s.set_recovery(P, &verifier).unwrap();
        let role = s
            .redeem_recovery(P, &verifier, "dev-new", "actor-new", "Hera laptop", "bearerHash", "h", NOW)
            .unwrap();
        assert_eq!(role, Role::Owner);
        // Replay is refused.
        assert_eq!(
            s.redeem_recovery(P, &verifier, "dev-new2", "actor-new2", "X", "bearerHash", "h", NOW).unwrap_err(),
            JoinRefusal::NotAMember
        );
        // A wrong code is refused.
        s.set_recovery(P, &verifier).unwrap();
        assert!(s.redeem_recovery(P, "wronghash", "d", "a", "n", "bearerHash", "h", NOW).is_err());
    }
}
