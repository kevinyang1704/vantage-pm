//! Closed sanitized error union for the native repository boundary (E9-FR5).
//!
//! Every variant strips internal details: no raw SQL, no filesystem paths,
//! no stack traces, and no authored body text. Serialized as a camelCase
//! tagged union matching the TypeScript `ProductCommandRejected` codes plus
//! the native boundary errors defined in Story 9.2.

use serde::Serialize;

/// Native repository command surface errors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE", rename_all_fields = "camelCase")]
pub enum RepositoryError {
    /// The request violated protocol or semantic limits before any mutation.
    InvalidRequest,
    /// CommandId already recorded with a different identity (project/type/base).
    CommandIdentityConflict,
    /// The base revision does not match the current project revision.
    RevisionConflict {
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_revision: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
    },
    /// The project does not exist (or was deleted).
    ProjectNotFound,
    /// A referenced node does not exist in the project scope.
    NodeNotFound {
        #[serde(skip_serializing_if = "Option::is_none")]
        node_id: Option<String>,
    },
    /// The referenced parent node does not exist.
    ParentNotFound {
        #[serde(skip_serializing_if = "Option::is_none")]
        node_id: Option<String>,
    },
    /// Moving a node beneath one of its own descendants.
    CycleDetected,
    /// Referenced phase does not exist.
    PhaseNotFound,
    /// Duplicate unlock edge between the same source and target.
    EdgeConflict,
    /// Duplicate custom-field/template identity conflict.
    FieldConflict,
    /// Typed parent/child hierarchy inversion.
    HierarchyConflict,
    /// Revision gap detected — the client must perform a full resync.
    ResyncRequired,
    /// Storage is not ready (open not completed or closed).
    StorageNotReady,
    /// Command intake is halted during shutdown.
    ShuttingDown,
    /// The storage volume is full.
    StorageFull,
    /// Integrity checks failed on open or after mutation.
    IntegrityFailed,
    /// Internal error — generic, no details leaked.
    Internal,
}

impl RepositoryError {
    /// Attach an optional `expected_revision` to a revision conflict.
    pub fn revision_conflict(expected_revision: i64) -> Self {
        RepositoryError::RevisionConflict {
            expected_revision: Some(expected_revision),
            project_id: None,
        }
    }

    /// Maps internal invariants to the closed `Internal` variant.
    pub fn internal() -> Self {
        RepositoryError::Internal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_camel_case_screaming_snake_tags() {
        let err = RepositoryError::revision_conflict(7);
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "REVISION_CONFLICT");
        assert_eq!(json["expectedRevision"], 7);
    }

    #[test]
    fn strips_internal_details() {
        let err = RepositoryError::Internal;
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "INTERNAL");
        assert!(json.get("sql").is_none());
        assert!(json.get("path").is_none());
        assert!(json.get("stack").is_none());
    }
}
