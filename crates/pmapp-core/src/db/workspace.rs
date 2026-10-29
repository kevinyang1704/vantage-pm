//! Workspace registry operations (Epic 17) — native counterpart to
//! `src/adapters/persistence/workspace-operations.ts`.
//!
//! Workspace mutations are NOT `ProductCommand`s: they have no `base_revision`,
//! write no `product_command_receipt`, produce no `ChangeSet`, and are never
//! written to the portable file. They follow the `view_state` precedent — an
//! isolated lane applied directly — so they are not undoable, by design.
//!
//! The webview is not trusted: every mutation re-validates the name and the
//! delete eligibility here, so a hand-crafted `invoke` cannot bypass the rules
//! the browser composition enforces.

use rusqlite::{Connection, OptionalExtension};

use crate::protocol::errors::RepositoryError;
use crate::protocol::uuid_v7::create_uuid_v7;

/// Settings key under which the active workspace pointer is persisted.
/// Must match `ACTIVE_WORKSPACE_SETTING_KEY` in `src/contracts/workspace.ts`.
pub const ACTIVE_WORKSPACE_SETTING_KEY: &str = "active_workspace_id";

/// Name given to the workspace created by the one-time backfill.
/// Must match `DEFAULT_WORKSPACE_NAME` in `src/domain/workspace/workspace.policy.ts`.
pub const DEFAULT_WORKSPACE_NAME: &str = "My Workspace";

/// Maximum code points for a workspace name (matches the TS policy).
pub const MAX_WORKSPACE_NAME_LENGTH: usize = 200;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRow {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub project_count: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRegistry {
    pub workspaces: Vec<WorkspaceRow>,
    pub active_workspace_id: String,
}

/// The mutation union as it crosses the Tauri boundary. Mirrors the
/// `MutateWorkspace` message's `mutation` field in the browser composition.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind")]
pub enum WorkspaceMutation {
    Create {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        name: String,
    },
    Rename {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        name: String,
    },
    Delete {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
    SetActive {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
    MoveProject {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
}

/// Result union. Serialized to match `WorkspaceMutationResult` in
/// `src/contracts/workspace.ts` exactly — the TS side discriminates on `type`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type")]
pub enum WorkspaceMutationResult {
    WorkspaceMutationApplied {
        registry: WorkspaceRegistry,
    },
    WorkspaceMutationRejected {
        code: String,
        #[serde(rename = "projectCount", skip_serializing_if = "Option::is_none")]
        project_count: Option<i64>,
    },
}

fn rejected(code: &str, project_count: Option<i64>) -> WorkspaceMutationResult {
    WorkspaceMutationResult::WorkspaceMutationRejected {
        code: code.to_string(),
        project_count,
    }
}

/// Validate a workspace name. Trims, rejects empty, caps at 200 code points.
/// Mirrors `validateWorkspaceName` in the TS domain policy.
fn validate_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() > MAX_WORKSPACE_NAME_LENGTH {
        return None;
    }
    Some(trimmed.to_string())
}

fn workspace_exists(conn: &Connection, workspace_id: &str) -> Result<bool, RepositoryError> {
    let found: Option<String> = conn
        .query_row(
            "SELECT id FROM workspaces WHERE id = ?1",
            [workspace_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| RepositoryError::Internal)?;
    Ok(found.is_some())
}

fn count_projects_in(conn: &Connection, workspace_id: &str) -> Result<i64, RepositoryError> {
    conn.query_row(
        "SELECT COUNT(*) FROM projects WHERE workspace_id = ?1",
        [workspace_id],
        |r| r.get(0),
    )
    .map_err(|_| RepositoryError::Internal)
}

fn write_active_workspace_id(conn: &Connection, workspace_id: &str) -> Result<(), RepositoryError> {
    conn.execute(
        "INSERT INTO app_settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [ACTIVE_WORKSPACE_SETTING_KEY, workspace_id],
    )
    .map_err(|_| RepositoryError::Internal)?;
    Ok(())
}

/// Guarantee the invariants the rest of the feature assumes:
///   1. At least one workspace exists.
///   2. Every project has a non-null `workspace_id`.
///   3. `active_workspace_id` resolves to a workspace that exists.
///
/// Runs on every open, immediately after schema init/migration. Idempotent.
/// Returns the resolved active workspace id.
pub fn ensure_default_workspace(conn: &Connection) -> Result<String, RepositoryError> {
    let first: Option<String> = conn
        .query_row(
            "SELECT id FROM workspaces ORDER BY position ASC, id ASC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| RepositoryError::Internal)?;

    let fallback_id = match first {
        Some(id) => id,
        None => {
            let id = create_uuid_v7();
            conn.execute(
                "INSERT INTO workspaces(id, name, position) VALUES(?1, ?2, 0)",
                rusqlite::params![&id, DEFAULT_WORKSPACE_NAME],
            )
            .map_err(|_| RepositoryError::Internal)?;
            id
        }
    };

    // One-time backfill: every project that predates workspaces lands in the
    // lowest-positioned workspace.
    conn.execute(
        "UPDATE projects SET workspace_id = ?1 WHERE workspace_id IS NULL",
        [&fallback_id],
    )
    .map_err(|_| RepositoryError::Internal)?;

    // Re-home projects pointing at a workspace that no longer exists (a
    // restore from a backup taken at a different point, or a hand-edited
    // file) rather than leaving them invisible to every scoped query.
    conn.execute(
        "UPDATE projects SET workspace_id = ?1
         WHERE workspace_id NOT IN (SELECT id FROM workspaces)",
        [&fallback_id],
    )
    .map_err(|_| RepositoryError::Internal)?;

    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [ACTIVE_WORKSPACE_SETTING_KEY],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| RepositoryError::Internal)?;

    if let Some(id) = stored {
        if workspace_exists(conn, &id)? {
            return Ok(id);
        }
    }
    write_active_workspace_id(conn, &fallback_id)?;
    Ok(fallback_id)
}

/// Read the active workspace pointer WITHOUT repairing anything.
///
/// Safe to call inside a caller's open transaction — unlike
/// `ensure_default_workspace`, which writes.
pub fn read_active_workspace_id(conn: &Connection) -> Result<Option<String>, RepositoryError> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [ACTIVE_WORKSPACE_SETTING_KEY],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| RepositoryError::Internal)?;

    if let Some(id) = stored {
        if workspace_exists(conn, &id)? {
            return Ok(Some(id));
        }
    }

    conn.query_row(
        "SELECT id FROM workspaces ORDER BY position ASC, id ASC LIMIT 1",
        [],
        |r| r.get(0),
    )
    .optional()
    .map_err(|_| RepositoryError::Internal)
}

pub fn query_workspace_registry(conn: &Connection) -> Result<WorkspaceRegistry, RepositoryError> {
    let active_workspace_id = ensure_default_workspace(conn)?;

    let mut stmt = conn
        .prepare(
            "SELECT w.id, w.name, w.position, COUNT(p.id) AS project_count
               FROM workspaces w
               LEFT JOIN projects p ON p.workspace_id = w.id
              GROUP BY w.id, w.name, w.position
              ORDER BY w.position ASC, w.name ASC",
        )
        .map_err(|_| RepositoryError::Internal)?;

    let rows = stmt
        .query_map([], |r| {
            Ok(WorkspaceRow {
                id: r.get(0)?,
                name: r.get(1)?,
                position: r.get(2)?,
                project_count: r.get(3)?,
            })
        })
        .map_err(|_| RepositoryError::Internal)?;

    let mut workspaces = Vec::new();
    for row in rows {
        workspaces.push(row.map_err(|_| RepositoryError::Internal)?);
    }

    Ok(WorkspaceRegistry {
        workspaces,
        active_workspace_id,
    })
}

pub fn mutate_workspace(
    conn: &mut Connection,
    mutation: WorkspaceMutation,
) -> Result<WorkspaceMutationResult, RepositoryError> {
    match mutation {
        WorkspaceMutation::Create { workspace_id, name } => {
            let Some(trimmed) = validate_name(&name) else {
                return Ok(rejected("INVALID_WORKSPACE_NAME", None));
            };
            let tx = conn
                .transaction()
                .map_err(|_| RepositoryError::Internal)?;
            let next_position: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(position) + 1, 0) FROM workspaces",
                    [],
                    |r| r.get(0),
                )
                .map_err(|_| RepositoryError::Internal)?;
            tx.execute(
                "INSERT INTO workspaces(id, name, position) VALUES(?1, ?2, ?3)",
                rusqlite::params![&workspace_id, &trimmed, next_position],
            )
            .map_err(|_| RepositoryError::Internal)?;
            tx.execute(
                "INSERT INTO app_settings(key, value) VALUES(?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [ACTIVE_WORKSPACE_SETTING_KEY, &workspace_id],
            )
            .map_err(|_| RepositoryError::Internal)?;
            tx.commit().map_err(|_| RepositoryError::Internal)?;
        }

        WorkspaceMutation::Rename { workspace_id, name } => {
            if !workspace_exists(conn, &workspace_id)? {
                return Ok(rejected("WORKSPACE_NOT_FOUND", None));
            }
            let Some(trimmed) = validate_name(&name) else {
                return Ok(rejected("INVALID_WORKSPACE_NAME", None));
            };
            conn.execute(
                "UPDATE workspaces SET name = ?1 WHERE id = ?2",
                rusqlite::params![&trimmed, &workspace_id],
            )
            .map_err(|_| RepositoryError::Internal)?;
        }

        WorkspaceMutation::Delete { workspace_id } => {
            if !workspace_exists(conn, &workspace_id)? {
                return Ok(rejected("WORKSPACE_NOT_FOUND", None));
            }
            let project_count = count_projects_in(conn, &workspace_id)?;
            if project_count > 0 {
                return Ok(rejected("WORKSPACE_NOT_EMPTY", Some(project_count)));
            }
            let total: i64 = conn
                .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
                .map_err(|_| RepositoryError::Internal)?;
            if total <= 1 {
                return Ok(rejected("LAST_WORKSPACE", None));
            }
            conn.execute("DELETE FROM workspaces WHERE id = ?1", [&workspace_id])
                .map_err(|_| RepositoryError::Internal)?;
            // If the deleted workspace was active, query_workspace_registry's
            // ensure_default_workspace repoints at a survivor.
        }

        WorkspaceMutation::SetActive { workspace_id } => {
            if !workspace_exists(conn, &workspace_id)? {
                return Ok(rejected("WORKSPACE_NOT_FOUND", None));
            }
            write_active_workspace_id(conn, &workspace_id)?;
        }

        WorkspaceMutation::MoveProject {
            project_id,
            workspace_id,
        } => {
            if !workspace_exists(conn, &workspace_id)? {
                return Ok(rejected("WORKSPACE_NOT_FOUND", None));
            }
            let found: Option<String> = conn
                .query_row("SELECT id FROM projects WHERE id = ?1", [&project_id], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(|_| RepositoryError::Internal)?;
            if found.is_none() {
                return Ok(rejected("PROJECT_NOT_FOUND", None));
            }
            // Deliberately does NOT bump projects.revision: workspace
            // membership is not project content, and bumping it would
            // invalidate every in-flight command's baseRevision plus the
            // workspace summary cache for a change that altered no node.
            conn.execute(
                "UPDATE projects SET workspace_id = ?1 WHERE id = ?2",
                rusqlite::params![&workspace_id, &project_id],
            )
            .map_err(|_| RepositoryError::Internal)?;
        }
    }

    Ok(WorkspaceMutationResult::WorkspaceMutationApplied {
        registry: query_workspace_registry(conn)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::PRODUCT_SCHEMA_DDL;

    fn open() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for ddl in PRODUCT_SCHEMA_DDL.iter() {
            conn.execute_batch(ddl).unwrap();
        }
        conn
    }

    #[test]
    fn ensure_creates_a_default_workspace_and_is_idempotent() {
        let conn = open();
        let first = ensure_default_workspace(&conn).unwrap();
        let second = ensure_default_workspace(&conn).unwrap();
        assert_eq!(first, second);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "must not create a second default workspace");
    }

    #[test]
    fn ensure_backfills_projects_that_predate_workspaces() {
        let conn = open();
        conn.execute(
            "INSERT INTO projects(id, name, revision, workspace_id) VALUES('p1','Legacy',1,NULL)",
            [],
        )
        .unwrap();
        let active = ensure_default_workspace(&conn).unwrap();
        let homed: String = conn
            .query_row("SELECT workspace_id FROM projects WHERE id='p1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(homed, active);
    }

    #[test]
    fn delete_is_refused_while_projects_remain() {
        let mut conn = open();
        let active = ensure_default_workspace(&conn).unwrap();
        conn.execute(
            "INSERT INTO projects(id, name, revision, workspace_id) VALUES('p1','A',1,?1)",
            [&active],
        )
        .unwrap();
        let result = mutate_workspace(
            &mut conn,
            WorkspaceMutation::Delete {
                workspace_id: active.clone(),
            },
        )
        .unwrap();
        match result {
            WorkspaceMutationResult::WorkspaceMutationRejected { code, project_count } => {
                assert_eq!(code, "WORKSPACE_NOT_EMPTY");
                assert_eq!(project_count, Some(1));
            }
            _ => panic!("expected rejection"),
        }
        let still_there: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(still_there, 1, "a refused delete must not touch projects");
    }

    #[test]
    fn last_workspace_cannot_be_deleted_even_when_empty() {
        let mut conn = open();
        let active = ensure_default_workspace(&conn).unwrap();
        let result = mutate_workspace(
            &mut conn,
            WorkspaceMutation::Delete {
                workspace_id: active,
            },
        )
        .unwrap();
        match result {
            WorkspaceMutationResult::WorkspaceMutationRejected { code, .. } => {
                assert_eq!(code, "LAST_WORKSPACE");
            }
            _ => panic!("expected rejection"),
        }
    }

    #[test]
    fn deleting_the_active_workspace_repoints_the_pointer() {
        let mut conn = open();
        let first = ensure_default_workspace(&conn).unwrap();
        let second_id = create_uuid_v7();
        // Create makes the new workspace active.
        mutate_workspace(
            &mut conn,
            WorkspaceMutation::Create {
                workspace_id: second_id.clone(),
                name: "Second".to_string(),
            },
        )
        .unwrap();
        assert_eq!(read_active_workspace_id(&conn).unwrap(), Some(second_id.clone()));

        let result = mutate_workspace(
            &mut conn,
            WorkspaceMutation::Delete {
                workspace_id: second_id,
            },
        )
        .unwrap();
        match result {
            WorkspaceMutationResult::WorkspaceMutationApplied { registry } => {
                assert_eq!(registry.active_workspace_id, first);
            }
            _ => panic!("expected the delete to be applied"),
        }
    }

    #[test]
    fn move_project_does_not_bump_revision() {
        let mut conn = open();
        let first = ensure_default_workspace(&conn).unwrap();
        conn.execute(
            "INSERT INTO projects(id, name, revision, workspace_id) VALUES('p1','A',7,?1)",
            [&first],
        )
        .unwrap();
        let second_id = create_uuid_v7();
        mutate_workspace(
            &mut conn,
            WorkspaceMutation::Create {
                workspace_id: second_id.clone(),
                name: "Second".to_string(),
            },
        )
        .unwrap();
        mutate_workspace(
            &mut conn,
            WorkspaceMutation::MoveProject {
                project_id: "p1".to_string(),
                workspace_id: second_id.clone(),
            },
        )
        .unwrap();

        let (ws, rev): (String, i64) = conn
            .query_row(
                "SELECT workspace_id, revision FROM projects WHERE id='p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(ws, second_id);
        assert_eq!(rev, 7, "workspace membership is not project content");
    }

    // ── Cross-boundary contract ────────────────────────────────────
    //
    // The webview discriminates on these exact field names and tag values
    // (see `WorkspaceRegistry` / `WorkspaceMutationResult` in
    // `src/contracts/workspace.ts`). A rename on either side that is not
    // mirrored would compile cleanly and fail only at runtime, in the native
    // build alone — so the shape is asserted here rather than assumed.

    #[test]
    fn mutation_deserializes_from_the_typescript_wire_shape() {
        let create: WorkspaceMutation = serde_json::from_str(
            r#"{"kind":"Create","workspaceId":"ws-1","name":"Client"}"#,
        )
        .unwrap();
        match create {
            WorkspaceMutation::Create { workspace_id, name } => {
                assert_eq!(workspace_id, "ws-1");
                assert_eq!(name, "Client");
            }
            _ => panic!("expected Create"),
        }

        let mv: WorkspaceMutation = serde_json::from_str(
            r#"{"kind":"MoveProject","projectId":"p-1","workspaceId":"ws-2"}"#,
        )
        .unwrap();
        match mv {
            WorkspaceMutation::MoveProject {
                project_id,
                workspace_id,
            } => {
                assert_eq!(project_id, "p-1");
                assert_eq!(workspace_id, "ws-2");
            }
            _ => panic!("expected MoveProject"),
        }
    }

    #[test]
    fn registry_and_results_serialize_to_the_typescript_contract() {
        let registry = WorkspaceRegistry {
            workspaces: vec![WorkspaceRow {
                id: "ws-1".into(),
                name: "Client".into(),
                position: 0,
                project_count: 3,
            }],
            active_workspace_id: "ws-1".into(),
        };
        let json = serde_json::to_value(
            WorkspaceMutationResult::WorkspaceMutationApplied { registry },
        )
        .unwrap();

        assert_eq!(json["type"], "WorkspaceMutationApplied");
        assert_eq!(json["registry"]["activeWorkspaceId"], "ws-1");
        assert_eq!(json["registry"]["workspaces"][0]["projectCount"], 3);
        assert_eq!(json["registry"]["workspaces"][0]["position"], 0);

        let rejected_json = serde_json::to_value(rejected("WORKSPACE_NOT_EMPTY", Some(2))).unwrap();
        assert_eq!(rejected_json["type"], "WorkspaceMutationRejected");
        assert_eq!(rejected_json["code"], "WORKSPACE_NOT_EMPTY");
        assert_eq!(rejected_json["projectCount"], 2);

        // projectCount is omitted (not null) when it does not apply, matching
        // the optional field in the TS union.
        let no_count = serde_json::to_value(rejected("WORKSPACE_NOT_FOUND", None)).unwrap();
        assert!(
            no_count.get("projectCount").is_none(),
            "projectCount must be absent, not null"
        );
    }

    #[test]
    fn schema_version_tracks_the_migration_registry() {
        // Regression guard for the drift this epic fixed: CURRENT_SCHEMA_VERSION
        // was a hardcoded 5 while the registry had advanced to 6, so
        // `run_migrations` short-circuited before the v6 step.
        use crate::db::schema::CURRENT_SCHEMA_VERSION;
        use crate::migration::registry::current_supported_version;
        assert_eq!(
            CURRENT_SCHEMA_VERSION,
            current_supported_version(),
            "the version stamped on a fresh database must equal the highest migration step"
        );
    }

    #[test]
    fn blank_names_are_refused() {
        let mut conn = open();
        ensure_default_workspace(&conn).unwrap();
        let result = mutate_workspace(
            &mut conn,
            WorkspaceMutation::Create {
                workspace_id: create_uuid_v7(),
                name: "   ".to_string(),
            },
        )
        .unwrap();
        match result {
            WorkspaceMutationResult::WorkspaceMutationRejected { code, .. } => {
                assert_eq!(code, "INVALID_WORKSPACE_NAME");
            }
            _ => panic!("expected rejection"),
        }
    }
}
