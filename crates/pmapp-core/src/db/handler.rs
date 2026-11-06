//! Native product command handler (E9-FR3, E9-AR3).
//!
//! Faithful port of `src/adapters/persistence/project-commands.ts` semantics:
//! - duplicate commandId lookup via the receipt ledger (exactly-once replay)
//! - base-revision conflict detection returning typed rejections
//! - ONE transaction per command: domain mutation + receipt + revision advance
//! - change sets preserved so the frontend undo/redo stack stays authoritative
//!
//! Domain rules (hierarchy, cycles, typed neighborhoods) mirror the TypeScript
//! policies at `src/domain/**`; the TS domain remains canonical (E9-AR1).

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

use crate::protocol::commands::*;
use crate::protocol::errors::RepositoryError;
use crate::protocol::PROTOCOL_VERSION;


const SIBLING_POSITION_GAP: i64 = 4_294_967_296; // 2^32 (matches AD-7)

/// Match the browser's fallback for legacy or unrecognized stored levels.
fn read_planning_level(row: &rusqlite::Row<'_>, index: usize) -> String {
    match row.get::<_, String>(index).ok().as_deref() {
        Some("Theme") => "Theme".to_string(),
        Some("Component") => "Component".to_string(),
        _ => "Feature".to_string(),
    }
}

// ── Position helpers (port of sibling-position.policy.ts) ──────────────────

fn parse_position(text: &str) -> i64 {
    text.trim().parse::<i64>().unwrap_or(0)
}

fn format_position(value: i64) -> String {
    value.to_string()
}

/// Resolve a D8(c) anchored placement (Story 27.2, R3): after the after-anchor;
/// else before the before-anchor; else the intended index, clamped. Returns
/// None when an anchor names the moving item itself (SelfAnchor).
fn resolve_anchored_index(
    ordered_ids: &[String],
    moving_id: &str,
    after_id: Option<&str>,
    before_id: Option<&str>,
    intended_index: i64,
) -> Option<usize> {
    if after_id == Some(moving_id) || before_id == Some(moving_id) {
        return None;
    }
    let remaining: Vec<&String> = ordered_ids.iter().filter(|id| id.as_str() != moving_id).collect();
    if let Some(after) = after_id {
        if let Some(pos) = remaining.iter().position(|id| id.as_str() == after) {
            return Some(pos + 1);
        }
    }
    if let Some(before) = before_id {
        if let Some(pos) = remaining.iter().position(|id| id.as_str() == before) {
            return Some(pos);
        }
    }
    let intended = if intended_index < 0 { 0 } else { intended_index as usize };
    Some(intended.min(remaining.len()))
}

/// The next ordered ids after moving `moving_id` per the anchors.
fn apply_anchored_move(
    ordered_ids: &[String],
    moving_id: &str,
    after_id: Option<&str>,
    before_id: Option<&str>,
    intended_index: i64,
) -> Option<Vec<String>> {
    let index = resolve_anchored_index(ordered_ids, moving_id, after_id, before_id, intended_index)?;
    let mut remaining: Vec<String> = ordered_ids.iter().filter(|id| id.as_str() != moving_id).cloned().collect();
    remaining.insert(index.min(remaining.len()), moving_id.to_string());
    Some(remaining)
}

/// Midpoint between two neighbouring positions (port of TS `positionBetween`).
/// Returns None when no gap remains and a rebalance is required.
fn position_between(before: Option<i64>, after: Option<i64>) -> Option<i64> {
    match (before, after) {
        (None, None) => Some(SIBLING_POSITION_GAP),
        (None, Some(a)) => a.checked_sub(SIBLING_POSITION_GAP),
        (Some(b), None) => b.checked_add(SIBLING_POSITION_GAP),
        (Some(b), Some(a)) => {
            // Use checked arithmetic: extreme i64 positions (from a crafted
            // command) must rebalance, not overflow-panic while a lock is held.
            match a.checked_sub(b) {
                None => None,
                Some(delta) if delta <= 1 => None,
                Some(delta) => b.checked_add(delta / 2),
            }
        }
    }
}

fn rebalance_sibling_positions(ordered_ids: &[String]) -> Vec<(String, i64)> {
    ordered_ids
        .iter()
        .enumerate()
        .map(|(idx, id)| (id.clone(), (idx as i64 + 1) * SIBLING_POSITION_GAP))
        .collect()
}

// ── Hierarchy helpers (mirror node-hierarchy.policy.ts) ────────────────────

fn node_type_rank(node_type: Option<&str>) -> i64 {
    match node_type {
        Some("Vision") => 0,
        Some("Theme") => 1,
        Some("Component") => 2,
        Some("Feature") => 3,
        Some("AcceptanceCriterion") => 4,
        _ => 5,
    }
}

/// `canParentNodeType(parent, child)`: typed rank(parent) <= rank(child);
/// untyped on either side is permissive.
fn can_parent_node_type(parent: Option<&str>, child: Option<&str>) -> bool {
    if parent.is_none() || child.is_none() {
        return true;
    }
    node_type_rank(parent) <= node_type_rank(child)
}

// ── Rejection constructors (mirror ProductCommandRejected) ─────────────────

fn rejected(
    command_id: &str,
    code: &str,
    expected_revision: Option<i64>,
    project_id: Option<&str>,
    node_id: Option<&str>,
) -> ProductCommandResult {
    ProductCommandResult::ProductCommandRejected(ProductCommandRejected {
        result_type: "ProductCommandRejected".to_string(),
        protocol_version: PROTOCOL_VERSION.to_string(),
        command_id: command_id.to_string(),
        code: code.to_string(),
        expected_revision,
        project_id: project_id.map(str::to_string),
        node_id: node_id.map(str::to_string),
        person_id: None,
        conflicting_feature_ids: None,
        feature_id: None,
        column: None,
    })
}

fn forecast_assignment_conflict(
    command_id: &str,
    person_id: &str,
    conflicting_feature_ids: Vec<String>,
) -> ProductCommandResult {
    ProductCommandResult::ProductCommandRejected(ProductCommandRejected {
        result_type: "ProductCommandRejected".to_string(),
        protocol_version: PROTOCOL_VERSION.to_string(),
        command_id: command_id.to_string(),
        code: "FORECAST_ASSIGNMENT_CONFLICT".to_string(),
        expected_revision: None,
        project_id: None,
        node_id: None,
        person_id: Some(person_id.to_string()),
        conflicting_feature_ids: Some(conflicting_feature_ids),
        feature_id: None,
        column: None,
    })
}

fn forecast_assignment_zero_work(
    command_id: &str,
    feature_id: &str,
) -> ProductCommandResult {
    ProductCommandResult::ProductCommandRejected(ProductCommandRejected {
        result_type: "ProductCommandRejected".to_string(),
        protocol_version: PROTOCOL_VERSION.to_string(),
        command_id: command_id.to_string(),
        code: "FORECAST_ASSIGNMENT_ZERO_WORK".to_string(),
        expected_revision: None,
        project_id: None,
        node_id: None,
        person_id: None,
        conflicting_feature_ids: None,
        feature_id: Some(feature_id.to_string()),
        column: None,
    })
}

fn forecast_assignment_invalid_person(
    command_id: &str,
    person_id: &str,
) -> ProductCommandResult {
    ProductCommandResult::ProductCommandRejected(ProductCommandRejected {
        result_type: "ProductCommandRejected".to_string(),
        protocol_version: PROTOCOL_VERSION.to_string(),
        command_id: command_id.to_string(),
        code: "FORECAST_ASSIGNMENT_INVALID".to_string(),
        expected_revision: None,
        project_id: None,
        node_id: None,
        person_id: Some(person_id.to_string()),
        conflicting_feature_ids: None,
        feature_id: None,
        column: None,
    })
}

fn forecast_plan_corrupt(
    command_id: &str,
    column: &str,
) -> ProductCommandResult {
    ProductCommandResult::ProductCommandRejected(ProductCommandRejected {
        result_type: "ProductCommandRejected".to_string(),
        protocol_version: PROTOCOL_VERSION.to_string(),
        command_id: command_id.to_string(),
        code: "FORECAST_PLAN_CORRUPT".to_string(),
        expected_revision: None,
        project_id: None,
        node_id: None,
        person_id: None,
        conflicting_feature_ids: None,
        feature_id: None,
        column: Some(column.to_string()),
    })
}

fn parse_plan_cell<T: serde::de::DeserializeOwned + Default>(
    json: Option<&str>,
    column: &'static str,
    command_id: &str,
) -> Result<T, ProductCommandResult> {
    match json {
        None => Ok(T::default()),
        Some(s) => serde_json::from_str(s).map_err(|_| forecast_plan_corrupt(command_id, column)),
    }
}

pub(crate) struct StoredForecastPlan {
    pub selected_feature_ids: Vec<String>,
    pub parallel_groups: Vec<ParallelGroup>,
    pub blocked_feature_ids: Vec<String>,
    pub points_per_sprint: Option<i64>,
    pub sprint_length_days: Option<i64>,
    #[allow(dead_code)]
    pub cadence: String,
    pub start_sprint_ordinal: Option<i64>,
    pub start_date: Option<String>,
    pub policy_version: String,
    pub planning_level: String,
    pub roster: Vec<ForecastPersonDto>,
    pub assignments: HashMap<String, Vec<String>>,
}

fn read_stored_forecast_plan(
    tx: &Transaction,
    project_id: &str,
    command_id: &str,
) -> Result<Option<StoredForecastPlan>, ProductCommandResult> {
    let raw: Option<(
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    )> = tx
        .query_row(
            "SELECT selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
                    sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version,
                    planning_level, roster, assignments
             FROM forecast_plans WHERE project_id = ?1",
            rusqlite::params![project_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    read_planning_level(r, 9),
                    r.get(10)?,
                    r.get(11)?,
                ))
            },
        )
        .optional()
        .map_err(|_| internal_rejection(command_id))?;

    let Some((
        ids_json,
        groups_json,
        blocked_json,
        pps,
        sld,
        cadence,
        sso,
        sd,
        policy,
        planning_level,
        roster_json,
        assignments_json,
    )) = raw else {
        return Ok(None);
    };

    let selected_feature_ids: Vec<String> =
        parse_plan_cell(ids_json.as_deref(), "selected_feature_ids", command_id)?;
    let parallel_groups: Vec<ParallelGroup> =
        parse_plan_cell(groups_json.as_deref(), "parallel_groups", command_id)?;
    let blocked_feature_ids: Vec<String> =
        parse_plan_cell(blocked_json.as_deref(), "blocked_feature_ids", command_id)?;
    let roster: Vec<ForecastPersonDto> =
        parse_plan_cell(roster_json.as_deref(), "roster", command_id)?;
    let assignments: HashMap<String, Vec<String>> =
        parse_plan_cell(assignments_json.as_deref(), "assignments", command_id)?;

    Ok(Some(StoredForecastPlan {
        selected_feature_ids,
        parallel_groups,
        blocked_feature_ids,
        points_per_sprint: pps,
        sprint_length_days: sld,
        cadence: cadence.unwrap_or_else(|| "fixed-contiguous".to_string()),
        start_sprint_ordinal: sso,
        start_date: sd,
        policy_version: policy.unwrap_or_else(|| "shared-capacity-v1".to_string()),
        planning_level,
        roster,
        assignments,
    }))
}

fn revision_conflict(command_id: &str, project_id: &str, current: i64) -> ProductCommandResult {
    rejected(command_id, "REVISION_CONFLICT", Some(current), Some(project_id), None)
}

fn project_not_found(command_id: &str, project_id: &str) -> ProductCommandResult {
    rejected(command_id, "PROJECT_NOT_FOUND", None, Some(project_id), None)
}

fn node_not_found(command_id: &str, project_id: &str, node_id: Option<&str>) -> ProductCommandResult {
    rejected(command_id, "NODE_NOT_FOUND", None, Some(project_id), node_id)
}

fn parent_not_found(command_id: &str, project_id: &str, node_id: &str) -> ProductCommandResult {
    rejected(command_id, "PARENT_NOT_FOUND", None, Some(project_id), Some(node_id))
}

fn cycle_detected(command_id: &str, project_id: &str, node_id: &str) -> ProductCommandResult {
    rejected(command_id, "CYCLE_DETECTED", None, Some(project_id), Some(node_id))
}

fn hierarchy_conflict(command_id: &str, project_id: &str, node_id: &str) -> ProductCommandResult {
    rejected(command_id, "HIERARCHY_CONFLICT", None, Some(project_id), Some(node_id))
}

fn phase_not_found(command_id: &str) -> ProductCommandResult {
    rejected(command_id, "PHASE_NOT_FOUND", None, None, None)
}

fn edge_conflict(command_id: &str) -> ProductCommandResult {
    rejected(command_id, "EDGE_CONFLICT", None, None, None)
}

fn internal_rejection(command_id: &str) -> ProductCommandResult {
    rejected(command_id, "INTERNAL", None, None, None)
}

// Preserve the original SQLite failure before cleanup can replace its error code.
fn storage_rejection(command_id: &str, error: rusqlite::Error) -> ProductCommandResult {
    let code = if matches!(map_sqlite_error(error), RepositoryError::StorageFull) { "STORAGE_FULL" } else { "INTERNAL" };
    rejected(command_id,code,None,None,None)
}

// ── Applied result + change-set helpers ────────────────────────────────────

fn applied(
    command_id: &str,
    project_id: &str,
    base_revision: i64,
    target_revision: i64,
    change_set: Option<ChangeSet>,
) -> ProductCommandResult {
    ProductCommandResult::ProductCommandApplied(ProductCommandApplied {
        result_type: "ProductCommandApplied".to_string(),
        protocol_version: PROTOCOL_VERSION.to_string(),
        command_id: command_id.to_string(),
        project_id: project_id.to_string(),
        base_revision,
        target_revision,
        outcome: "VfsCommitAccepted".to_string(),
        disposition: "NewCommit".to_string(),
        change_set,
    })
}

fn change_set(
    project_id: &str,
    base_revision: i64,
    target_revision: i64,
    changes: Vec<NodeChange>,
) -> ChangeSet {
    ChangeSet {
        protocol_version: PROTOCOL_VERSION.to_string(),
        project_id: project_id.to_string(),
        base_revision,
        target_revision,
        changes,
    }
}

// ── Envelope helpers ───────────────────────────────────────────────────────

fn command_id_of(command: &ProductCommand) -> String {
    command.command_id().to_string()
}

// ── Entry point ────────────────────────────────────────────────────────────

/// Idempotent schema initialization (port of `initializeSchema()`).
pub fn initialize_schema(conn: &Connection) -> rusqlite::Result<()> {
    for ddl in super::schema::PRODUCT_SCHEMA_DDL.iter() {
        conn.execute_batch(ddl)?;
    }
    conn.execute_batch(super::collaboration::JOURNAL_DDL)?;
    super::recovery_journal::initialize(conn)?;
    conn.execute_batch(super::local_file::DDL)?;
    Ok(())
}

/// Validates protocol version and semantic limits (E9-FR5).
pub fn validate_command(command: &ProductCommand) -> Result<(), RepositoryError> {
    if command.protocol_version() != PROTOCOL_VERSION {
        return Err(RepositoryError::InvalidRequest);
    }
    let base = command.base_revision();
    if base < 0 || base >= 9_007_199_254_740_991 || command.expected_revision() != base + 1 {
        return Err(RepositoryError::InvalidRequest);
    }
    Ok(())
}

/// Whether a command type may be submitted BY A REMOTE member (R2/D8, H03).
///
/// Project lifecycle and administrative/local-only commands are never acceptable
/// as arbitrary editor requests: `DeleteProject`/`RenameProject`/`CreateProject`
/// are local owner actions, and the restore/remove/scope commands are produced by
/// the client's own undo, not by a peer. A remote submit of one of these is
/// rejected with `REMOTE_COMMAND_NOT_ADMISSIBLE`.
///
/// The set mirrors the `local-only` class in the TypeScript merge policy
/// (`src/domain/collaboration/merge-policy.ts`).
pub fn is_remotely_admissible(kind: &str) -> bool {
    !matches!(
        kind,
        "CreateProject"
            | "RenameProject"
            | "DeleteProject"
            | "RemoveForecastPlan"
            | "RemoveForecastScenario"
            | "RestoreForecastScenario"
            | "RestoreForecastScope"
            | "RestoreForecastPlanningLevel"
            | "RemoveForecastPerson"
            | "RestoreForecastPerson"
            | "RestoreSubtree"
            | "RestorePhase"
    )
}

/// Applies a product command: exactly-once replay then one transaction.
pub fn apply(
    conn: &mut Connection,
    command: ProductCommand,
) -> Result<ProductCommandResult, RepositoryError> {
    if let Some(refusal) = shared_project_refusal(conn, &command)? {
        return Ok(refusal);
    }
    apply_atomic(conn, command, |_tx, _command_id, _revision| Ok(()))
}

/// A shared project's edits must commit with their outbox entry through its
/// live session. This plain local path has no outbox, so an edit here (from a
/// local-only build, or before the session connects) would never reach the
/// team and could later be replaced by the service's copy. Refuse it. Deleting
/// the local copy stays allowed.
fn shared_project_refusal(conn: &Connection, command: &ProductCommand) -> Result<Option<ProductCommandResult>, RepositoryError> {
    if matches!(command, ProductCommand::CreateProject(_) | ProductCommand::DeleteProject(_)) {
        return Ok(None);
    }
    let project_id = command.project_id();
    let shared = conn
        .query_row("SELECT 1 FROM collaboration_cursor WHERE project_id = ?1 LIMIT 1", [project_id], |_| Ok(()))
        .optional()
        .map_err(map_sqlite_error)?
        .is_some();
    Ok(shared.then(|| rejected(&command_id_of(command), "SHARED_PROJECT_NOT_CONNECTED", None, Some(project_id), None)))
}

/// Whether a command may be applied on the server-ordered shared path.
/// The server owns the revision, so the project-wide `expectedRevision`
/// precondition is replaced by the per-command content precondition the domain
/// handlers already enforce (target exists, invariants) — a rebased/re-applied
/// command is therefore not refused merely because the project revision advanced
/// past its original `baseRevision` (R2, AC 27.3-4, H03). Local projects keep
/// `apply`'s strict `expectedRevision` check.
pub fn apply_shared<F>(
    conn: &mut Connection,
    command: ProductCommand,
    on_applied: F,
) -> Result<ProductCommandResult, RepositoryError>
where
    F: FnOnce(&Transaction, &str, i64) -> Result<(), RepositoryError>,
{
    apply_with_mode(conn, command, RevisionMode::ServerOrdered, on_applied)
}

/// Capture authoritative metadata before dispatch and retain it after the
/// receipt is written, under the same transaction as all command effects.
/// The hooks cannot expose a committed graph with missing recovery metadata.
pub fn apply_shared_with_capture<T, B, A>(
    conn: &mut Connection,
    command: ProductCommand,
    before: B,
    after: A,
) -> Result<ProductCommandResult, RepositoryError>
where
    B: FnOnce(&Transaction) -> Result<T, RepositoryError>,
    A: FnOnce(&Transaction, T, &str, i64) -> Result<(), RepositoryError>,
{
    let mut tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(map_sqlite_error)?;
    let captured = before(&tx)?;
    let result = apply_in_transaction(
        &mut tx,
        command,
        RevisionMode::ServerOrdered,
        |transaction, command_id, revision| after(transaction, captured, command_id, revision),
    )?;
    if matches!(result, ProductCommandResult::ProductCommandApplied(_)) {
        tx.commit().map_err(map_sqlite_error)?;
    }
    Ok(result)
}

/// Outcome of a shared atomic group (Story 27.2/27.6, composite gestures).
#[derive(Debug)]
pub enum SharedGroupOutcome {
    /// Every member applied, in order, at consecutive server revisions.
    Applied(Vec<ProductCommandResult>),
    /// Member `index` was refused; nothing from the group was committed.
    Rejected { index: usize, result: ProductCommandResult },
}

/// One member of a shared atomic group: the command plus the same before/after
/// hooks `apply_shared_with_capture` takes (graph capture, log/history rows).
pub type SharedGroupMember<T> = (
    ProductCommand,
    Box<dyn FnOnce(&Transaction) -> Result<T, RepositoryError>>,
    Box<dyn FnOnce(&Transaction, T, &str, i64) -> Result<(), RepositoryError>>,
);

/// Apply a composite gesture on the service as ONE transaction: each member is
/// server-ordered at the next revision with its own receipt, log and history
/// rows, and a refused member rolls back every earlier member of the group.
pub fn apply_shared_group_with_capture<T>(
    conn: &mut Connection,
    members: Vec<SharedGroupMember<T>>,
) -> Result<SharedGroupOutcome, RepositoryError> {
    let mut tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(map_sqlite_error)?;
    let mut results = Vec::with_capacity(members.len());
    for (index, (command, before, after)) in members.into_iter().enumerate() {
        let captured = before(&tx)?;
        let result = apply_in_transaction(
            &mut tx,
            command,
            RevisionMode::ServerOrdered,
            |transaction, command_id, revision| after(transaction, captured, command_id, revision),
        )?;
        if !matches!(result, ProductCommandResult::ProductCommandApplied(_)) {
            // Dropping the transaction rolls back every earlier member.
            return Ok(SharedGroupOutcome::Rejected { index, result });
        }
        results.push(result);
    }
    tx.commit().map_err(map_sqlite_error)?;
    Ok(SharedGroupOutcome::Applied(results))
}

/// Apply a command inside ONE transaction, invoking `on_applied` after the
/// state mutation, receipt and revision advance but *before* commit. This is the
/// transaction-scoped reuse the collaboration service needs: the server appends
/// its own command-log row through `on_applied`, so the state, the receipt, the
/// revision and the server log commit together or not at all (H02, AC 27.5-2).
pub fn apply_atomic<F>(
    conn: &mut Connection,
    command: ProductCommand,
    on_applied: F,
) -> Result<ProductCommandResult, RepositoryError>
where
    F: FnOnce(&Transaction, &str, i64) -> Result<(), RepositoryError>,
{
    apply_with_mode(conn, command, RevisionMode::Local, on_applied)
}

/// How the revision precondition is decided.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RevisionMode {
    /// Local: the command's `baseRevision` must equal the current revision, and
    /// the write advances to `expectedRevision` (today's behavior).
    Local,
    /// Server-ordered: the service assigns the next revision; the client's
    /// base/expected are advisory. Content preconditions in the handlers decide.
    ServerOrdered,
}

fn apply_with_mode<F>(
    conn: &mut Connection,
    command: ProductCommand,
    mode: RevisionMode,
    on_applied: F,
) -> Result<ProductCommandResult, RepositoryError>
where
    F: FnOnce(&Transaction, &str, i64) -> Result<(), RepositoryError>,
{
    let mut tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(map_sqlite_error)?;
    let outcome = apply_in_transaction(&mut tx, command, mode, on_applied)?;
    if matches!(outcome, ProductCommandResult::ProductCommandApplied(_)) {
        tx.commit().map_err(map_sqlite_error)?;
    }
    Ok(outcome)
}

/// Apply a composite gesture in one transaction. A rejected later component
/// rolls back every prior mutation, receipt and revision from this gesture.
pub fn apply_batch(conn: &mut Connection, commands: Vec<ProductCommand>) -> Result<Vec<ProductCommandResult>, RepositoryError> {
    if commands.is_empty() { return Ok(Vec::new()); }
    let project_id = commands[0].project_id().to_owned();
    if commands.iter().any(|command| command.project_id() != project_id) { return Err(RepositoryError::Internal); }
    let mut tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(map_sqlite_error)?;
    // A synced project has no authoritative atomic server group yet; refuse the
    // whole group rather than committing components that would sync separately.
    let synced = tx.query_row("SELECT 1 FROM collaboration_cursor WHERE project_id = ?1 LIMIT 1", [&project_id], |_| Ok(())).optional().map_err(map_sqlite_error)?.is_some();
    if synced {
        return Ok(vec![rejected(&command_id_of(&commands[0]), "SHARED_ATOMIC_GROUP_UNAVAILABLE", None, Some(&project_id), None)]);
    }
    let mut results = Vec::new();
    for command in commands {
        let result = apply_in_transaction(&mut tx, command, RevisionMode::Local, |_tx, _id, _revision| Ok(()))?;
        if !matches!(result, ProductCommandResult::ProductCommandApplied(_)) { return Ok(vec![result]); }
        results.push(result);
    }
    tx.commit().map_err(map_sqlite_error)?;
    Ok(results)
}

pub(crate) fn apply_in_transaction<F>(
    tx: &mut Transaction,
    command: ProductCommand,
    mode: RevisionMode,
    on_applied: F,
) -> Result<ProductCommandResult, RepositoryError>
where
    F: FnOnce(&Transaction, &str, i64) -> Result<(), RepositoryError>,
{
    validate_command(&command)?;
    let command_id = command_id_of(&command);

    // Duplicate commandId lookup — replay the stored result.
    let prior = tx
        .query_row(
            "SELECT project_id, command_type, base_revision, result_json
             FROM product_command_receipt WHERE command_id = ?1",
            [&command_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| RepositoryError::Internal)?;

    if let Some((stored_project, stored_type, stored_base, result_json)) = prior {
        let identity_ok = stored_project == command.project_id()
            && stored_type == command.kind()
            && stored_base == command.base_revision()
            && scenario_replay_identity_matches(&command, &result_json);
        if !identity_ok {
            return Ok(rejected(&command_id, "COMMAND_IDENTITY_CONFLICT", None, None, None));
        }
        // Older level-command receipts predate the forward delta fields.
        // Recover those fields from the exact replayed command, not live state.
        let mut stored: serde_json::Value = serde_json::from_str(&result_json)
            .map_err(|_| RepositoryError::Internal)?;
        let scope = match &command {
            ProductCommand::SetForecastPlanningLevel(_) => Some(serde_json::json!({
                "selectedFeatureIds": [], "parallelGroups": [], "blockedFeatureIds": []
            })),
            ProductCommand::RestoreForecastPlanningLevel(cmd) => Some(serde_json::json!({
                "selectedFeatureIds": cmd.selected_feature_ids,
                "parallelGroups": cmd.parallel_groups,
                "blockedFeatureIds": cmd.blocked_feature_ids
            })),
            _ => None,
        };
        if let (Some(scope), Some(changes)) = (scope, stored.pointer_mut("/changeSet/changes").and_then(|value| value.as_array_mut())) {
            for change in changes {
                if change["type"] == "ForecastPlanningLevelSet" {
                    if let Some(fields) = change.as_object_mut() {
                        for key in ["selectedFeatureIds", "parallelGroups", "blockedFeatureIds"] {
                            fields.entry(key).or_insert_with(|| scope[key].clone());
                        }
                    }
                }
            }
        }
        let mut replayed: ProductCommandResult = serde_json::from_value(stored)
            .map_err(|_| RepositoryError::Internal)?;
        replayed.set_disposition_stored();
        return Ok(replayed);
    }

    let base = command.base_revision();
    let project_id = command.project_id().to_string();
    let actor_id = command.actor_id().map(|value| value.to_string());

    // Resolve the revision to write. Local: strict base match. Server-ordered:
    // the server assigns the next revision (content preconditions decide).
    let write_revision = match mode {
        RevisionMode::Local => {
            if command.kind() != "CreateProject" {
                let current = project_revision(tx, &project_id)?;
                let Some(current) = current else {
                    return Ok(project_not_found(&command_id, &project_id));
                };
                if current != base {
                    return Ok(revision_conflict(&command_id, &project_id, current));
                }
            }
            command.expected_revision()
        }
        RevisionMode::ServerOrdered => {
            if command.kind() != "CreateProject" {
                let current = project_revision(tx, &project_id)?;
                let Some(current) = current else {
                    return Ok(project_not_found(&command_id, &project_id));
                };
                current + 1
            } else {
                1
            }
        }
    };

    if matches!(mode, RevisionMode::ServerOrdered) && matches!(&command, ProductCommand::RestoreSubtree(c) if c.deletion_bundle.is_some()) {
        return Ok(rejected(&command_id, "SHARED_BUNDLED_RESTORE_UNAVAILABLE", None, Some(&project_id), None));
    }
    let command_kind = command.kind().to_string();
    // A rejected multi-write command must not leak effects into an outer rebase/attempt transaction.
    tx.execute_batch("SAVEPOINT pmapp_command_dispatch").map_err(map_sqlite_error)?;
    let mut outcome = match dispatch(tx, command) {
        Ok(applied) => applied,
        // A domain error returns early; the local path writes no receipt for it
        // (the durable terminal-rejection store is the server's concern, R2/H03).
        Err(rejection) => {
            let failure = match &rejection {
                ProductCommandResult::ProductCommandRejected(r) if r.code == "STORAGE_FULL" => Some(RepositoryError::StorageFull),
                ProductCommandResult::ProductCommandRejected(r) if r.code == "INTERNAL" => Some(RepositoryError::Internal),
                _ => None,
            };
            // SQLITE_FULL may already have rolled back the entire outer transaction.
            if !tx.is_autocommit() {
                if let Err(error) = tx.execute_batch("ROLLBACK TO pmapp_command_dispatch; RELEASE pmapp_command_dispatch") {
                    return Err(failure.unwrap_or_else(||map_sqlite_error(error)));
                }
            }
            if let Some(error) = failure { return Err(error); }
            return Ok(rejection);
        },
    };

    // Shared receipts describe the authoritative cut, while the original
    // command keeps its immutable client revision metadata for deduplication.
    if mode == RevisionMode::ServerOrdered {
        if let ProductCommandResult::ProductCommandApplied(applied) = &mut outcome {
            applied.base_revision = write_revision - 1;
            applied.target_revision = write_revision;
            if let Some(change_set) = &mut applied.change_set {
                change_set.base_revision = write_revision - 1;
                change_set.target_revision = write_revision;
            }
        }
    }

    // Receipt recording + revision advance inside the same transaction.
    if matches!(outcome, ProductCommandResult::ProductCommandApplied(_)) {
        tx.execute(
            "UPDATE projects SET revision = ?1 WHERE id = ?2",
            rusqlite::params![write_revision, project_id],
        )
        .map_err(map_sqlite_error)?;
        tx.execute(
            "INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json, actor_id
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                command_id,
                project_id,
                command_kind,
                base,
                write_revision,
                serde_json::to_string(&outcome).map_err(|_| RepositoryError::Internal)?,
                actor_id
            ],
        )
        .map_err(map_sqlite_error)?;
        // The caller may append rows (e.g. the server command log) inside this
        // same transaction, so they commit together with state/receipt/revision.
        on_applied(tx, &command_id, write_revision)?;
    }

    tx.execute_batch("RELEASE pmapp_command_dispatch").map_err(map_sqlite_error)?;
    Ok(outcome)
}

fn scenario_replay_identity_matches(command: &ProductCommand, result_json: &str) -> bool {
    let Ok(result) = serde_json::from_str::<serde_json::Value>(result_json) else { return false; };
    let change = result.get("changeSet").and_then(|v| v.get("changes")).and_then(|v| v.as_array()).and_then(|v| v.first());
    match command {
        ProductCommand::CreateForecastScenario(cmd) => change
            .filter(|v| v.get("type").and_then(|x| x.as_str()) == Some("ForecastScenarioCreated"))
            .and_then(|v| v.get("scenario"))
            .map(|s| s.get("scenarioId").and_then(|v| v.as_str()) == Some(cmd.scenario_id.as_str())
                && s.get("label").and_then(|v| v.as_str()) == Some(cmd.label.as_str())
                && s.get("baselineRevision").and_then(|v| v.as_i64()) == Some(cmd.baseline_revision)
                && s.get("baselineFingerprint").and_then(|v| v.as_str()) == Some(cmd.expected_material_fingerprint.as_str())
                && s.get("createdAtISO").and_then(|v| v.as_str()) == Some(cmd.created_at_iso.as_str())
                && s.get("patch") == Some(&cmd.patch)).unwrap_or(false),
        ProductCommand::RemoveForecastScenario(cmd) => change
            .map(|v| v.get("type").and_then(|x| x.as_str()) == Some("ForecastScenarioRemoved")
                && v.get("scenarioId").and_then(|x| x.as_str()) == Some(cmd.scenario_id.as_str())).unwrap_or(false),
        ProductCommand::RestoreForecastScenario(cmd) => change
            .map(|v| v.get("type").and_then(|x| x.as_str()) == Some("ForecastScenarioRestored")
                && v.get("scenario") == Some(&cmd.scenario)).unwrap_or(false),
        ProductCommand::AddForecastPerson(cmd) => {
            let changes = result.get("changeSet").and_then(|v| v.get("changes")).and_then(|v| v.as_array());
            let added = changes.and_then(|arr| arr.iter().find(|c| c.get("type").and_then(|t| t.as_str()) == Some("ForecastPersonAdded")));
            added.and_then(|c| c.get("person")).map(|p| {
                p.get("id").and_then(|v| v.as_str()) == Some(cmd.person_id.as_str())
                    && p.get("name").and_then(|v| v.as_str()) == Some(cmd.name.as_str())
                    && p.get("weightUnits").and_then(|v| v.as_i64()) == Some(cmd.weight_units)
            }).unwrap_or(false)
        }
        ProductCommand::UpdateForecastPerson(cmd) => change
            .map(|v| v.get("type").and_then(|x| x.as_str()) == Some("ForecastPersonUpdated")
                && v.get("personId").and_then(|x| x.as_str()) == Some(cmd.person_id.as_str())
                && v.get("name").and_then(|x| x.as_str()) == Some(cmd.name.as_str())
                && v.get("weightUnits").and_then(|x| x.as_i64()) == Some(cmd.weight_units))
            .unwrap_or(false),
        ProductCommand::RemoveForecastPerson(cmd) => change
            .and_then(|v| if v.get("type").and_then(|x| x.as_str()) == Some("ForecastPersonRemoved") { v.get("person") } else { None })
            .map(|p| p.get("id").and_then(|v| v.as_str()) == Some(cmd.person_id.as_str()))
            .unwrap_or(false),
        ProductCommand::RestoreForecastPerson(cmd) => {
            let changes = result.get("changeSet").and_then(|v| v.get("changes")).and_then(|v| v.as_array());
            let restored = changes.and_then(|arr| arr.iter().find(|c| c.get("type").and_then(|t| t.as_str()) == Some("ForecastPersonRestored")));
            restored.and_then(|c| c.get("person")).map(|p| {
                p.get("id").and_then(|v| v.as_str()) == Some(cmd.person.id.as_str())
                    && p.get("name").and_then(|v| v.as_str()) == Some(cmd.person.name.as_str())
                    && p.get("weightUnits").and_then(|v| v.as_i64()) == Some(cmd.person.weight_units)
            }).unwrap_or(false)
        }
        ProductCommand::SetForecastAssignments(cmd) => change
            .map(|v| v.get("type").and_then(|x| x.as_str()) == Some("ForecastAssignmentsSet")
                && v.get("featureId").and_then(|x| x.as_str()) == Some(cmd.feature_id.as_str())
                && v.get("personIds").and_then(|x| x.as_array()).map(|arr| {
                    let pids: Vec<&str> = arr.iter().filter_map(|p| p.as_str()).collect();
                    let expected: Vec<&str> = cmd.person_ids.iter().map(|s| s.as_str()).collect();
                    pids == expected
                }).unwrap_or(false))
            .unwrap_or(false),
        ProductCommand::SetForecastPolicy(cmd) => change
            .map(|v| v.get("type").and_then(|x| x.as_str()) == Some("ForecastPolicySet")
                && v.get("policyVersion").and_then(|x| x.as_str()) == Some(cmd.policy_version.as_str()))
            .unwrap_or(false),
        _ => true,
    }
}

/// Dispatches to the per-command apply function inside the transaction.
fn dispatch(tx: &mut Transaction, command: ProductCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let result = match command {
        ProductCommand::CreateProject(c) => apply_create_project(tx, c),
        ProductCommand::RenameProject(c) => apply_rename_project(tx, c),
        ProductCommand::DeleteProject(c) => apply_delete_project(tx, c),
        ProductCommand::CreateNode(c) => apply_create_node(tx, c),
        ProductCommand::SetNodeTitle(c) => apply_set_node_title(tx, c),
        ProductCommand::SetNodeBodyText(c) => apply_set_node_body_text(tx, c),
        ProductCommand::MoveNode(c) => apply_move_node(tx, c),
        ProductCommand::DeleteSubtree(c) => apply_delete_subtree(tx, c),
        ProductCommand::DuplicateSubtree(c) => apply_duplicate_subtree(tx, c),
        ProductCommand::RestoreSubtree(c) => apply_restore_subtree(tx, c),
        ProductCommand::SetNodeType(c) => apply_set_node_type(tx, c),
        ProductCommand::SetNodeCustomField(c) => apply_set_node_custom_field(tx, c),
        ProductCommand::PromoteFieldToTemplate(c) => apply_promote_field_to_template(tx, c),
        ProductCommand::SetNodeSchedule(c) => apply_set_node_schedule(tx, c),
        ProductCommand::ToggleNodeCompleted(c) => apply_toggle_node_completed(tx, c),
        ProductCommand::SetNodeEffort(c) => apply_set_node_effort(tx, c),
        ProductCommand::SetNodeStatus(c) => apply_set_node_status(tx, c),
        ProductCommand::SetThemeWeight(c) => apply_set_theme_weight(tx, c),
        ProductCommand::CreatePhase(c) => apply_create_phase(tx, c),
        ProductCommand::RenamePhase(c) => apply_rename_phase(tx, c),
        ProductCommand::ReorderPhases(c) => apply_reorder_phases(tx, c),
        ProductCommand::MovePhase(c) => apply_move_phase(tx, c),
        ProductCommand::AssignNodePhase(c) => apply_assign_node_phase(tx, c),
        ProductCommand::DeletePhase(c) => apply_delete_phase(tx, c),
        ProductCommand::RestorePhase(c) => apply_restore_phase(tx, c),
        ProductCommand::CreateUnlockEdge(c) => apply_create_unlock_edge(tx, c),
        ProductCommand::DeleteUnlockEdge(c) => apply_delete_unlock_edge(tx, c),
        ProductCommand::DismissFinding(c) => apply_dismiss_finding(tx, c),
        ProductCommand::UndismissFinding(c) => apply_undismiss_finding(tx, c),
        ProductCommand::RecordAffectedReasons(c) => apply_record_affected_reasons(tx, c),
        ProductCommand::AcknowledgeAffectedReason(c) => apply_acknowledge_affected_reason(tx, c),
        ProductCommand::ClearNodeAffectedReasons(c) => apply_clear_node_affected_reasons(tx, c),
        ProductCommand::AddNodeQuestion(c) => apply_add_node_question(tx, c),
        ProductCommand::UpdateNodeQuestion(c) => apply_update_node_question(tx, c),
        ProductCommand::ResolveNodeQuestion(c) => apply_resolve_node_question(tx, c),
        ProductCommand::ReorderNodeQuestions(c) => apply_reorder_node_questions(tx, c),
        ProductCommand::MoveNodeQuestion(c) => apply_move_node_question(tx, c),
        ProductCommand::DeleteNodeQuestion(c) => apply_delete_node_question(tx, c),
        ProductCommand::ConfigureForecastPlan(c) => apply_configure_forecast_plan(tx, c),
        ProductCommand::SetForecastMembership(c) => apply_set_forecast_membership(tx, c),
        ProductCommand::SetForecastBlocker(c) => apply_set_forecast_blocker(tx, c),
        ProductCommand::SetForecastSprintPlan(c) => apply_set_forecast_sprint_plan(tx, c),
        ProductCommand::CreateForecastScenario(c) => apply_create_forecast_scenario(tx, c),
        ProductCommand::RemoveForecastScenario(c) => apply_remove_forecast_scenario(tx, c),
        ProductCommand::RestoreForecastScenario(c) => apply_restore_forecast_scenario(tx, c),
        ProductCommand::ReorderForecastFeatures(c) => apply_reorder_forecast_features(tx, c),
        ProductCommand::SetForecastSequence(c) => apply_set_forecast_sequence(tx, c),
        ProductCommand::SetForecastParallelGroups(c) => apply_set_forecast_parallel_groups(tx, c),
        ProductCommand::RestoreForecastScope(c) => apply_restore_forecast_scope(tx, c),
        ProductCommand::SetForecastPlanningLevel(c) => apply_set_forecast_planning_level(tx, c),
        ProductCommand::RestoreForecastPlanningLevel(c) => apply_restore_forecast_planning_level(tx, c),
        ProductCommand::RemoveForecastPlan(c) => apply_remove_forecast_plan(tx, c),
        ProductCommand::AddForecastPerson(c) => apply_add_forecast_person(tx, c),
        ProductCommand::UpdateForecastPerson(c) => apply_update_forecast_person(tx, c),
        ProductCommand::RemoveForecastPerson(c) => apply_remove_forecast_person(tx, c),
        ProductCommand::RestoreForecastPerson(c) => apply_restore_forecast_person(tx, c),
        ProductCommand::SetForecastAssignments(c) => apply_set_forecast_assignments(tx, c),
        ProductCommand::MoveForecastFeature(c) => apply_move_forecast_feature(tx, c),
        ProductCommand::SetForecastAssignment(c) => apply_set_forecast_assignment(tx, c),
        ProductCommand::SetForecastPolicy(c) => apply_set_forecast_policy(tx, c),
    };

    match result {
        Ok(ok) => Ok(ok),
        Err(rejection) => Err(rejection),
    }
}

// ── SQLite helpers ─────────────────────────────────────────────────────────

fn project_revision(conn: &Connection, project_id: &str) -> Result<Option<i64>, RepositoryError> {
    conn.query_row(
        "SELECT revision FROM projects WHERE id = ?1",
        [project_id],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map_err(|_| RepositoryError::Internal)
}

fn map_sqlite_error(err: rusqlite::Error) -> RepositoryError {
    match &err {
        rusqlite::Error::SqliteFailure(e, _) => {
            // Extended codes: SQLITE_FULL (13), SQLITE_IOERR (10), SQLITE_CANTOPEN (14).
            let extended = e.extended_code;
            if extended & 0xff == 13 || extended == 10 || (extended & 0xff) == 14 {
                RepositoryError::StorageFull
            } else if e.code == rusqlite::ErrorCode::ConstraintViolation {
                RepositoryError::IntegrityFailed
            } else {
                RepositoryError::Internal
            }
        }
        _ => RepositoryError::Internal,
    }
}

// ── Per-command apply functions ────────────────────────────────────────────
// Each receives the active transaction and returns `Ok(applied)` or
// `Err(ProductCommandResult::ProductCommandRejected)`. Receipt + revision
// advance happen in the caller.

fn apply_create_project(tx: &mut Transaction, cmd: CreateProjectCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let count: i64 = tx
        .query_row("SELECT COUNT(1) FROM projects WHERE id = ?1", [&cmd.project_id], |r| r.get(0))
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    if count > 0 {
        return Err(rejected(&cmd.command_id, "REVISION_CONFLICT", Some(0), Some(&cmd.project_id), None));
    }

    // Epic 17: a new project is born into whichever workspace is active.
    // Read (never repair) the pointer — we are inside this command's
    // transaction, and ensure_default_workspace ran at open, so the
    // invariants hold. Stamping it in the same INSERT means a project row is
    // never briefly workspace-less, even across a crash.
    let workspace_id = crate::db::workspace::read_active_workspace_id(tx)
        .map_err(|_| internal_rejection(&cmd.command_id))?;

    tx.execute(
        "INSERT INTO projects(id, name, revision, workspace_id) VALUES(?1, ?2, ?3, ?4)",
        rusqlite::params![cmd.project_id, cmd.name, cmd.expected_revision, workspace_id],
    )
    .map_err(|_e| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        None,
    ))
}

fn apply_rename_project(tx: &mut Transaction, cmd: RenameProjectCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    tx.execute(
        "UPDATE projects SET name = ?1 WHERE id = ?2",
        rusqlite::params![cmd.name, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;
    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        None,
    ))
}

fn apply_delete_project(tx: &mut Transaction, cmd: DeleteProjectCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let result = applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        None,
    );
    tx.execute("DELETE FROM projects WHERE id = ?1", [&cmd.project_id])
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    Ok(result)
}

fn apply_create_node(tx: &mut Transaction, cmd: CreateNodeCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    if let Some(parent) = &cmd.parent_id {
        let count: i64 = tx
            .query_row(
                "SELECT COUNT(1) FROM nodes WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![parent, cmd.project_id],
                |r| r.get(0),
            )
            .map_err(|_| internal_rejection(&cmd.command_id))?;
        if count == 0 {
            return Err(parent_not_found(&cmd.command_id, &cmd.project_id, parent));
        }
    }

    let target_pos = parse_position(&cmd.position);
    let existing: Option<i64> = tx
        .query_row(
            "SELECT position FROM nodes WHERE project_id = ?1 AND IFNULL(parent_id, '') = ?2 AND position = ?3",
            rusqlite::params![cmd.project_id, cmd.parent_id.clone().unwrap_or_default(), target_pos],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;

    let mut changes = Vec::new();
    let final_position = if existing.is_some() {
        let siblings = sibling_positions(tx, &cmd.project_id, cmd.parent_id.as_deref())?;
        let mut ids: Vec<String> = siblings.iter().map(|(id, _)| id.clone()).collect();
        ids.push(cmd.node_id.clone());
        let rebalanced = rebalance_sibling_positions(&ids);
        let mut final_pos = target_pos;
        for (node_id, pos) in &rebalanced {
            if *node_id != cmd.node_id {
                tx.execute("UPDATE nodes SET position = ?1 WHERE id = ?2", rusqlite::params![pos, node_id])
                    .map_err(|_| internal_rejection(&cmd.command_id))?;
            } else {
                final_pos = *pos;
            }
        }
        changes.push(NodeChange::SiblingPositionsRebalanced {
            parent_id: cmd.parent_id.clone(),
            positions: rebalanced
                .iter()
                .map(|(node_id, pos)| PositionPair { node_id: node_id.clone(), position: format_position(*pos) })
                .collect(),
        });
        final_pos
    } else {
        target_pos
    };

    tx.execute(
        "INSERT INTO nodes(id, project_id, parent_id, title, body_text, position) VALUES(?1, ?2, ?3, ?4, NULL, ?5)",
        rusqlite::params![cmd.node_id, cmd.project_id, cmd.parent_id, cmd.title, final_position],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    changes.push(NodeChange::NodeCreated {
        node_id: cmd.node_id.clone(),
        parent_id: cmd.parent_id.clone(),
        position: format_position(final_position),
        title: cmd.title.clone(),
    });

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

fn sibling_positions(
    tx: &mut Transaction,
    project_id: &str,
    parent_id: Option<&str>,
) -> Result<Vec<(String, i64)>, ProductCommandResult> {
    let mut stmt = tx
        .prepare("SELECT id, position FROM nodes WHERE project_id = ?1 AND IFNULL(parent_id, '') = ?2 ORDER BY position ASC")
        .map_err(|_| internal_error_rejection())?;
    let rows = stmt
        .query_map(rusqlite::params![project_id, parent_id.unwrap_or("")], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|_| internal_error_rejection())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|_| internal_error_rejection())?);
    }
    Ok(out)
}

fn internal_error_rejection() -> ProductCommandResult {
    rejected("", "INTERNAL", None, None, None)
}

fn apply_set_node_title(tx: &mut Transaction, cmd: SetNodeTitleCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let prior: Option<String> = tx
        .query_row(
            "SELECT title FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.node_id, cmd.project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some(prior) = prior else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    };

    tx.execute(
        "UPDATE nodes SET title = ?1 WHERE id = ?2 AND project_id = ?3",
        rusqlite::params![cmd.title, cmd.node_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodeTitleSet { node_id: cmd.node_id.clone(), title: cmd.title.clone(), prior_title: prior },
        ])),
    ))
}

fn apply_set_node_body_text(tx: &mut Transaction, cmd: SetNodeBodyTextCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let prior: Option<Option<String>> = tx
        .query_row(
            "SELECT body_text FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.node_id, cmd.project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|error| storage_rejection(&cmd.command_id,error))?;
    let Some(prior) = prior else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    };

    tx.execute(
        "UPDATE nodes SET body_text = ?1 WHERE id = ?2 AND project_id = ?3",
        rusqlite::params![cmd.body_text, cmd.node_id, cmd.project_id],
    )
    .map_err(|error| storage_rejection(&cmd.command_id,error))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodeBodyTextSet { node_id: cmd.node_id.clone(), body_text: cmd.body_text.clone(), prior_body_text: prior },
        ])),
    ))
}

fn apply_move_node(tx: &mut Transaction, cmd: MoveNodeCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let node: Option<(Option<String>, i64, Option<String>)> = tx
        .query_row(
            "SELECT parent_id, position, node_type FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.node_id, cmd.project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some((prior_parent, prior_position, child_type)) = node else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    };

    if let Some(new_parent) = &cmd.new_parent_id {
        let parent: Option<(Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT parent_id, node_type FROM nodes WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![new_parent, cmd.project_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| internal_rejection(&cmd.command_id))?;
        let Some((_, parent_type)) = parent else {
            return Err(parent_not_found(&cmd.command_id, &cmd.project_id, new_parent));
        };

        // Acyclicity walk.
        let mut current: Option<String> = Some(new_parent.clone());
        let mut depth = 0;
        while let Some(parent_id) = current {
            if parent_id == cmd.node_id {
                return Err(cycle_detected(&cmd.command_id, &cmd.project_id, &cmd.node_id));
            }
            let next: Option<Option<String>> = tx
                .query_row(
                    "SELECT parent_id FROM nodes WHERE id = ?1 AND project_id = ?2",
                    rusqlite::params![parent_id, cmd.project_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|_| internal_rejection(&cmd.command_id))?;
            current = next.unwrap_or(None);
            depth += 1;
            if depth > 100_000 {
                break;
            }
        }

        if !can_parent_node_type(parent_type.as_deref(), child_type.as_deref()) {
            return Err(hierarchy_conflict(&cmd.command_id, &cmd.project_id, &cmd.node_id));
        }
    }

    let target_pos = parse_position(&cmd.new_position);
    let mut changes = Vec::new();
    let final_position = if cmd.after_id.is_some() || cmd.before_id.is_some() || cmd.intended_index.is_some() {
        // R3 extension (Story 27.2, D8(c)): resolve the destination placement
        // from the anchors over the destination parent's current children.
        let dest_parent = cmd.new_parent_id.clone().unwrap_or_default();
        let mut stmt = tx
            .prepare("SELECT id, position FROM nodes WHERE project_id = ?1 AND IFNULL(parent_id, '') = ?2 AND id != ?3")
            .map_err(|_| internal_error_rejection())?;
        let rows = stmt
            .query_map(rusqlite::params![cmd.project_id, dest_parent, cmd.node_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(|_| internal_error_rejection())?;
        let mut siblings: Vec<(String, i64)> = Vec::new();
        for row in rows {
            siblings.push(row.map_err(|_| internal_error_rejection())?);
        }
        siblings.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        let dest_ids: Vec<String> = siblings.iter().map(|(id, _)| id.clone()).collect();
        let pos_of: HashMap<&str, i64> = siblings.iter().map(|(id, pos)| (id.as_str(), *pos)).collect();

        let Some(next) = apply_anchored_move(
            &dest_ids,
            &cmd.node_id,
            cmd.after_id.as_deref(),
            cmd.before_id.as_deref(),
            cmd.intended_index.unwrap_or(0),
        ) else {
            return Err(rejected(&cmd.command_id, "SELF_ANCHOR", None, Some(&cmd.project_id), Some(&cmd.node_id)));
        };

        let idx = next.iter().position(|id| id == &cmd.node_id).unwrap_or(0);
        let before_pos = if idx > 0 { pos_of.get(next[idx - 1].as_str()).copied() } else { None };
        let after_pos = if idx + 1 < next.len() { pos_of.get(next[idx + 1].as_str()).copied() } else { None };
        position_between(before_pos, after_pos).unwrap_or(target_pos)
    } else {
        // Local (un-anchored) path — byte-identical to prior behavior.
        let existing: Option<i64> = tx
            .query_row(
                "SELECT position FROM nodes WHERE project_id = ?1 AND IFNULL(parent_id, '') = ?2 AND position = ?3 AND id != ?4",
                rusqlite::params![cmd.project_id, cmd.new_parent_id.clone().unwrap_or_default(), target_pos, cmd.node_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| internal_rejection(&cmd.command_id))?;

        if existing.is_some() {
            let mut stmt = tx
                .prepare("SELECT id FROM nodes WHERE project_id = ?1 AND IFNULL(parent_id, '') = ?2 AND id != ?3 ORDER BY position ASC")
                .map_err(|_| internal_error_rejection())?;
            let rows = stmt
                .query_map(rusqlite::params![cmd.project_id, cmd.new_parent_id.clone().unwrap_or_default(), cmd.node_id], |r| r.get::<_, String>(0))
                .map_err(|_| internal_error_rejection())?;
            let mut ids: Vec<String> = Vec::new();
            for row in rows {
                ids.push(row.map_err(|_| internal_error_rejection())?);
            }
            ids.push(cmd.node_id.clone());
            let rebalanced = rebalance_sibling_positions(&ids);
            let mut final_pos = target_pos;
            for (node_id, pos) in &rebalanced {
                if *node_id != cmd.node_id {
                    tx.execute("UPDATE nodes SET position = ?1 WHERE id = ?2", rusqlite::params![pos, node_id])
                        .map_err(|_| internal_rejection(&cmd.command_id))?;
                } else {
                    final_pos = *pos;
                }
            }
            changes.push(NodeChange::SiblingPositionsRebalanced {
                parent_id: cmd.new_parent_id.clone(),
                positions: rebalanced
                    .iter()
                    .map(|(node_id, pos)| PositionPair { node_id: node_id.clone(), position: format_position(*pos) })
                    .collect(),
            });
            final_pos
        } else {
            target_pos
        }
    };

    tx.execute(
        "UPDATE nodes SET parent_id = ?1, position = ?2 WHERE id = ?3 AND project_id = ?4",
        rusqlite::params![cmd.new_parent_id, final_position, cmd.node_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    changes.push(NodeChange::NodeMoved {
        node_id: cmd.node_id.clone(),
        parent_id: cmd.new_parent_id.clone(),
        position: format_position(final_position),
        prior_parent_id: prior_parent,
        prior_position: format_position(prior_position),
    });

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

fn subtree_rows(
    tx: &mut Transaction,
    project_id: &str,
    root_node_id: &str,
) -> Result<Option<Vec<NodeSnapshot>>, ProductCommandResult> {
    let mut stmt = tx
        .prepare(
            "WITH RECURSIVE subtree(id, parent_id, title, body_text, position, depth) AS (
                SELECT id, parent_id, title, body_text, position, 0
                FROM nodes
                WHERE id = ?1 AND project_id = ?2
                UNION ALL
                SELECT n.id, n.parent_id, n.title, n.body_text, n.position, s.depth + 1
                FROM nodes n
                JOIN subtree s ON n.parent_id = s.id
                WHERE n.project_id = ?2
            )
            SELECT * FROM subtree ORDER BY depth ASC, position ASC",
        )
        .map_err(|_| internal_error_rejection())?;
    let rows = stmt
        .query_map(rusqlite::params![root_node_id, project_id], |r| {
            Ok(NodeSnapshot {
                node_id: r.get(0)?,
                parent_id: r.get(1)?,
                title: r.get(2)?,
                body_text: r.get(3)?,
                position: r.get::<_, i64>(4)?.to_string(),
                depth: r.get(5)?,
                node_type: None,
                start_date: None,
                end_date: None,
                duration_days: None,
                schedule_source_mode: None,
                completed: None,
                effort_points: None,
                strategic_weight: None,
                phase_id: None,
                delivery_status: None,
            })
        })
        .map_err(|_| internal_error_rejection())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|_| internal_error_rejection())?);
    }
    if out.is_empty() {
        Ok(None)
    } else {
        Ok(Some(out))
    }
}

fn apply_delete_subtree(tx: &mut Transaction, cmd: DeleteSubtreeCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    // Story 22.14 AC 22.14-1 names subtree delete among the plan-touching
    // commands (assignment cleanup): refuse a damaged stored plan before
    // reading or deleting nodes. A typed `FORECAST_PLAN_CORRUPT` rejection is
    // propagated unchanged and no transaction write is attempted. NOTE: this
    // handler does not itself prune `forecast_plans.assignments`; that cleanup
    // gap is tracked as deferred work against 22.14-1.
    read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let Some(snapshots) = subtree_rows(tx, &cmd.project_id, &cmd.node_id)? else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    };
    let deletion_bundle = super::deletion::capture(tx,&cmd.project_id,&cmd.node_id)
        .map_err(|error| storage_rejection(&cmd.command_id,error))?;
    if deletion_bundle.validate(&cmd.project_id,&cmd.node_id,&snapshots).is_err() {
        return Err(rejected(&cmd.command_id,"INVALID_DELETION_BUNDLE",None,Some(&cmd.project_id),Some(&cmd.node_id)));
    }
    tx.execute(
        "DELETE FROM nodes WHERE id = ?1 AND project_id = ?2",
        rusqlite::params![cmd.node_id, cmd.project_id],
    )
    .map_err(|error| storage_rejection(&cmd.command_id,error))?;
    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::SubtreeDeleted { root_node_id: cmd.node_id.clone(), nodes: snapshots, deletion_bundle: Some(deletion_bundle) },
        ])),
    ))
}

fn apply_duplicate_subtree(tx: &mut Transaction, cmd: DuplicateSubtreeCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let Some(source) = subtree_rows(tx, &cmd.project_id, &cmd.source_node_id)? else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.source_node_id)));
    };
    let mut duplicated = Vec::new();
    let root_parent = source[0].parent_id.clone();
    for row in &source {
        let is_root = row.node_id == cmd.source_node_id;
        let target_id = if is_root {
            cmd.new_root_id.clone()
        } else {
            cmd.id_map.get(&row.node_id).cloned().unwrap_or_else(|| row.node_id.clone())
        };
        let parent_id = if is_root {
            root_parent.clone()
        } else {
            row.parent_id.as_ref().and_then(|p| cmd.id_map.get(p).cloned()).or_else(|| row.parent_id.clone())
        };
        let position = if is_root { cmd.new_position.clone() } else { row.position.clone() };
        tx.execute(
            "INSERT INTO nodes(id, project_id, parent_id, title, body_text, position) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![target_id, cmd.project_id, parent_id, row.title, row.body_text, position.parse::<i64>().unwrap_or(0)],
        )
        .map_err(|error| storage_rejection(&cmd.command_id,error))?;
        duplicated.push(NodeSnapshot {
            node_id: target_id,
            parent_id,
            title: row.title.clone(),
            body_text: row.body_text.clone(),
            position,
            depth: row.depth,
            node_type: None,
            start_date: None,
            end_date: None,
            duration_days: None,
            schedule_source_mode: None,
            completed: None,
            effort_points: None,
            strategic_weight: None,
            phase_id: None,
            delivery_status: None,
        });
    }
    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::SubtreeDuplicated { source_root_id: cmd.source_node_id.clone(), new_root_id: cmd.new_root_id.clone(), nodes: duplicated },
        ])),
    ))
}

fn apply_restore_subtree(tx: &mut Transaction, cmd: RestoreSubtreeCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    if let Some(bundle) = &cmd.deletion_bundle {
        if let Some(code) = super::deletion::restore(tx,bundle,&cmd.project_id,&cmd.root_node_id,&cmd.nodes)
            .map_err(|error|storage_rejection(&cmd.command_id,error))? {
            return Err(rejected(&cmd.command_id,code,None,Some(&cmd.project_id),Some(&cmd.root_node_id)));
        }
    } else {
    let mut sorted = cmd.nodes.clone();
    sorted.sort_by_key(|n| n.depth);
    for node in &sorted {
        tx.execute(
            "INSERT INTO nodes(id, project_id, parent_id, title, body_text, position) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![node.node_id, cmd.project_id, node.parent_id, node.title, node.body_text, node.position.parse::<i64>().unwrap_or(0)],
        )
        .map_err(|error| storage_rejection(&cmd.command_id,error))?;
    }
    }
    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::SubtreeRestored { root_node_id: cmd.root_node_id.clone(), nodes: cmd.nodes.clone(), deletion_bundle: cmd.deletion_bundle.clone() },
        ])),
    ))
}

fn apply_set_node_type(tx: &mut Transaction, cmd: SetNodeTypeCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let node: Option<(Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT parent_id, node_type FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.node_id, cmd.project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some((parent_id, prior_type)) = node else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    };

    let parent_type = match &parent_id {
        Some(pid) => {
            let t: Option<Option<String>> = tx
                .query_row(
                    "SELECT node_type FROM nodes WHERE id = ?1 AND project_id = ?2",
                    rusqlite::params![pid, cmd.project_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|_| internal_rejection(&cmd.command_id))?;
            t.unwrap_or(None)
        }
        None => None,
    };

    // validateTypedNeighborhood
    if let Some(proposed) = &cmd.node_type {
        if let Some(pt) = &parent_type {
            if !can_parent_node_type(Some(pt), Some(proposed)) {
                return Err(hierarchy_conflict(&cmd.command_id, &cmd.project_id, &cmd.node_id));
            }
        }
        let mut stmt = tx
            .prepare("SELECT node_type FROM nodes WHERE parent_id = ?1 AND project_id = ?2")
            .map_err(|_| internal_error_rejection())?;
        let rows = stmt
            .query_map(rusqlite::params![cmd.node_id, cmd.project_id], |r| r.get::<_, Option<String>>(0))
            .map_err(|_| internal_error_rejection())?;
        for row in rows {
            let ct = row.map_err(|_| internal_error_rejection())?;
            if let Some(ct) = ct {
                if !can_parent_node_type(Some(proposed), Some(&ct)) {
                    return Err(hierarchy_conflict(&cmd.command_id, &cmd.project_id, &cmd.node_id));
                }
            }
        }
    }

    tx.execute(
        "UPDATE nodes SET node_type = ?1 WHERE id = ?2 AND project_id = ?3",
        rusqlite::params![cmd.node_type, cmd.node_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodeTypeSet { node_id: cmd.node_id.clone(), node_type: cmd.node_type.clone(), prior_node_type: prior_type },
        ])),
    ))
}

fn apply_set_node_custom_field(tx: &mut Transaction, cmd: SetNodeCustomFieldCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let prior: Option<Option<String>> = tx
        .query_row(
            "SELECT field_value FROM node_custom_fields WHERE project_id = ?1 AND node_id = ?2 AND field_key = ?3",
            rusqlite::params![cmd.project_id, cmd.node_id, cmd.field_key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let prior_value = prior.flatten();

    if cmd.field_value.is_none() {
        tx.execute(
            "DELETE FROM node_custom_fields WHERE project_id = ?1 AND node_id = ?2 AND field_key = ?3",
            rusqlite::params![cmd.project_id, cmd.node_id, cmd.field_key],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    } else {
        tx.execute(
            "INSERT INTO node_custom_fields(project_id, node_id, field_key, field_value)
             VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(project_id, node_id, field_key) DO UPDATE SET field_value = excluded.field_value",
            rusqlite::params![cmd.project_id, cmd.node_id, cmd.field_key, cmd.field_value],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    }

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodeCustomFieldSet { node_id: cmd.node_id.clone(), field_key: cmd.field_key.clone(), field_value: cmd.field_value.clone(), prior_field_value: prior_value },
        ])),
    ))
}

fn apply_promote_field_to_template(tx: &mut Transaction, cmd: PromoteFieldToTemplateCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let max_pos: Option<i64> = tx
        .query_row(
            "SELECT MAX(position) FROM type_template_fields WHERE project_id = ?1 AND node_type = ?2",
            rusqlite::params![cmd.project_id, cmd.node_type],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let next = max_pos.unwrap_or(0).saturating_add(1);

    tx.execute(
        "INSERT INTO type_template_fields(project_id, node_type, field_key, field_label, position)
         VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(project_id, node_type, field_key) DO UPDATE SET field_label = excluded.field_label",
        rusqlite::params![cmd.project_id, cmd.node_type, cmd.field_key, cmd.field_label, next],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::FieldTemplatePromoted { node_type: cmd.node_type.clone(), field_key: cmd.field_key.clone(), field_label: cmd.field_label.clone() },
        ])),
    ))
}

fn apply_set_node_schedule(tx: &mut Transaction, cmd: SetNodeScheduleCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let prior: Option<(Option<String>, Option<String>, Option<i64>, Option<String>)> = tx
        .query_row(
            "SELECT start_date, end_date, duration_days, schedule_source_mode FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.node_id, cmd.project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some((p_start, p_end, p_dur, p_mode)) = prior else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    };

    tx.execute(
        "UPDATE nodes SET start_date = ?1, end_date = ?2, duration_days = ?3, schedule_source_mode = ?4 WHERE id = ?5 AND project_id = ?6",
        rusqlite::params![cmd.start_date, cmd.end_date, cmd.duration_days, cmd.source_mode, cmd.node_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodeScheduleSet {
                node_id: cmd.node_id.clone(),
                start_date: cmd.start_date.clone(),
                end_date: cmd.end_date.clone(),
                duration_days: cmd.duration_days,
                source_mode: cmd.source_mode.clone(),
                prior_start_date: p_start,
                prior_end_date: p_end,
                prior_duration_days: p_dur,
                prior_source_mode: p_mode.unwrap_or_else(|| "none".to_string()),
            },
        ])),
    ))
}

fn apply_toggle_node_completed(tx: &mut Transaction, cmd: ToggleNodeCompletedCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let prior: Option<bool> = tx
        .query_row(
            "SELECT completed FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.node_id, cmd.project_id],
            |r| r.get::<_, i64>(0).map(|v| v != 0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some(prior) = prior else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    };

    tx.execute(
        "UPDATE nodes SET completed = ?1 WHERE id = ?2 AND project_id = ?3",
        rusqlite::params![if cmd.completed { 1 } else { 0 }, cmd.node_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodeCompletedToggled { node_id: cmd.node_id.clone(), completed: cmd.completed, prior_completed: prior },
        ])),
    ))
}

fn apply_set_node_effort(tx: &mut Transaction, cmd: SetNodeEffortCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let prior: Option<Option<i64>> = tx
        .query_row(
            "SELECT effort_points FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.node_id, cmd.project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some(prior) = prior else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    };

    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;

    let mut cleared_assignments = None;

    if cmd.effort_points == Some(0) {
        if let Some(plan) = &stored_plan {
            let mut assignments = plan.assignments.clone();
            if let Some(cleared) = assignments.remove(&cmd.node_id) {
                if !cleared.is_empty() {
                    cleared_assignments = Some(cleared);
                    tx.execute(
                        "UPDATE forecast_plans SET assignments = ?1 WHERE project_id = ?2",
                        rusqlite::params![
                            serde_json::to_string(&assignments).unwrap_or_else(|_| "{}".to_string()),
                            cmd.project_id
                        ],
                    )
                    .map_err(|_| internal_rejection(&cmd.command_id))?;
                }
            }
        }
    } else if let Some(restored) = &cmd.restored_assignments {
        if let Some(plan) = &stored_plan {
            let mut assignments = plan.assignments.clone();
            assignments.insert(cmd.node_id.clone(), restored.clone());
            tx.execute(
                "UPDATE forecast_plans SET assignments = ?1 WHERE project_id = ?2",
                rusqlite::params![
                    serde_json::to_string(&assignments).unwrap_or_else(|_| "{}".to_string()),
                    cmd.project_id
                ],
            )
            .map_err(|_| internal_rejection(&cmd.command_id))?;
        }
    }

    tx.execute(
        "UPDATE nodes SET effort_points = ?1 WHERE id = ?2 AND project_id = ?3",
        rusqlite::params![cmd.effort_points, cmd.node_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodeEffortSet {
                node_id: cmd.node_id.clone(),
                effort_points: cmd.effort_points,
                prior_effort_points: prior,
                cleared_assignments,
            },
        ])),
    ))
}

fn coerce_delivery_status(raw: Option<String>) -> String {
    match raw.as_deref() {
        Some("in_progress") => "in_progress".to_string(),
        Some("delivered") => "delivered".to_string(),
        _ => "not_started".to_string(),
    }
}

fn apply_set_node_status(tx: &mut Transaction, cmd: SetNodeStatusCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    if !matches!(cmd.delivery_status.as_str(), "not_started" | "in_progress" | "delivered") {
        return Err(rejected(&cmd.command_id,"INVALID_NODE_STATUS",None,Some(&cmd.project_id),Some(&cmd.node_id)));
    }

    let prior: Option<Option<String>> = tx
        .query_row(
            "SELECT delivery_status FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.node_id, cmd.project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some(prior) = prior else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    };
    let prior_delivery_status = coerce_delivery_status(prior);

    tx.execute(
        "UPDATE nodes SET delivery_status = ?1 WHERE id = ?2 AND project_id = ?3",
        rusqlite::params![cmd.delivery_status, cmd.node_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodeStatusSet {
                node_id: cmd.node_id.clone(),
                delivery_status: cmd.delivery_status.clone(),
                prior_delivery_status,
            },
        ])),
    ))
}

fn apply_set_theme_weight(tx: &mut Transaction, cmd: SetThemeWeightCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let prior: Option<Option<i64>> = tx
        .query_row(
            "SELECT strategic_weight FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.node_id, cmd.project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some(prior) = prior else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    };

    tx.execute(
        "UPDATE nodes SET strategic_weight = ?1 WHERE id = ?2 AND project_id = ?3",
        rusqlite::params![cmd.strategic_weight, cmd.node_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::ThemeWeightSet { node_id: cmd.node_id.clone(), strategic_weight: cmd.strategic_weight, prior_strategic_weight: prior },
        ])),
    ))
}

fn apply_create_phase(tx: &mut Transaction, cmd: CreatePhaseCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    tx.execute(
        "INSERT INTO phases(id, project_id, name, position) VALUES(?1, ?2, ?3, ?4)",
        rusqlite::params![cmd.phase_id, cmd.project_id, cmd.name, parse_position(&cmd.position)],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;
    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::PhaseCreated { phase_id: cmd.phase_id.clone(), name: cmd.name.clone(), position: cmd.position.clone() },
        ])),
    ))
}

fn apply_rename_phase(tx: &mut Transaction, cmd: RenamePhaseCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let prior: Option<String> = tx
        .query_row(
            "SELECT name FROM phases WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.phase_id, cmd.project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some(prior) = prior else {
        return Err(phase_not_found(&cmd.command_id));
    };

    tx.execute(
        "UPDATE phases SET name = ?1 WHERE id = ?2 AND project_id = ?3",
        rusqlite::params![cmd.name, cmd.phase_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::PhaseRenamed { phase_id: cmd.phase_id.clone(), name: cmd.name.clone(), prior_name: prior },
        ])),
    ))
}

fn apply_reorder_phases(tx: &mut Transaction, cmd: ReorderPhasesCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let mut stmt = tx
        .prepare("SELECT id, position FROM phases WHERE project_id = ?1")
        .map_err(|_| internal_error_rejection())?;
    let rows = stmt
        .query_map([&cmd.project_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|_| internal_error_rejection())?;
    let mut prior_phases = Vec::new();
    for row in rows {
        let (id, pos) = row.map_err(|_| internal_error_rejection())?;
        prior_phases.push(PositionPair { node_id: id, position: format_position(pos) });
    }

    for p in &cmd.phases {
        tx.execute(
            "UPDATE phases SET position = ?1 WHERE id = ?2 AND project_id = ?3",
            rusqlite::params![parse_position(&p.position), p.phase_id, cmd.project_id],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    }

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::PhasesReordered {
                phases: cmd
                    .phases
                    .iter()
                    .map(|p| PositionPair { node_id: p.phase_id.clone(), position: p.position.clone() })
                    .collect(),
                prior_phases,
            },
        ])),
    ))
}

fn apply_move_phase(tx: &mut Transaction, cmd: MovePhaseCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let mut stmt = tx
        .prepare("SELECT id, position FROM phases WHERE project_id = ?1")
        .map_err(|_| internal_error_rejection())?;
    let rows = stmt
        .query_map([&cmd.project_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|_| internal_error_rejection())?;
    let mut pairs: Vec<(String, i64)> = Vec::new();
    for row in rows {
        pairs.push(row.map_err(|_| internal_error_rejection())?);
    }
    pairs.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    let ordered: Vec<String> = pairs.iter().map(|(id, _)| id.clone()).collect();

    if !ordered.contains(&cmd.phase_id) {
        return Err(phase_not_found(&cmd.command_id));
    }

    let Some(next) = apply_anchored_move(
        &ordered,
        &cmd.phase_id,
        cmd.after_id.as_deref(),
        cmd.before_id.as_deref(),
        cmd.intended_index,
    ) else {
        return Err(rejected(&cmd.command_id, "SELF_ANCHOR", None, Some(&cmd.project_id), None));
    };

    let next_phases: Vec<PositionPair> = next
        .iter()
        .enumerate()
        .map(|(i, phase_id)| PositionPair {
            node_id: phase_id.clone(),
            position: format_position((i as i64 + 1) * SIBLING_POSITION_GAP),
        })
        .collect();
    let prior_phases: Vec<PositionPair> = pairs
        .iter()
        .map(|(id, pos)| PositionPair { node_id: id.clone(), position: format_position(*pos) })
        .collect();

    for p in &next_phases {
        tx.execute(
            "UPDATE phases SET position = ?1 WHERE id = ?2 AND project_id = ?3",
            rusqlite::params![parse_position(&p.position), p.node_id, cmd.project_id],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    }

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::PhasesReordered { phases: next_phases, prior_phases },
        ])),
    ))
}

fn apply_assign_node_phase(tx: &mut Transaction, cmd: AssignNodePhaseCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    if let Some(phase) = &cmd.phase_id {
        let count: i64 = tx
            .query_row(
                "SELECT COUNT(1) FROM phases WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![phase, cmd.project_id],
                |r| r.get(0),
            )
            .map_err(|_| internal_rejection(&cmd.command_id))?;
        if count == 0 {
            return Err(phase_not_found(&cmd.command_id));
        }
    }

    let prior: Option<Option<String>> = tx
        .query_row(
            "SELECT phase_id FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.node_id, cmd.project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some(prior) = prior else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    };

    tx.execute(
        "UPDATE nodes SET phase_id = ?1 WHERE id = ?2 AND project_id = ?3",
        rusqlite::params![cmd.phase_id, cmd.node_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodePhaseAssigned { node_id: cmd.node_id.clone(), phase_id: cmd.phase_id.clone(), prior_phase_id: prior },
        ])),
    ))
}

fn apply_delete_phase(tx: &mut Transaction, cmd: DeletePhaseCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let phase: Option<(String, i64)> = tx
        .query_row(
            "SELECT name, position FROM phases WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.phase_id, cmd.project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some((name, position)) = phase else {
        return Err(phase_not_found(&cmd.command_id));
    };

    let mut prior_assignments: HashMap<String, Option<String>> = HashMap::new();
    for (node_id, _) in &cmd.reassignments {
        prior_assignments.insert(node_id.clone(), Some(cmd.phase_id.clone()));
    }

    for (node_id, new_phase) in &cmd.reassignments {
        tx.execute(
            "UPDATE nodes SET phase_id = ?1 WHERE id = ?2 AND project_id = ?3",
            rusqlite::params![new_phase, node_id, cmd.project_id],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    }

    tx.execute(
        "DELETE FROM phases WHERE id = ?1 AND project_id = ?2",
        rusqlite::params![cmd.phase_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::PhaseDeleted {
                phase_id: cmd.phase_id.clone(),
                name,
                position: format_position(position),
                reassignments: cmd.reassignments.clone(),
                prior_assignments,
            },
        ])),
    ))
}

fn apply_restore_phase(tx: &mut Transaction, cmd: RestorePhaseCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    tx.execute(
        "INSERT INTO phases(id, project_id, name, position) VALUES(?1, ?2, ?3, ?4)",
        rusqlite::params![cmd.phase_id, cmd.project_id, cmd.name, parse_position(&cmd.position)],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    for (node_id, phase_id) in &cmd.prior_assignments {
        tx.execute(
            "UPDATE nodes SET phase_id = ?1 WHERE id = ?2 AND project_id = ?3",
            rusqlite::params![phase_id, node_id, cmd.project_id],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    }

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::PhaseRestored {
                phase_id: cmd.phase_id.clone(),
                name: cmd.name.clone(),
                position: cmd.position.clone(),
                prior_assignments: cmd.prior_assignments.clone(),
            },
        ])),
    ))
}

fn apply_create_unlock_edge(tx: &mut Transaction, cmd: CreateUnlockEdgeCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let src: i64 = tx
        .query_row(
            "SELECT COUNT(1) FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.source_node_id, cmd.project_id],
            |r| r.get(0),
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let tgt: i64 = tx
        .query_row(
            "SELECT COUNT(1) FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.target_node_id, cmd.project_id],
            |r| r.get(0),
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    if src == 0 || tgt == 0 {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, None));
    }

    let existing: i64 = tx
        .query_row(
            "SELECT COUNT(1) FROM unlock_edges WHERE project_id = ?1 AND source_node_id = ?2 AND target_node_id = ?3",
            rusqlite::params![cmd.project_id, cmd.source_node_id, cmd.target_node_id],
            |r| r.get(0),
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    if existing > 0 {
        return Err(edge_conflict(&cmd.command_id));
    }

    tx.execute(
        "INSERT INTO unlock_edges(id, project_id, source_node_id, target_node_id) VALUES(?1, ?2, ?3, ?4)",
        rusqlite::params![cmd.edge_id, cmd.project_id, cmd.source_node_id, cmd.target_node_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::UnlockEdgeCreated { edge_id: cmd.edge_id.clone(), source_node_id: cmd.source_node_id.clone(), target_node_id: cmd.target_node_id.clone() },
        ])),
    ))
}

fn apply_delete_unlock_edge(tx: &mut Transaction, cmd: DeleteUnlockEdgeCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let edge: Option<(String, String)> = tx
        .query_row(
            "SELECT source_node_id, target_node_id FROM unlock_edges WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.edge_id, cmd.project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let (source, target) = match edge {
        Some((s, t)) => (s, t),
        None => (cmd.source_node_id.clone().unwrap_or_default(), cmd.target_node_id.clone().unwrap_or_default()),
    };

    tx.execute(
        "DELETE FROM unlock_edges WHERE id = ?1 AND project_id = ?2",
        rusqlite::params![cmd.edge_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::UnlockEdgeDeleted { edge_id: cmd.edge_id.clone(), source_node_id: source, target_node_id: target },
        ])),
    ))
}

fn apply_dismiss_finding(tx: &mut Transaction, cmd: DismissFindingCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    tx.execute(
        "INSERT OR REPLACE INTO finding_dismissals(
            project_id, finding_id, finding_kind, target_id, fingerprint, dismissed_at
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![cmd.project_id, cmd.finding_id, cmd.finding_kind, cmd.target_id, cmd.fingerprint, cmd.dismissed_at],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::FindingDismissed { finding_id: cmd.finding_id.clone(), finding_kind: cmd.finding_kind.clone(), target_id: cmd.target_id.clone(), fingerprint: cmd.fingerprint.clone(), dismissed_at: cmd.dismissed_at.clone() },
        ])),
    ))
}

fn apply_undismiss_finding(tx: &mut Transaction, cmd: UndismissFindingCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let prior: Option<String> = tx
        .query_row(
            "SELECT dismissed_at FROM finding_dismissals WHERE project_id = ?1 AND finding_kind = ?2 AND target_id = ?3 AND fingerprint = ?4",
            rusqlite::params![cmd.project_id, cmd.finding_kind, cmd.target_id, cmd.fingerprint],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let prior = prior.unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string());

    tx.execute(
        "DELETE FROM finding_dismissals WHERE project_id = ?1 AND finding_kind = ?2 AND target_id = ?3 AND fingerprint = ?4",
        rusqlite::params![cmd.project_id, cmd.finding_kind, cmd.target_id, cmd.fingerprint],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::FindingUndismissed { finding_id: cmd.finding_id.clone(), finding_kind: cmd.finding_kind.clone(), target_id: cmd.target_id.clone(), fingerprint: cmd.fingerprint.clone(), prior_dismissed_at: prior },
        ])),
    ))
}

fn apply_record_affected_reasons(tx: &mut Transaction, cmd: RecordAffectedReasonsCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    for reason in &cmd.reasons {
        tx.execute(
            "INSERT OR REPLACE INTO affected_reasons(
                id, project_id, affected_node_id, causal_node_id, causal_node_title, delta_days, causal_date_summary, created_at, acknowledged_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)",
            rusqlite::params![
                reason.id, cmd.project_id, reason.affected_node_id, reason.causal_node_id,
                reason.causal_node_title, reason.delta_days, reason.causal_date_summary, reason.created_at
            ],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    }

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::AffectedReasonsRecorded { reasons: cmd.reasons.clone() },
        ])),
    ))
}

fn apply_acknowledge_affected_reason(tx: &mut Transaction, cmd: AcknowledgeAffectedReasonCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    tx.execute(
        "UPDATE affected_reasons SET acknowledged_at = ?1 WHERE project_id = ?2 AND id = ?3",
        rusqlite::params![cmd.acknowledged_at, cmd.project_id, cmd.reason_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::AffectedReasonAcknowledged { reason_id: cmd.reason_id.clone(), acknowledged_at: cmd.acknowledged_at.clone() },
        ])),
    ))
}

fn apply_clear_node_affected_reasons(tx: &mut Transaction, cmd: ClearNodeAffectedReasonsCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    tx.execute(
        "DELETE FROM affected_reasons WHERE project_id = ?1 AND affected_node_id = ?2",
        rusqlite::params![cmd.project_id, cmd.node_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, Vec::new())),
    ))
}

// ── Epic 16 apply functions (Story 16.1) ───────────────────────────────────

fn apply_add_node_question(tx: &mut Transaction, cmd: AddNodeQuestionCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let node_count: i64 = tx
        .query_row(
            "SELECT COUNT(1) FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.node_id, cmd.project_id],
            |r| r.get(0),
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    if node_count == 0 {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    }

    tx.execute(
        "INSERT INTO node_open_questions(
            id, project_id, node_id, question_text, status, decision_text, position, resolved_at_iso, created_at_iso
         ) VALUES(?1, ?2, ?3, ?4, 'OPEN', NULL, ?5, NULL, ?6)",
        rusqlite::params![
            cmd.question_id, cmd.project_id, cmd.node_id, cmd.question_text,
            parse_position(&cmd.position), cmd.created_at_iso
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodeQuestionAdded {
                question_id: cmd.question_id.clone(),
                node_id: cmd.node_id.clone(),
                question_text: cmd.question_text.clone(),
                position: cmd.position.clone(),
                created_at_iso: cmd.created_at_iso.clone(),
            },
        ])),
    ))
}

fn apply_update_node_question(tx: &mut Transaction, cmd: UpdateNodeQuestionCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let prior: Option<String> = tx
        .query_row(
            "SELECT question_text FROM node_open_questions WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.question_id, cmd.project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some(prior) = prior else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.question_id)));
    };

    tx.execute(
        "UPDATE node_open_questions SET question_text = ?1 WHERE id = ?2 AND project_id = ?3",
        rusqlite::params![cmd.question_text, cmd.question_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodeQuestionUpdated {
                question_id: cmd.question_id.clone(),
                question_text: cmd.question_text.clone(),
                prior_question_text: prior,
            },
        ])),
    ))
}

fn apply_resolve_node_question(tx: &mut Transaction, cmd: ResolveNodeQuestionCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let prior: Option<(String, Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT status, decision_text, resolved_at_iso FROM node_open_questions WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.question_id, cmd.project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some((prior_status, prior_decision, prior_resolved)) = prior else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.question_id)));
    };

    tx.execute(
        "UPDATE node_open_questions SET status = 'DECIDED', decision_text = ?1, resolved_at_iso = ?2 WHERE id = ?3 AND project_id = ?4",
        rusqlite::params![cmd.decision_text, cmd.resolved_at_iso, cmd.question_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodeQuestionResolved {
                question_id: cmd.question_id.clone(),
                decision_text: cmd.decision_text.clone(),
                resolved_at_iso: cmd.resolved_at_iso.clone(),
                prior_status,
                prior_decision_text: prior_decision,
                prior_resolved_at_iso: prior_resolved,
            },
        ])),
    ))
}

fn apply_reorder_node_questions(tx: &mut Transaction, cmd: ReorderNodeQuestionsCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let node_count: i64 = tx
        .query_row(
            "SELECT COUNT(1) FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.node_id, cmd.project_id],
            |r| r.get(0),
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    if node_count == 0 {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    }

    let mut stmt = tx
        .prepare("SELECT id FROM node_open_questions WHERE project_id = ?1 AND node_id = ?2 ORDER BY position ASC")
        .map_err(|_| internal_error_rejection())?;
    let rows = stmt
        .query_map(rusqlite::params![cmd.project_id, cmd.node_id], |r| r.get::<_, String>(0))
        .map_err(|_| internal_error_rejection())?;
    let mut existing: Vec<String> = Vec::new();
    for row in rows {
        existing.push(row.map_err(|_| internal_error_rejection())?);
    }

    let requested: std::collections::HashSet<&String> = cmd.question_ids.iter().collect();
    let existing_set: std::collections::HashSet<&String> = existing.iter().collect();
    if requested.len() != cmd.question_ids.len() || requested != existing_set {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    }

    for (index, question_id) in cmd.question_ids.iter().enumerate() {
        tx.execute(
            "UPDATE node_open_questions SET position = ?1 WHERE id = ?2 AND project_id = ?3",
            rusqlite::params![index as i64 + 1, question_id, cmd.project_id],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    }

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodeQuestionsReordered {
                node_id: cmd.node_id.clone(),
                question_ids: cmd.question_ids.clone(),
                prior_question_ids: existing,
            },
        ])),
    ))
}

fn apply_move_node_question(tx: &mut Transaction, cmd: MoveNodeQuestionCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let node_count: i64 = tx
        .query_row(
            "SELECT COUNT(1) FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.node_id, cmd.project_id],
            |r| r.get(0),
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    if node_count == 0 {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    }

    let mut stmt = tx
        .prepare("SELECT id FROM node_open_questions WHERE project_id = ?1 AND node_id = ?2 ORDER BY position ASC")
        .map_err(|_| internal_error_rejection())?;
    let rows = stmt
        .query_map(rusqlite::params![cmd.project_id, cmd.node_id], |r| r.get::<_, String>(0))
        .map_err(|_| internal_error_rejection())?;
    let mut existing: Vec<String> = Vec::new();
    for row in rows {
        existing.push(row.map_err(|_| internal_error_rejection())?);
    }

    if !existing.contains(&cmd.question_id) {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.node_id)));
    }

    let Some(next) = apply_anchored_move(
        &existing,
        &cmd.question_id,
        cmd.after_id.as_deref(),
        cmd.before_id.as_deref(),
        cmd.intended_index,
    ) else {
        return Err(rejected(&cmd.command_id, "SELF_ANCHOR", None, Some(&cmd.project_id), Some(&cmd.node_id)));
    };

    for (index, question_id) in next.iter().enumerate() {
        tx.execute(
            "UPDATE node_open_questions SET position = ?1 WHERE id = ?2 AND project_id = ?3",
            rusqlite::params![index as i64 + 1, question_id, cmd.project_id],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    }

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodeQuestionsReordered {
                node_id: cmd.node_id.clone(),
                question_ids: next,
                prior_question_ids: existing,
            },
        ])),
    ))
}

fn apply_delete_node_question(tx: &mut Transaction, cmd: DeleteNodeQuestionCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let prior: Option<(String, String, String, Option<String>, i64, Option<String>, String)> = tx
        .query_row(
            "SELECT node_id, question_text, status, decision_text, position, resolved_at_iso, created_at_iso
             FROM node_open_questions WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.question_id, cmd.project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some((node_id, question_text, status, decision_text, position, resolved_at_iso, created_at_iso)) = prior else {
        return Err(node_not_found(&cmd.command_id, &cmd.project_id, Some(&cmd.question_id)));
    };

    tx.execute(
        "DELETE FROM node_open_questions WHERE id = ?1 AND project_id = ?2",
        rusqlite::params![cmd.question_id, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![
            NodeChange::NodeQuestionDeleted {
                question_id: cmd.question_id.clone(),
                node_id,
                question_text,
                status,
                decision_text,
                position: format_position(position),
                resolved_at_iso,
                created_at_iso,
            },
        ])),
    ))
}

// ── Epic 18: ConfigureForecastPlan (Story 18.2) ───────────────────────────
// One atomic command covers the complete configuration group — capacity,
// sprint length, cadence, start ordinal, and start date — so one UI save
// never splits into separate capacity and cadence commits (AC 18.1-3,
// UX-DR9). Incomplete and zero values remain stored and distinctly
// explained (AC 18.5-4).

/// A real ISO `YYYY-MM-DD` calendar date. Mirrors the TS `isValidIsoDateOnly`
/// guard so a well-formed-but-impossible date (e.g. 2026-02-30) is rejected
/// at the native command boundary too (Story 18.1 AC2, parity with the wire
/// validator).
pub(crate) fn is_valid_iso_calendar_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if !s[0..4].bytes().all(|c| c.is_ascii_digit())
        || !s[5..7].bytes().all(|c| c.is_ascii_digit())
        || !s[8..10].bytes().all(|c| c.is_ascii_digit())
    {
        return false;
    }
    let year: i32 = match s[0..4].parse() {
        Ok(v) => v,
        Err(_) => return false,
    };
    let month: u32 = match s[5..7].parse() {
        Ok(v) => v,
        Err(_) => return false,
    };
    let day: u32 = match s[8..10].parse() {
        Ok(v) => v,
        Err(_) => return false,
    };
    if !(1..=12).contains(&month) || day < 1 {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let dim = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => 0,
    };
    day <= dim
}

fn apply_configure_forecast_plan(tx: &mut Transaction, cmd: ConfigureForecastPlanCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    // Value validation, parity with `validateConfigureForecastPlanWireCommand`:
    // reject rather than persist a malformed configuration group (Story 18.1
    // AC2, AC 18.3-4).
    let bad_number = cmd.points_per_sprint.map_or(false, |v| v < 0)
        || cmd.sprint_length_days.map_or(false, |v| v <= 0)
        || cmd.start_sprint_ordinal.map_or(false, |v| v <= 0);
    let bad_date = cmd
        .start_date
        .as_deref()
        .map_or(false, |s| !is_valid_iso_calendar_date(s));
    if bad_number || bad_date {
        return Err(rejected(
            &cmd.command_id,
            "FORECAST_CONFIG_INVALID",
            None,
            Some(&cmd.project_id),
            None,
        ));
    }

    // Story 21.13 D5: the prior planning level is read both for the
    // preserved-level edit path and for the creation path's forward state.
    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let had_prior = stored_plan.is_some();
    let (prior_points, prior_length, prior_ordinal, prior_date, prior_level) = match stored_plan {
        Some(p) => (p.points_per_sprint, p.sprint_length_days, p.start_sprint_ordinal, p.start_date, p.planning_level),
        None => (None, None, None, None, "Feature".to_string()),
    };

    // A carried level applies only at CREATION (Story 21.13 D5); an invalid
    // level is rejected with the same code the TS wire validator uses.
    let applied_level: Option<String> = if had_prior {
        None
    } else {
        match cmd.planning_level.as_deref() {
            Some(l) if l == "Theme" || l == "Component" || l == "Feature" => Some(l.to_string()),
            Some(_) => {
                return Err(rejected(
                    &cmd.command_id,
                    "INVALID_PLANNING_LEVEL",
                    None,
                    Some(&cmd.project_id),
                    None,
                ));
            }
            None => None,
        }
    };
    // The INSERT's planning_level column only matters for a fresh row; the
    // ON CONFLICT arm never touches the column, so edit-in-place saves
    // preserve the stored level exactly as the TS handler does.
    let insert_level = applied_level.clone().unwrap_or_else(|| "Feature".to_string());

    tx.execute(
        "INSERT INTO forecast_plans(
            project_id, selected_feature_ids, parallel_groups, points_per_sprint,
            sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version, planning_level
         ) VALUES(?1, '[]', '[]', ?2, ?3, 'fixed-contiguous', ?4, ?5, 'shared-capacity-v1', ?6)
          ON CONFLICT(project_id) DO UPDATE SET
            points_per_sprint    = excluded.points_per_sprint,
            sprint_length_days   = excluded.sprint_length_days,
            start_sprint_ordinal = excluded.start_sprint_ordinal,
            start_date           = excluded.start_date",
        rusqlite::params![
            &cmd.project_id,
            cmd.points_per_sprint,
            cmd.sprint_length_days,
            cmd.start_sprint_ordinal,
            cmd.start_date,
            insert_level,
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let mut changes = Vec::new();
    if !had_prior {
        changes.push(NodeChange::ForecastPlanCreated {
            project_id: cmd.project_id.clone(),
        });
    }
    changes.push(NodeChange::ForecastConfigurationSet {
        points_per_sprint: cmd.points_per_sprint,
        sprint_length_days: cmd.sprint_length_days,
        start_sprint_ordinal: cmd.start_sprint_ordinal,
        start_date: cmd.start_date.clone(),
        prior_points_per_sprint: prior_points,
        prior_sprint_length_days: prior_length,
        prior_start_sprint_ordinal: prior_ordinal,
        prior_start_date: prior_date,
    });
    // Story 21.13 D5: the level rides the same command at creation, so its
    // forward state is reported in the same changeset — parity with the TS
    // handler (no second command, no async chip flip).
    if let Some(level) = &applied_level {
        if level != "Feature" {
            changes.push(NodeChange::ForecastPlanningLevelSet {
                planning_level: level.clone(),
                selected_feature_ids: Vec::new(),
                parallel_groups: Vec::new(),
                blocked_feature_ids: Vec::new(),
                prior_planning_level: prior_level.clone(),
                prior_selected_feature_ids: Vec::new(),
                prior_parallel_groups: Vec::new(),
                prior_blocked_feature_ids: Vec::new(),
                prior_assignments: None,
                assignments: None,
            });
        }
    }

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

// ── Epic 18: SetForecastMembership (Story 18.2) ────────────────────────────
// Inclusion appends by default (AR-18); exclusion removes only that ID.
// Excluding a group member updates group membership in the same transaction;
// a resulting singleton group dissolves and both changes are reported
// (AR-19). Invalid references can be explicitly excluded; the system never
// silently shrinks scope (AC 18.1-4).

fn apply_set_forecast_membership(tx: &mut Transaction, cmd: SetForecastMembershipCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let had_prior = stored_plan.is_some();
    let (prior_ids, prior_groups, prior_blocked, prior_level, prior_assignments) = match stored_plan {
        Some(p) => (p.selected_feature_ids, p.parallel_groups, p.blocked_feature_ids, p.planning_level, p.assignments),
        None => (Vec::new(), Vec::new(), Vec::new(), "Feature".to_string(), HashMap::new()),
    };

    if cmd.included {
        if prior_ids.contains(&cmd.feature_id) {
            return Err(rejected(
                &cmd.command_id,
                "FORECAST_SCOPE_INVALID",
                None,
                Some(&cmd.project_id),
                Some(&cmd.feature_id),
            ));
        }
        let node_type: Option<String> = tx
            .query_row(
                "SELECT node_type FROM nodes WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![cmd.feature_id, cmd.project_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| internal_rejection(&cmd.command_id))?;
        // Story 21.7 AC 5: membership validates against the plan's planning
        // level — not the literal "Feature" — with a safe fallback to
        // "Feature" for a missing/unparseable stored level.
        let level = if prior_level == "Theme" || prior_level == "Component" || prior_level == "Feature" {
            prior_level.as_str()
        } else {
            "Feature"
        };
        if node_type.as_deref() != Some(level) {
            return Err(rejected(
                &cmd.command_id,
                "FORECAST_SCOPE_INVALID",
                None,
                Some(&cmd.project_id),
                Some(&cmd.feature_id),
            ));
        }

        // Parent/descendant overlap is rejected by name (AR-4) — parity with
        // the browser handler. Walks are visited-bounded.
        let mut parent_of: std::collections::HashMap<String, Option<String>> =
            std::collections::HashMap::new();
        {
            let mut stmt = tx
                .prepare("SELECT id, parent_id FROM nodes WHERE project_id = ?1")
                .map_err(|_| internal_rejection(&cmd.command_id))?;
            let rows = stmt
                .query_map(rusqlite::params![cmd.project_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
                })
                .map_err(|_| internal_rejection(&cmd.command_id))?;
            for row in rows {
                let (id, parent) = row.map_err(|_| internal_rejection(&cmd.command_id))?;
                parent_of.insert(id, parent);
            }
        }
        let prior_set: std::collections::HashSet<&String> = prior_ids.iter().collect();
        let overlap_reject = || {
            rejected(
                &cmd.command_id,
                "FORECAST_SCOPE_INVALID",
                None,
                Some(&cmd.project_id),
                Some(&cmd.feature_id),
            )
        };
        // Is an ancestor of the new Feature already selected?
        {
            let mut visited: std::collections::HashSet<String> =
                std::collections::HashSet::from([cmd.feature_id.clone()]);
            let mut cur = parent_of.get(&cmd.feature_id).cloned().flatten();
            while let Some(anc) = cur {
                if visited.contains(&anc) {
                    break;
                }
                if prior_set.contains(&anc) {
                    return Err(overlap_reject());
                }
                visited.insert(anc.clone());
                cur = parent_of.get(&anc).cloned().flatten();
            }
        }
        // Is the new Feature an ancestor of an already-selected Feature?
        for sel in &prior_ids {
            let mut visited: std::collections::HashSet<String> =
                std::collections::HashSet::from([sel.clone()]);
            let mut cur = parent_of.get(sel).cloned().flatten();
            while let Some(anc) = cur {
                if visited.contains(&anc) {
                    break;
                }
                if anc == cmd.feature_id {
                    return Err(overlap_reject());
                }
                visited.insert(anc.clone());
                cur = parent_of.get(&anc).cloned().flatten();
            }
        }
    } else if !prior_ids.contains(&cmd.feature_id) {
        // Excluding a Feature that is not in scope is a no-op — reject rather
        // than commit an identical plan and bump the revision (symmetric with
        // the already-present check on the inclusion path).
        return Err(rejected(
            &cmd.command_id,
            "FORECAST_SCOPE_INVALID",
            None,
            Some(&cmd.project_id),
            Some(&cmd.feature_id),
        ));
    }

    let next_ids: Vec<String> = if cmd.included {
        let mut ids = prior_ids.clone();
        ids.push(cmd.feature_id.clone());
        ids
    } else {
        prior_ids.iter().filter(|id| **id != cmd.feature_id).cloned().collect()
    };

    let next_groups: Vec<ParallelGroup> = if cmd.included {
        prior_groups.clone()
    } else {
        prior_groups
            .iter()
            .filter_map(|g| {
                let ids: Vec<String> = g
                    .feature_ids
                    .iter()
                    .filter(|id| **id != cmd.feature_id)
                    .cloned()
                    .collect();
                if ids.len() >= 2 {
                    Some(ParallelGroup { feature_ids: ids })
                } else {
                    None
                }
            })
            .collect()
    };

    // Excluding a Feature also clears any forecast-owned blocker on it, in the
    // same transaction (Story 20.1 AC5, AR-19). The ForecastScopeSet change
    // carries both blocked sets so the cleanup is reported and reversible.
    let next_blocked: Vec<String> = if cmd.included {
        prior_blocked.clone()
    } else {
        prior_blocked
            .iter()
            .filter(|id| **id != cmd.feature_id)
            .cloned()
            .collect()
    };

    let (next_assignments, cleared_assignments) = if !cmd.included {
        if let Some(cleared) = prior_assignments.get(&cmd.feature_id).cloned() {
            let mut updated = prior_assignments.clone();
            updated.remove(&cmd.feature_id);
            (updated, Some(cleared))
        } else {
            (prior_assignments.clone(), None)
        }
    } else {
        (prior_assignments.clone(), None)
    };

    tx.execute(
        "INSERT INTO forecast_plans(
            project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
            sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version, assignments
         ) VALUES(?1, ?2, ?3, ?4, NULL, NULL, 'fixed-contiguous', NULL, NULL, 'shared-capacity-v1', ?5)
         ON CONFLICT(project_id) DO UPDATE SET
            selected_feature_ids = excluded.selected_feature_ids,
            parallel_groups      = excluded.parallel_groups,
            blocked_feature_ids  = excluded.blocked_feature_ids,
            assignments          = excluded.assignments",
        rusqlite::params![
            cmd.project_id,
            serde_json::to_string(&next_ids).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&next_groups).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&next_blocked).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&next_assignments).unwrap_or_else(|_| "{}".to_string()),
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let mut changes = Vec::new();
    if !had_prior {
        changes.push(NodeChange::ForecastPlanCreated {
            project_id: cmd.project_id.clone(),
        });
    }
    changes.push(NodeChange::ForecastScopeSet {
        selected_feature_ids: next_ids.clone(),
        parallel_groups: next_groups.clone(),
        prior_selected_feature_ids: prior_ids,
        prior_parallel_groups: prior_groups,
        blocked_feature_ids: next_blocked.clone(),
        prior_blocked_feature_ids: prior_blocked.clone(),
        cleared_assignments,
        prior_assignments: if had_prior { Some(prior_assignments) } else { None },
        assignments: Some(next_assignments),
    });

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

// ── Epic 20: SetForecastBlocker (Story 20.1) ─────────────────────────────
// Marks/clears a forecast-owned blocker on one included Feature. Never
// inferred from unlock edges or delivery status; adds no delay duration
// (AR-12). A no-op is rejected rather than committed as an empty revision.
fn apply_set_forecast_blocker(
    tx: &mut Transaction,
    cmd: SetForecastBlockerCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let had_prior = stored_plan.is_some();
    let (prior_ids, prior_blocked) = match stored_plan {
        Some(p) => (p.selected_feature_ids, p.blocked_feature_ids),
        None => (Vec::new(), Vec::new()),
    };
    let is_blocked = prior_blocked.iter().any(|id| *id == cmd.feature_id);

    if cmd.blocked {
        if !prior_ids.iter().any(|id| *id == cmd.feature_id) {
            return Err(rejected(
                &cmd.command_id,
                "FORECAST_SCOPE_INVALID",
                None,
                Some(&cmd.project_id),
                Some(&cmd.feature_id),
            ));
        }
        if is_blocked {
            return Err(rejected(
                &cmd.command_id,
                "FORECAST_BLOCKER_INVALID",
                None,
                Some(&cmd.project_id),
                Some(&cmd.feature_id),
            ));
        }
    } else if !is_blocked {
        return Err(rejected(
            &cmd.command_id,
            "FORECAST_BLOCKER_INVALID",
            None,
            Some(&cmd.project_id),
            Some(&cmd.feature_id),
        ));
    }

    // Keep priority order: rebuild the blocked set from scope order.
    let next_blocked: Vec<String> = if cmd.blocked {
        let mut with_new: std::collections::HashSet<String> =
            prior_blocked.iter().cloned().collect();
        with_new.insert(cmd.feature_id.clone());
        prior_ids
            .iter()
            .filter(|id| with_new.contains(*id))
            .cloned()
            .collect()
    } else {
        prior_ids
            .iter()
            .filter(|id| *id != &cmd.feature_id && prior_blocked.contains(id))
            .cloned()
            .collect()
    };

    tx.execute(
        "INSERT INTO forecast_plans(
            project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
            sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version
         ) VALUES(?1, '[]', '[]', ?2, NULL, NULL, 'fixed-contiguous', NULL, NULL, 'shared-capacity-v1')
         ON CONFLICT(project_id) DO UPDATE SET
            blocked_feature_ids = excluded.blocked_feature_ids",
        rusqlite::params![
            cmd.project_id,
            serde_json::to_string(&next_blocked).unwrap_or_else(|_| "[]".to_string()),
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let mut changes = Vec::new();
    if !had_prior {
        changes.push(NodeChange::ForecastPlanCreated {
            project_id: cmd.project_id.clone(),
        });
    }
    changes.push(NodeChange::ForecastBlockerSet {
        feature_id: cmd.feature_id.clone(),
        blocked: cmd.blocked,
        prior_blocked: is_blocked,
    });

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

// ── Delivery Board: SetForecastSprintPlan ────────────────────────────────
// Replaces the plan's sprint plan (hand placements + per-sprint capacity).
// The board checks capacity and dependency rules before sending; the
// repository validates the shape and stores the canonical value. Needs an
// existing plan and rejects a no-op, matching the browser handler.

const MAX_SPRINT_PLAN_ENTRIES: usize = 10_000;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Validate and canonicalize a sprint plan: one placement per item (the last
/// wins, at its position) and capacity keys in sprint order. `None` when the
/// value is malformed.
pub(crate) fn canonical_sprint_plan(value: &serde_json::Value) -> Option<serde_json::Value> {
    use serde_json::{json, Map, Value};
    let object = match value {
        Value::Null => return Some(json!({ "placements": [], "capacities": {} })),
        Value::Object(object) => object,
        _ => return None,
    };
    if object.keys().any(|key| key != "placements" && key != "capacities") {
        return None;
    }
    let placements_in = match object.get("placements") {
        None => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(_) => return None,
    };
    let capacities_in = match object.get("capacities") {
        None => Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => return None,
    };
    if placements_in.len() + capacities_in.len() > MAX_SPRINT_PLAN_ENTRIES {
        return None;
    }
    let mut parsed: Vec<(String, i64)> = Vec::with_capacity(placements_in.len());
    for entry in &placements_in {
        let entry = entry.as_object()?;
        if entry.keys().any(|key| key != "itemId" && key != "sprint") {
            return None;
        }
        let item_id = entry.get("itemId")?.as_str()?;
        if !crate::protocol::uuid_v7::is_uuid_v7(item_id) {
            return None;
        }
        let sprint = entry.get("sprint")?.as_i64()?;
        if sprint <= 0 || sprint > MAX_SAFE_INTEGER {
            return None;
        }
        parsed.push((item_id.to_string(), sprint));
    }
    let mut last_index: HashMap<&str, usize> = HashMap::new();
    for (index, (item_id, _)) in parsed.iter().enumerate() {
        last_index.insert(item_id.as_str(), index);
    }
    let placements: Vec<Value> = parsed
        .iter()
        .enumerate()
        .filter(|(index, (item_id, _))| last_index.get(item_id.as_str()) == Some(index))
        .map(|(_, (item_id, sprint))| json!({ "itemId": item_id, "sprint": sprint }))
        .collect();
    let mut capacities: Vec<(i64, i64)> = Vec::with_capacity(capacities_in.len());
    for (key, points) in &capacities_in {
        let first = key.chars().next()?;
        if first == '0' || !key.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let sprint: i64 = key.parse().ok()?;
        if sprint <= 0 || sprint > MAX_SAFE_INTEGER {
            return None;
        }
        let points = points.as_i64()?;
        if points < 0 || points > MAX_SAFE_INTEGER {
            return None;
        }
        capacities.push((sprint, points));
    }
    capacities.sort_by_key(|(sprint, _)| *sprint);
    let mut capacity_map = Map::new();
    for (sprint, points) in capacities {
        capacity_map.insert(sprint.to_string(), json!(points));
    }
    Some(json!({ "placements": placements, "capacities": Value::Object(capacity_map) }))
}

fn apply_set_forecast_sprint_plan(
    tx: &mut Transaction,
    cmd: SetForecastSprintPlanCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    let Some(next) = canonical_sprint_plan(&cmd.sprint_plan) else {
        return Err(rejected(&cmd.command_id, "INVALID_COMMAND", None, Some(&cmd.project_id), None));
    };
    let stored: Option<Option<String>> = tx
        .query_row(
            "SELECT sprint_plan FROM forecast_plans WHERE project_id = ?1",
            rusqlite::params![cmd.project_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    let Some(stored) = stored else {
        return Err(rejected(&cmd.command_id, "FORECAST_SPRINT_PLAN_INVALID", None, Some(&cmd.project_id), None));
    };
    let prior_raw: serde_json::Value = match stored.as_deref() {
        None => serde_json::Value::Null,
        Some(text) => serde_json::from_str(text).map_err(|_| internal_rejection(&cmd.command_id))?,
    };
    let prior = canonical_sprint_plan(&prior_raw).ok_or_else(|| internal_rejection(&cmd.command_id))?;
    if prior == next {
        return Err(rejected(&cmd.command_id, "FORECAST_SPRINT_PLAN_INVALID", None, Some(&cmd.project_id), None));
    }
    tx.execute(
        "UPDATE forecast_plans SET sprint_plan = ?1 WHERE project_id = ?2",
        rusqlite::params![next.to_string(), cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let changes = vec![NodeChange::ForecastSprintPlanSet {
        sprint_plan: next,
        prior_sprint_plan: prior,
    }];
    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

// ── Epic 20: Forecast scenarios (Story 20.4) ─────────────────────────────
// Inputs only, never a computed result (AD-22). CreateForecastScenario
// extracts the baseline scope/config/groups/blocked set and the union fact
// map from this snapshot at the previewed revision. Staleness is caught by
// the central revision check.

fn scenario_fact_map(
    tx: &mut Transaction,
    project_id: &str,
    ids: &[String],
    command_id: &str,
) -> Result<serde_json::Value, ProductCommandResult> {
    use std::collections::HashMap;
    let mut parent_of: HashMap<String, Option<String>> = HashMap::new();
    let mut type_of: HashMap<String, Option<String>> = HashMap::new();
    let mut project_of: HashMap<String, String> = HashMap::new();
    let mut effort_of: HashMap<String, Option<i64>> = HashMap::new();
    {
        let mut stmt = tx
            .prepare("SELECT id, parent_id, node_type, project_id, effort_points FROM nodes WHERE project_id = ?1")
            .map_err(|_| internal_rejection(command_id))?;
        let rows = stmt
            .query_map(rusqlite::params![project_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                ))
            })
            .map_err(|_| internal_rejection(command_id))?;
        for row in rows {
            let (id, parent, ntype, pid, effort) = row.map_err(|_| internal_rejection(command_id))?;
            parent_of.insert(id.clone(), parent);
            type_of.insert(id.clone(), ntype);
            project_of.insert(id.clone(), pid);
            effort_of.insert(id, effort);
        }
    }
    let mut map = serde_json::Map::new();
    let mut unique: Vec<&String> = Vec::new();
    for id in ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    for id in unique {
        let exists = type_of.contains_key(id);
        let mut ancestors: Vec<String> = Vec::new();
        let mut visited: std::collections::HashSet<String> = std::collections::HashSet::from([id.clone()]);
        let mut cur = parent_of.get(id).cloned().flatten();
        while let Some(anc) = cur {
            if visited.contains(&anc) {
                break;
            }
            visited.insert(anc.clone());
            ancestors.push(anc.clone());
            cur = parent_of.get(&anc).cloned().flatten();
        }
        map.insert(
            id.clone(),
            serde_json::json!({
                "effortPoints": if exists { effort_of.get(id).cloned().flatten() } else { None },
                // Story 21.9 AC 2: the fact records the node's ACTUAL type —
                // not a Feature-only boolean — so a Theme- or Component-level
                // scenario evaluates and diffs correctly.
                "nodeType": if exists { type_of.get(id).cloned().flatten().unwrap_or_default() } else { String::new() },
                "projectId": if exists { project_of.get(id).cloned().unwrap_or_default() } else { String::new() },
                "ancestorIds": ancestors,
            }),
        );
    }
    Ok(serde_json::Value::Object(map))
}

fn apply_create_forecast_scenario(
    tx: &mut Transaction,
    cmd: CreateForecastScenarioCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    // The preview must have been taken at the current revision (AC 20.4-2).
    if cmd.baseline_revision != cmd.base_revision {
        return Err(rejected(&cmd.command_id, "FORECAST_SCENARIO_STALE", None, Some(&cmd.project_id), None));
    }
    let exists: Option<String> = tx
        .query_row("SELECT scenario_id FROM forecast_scenarios WHERE scenario_id = ?1", rusqlite::params![cmd.scenario_id], |r| r.get(0))
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    if exists.is_some() {
        return Err(rejected(&cmd.command_id, "FORECAST_SCENARIO_INVALID", None, Some(&cmd.project_id), None));
    }

    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let (ordered_scope, parallel_groups, blocked_all, pps, sld, sso, sd, policy, planning_level, roster, assignments) = match stored_plan {
        Some(p) => (
            p.selected_feature_ids,
            p.parallel_groups,
            p.blocked_feature_ids,
            p.points_per_sprint,
            p.sprint_length_days,
            p.start_sprint_ordinal,
            p.start_date,
            p.policy_version,
            p.planning_level,
            p.roster,
            p.assignments,
        ),
        None => (
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            None,
            None,
            None,
            "shared-capacity-v1".to_string(),
            "Feature".to_string(),
            Vec::new(),
            HashMap::new(),
        ),
    };
    let patch_scope: Vec<String> = cmd
        .patch
        .get("orderedScope")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let assigned_ids: Vec<String> = if policy == "staffed-capacity-v1" {
        assignments.keys().cloned().collect()
    } else {
        Vec::new()
    };
    let patch_assigned_ids: Vec<String> = cmd
        .patch
        .get("assignmentOverrides")
        .and_then(|v| v.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default();

    let mut union_ids = ordered_scope.clone();
    for id in patch_scope.iter().chain(assigned_ids.iter()).chain(patch_assigned_ids.iter()) {
        if !union_ids.contains(id) {
            union_ids.push(id.clone());
        }
    }
    let fact_map = scenario_fact_map(tx, &cmd.project_id, &union_ids, &cmd.command_id)?;

    // Reject a patch that references a node that is not at the plan's level
    // in this project at save time (Story 21.9 AC 3).
    for id in &patch_scope {
        let ok = fact_map
            .get(id)
            .map(|f| f.get("nodeType").and_then(|t| t.as_str()) == Some(planning_level.as_str())
                && f.get("projectId").and_then(|p| p.as_str()) == Some(cmd.project_id.as_str()))
            .unwrap_or(false);
        if !ok {
            return Err(rejected(&cmd.command_id, "FORECAST_SCENARIO_INVALID", None, Some(&cmd.project_id), Some(id)));
        }
    }

    // Story 21.9 AC 3: the estimate filter accepts members whose captured
    // type equals the plan's level — never a Feature-only boolean.
    let estimates = ordered_scope.iter().filter_map(|id| {
        fact_map.get(id).filter(|f| f.get("nodeType").and_then(|v| v.as_str()) == Some(planning_level.as_str()))
            .map(|f| (id.clone(), f.get("effortPoints").cloned().unwrap_or(serde_json::Value::Null)))
    }).collect::<serde_json::Map<String, serde_json::Value>>();
    let blocked: Vec<String> = ordered_scope.iter().filter(|id| blocked_all.contains(id)).cloned().collect();

    let (actual_fingerprint, baseline) = if policy == "staffed-capacity-v1" {

        let mut canonical_roster: Vec<serde_json::Value> = roster
            .iter()
            .map(|p| serde_json::json!({ "id": p.id, "weightUnits": p.weight_units }))
            .collect();
        canonical_roster.sort_by(|a, b| {
            let ida = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let idb = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
            ida.cmp(idb)
        });

        let mut canonical_assignments: Vec<serde_json::Value> = ordered_scope
            .iter()
            .filter(|id| assignments.get(*id).map(|pids| !pids.is_empty()).unwrap_or(false))
            .map(|id| {
                let mut pids = assignments.get(id).cloned().unwrap_or_default();
                pids.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
                serde_json::json!({
                    "featureId": id,
                    "personIds": pids,
                })
            })
            .collect();
        canonical_assignments.sort_by(|a, b| {
            let fa = a.get("featureId").and_then(|v| v.as_str()).unwrap_or("");
            let fb = b.get("featureId").and_then(|v| v.as_str()).unwrap_or("");
            fa.cmp(fb)
        });

        let material = serde_json::json!({
            "policyVersion": policy,
            "selectedFeatureIds": ordered_scope,
            "estimates": estimates,
            "pointsPerSprint": pps,
            "sprintLengthDays": sld,
            "startSprintOrdinal": sso,
            "startDate": sd,
            "parallelGroups": parallel_groups,
            "blockedFeatureIds": blocked,
            "roster": canonical_roster,
            "assignments": canonical_assignments,
        });

        let mut baseline_map = serde_json::Map::new();
        baseline_map.insert("planningLevel".into(), serde_json::json!(planning_level));
        baseline_map.insert("orderedScope".into(), serde_json::json!(ordered_scope));
        baseline_map.insert("configuration".into(), serde_json::json!({
            "pointsPerSprint": pps,
            "sprintLengthDays": sld,
            "cadence": "fixed-contiguous",
            "startSprintOrdinal": sso,
            "startDate": sd,
        }));
        baseline_map.insert("parallelGroups".into(), serde_json::json!(parallel_groups));
        baseline_map.insert("blockedFeatureIds".into(), serde_json::json!(blocked_all));
        baseline_map.insert("factMap".into(), fact_map);
        baseline_map.insert("roster".into(), serde_json::json!(roster));
        baseline_map.insert("assignments".into(), serde_json::json!(assignments));

        (
            hex::encode(Sha256::digest(serde_json::to_vec(&material).unwrap_or_default())),
            serde_json::Value::Object(baseline_map),
        )
    } else {
        let material = serde_json::json!({
            "policyVersion": policy,
            "selectedFeatureIds": ordered_scope,
            "estimates": estimates,
            "pointsPerSprint": pps,
            "sprintLengthDays": sld,
            "startSprintOrdinal": sso,
            "startDate": sd,
            "parallelGroups": parallel_groups,
            "blockedFeatureIds": blocked,
        });

        let baseline = serde_json::json!({
            "planningLevel": planning_level,
            "orderedScope": ordered_scope,
            "configuration": {
                "pointsPerSprint": pps,
                "sprintLengthDays": sld,
                "cadence": "fixed-contiguous",
                "startSprintOrdinal": sso,
                "startDate": sd,
            },
            "parallelGroups": parallel_groups,
            "blockedFeatureIds": blocked_all,
            "factMap": fact_map,
        });

        (
            hex::encode(Sha256::digest(serde_json::to_vec(&material).unwrap_or_default())),
            baseline,
        )
    };

    if actual_fingerprint != cmd.expected_material_fingerprint {
        return Err(rejected(&cmd.command_id, "FORECAST_SCENARIO_STALE", None, Some(&cmd.project_id), None));
    }
    let scenario = serde_json::json!({
        "scenarioId": cmd.scenario_id,
        "projectId": cmd.project_id,
        "label": cmd.label,
        "baselineRevision": cmd.baseline_revision,
        "baselineFingerprint": cmd.expected_material_fingerprint,
        "policyVersion": policy,
        "createdAtISO": cmd.created_at_iso,
        "baseline": baseline,
        "patch": cmd.patch,
    });

    tx.execute(
        "INSERT INTO forecast_scenarios(scenario_id, project_id, label, baseline_revision, baseline_fingerprint, policy_version, created_at_iso, baseline_json, patch_json)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            cmd.scenario_id,
            cmd.project_id,
            cmd.label,
            cmd.baseline_revision,
            cmd.expected_material_fingerprint,
            scenario.get("policyVersion").and_then(|v| v.as_str()).unwrap_or("shared-capacity-v1"),
            cmd.created_at_iso,
            serde_json::to_string(&scenario["baseline"]).unwrap_or_default(),
            serde_json::to_string(&cmd.patch).unwrap_or_default(),
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![NodeChange::ForecastScenarioCreated { scenario }])),
    ))
}

fn read_scenario_json(tx: &mut Transaction, scenario_id: &str) -> Option<serde_json::Value> {
    tx.query_row(
        "SELECT scenario_id, project_id, label, baseline_revision, baseline_fingerprint, policy_version, created_at_iso, baseline_json, patch_json
         FROM forecast_scenarios WHERE scenario_id = ?1",
        rusqlite::params![scenario_id],
        |r| {
            let baseline: serde_json::Value = serde_json::from_str::<serde_json::Value>(&r.get::<_, String>(7)?).unwrap_or(serde_json::Value::Null);
            let patch: serde_json::Value = serde_json::from_str::<serde_json::Value>(&r.get::<_, String>(8)?).unwrap_or(serde_json::Value::Null);
            Ok(serde_json::json!({
                "scenarioId": r.get::<_, String>(0)?,
                "projectId": r.get::<_, String>(1)?,
                "label": r.get::<_, String>(2)?,
                "baselineRevision": r.get::<_, i64>(3)?,
                "baselineFingerprint": r.get::<_, String>(4)?,
                "policyVersion": r.get::<_, String>(5)?,
                "createdAtISO": r.get::<_, String>(6)?,
                "baseline": baseline,
                "patch": patch,
            }))
        },
    )
    .optional()
    .ok()
    .flatten()
}

fn apply_remove_forecast_scenario(
    tx: &mut Transaction,
    cmd: RemoveForecastScenarioCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    // Plan-touching scenario command: refuse a damaged stored plan before
    // mutating (Story 22.14 AC 22.14-1/-2).
    read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let existing = read_scenario_json(tx, &cmd.scenario_id);
    let existing = match existing {
        Some(s) if s.get("projectId").and_then(|p| p.as_str()) == Some(cmd.project_id.as_str()) => s,
        _ => return Err(rejected(&cmd.command_id, "FORECAST_SCENARIO_NOT_FOUND", None, Some(&cmd.project_id), None)),
    };
    tx.execute("DELETE FROM forecast_scenarios WHERE scenario_id = ?1", rusqlite::params![cmd.scenario_id])
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![NodeChange::ForecastScenarioRemoved {
            scenario_id: cmd.scenario_id.clone(),
            scenario: existing,
        }])),
    ))
}

fn apply_restore_forecast_scenario(
    tx: &mut Transaction,
    cmd: RestoreForecastScenarioCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    // Plan-touching scenario command: refuse a damaged stored plan before
    // mutating (Story 22.14 AC 22.14-1/-2).
    read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let s = &cmd.scenario;
    let scenario_id = s.get("scenarioId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let policy = s.get("policyVersion").and_then(|v| v.as_str()).unwrap_or_default();
    let policy_ok = policy == "shared-capacity-v1" || policy == "staffed-capacity-v1";
    if scenario_id.is_empty()
        || s.get("projectId").and_then(|v| v.as_str()) != Some(cmd.project_id.as_str())
        || !policy_ok
        || !s.get("baseline").is_some_and(|v| v.is_object())
        || !s.get("patch").is_some_and(|v| v.is_object())
    {
        return Err(rejected(&cmd.command_id, "FORECAST_SCENARIO_INVALID", None, Some(&cmd.project_id), None));
    }
    if policy == "staffed-capacity-v1" {
        let baseline = s.get("baseline");
        let has_roster = baseline.and_then(|b| b.get("roster")).is_some_and(|r| r.is_array());
        let has_assignments = baseline.and_then(|b| b.get("assignments")).is_some_and(|a| a.is_object());
        if !has_roster || !has_assignments {
            return Err(rejected(&cmd.command_id, "FORECAST_SCENARIO_INVALID", None, Some(&cmd.project_id), None));
        }
    }
    let exists: Option<String> = tx
        .query_row("SELECT scenario_id FROM forecast_scenarios WHERE scenario_id = ?1", rusqlite::params![scenario_id], |r| r.get(0))
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    if exists.is_some() {
        return Err(rejected(&cmd.command_id, "FORECAST_SCENARIO_INVALID", None, Some(&cmd.project_id), None));
    }
    tx.execute(
        "INSERT INTO forecast_scenarios(scenario_id, project_id, label, baseline_revision, baseline_fingerprint, policy_version, created_at_iso, baseline_json, patch_json)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            scenario_id,
            s.get("projectId").and_then(|v| v.as_str()).unwrap_or(&cmd.project_id),
            s.get("label").and_then(|v| v.as_str()).unwrap_or(""),
            s.get("baselineRevision").and_then(|v| v.as_i64()).unwrap_or(0),
            s.get("baselineFingerprint").and_then(|v| v.as_str()).unwrap_or(""),
            policy,
            s.get("createdAtISO").and_then(|v| v.as_str()).unwrap_or(""),
            serde_json::to_string(s.get("baseline").unwrap_or(&serde_json::Value::Null)).unwrap_or_default(),
            serde_json::to_string(s.get("patch").unwrap_or(&serde_json::Value::Null)).unwrap_or_default(),
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;
    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, vec![NodeChange::ForecastScenarioRestored { scenario: cmd.scenario.clone() }])),
    ))
}

// ── Epic 19: ReorderForecastFeatures (Story 19.2) ────────────────────────
fn apply_reorder_forecast_features(
    tx: &mut Transaction,
    cmd: ReorderForecastFeaturesCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let had_prior = stored_plan.is_some();
    let (prior_ids, prior_groups) = match stored_plan {
        Some(p) => (p.selected_feature_ids, p.parallel_groups),
        None => (Vec::new(), Vec::new()),
    };

    // Permutation check: lengths match, every id in cmd.feature_ids is in prior_ids, no duplicates
    let new_set: std::collections::HashSet<&String> = cmd.feature_ids.iter().collect();
    let is_permutation = cmd.feature_ids.len() == prior_ids.len()
        && new_set.len() == cmd.feature_ids.len()
        && prior_ids.iter().all(|id| new_set.contains(id));

    if !is_permutation {
        return Err(rejected(
            &cmd.command_id,
            "FORECAST_SCOPE_INVALID",
            None,
            Some(&cmd.project_id),
            None,
        ));
    }

    // Contiguity check for existing parallel groups:
    for group in &prior_groups {
        let mut min_idx = usize::MAX;
        let mut max_idx = 0;
        for id in &group.feature_ids {
            if let Some(pos) = cmd.feature_ids.iter().position(|x| x == id) {
                min_idx = min_idx.min(pos);
                max_idx = max_idx.max(pos);
            }
        }
        if max_idx - min_idx + 1 != group.feature_ids.len() {
            return Err(rejected(
                &cmd.command_id,
                "FORECAST_GROUP_SPLIT",
                None,
                Some(&cmd.project_id),
                None,
            ));
        }
    }

    tx.execute(
        "INSERT INTO forecast_plans(
            project_id, selected_feature_ids, parallel_groups, points_per_sprint,
            sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version
         ) VALUES(?1, ?2, ?3, NULL, NULL, 'fixed-contiguous', NULL, NULL, 'shared-capacity-v1')
         ON CONFLICT(project_id) DO UPDATE SET
            selected_feature_ids = excluded.selected_feature_ids",
        rusqlite::params![
            cmd.project_id,
            serde_json::to_string(&cmd.feature_ids).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&prior_groups).unwrap_or_else(|_| "[]".to_string()),
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let mut changes = Vec::new();
    if !had_prior {
        changes.push(NodeChange::ForecastPlanCreated {
            project_id: cmd.project_id.clone(),
        });
    }
    changes.push(NodeChange::ForecastOrderSet {
        selected_feature_ids: cmd.feature_ids.clone(),
        prior_selected_feature_ids: prior_ids,
    });

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

fn apply_move_forecast_feature(
    tx: &mut Transaction,
    cmd: MoveForecastFeatureCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let had_prior = stored_plan.is_some();
    let (prior_ids, prior_groups, policy_version, prior_assignments, prior_roster) = match stored_plan {
        Some(p) => (p.selected_feature_ids, p.parallel_groups, p.policy_version, p.assignments, p.roster),
        None => (Vec::new(), Vec::new(), "shared-capacity-v1".to_string(), HashMap::new(), Vec::new()),
    };

    if !prior_ids.contains(&cmd.feature_id) {
        return Err(rejected(&cmd.command_id, "FORECAST_SCOPE_INVALID", None, Some(&cmd.project_id), None));
    }

    let Some(next_ids) = apply_anchored_move(
        &prior_ids,
        &cmd.feature_id,
        cmd.after_id.as_deref(),
        cmd.before_id.as_deref(),
        cmd.intended_index,
    ) else {
        return Err(rejected(&cmd.command_id, "FORECAST_GROUP_INVALID", None, Some(&cmd.project_id), None));
    };

    let next_groups = match &cmd.group_change {
        ForecastGroupChange::Unchanged => prior_groups.clone(),
        ForecastGroupChange::Leave => prior_groups
            .iter()
            .filter_map(|g| {
                let kept: Vec<String> =
                    g.feature_ids.iter().filter(|id| *id != &cmd.feature_id).cloned().collect();
                if kept.len() >= 2 { Some(ParallelGroup { feature_ids: kept }) } else { None }
            })
            .collect(),
        ForecastGroupChange::Join { partner_id } => {
            if partner_id == &cmd.feature_id || !next_ids.contains(partner_id) {
                return Err(rejected(&cmd.command_id, "FORECAST_GROUP_INVALID", None, Some(&cmd.project_id), None));
            }
            let mut rebuilt: Vec<ParallelGroup> = prior_groups
                .iter()
                .filter_map(|g| {
                    let kept: Vec<String> =
                        g.feature_ids.iter().filter(|id| *id != &cmd.feature_id).cloned().collect();
                    if kept.len() >= 2 { Some(ParallelGroup { feature_ids: kept }) } else { None }
                })
                .collect();
            if let Some(pos) = rebuilt.iter().position(|g| g.feature_ids.iter().any(|id| id == partner_id)) {
                rebuilt[pos].feature_ids.push(cmd.feature_id.clone());
            } else {
                rebuilt.push(ParallelGroup { feature_ids: vec![partner_id.clone(), cmd.feature_id.clone()] });
            }
            rebuilt
        }
    };

    // Contiguity repair (Story 21.3 AC 10): keep only the contiguous run around
    // each group's first member; groups with <2 survivors dissolve.
    let mut canonical_groups: Vec<ParallelGroup> = Vec::new();
    for group in &next_groups {
        let positions: Vec<usize> = next_ids
            .iter()
            .enumerate()
            .filter(|(_, id)| group.feature_ids.contains(*id))
            .map(|(i, _)| i)
            .collect();
        if positions.len() < 2 {
            continue;
        }
        let mut run: Vec<String> = Vec::new();
        for (i, pos) in positions.iter().enumerate() {
            if *pos != positions[0] + i {
                break;
            }
            run.push(next_ids[*pos].clone());
        }
        if run.len() >= 2 {
            canonical_groups.push(ParallelGroup { feature_ids: run });
        }
    }

    if policy_version == "staffed-capacity-v1" {
        if let Some((conflict_person, conflicting_features)) = find_staffing_concurrency_conflict(
            tx,
            &cmd.project_id,
            &canonical_groups,
            &prior_assignments,
            &prior_roster,
        )? {
            return Err(forecast_assignment_conflict(&cmd.command_id, &conflict_person, conflicting_features));
        }
    }

    tx.execute(
        "INSERT INTO forecast_plans(
            project_id, selected_feature_ids, parallel_groups, points_per_sprint,
            sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version
         ) VALUES(?1, ?2, ?3, NULL, NULL, 'fixed-contiguous', NULL, NULL, 'shared-capacity-v1')
         ON CONFLICT(project_id) DO UPDATE SET
            selected_feature_ids = excluded.selected_feature_ids,
            parallel_groups = excluded.parallel_groups",
        rusqlite::params![
            cmd.project_id,
            serde_json::to_string(&next_ids).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&canonical_groups).unwrap_or_else(|_| "[]".to_string()),
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let mut changes = Vec::new();
    if !had_prior {
        changes.push(NodeChange::ForecastPlanCreated {
            project_id: cmd.project_id.clone(),
        });
    }
    changes.push(NodeChange::ForecastOrderSet {
        selected_feature_ids: next_ids,
        prior_selected_feature_ids: prior_ids,
    });
    if cmd.group_change != ForecastGroupChange::Unchanged {
        changes.push(NodeChange::ForecastParallelGroupsSet {
            parallel_groups: canonical_groups,
            prior_parallel_groups: prior_groups,
        });
    }

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

// ── Epic 22: Staffing Concurrency Conflict Helper ────────────────────────
fn find_staffing_concurrency_conflict(
    tx: &mut Transaction,
    project_id: &str,
    groups: &[ParallelGroup],
    assignments: &HashMap<String, Vec<String>>,
    roster: &[ForecastPersonDto],
) -> Result<Option<(String, Vec<String>)>, ProductCommandResult> {
    if assignments.is_empty() || roster.is_empty() || groups.is_empty() {
        return Ok(None);
    }

    let mut effort_cache: HashMap<String, Option<i64>> = HashMap::new();

    for group in groups {
        for person in roster {
            let mut conflicting: Vec<String> = Vec::new();
            for feature_id in &group.feature_ids {
                if let Some(assigned_persons) = assignments.get(feature_id) {
                    if assigned_persons.contains(&person.id) {
                        let effort = if let Some(cached) = effort_cache.get(feature_id) {
                            *cached
                        } else {
                            let pts: Option<i64> = tx
                                .query_row(
                                    "SELECT effort_points FROM nodes WHERE id = ?1 AND project_id = ?2",
                                    rusqlite::params![feature_id, project_id],
                                    |r| r.get(0),
                                )
                                .optional()
                                .map_err(|_| internal_rejection(""))?
                                .flatten();
                            effort_cache.insert(feature_id.clone(), pts);
                            pts
                        };

                        if let Some(pts) = effort {
                            if pts > 0 {
                                conflicting.push(feature_id.clone());
                            }
                        }
                    }
                }
            }
            if conflicting.len() > 1 {
                return Ok(Some((person.id.clone(), conflicting)));
            }
        }
    }

    Ok(None)
}

// ── Epic 19: SetForecastParallelGroups (Story 19.2) ──────────────────────
fn apply_set_forecast_parallel_groups(
    tx: &mut Transaction,
    cmd: SetForecastParallelGroupsCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let had_prior = stored_plan.is_some();
    let (prior_ids, prior_groups, policy_version, prior_assignments, prior_roster) = match stored_plan {
        Some(p) => (p.selected_feature_ids, p.parallel_groups, p.policy_version, p.assignments, p.roster),
        None => (Vec::new(), Vec::new(), "shared-capacity-v1".to_string(), HashMap::new(), Vec::new()),
    };

    let prior_id_set: std::collections::HashSet<&String> = prior_ids.iter().collect();
    let mut seen_group_ids = std::collections::HashSet::new();

    for group in &cmd.parallel_groups {
        if group.feature_ids.len() < 2 {
            return Err(rejected(
                &cmd.command_id,
                "FORECAST_GROUP_INVALID",
                None,
                Some(&cmd.project_id),
                None,
            ));
        }

        let mut group_set = std::collections::HashSet::new();
        let mut min_idx = usize::MAX;
        let mut max_idx = 0;

        for id in &group.feature_ids {
            if !prior_id_set.contains(id) || !group_set.insert(id) || !seen_group_ids.insert(id) {
                return Err(rejected(
                    &cmd.command_id,
                    "FORECAST_GROUP_INVALID",
                    None,
                    Some(&cmd.project_id),
                    Some(id),
                ));
            }
            if let Some(pos) = prior_ids.iter().position(|x| x == id) {
                min_idx = min_idx.min(pos);
                max_idx = max_idx.max(pos);
            }
        }

        if max_idx - min_idx + 1 != group.feature_ids.len() {
            return Err(rejected(
                &cmd.command_id,
                "FORECAST_GROUP_INVALID",
                None,
                Some(&cmd.project_id),
                None,
            ));
        }
    }

    if policy_version == "staffed-capacity-v1" {
        if let Some((conflict_person, conflicting_features)) = find_staffing_concurrency_conflict(
            tx,
            &cmd.project_id,
            &cmd.parallel_groups,
            &prior_assignments,
            &prior_roster,
        )? {
            return Err(forecast_assignment_conflict(&cmd.command_id, &conflict_person, conflicting_features));
        }
    }

    tx.execute(
        "INSERT INTO forecast_plans(
            project_id, selected_feature_ids, parallel_groups, points_per_sprint,
            sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version
         ) VALUES(?1, ?2, ?3, NULL, NULL, 'fixed-contiguous', NULL, NULL, 'shared-capacity-v1')
         ON CONFLICT(project_id) DO UPDATE SET
            parallel_groups = excluded.parallel_groups",
        rusqlite::params![
            cmd.project_id,
            serde_json::to_string(&prior_ids).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&cmd.parallel_groups).unwrap_or_else(|_| "[]".to_string()),
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let mut changes = Vec::new();
    if !had_prior {
        changes.push(NodeChange::ForecastPlanCreated {
            project_id: cmd.project_id.clone(),
        });
    }
    changes.push(NodeChange::ForecastParallelGroupsSet {
        parallel_groups: cmd.parallel_groups.clone(),
        prior_parallel_groups: prior_groups,
    });

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

// ── Epic 19: RestoreForecastScope (Story 19.2) ───────────────────────────
fn apply_restore_forecast_scope(
    tx: &mut Transaction,
    cmd: RestoreForecastScopeCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let had_prior = stored_plan.is_some();
    let (prior_ids, prior_groups, prior_blocked, prior_assignments) = match stored_plan {
        Some(p) => (p.selected_feature_ids, p.parallel_groups, p.blocked_feature_ids, p.assignments),
        None => (Vec::new(), Vec::new(), Vec::new(), HashMap::new()),
    };
    let next_assignments = cmd.assignments.clone().unwrap_or_else(|| prior_assignments.clone());

    // Restore the blocked set alongside scope/groups; keep only IDs that are in
    // the restored scope (Story 20.1).
    let next_blocked: Vec<String> = cmd
        .selected_feature_ids
        .iter()
        .filter(|id| cmd.blocked_feature_ids.contains(id))
        .cloned()
        .collect();

    // Validate selected_feature_ids: all must exist as Feature nodes in project, no duplicates
    let mut id_set = std::collections::HashSet::new();
    for id in &cmd.selected_feature_ids {
        if !id_set.insert(id) {
            return Err(rejected(
                &cmd.command_id,
                "FORECAST_SCOPE_INVALID",
                None,
                Some(&cmd.project_id),
                Some(id),
            ));
        }
        let node_type: Option<String> = tx
            .query_row(
                "SELECT node_type FROM nodes WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![id, cmd.project_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| internal_rejection(&cmd.command_id))?;
        if node_type.as_deref() != Some("Feature") {
            return Err(rejected(
                &cmd.command_id,
                "FORECAST_SCOPE_INVALID",
                None,
                Some(&cmd.project_id),
                Some(id),
            ));
        }
    }

    // Validate parallel groups
    let mut seen_group_ids = std::collections::HashSet::new();
    for group in &cmd.parallel_groups {
        if group.feature_ids.len() < 2 {
            return Err(rejected(
                &cmd.command_id,
                "FORECAST_GROUP_INVALID",
                None,
                Some(&cmd.project_id),
                None,
            ));
        }
        let mut group_set = std::collections::HashSet::new();
        let mut min_idx = usize::MAX;
        let mut max_idx = 0;
        for id in &group.feature_ids {
            if !id_set.contains(id) || !group_set.insert(id) || !seen_group_ids.insert(id) {
                return Err(rejected(
                    &cmd.command_id,
                    "FORECAST_GROUP_INVALID",
                    None,
                    Some(&cmd.project_id),
                    Some(id),
                ));
            }
            if let Some(pos) = cmd.selected_feature_ids.iter().position(|x| x == id) {
                min_idx = min_idx.min(pos);
                max_idx = max_idx.max(pos);
            }
        }
        if max_idx - min_idx + 1 != group.feature_ids.len() {
            return Err(rejected(
                &cmd.command_id,
                "FORECAST_GROUP_INVALID",
                None,
                Some(&cmd.project_id),
                None,
            ));
        }
    }

    tx.execute(
        "INSERT INTO forecast_plans(
            project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
            sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version, assignments
         ) VALUES(?1, ?2, ?3, ?4, NULL, NULL, 'fixed-contiguous', NULL, NULL, 'shared-capacity-v1', ?5)
         ON CONFLICT(project_id) DO UPDATE SET
            selected_feature_ids = excluded.selected_feature_ids,
            parallel_groups      = excluded.parallel_groups,
            blocked_feature_ids  = excluded.blocked_feature_ids,
            assignments          = excluded.assignments",
        rusqlite::params![
            cmd.project_id,
            serde_json::to_string(&cmd.selected_feature_ids).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&cmd.parallel_groups).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&next_blocked).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&next_assignments).unwrap_or_else(|_| "{}".to_string()),
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let mut changes = Vec::new();
    if !had_prior {
        changes.push(NodeChange::ForecastPlanCreated {
            project_id: cmd.project_id.clone(),
        });
    }
    changes.push(NodeChange::ForecastScopeSet {
        selected_feature_ids: cmd.selected_feature_ids.clone(),
        parallel_groups: cmd.parallel_groups.clone(),
        prior_selected_feature_ids: prior_ids,
        prior_parallel_groups: prior_groups,
        blocked_feature_ids: next_blocked.clone(),
        prior_blocked_feature_ids: prior_blocked.clone(),
        cleared_assignments: None,
        prior_assignments: if had_prior { Some(prior_assignments) } else { None },
        assignments: cmd.assignments,
    });

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

/// Atomic order/group replacement with the same wire ChangeSet as the web
/// repository. This keeps native/browser worker deltas and undo semantics equal.
fn apply_set_forecast_sequence(
    tx: &mut Transaction,
    cmd: SetForecastSequenceCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let (prior_ids, prior_groups, policy_version, prior_assignments, prior_roster) = match stored_plan {
        Some(p) => (p.selected_feature_ids, p.parallel_groups, p.policy_version, p.assignments, p.roster),
        None => (vec![], vec![], "shared-capacity-v1".to_string(), HashMap::new(), vec![]),
    };
    let submitted: std::collections::HashSet<&String> = cmd.feature_ids.iter().collect();
    if cmd.feature_ids.len() != prior_ids.len() || submitted.len() != cmd.feature_ids.len() || !prior_ids.iter().all(|id| submitted.contains(id)) {
        return Err(rejected(&cmd.command_id, "FORECAST_SCOPE_INVALID", None, Some(&cmd.project_id), None));
    }
    let mut seen = std::collections::HashSet::new();
    let mut groups = Vec::new();
    for group in cmd.parallel_groups {
        if group.feature_ids.len() < 2 || group.feature_ids.iter().any(|id| !submitted.contains(id) || !seen.insert(id.clone())) {
            return Err(rejected(&cmd.command_id, "FORECAST_GROUP_INVALID", None, Some(&cmd.project_id), None));
        }
        let canonical: Vec<String> = cmd.feature_ids.iter().filter(|id| group.feature_ids.contains(id)).cloned().collect();
        let first = cmd.feature_ids.iter().position(|id| id == &canonical[0]).unwrap_or(usize::MAX);
        if canonical.len() != group.feature_ids.len() || canonical.iter().enumerate().any(|(i, id)| cmd.feature_ids.get(first + i) != Some(id)) {
            return Err(rejected(&cmd.command_id, "FORECAST_GROUP_INVALID", None, Some(&cmd.project_id), None));
        }
        groups.push(ParallelGroup { feature_ids: canonical });
    }

    if policy_version == "staffed-capacity-v1" {
        if let Some((conflict_person, conflicting_features)) = find_staffing_concurrency_conflict(
            tx,
            &cmd.project_id,
            &groups,
            &prior_assignments,
            &prior_roster,
        )? {
            return Err(forecast_assignment_conflict(&cmd.command_id, &conflict_person, conflicting_features));
        }
    }
    tx.execute(
        "UPDATE forecast_plans SET selected_feature_ids = ?1, parallel_groups = ?2 WHERE project_id = ?3",
        rusqlite::params![
            serde_json::to_string(&cmd.feature_ids).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&groups).unwrap_or_else(|_| "[]".to_string()),
            cmd.project_id,
        ],
    ).map_err(|_| internal_rejection(&cmd.command_id))?;

    let changes = vec![NodeChange::ForecastSequenceSet {
        selected_feature_ids: cmd.feature_ids,
        parallel_groups: groups,
        prior_selected_feature_ids: prior_ids,
        prior_parallel_groups: prior_groups,
    }];
    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

// ── Epic 21: SetForecastPlanningLevel / RestoreForecastPlanningLevel (Story 21.7) ──
// Switches the plan's planning level and atomically clears scope, parallel
// groups, and blockers in one transaction and one ChangeSet (FR-13). The
// inverse restores all four columns in a single step so Undo returns the plan
// to its pre-switch state. Wire ChangeSets match the browser worker exactly.

fn apply_set_forecast_planning_level(
    tx: &mut Transaction,
    cmd: SetForecastPlanningLevelCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let had_prior = stored_plan.is_some();
    let (prior_ids, prior_groups, prior_blocked, prior_level, prior_assignments) = match stored_plan {
        Some(p) => (p.selected_feature_ids, p.parallel_groups, p.blocked_feature_ids, p.planning_level, p.assignments),
        None => (Vec::new(), Vec::new(), Vec::new(), "Feature".to_string(), HashMap::new()),
    };

    // A no-op switch (same level) is rejected rather than committed as an
    // empty revision — parity with the browser handler.
    if prior_level == cmd.planning_level {
        return Err(rejected(&cmd.command_id, "FORECAST_CONFIG_INVALID", None, Some(&cmd.project_id), None));
    }

    tx.execute(
        "INSERT INTO forecast_plans(
            project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
            sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version, planning_level, assignments
         ) VALUES(?1, '[]', '[]', '[]', NULL, NULL, 'fixed-contiguous', NULL, NULL, 'shared-capacity-v1', ?2, '{}')
         ON CONFLICT(project_id) DO UPDATE SET
            selected_feature_ids = '[]',
            parallel_groups      = '[]',
            blocked_feature_ids  = '[]',
            planning_level       = excluded.planning_level,
            assignments          = '{}'",
        rusqlite::params![cmd.project_id, cmd.planning_level],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let mut changes = Vec::new();
    if !had_prior {
        changes.push(NodeChange::ForecastPlanCreated {
            project_id: cmd.project_id.clone(),
        });
    }
    changes.push(NodeChange::ForecastPlanningLevelSet {
        planning_level: cmd.planning_level,
        selected_feature_ids: vec![],
        parallel_groups: vec![],
        blocked_feature_ids: vec![],
        prior_planning_level: prior_level,
        prior_selected_feature_ids: prior_ids,
        prior_parallel_groups: prior_groups,
        prior_blocked_feature_ids: prior_blocked,
        prior_assignments: if had_prior { Some(prior_assignments) } else { None },
        assignments: None,
    });

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

fn apply_restore_forecast_planning_level(
    tx: &mut Transaction,
    cmd: RestoreForecastPlanningLevelCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let had_prior = stored_plan.is_some();
    let (prior_ids, prior_groups, prior_blocked, prior_level, prior_assignments) = match stored_plan {
        Some(p) => (p.selected_feature_ids, p.parallel_groups, p.blocked_feature_ids, p.planning_level, p.assignments),
        None => (Vec::new(), Vec::new(), Vec::new(), "Feature".to_string(), HashMap::new()),
    };
    let next_assignments = cmd.assignments.clone().unwrap_or_else(|| prior_assignments.clone());

    // Validate the restored scope members exist at the restored level.
    let mut seen = std::collections::HashSet::new();
    for id in &cmd.selected_feature_ids {
        if !seen.insert(id.clone()) {
            return Err(rejected(&cmd.command_id, "FORECAST_SCOPE_INVALID", None, Some(&cmd.project_id), Some(id)));
        }
        let node_type: Option<String> = tx
            .query_row(
                "SELECT node_type FROM nodes WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![id, cmd.project_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| internal_rejection(&cmd.command_id))?;
        if node_type.as_deref() != Some(cmd.planning_level.as_str()) {
            return Err(rejected(&cmd.command_id, "FORECAST_SCOPE_INVALID", None, Some(&cmd.project_id), Some(id)));
        }
    }

    tx.execute(
        "INSERT INTO forecast_plans(
            project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
            sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version, planning_level, assignments
         ) VALUES(?1, ?2, ?3, ?4, NULL, NULL, 'fixed-contiguous', NULL, NULL, 'shared-capacity-v1', ?5, ?6)
         ON CONFLICT(project_id) DO UPDATE SET
            selected_feature_ids = excluded.selected_feature_ids,
            parallel_groups      = excluded.parallel_groups,
            blocked_feature_ids  = excluded.blocked_feature_ids,
            planning_level       = excluded.planning_level,
            assignments          = excluded.assignments",
        rusqlite::params![
            cmd.project_id,
            serde_json::to_string(&cmd.selected_feature_ids).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&cmd.parallel_groups).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&cmd.blocked_feature_ids).unwrap_or_else(|_| "[]".to_string()),
            cmd.planning_level,
            serde_json::to_string(&next_assignments).unwrap_or_else(|_| "{}".to_string()),
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let mut changes = Vec::new();
    if !had_prior {
        changes.push(NodeChange::ForecastPlanCreated {
            project_id: cmd.project_id.clone(),
        });
    }
    changes.push(NodeChange::ForecastPlanningLevelSet {
        planning_level: cmd.planning_level,
        selected_feature_ids: cmd.selected_feature_ids,
        parallel_groups: cmd.parallel_groups,
        blocked_feature_ids: cmd.blocked_feature_ids,
        prior_planning_level: prior_level,
        prior_selected_feature_ids: prior_ids,
        prior_parallel_groups: prior_groups,
        prior_blocked_feature_ids: prior_blocked,
        prior_assignments: if had_prior { Some(prior_assignments) } else { None },
        assignments: cmd.assignments,
    });

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

// ── Epic 21: RemoveForecastPlan (Story 21.13, D5) ──────────────────────────
// The undo-side inverse of atomic plan creation: deletes the forecast_plans
// row so a single Undo returns to the pre-creation state (the level step).
// Scenarios are untouched — by undo-stack LIFO order they are all removed
// before the creation entry is ever popped.

fn apply_remove_forecast_plan(tx: &mut Transaction, cmd: RemoveForecastPlanCommand) -> Result<ProductCommandResult, ProductCommandResult> {
    let project_revision: Option<i64> = tx
        .query_row(
            "SELECT revision FROM projects WHERE id = ?1",
            rusqlite::params![cmd.project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;

    let current_revision = match project_revision {
        Some(rev) => rev,
        None => return Err(project_not_found(&cmd.command_id, &cmd.project_id)),
    };
    if current_revision != cmd.base_revision {
        return Err(revision_conflict(&cmd.command_id, &cmd.project_id, current_revision));
    }

    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    if stored_plan.is_none() {
        // Undo of a creation always finds the row the forward command wrote.
        return Err(rejected(
            &cmd.command_id,
            "FORECAST_CONFIG_INVALID",
            None,
            Some(&cmd.project_id),
            None,
        ));
    }

    tx.execute(
        "DELETE FROM forecast_plans WHERE project_id = ?1",
        rusqlite::params![cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    tx.execute(
        "UPDATE projects SET revision = ?1 WHERE id = ?2",
        rusqlite::params![cmd.expected_revision, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let changes = vec![NodeChange::ForecastPlanRemoved {
        project_id: cmd.project_id.clone(),
    }];

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

// ── Epic 22: Forecast Roster Commands (Story 22.3) ─────────────────────────

fn apply_add_forecast_person(
    tx: &mut Transaction,
    cmd: AddForecastPersonCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    let project_revision: Option<i64> = tx
        .query_row(
            "SELECT revision FROM projects WHERE id = ?1",
            rusqlite::params![cmd.project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;

    let current_revision = match project_revision {
        Some(rev) => rev,
        None => return Err(project_not_found(&cmd.command_id, &cmd.project_id)),
    };
    if current_revision != cmd.base_revision {
        return Err(revision_conflict(&cmd.command_id, &cmd.project_id, current_revision));
    }

    if cmd.person_id.trim().is_empty()
        || cmd.name.trim().is_empty()
        || cmd.weight_units <= 0
    {
        return Err(rejected(
            &cmd.command_id,
            "FORECAST_PERSON_INVALID",
            None,
            Some(&cmd.project_id),
            None,
        ));
    }

    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let had_prior = stored_plan.is_some();
    let mut roster: Vec<ForecastPersonDto> = stored_plan
        .as_ref()
        .map(|p| p.roster.clone())
        .unwrap_or_default();

    if roster.iter().any(|p| p.id == cmd.person_id) {
        return Err(rejected(
            &cmd.command_id,
            "FORECAST_PERSON_EXISTS",
            None,
            Some(&cmd.project_id),
            None,
        ));
    }

    let person = ForecastPersonDto {
        id: cmd.person_id.clone(),
        name: cmd.name.trim().to_string(),
        weight_units: cmd.weight_units,
    };
    roster.push(person.clone());

    if !had_prior {
        tx.execute(
            "INSERT INTO forecast_plans(
                project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
                sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version, planning_level, roster
             ) VALUES(?1, '[]', '[]', '[]', NULL, NULL, 'fixed-contiguous', NULL, NULL, 'shared-capacity-v1', 'Feature', ?2)",
            rusqlite::params![
                cmd.project_id,
                serde_json::to_string(&roster).unwrap_or_else(|_| "[]".to_string()),
            ],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    } else {
        tx.execute(
            "UPDATE forecast_plans SET roster = ?1 WHERE project_id = ?2",
            rusqlite::params![
                serde_json::to_string(&roster).unwrap_or_else(|_| "[]".to_string()),
                cmd.project_id,
            ],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    }

    tx.execute(
        "UPDATE projects SET revision = ?1 WHERE id = ?2",
        rusqlite::params![cmd.expected_revision, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let mut changes = Vec::new();
    if !had_prior {
        changes.push(NodeChange::ForecastPlanCreated {
            project_id: cmd.project_id.clone(),
        });
    }
    changes.push(NodeChange::ForecastPersonAdded {
        project_id: cmd.project_id.clone(),
        person,
    });

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

fn apply_update_forecast_person(
    tx: &mut Transaction,
    cmd: UpdateForecastPersonCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    let project_revision: Option<i64> = tx
        .query_row(
            "SELECT revision FROM projects WHERE id = ?1",
            rusqlite::params![cmd.project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;

    let current_revision = match project_revision {
        Some(rev) => rev,
        None => return Err(project_not_found(&cmd.command_id, &cmd.project_id)),
    };
    if current_revision != cmd.base_revision {
        return Err(revision_conflict(&cmd.command_id, &cmd.project_id, current_revision));
    }

    if cmd.person_id.trim().is_empty()
        || cmd.name.trim().is_empty()
        || cmd.weight_units <= 0
    {
        return Err(rejected(
            &cmd.command_id,
            "FORECAST_PERSON_INVALID",
            None,
            Some(&cmd.project_id),
            None,
        ));
    }

    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let mut roster: Vec<ForecastPersonDto> = match stored_plan {
        Some(p) => p.roster,
        None => {
            return Err(rejected(
                &cmd.command_id,
                "FORECAST_PERSON_NOT_FOUND",
                None,
                Some(&cmd.project_id),
                None,
            ));
        }
    };

    let idx = match roster.iter().position(|p| p.id == cmd.person_id) {
        Some(i) => i,
        None => {
            return Err(rejected(
                &cmd.command_id,
                "FORECAST_PERSON_NOT_FOUND",
                None,
                Some(&cmd.project_id),
                None,
            ))
        }
    };

    let prior_name = roster[idx].name.clone();
    let prior_weight_units = roster[idx].weight_units;
    roster[idx].name = cmd.name.trim().to_string();
    roster[idx].weight_units = cmd.weight_units;

    tx.execute(
        "UPDATE forecast_plans SET roster = ?1 WHERE project_id = ?2",
        rusqlite::params![
            serde_json::to_string(&roster).unwrap_or_else(|_| "[]".to_string()),
            cmd.project_id,
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    tx.execute(
        "UPDATE projects SET revision = ?1 WHERE id = ?2",
        rusqlite::params![cmd.expected_revision, cmd.project_id],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let changes = vec![NodeChange::ForecastPersonUpdated {
        project_id: cmd.project_id.clone(),
        person_id: cmd.person_id.clone(),
        name: cmd.name.trim().to_string(),
        weight_units: cmd.weight_units,
        prior_name,
        prior_weight_units,
    }];

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

fn apply_remove_forecast_person(
    tx: &mut Transaction,
    cmd: RemoveForecastPersonCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let (prior_roster, prior_assignments) = match stored_plan {
        Some(p) => (p.roster, p.assignments),
        None => (Vec::new(), HashMap::new()),
    };

    let existing = match prior_roster.iter().find(|p| p.id == cmd.person_id) {
        Some(p) => p.clone(),
        None => {
            return Err(rejected(
                &cmd.command_id,
                "FORECAST_PERSON_NOT_FOUND",
                None,
                Some(&cmd.project_id),
                None,
            ))
        }
    };

    let next_roster: Vec<ForecastPersonDto> = prior_roster
        .into_iter()
        .filter(|p| p.id != cmd.person_id)
        .collect();

    let mut next_assignments: HashMap<String, Vec<String>> = HashMap::new();
    for (f_id, p_list) in &prior_assignments {
        let filtered: Vec<String> = p_list.iter().filter(|id| *id != &cmd.person_id).cloned().collect();
        if !filtered.is_empty() {
            next_assignments.insert(f_id.clone(), filtered);
        }
    }

    tx.execute(
        "UPDATE forecast_plans SET roster = ?1, assignments = ?2 WHERE project_id = ?3",
        rusqlite::params![
            serde_json::to_string(&next_roster).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&next_assignments).unwrap_or_else(|_| "{}".to_string()),
            cmd.project_id,
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let changes = vec![NodeChange::ForecastPersonRemoved {
        project_id: cmd.project_id.clone(),
        person: existing,
        prior_assignments: Some(prior_assignments),
    }];

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

fn apply_restore_forecast_person(
    tx: &mut Transaction,
    cmd: RestoreForecastPersonCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    if cmd.person.id.trim().is_empty()
        || cmd.person.name.trim().is_empty()
        || cmd.person.weight_units <= 0
    {
        return Err(rejected(
            &cmd.command_id,
            "FORECAST_PERSON_INVALID",
            None,
            Some(&cmd.project_id),
            None,
        ));
    }

    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let had_prior = stored_plan.is_some();
    let (mut roster, prior_assignments) = match stored_plan {
        Some(p) => (p.roster, p.assignments),
        None => (Vec::new(), HashMap::new()),
    };
    let next_assignments = cmd.assignments.clone().unwrap_or_else(|| prior_assignments.clone());

    if roster.iter().any(|p| p.id == cmd.person.id) {
        return Err(rejected(
            &cmd.command_id,
            "FORECAST_PERSON_EXISTS",
            None,
            Some(&cmd.project_id),
            None,
        ));
    }

    let restored_person = ForecastPersonDto {
        id: cmd.person.id.clone(),
        name: cmd.person.name.trim().to_string(),
        weight_units: cmd.person.weight_units,
    };
    roster.push(restored_person.clone());

    if !had_prior {
        tx.execute(
            "INSERT INTO forecast_plans(
                project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
                sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version, planning_level, roster, assignments
             ) VALUES(?1, '[]', '[]', '[]', NULL, NULL, 'fixed-contiguous', NULL, NULL, 'shared-capacity-v1', 'Feature', ?2, ?3)",
            rusqlite::params![
                cmd.project_id,
                serde_json::to_string(&roster).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&next_assignments).unwrap_or_else(|_| "{}".to_string()),
            ],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    } else {
        tx.execute(
            "UPDATE forecast_plans SET roster = ?1, assignments = ?2 WHERE project_id = ?3",
            rusqlite::params![
                serde_json::to_string(&roster).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&next_assignments).unwrap_or_else(|_| "{}".to_string()),
                cmd.project_id,
            ],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    }

    let mut changes = Vec::new();
    if !had_prior {
        changes.push(NodeChange::ForecastPlanCreated {
            project_id: cmd.project_id.clone(),
        });
    }
    changes.push(NodeChange::ForecastPersonRestored {
        project_id: cmd.project_id.clone(),
        person: restored_person,
        assignments: cmd.assignments,
    });

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

// ── Epic 22: SetForecastAssignments / SetForecastPolicy (Story 22.4) ────────
fn apply_set_forecast_assignments(
    tx: &mut Transaction,
    cmd: SetForecastAssignmentsCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let Some(plan) = stored_plan else {
        return Err(rejected(&cmd.command_id, "FORECAST_SCOPE_INVALID", None, Some(&cmd.project_id), Some(&cmd.feature_id)));
    };

    if !plan.selected_feature_ids.contains(&cmd.feature_id) {
        return Err(rejected(&cmd.command_id, "FORECAST_SCOPE_INVALID", None, Some(&cmd.project_id), Some(&cmd.feature_id)));
    }

    let parallel_groups = plan.parallel_groups;
    let roster = plan.roster;
    let mut assignments = plan.assignments;
    let policy_version = plan.policy_version;

    let node_effort: Option<Option<i64>> = tx
        .query_row(
            "SELECT effort_points FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.feature_id, cmd.project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;

    let Some(effort_points) = node_effort else {
        return Err(rejected(&cmd.command_id, "FORECAST_SCOPE_INVALID", None, Some(&cmd.project_id), Some(&cmd.feature_id)));
    };

    if effort_points == Some(0) && !cmd.person_ids.is_empty() {
        return Err(forecast_assignment_zero_work(&cmd.command_id, &cmd.feature_id));
    }

    let mut seen_pids = std::collections::HashSet::new();
    for pid in &cmd.person_ids {
        if !seen_pids.insert(pid) {
            return Err(rejected(&cmd.command_id, "FORECAST_ASSIGNMENT_INVALID", None, Some(&cmd.project_id), None));
        }
    }

    let roster_pids: std::collections::HashSet<&str> = roster.iter().map(|p| p.id.as_str()).collect();
    for pid in &cmd.person_ids {
        if !roster_pids.contains(pid.as_str()) {
            return Err(forecast_assignment_invalid_person(&cmd.command_id, pid));
        }
    }

    let prior_person_ids = assignments.get(&cmd.feature_id).cloned().unwrap_or_default();
    if cmd.person_ids.is_empty() {
        assignments.remove(&cmd.feature_id);
    } else {
        assignments.insert(cmd.feature_id.clone(), cmd.person_ids.clone());
    }

    if policy_version == "staffed-capacity-v1" {
        if let Some((conflict_person, conflicting_features)) = find_staffing_concurrency_conflict(
            tx,
            &cmd.project_id,
            &parallel_groups,
            &assignments,
            &roster,
        )? {
            return Err(forecast_assignment_conflict(&cmd.command_id, &conflict_person, conflicting_features));
        }
    }

    tx.execute(
        "UPDATE forecast_plans SET assignments = ?1 WHERE project_id = ?2",
        rusqlite::params![
            serde_json::to_string(&assignments).unwrap_or_else(|_| "{}".to_string()),
            cmd.project_id,
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let changes = vec![NodeChange::ForecastAssignmentsSet {
        project_id: cmd.project_id.clone(),
        feature_id: cmd.feature_id,
        person_ids: cmd.person_ids,
        prior_person_ids,
    }];

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

fn apply_set_forecast_assignment(
    tx: &mut Transaction,
    cmd: SetForecastAssignmentCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let Some(plan) = stored_plan else {
        return Err(rejected(&cmd.command_id, "FORECAST_SCOPE_INVALID", None, Some(&cmd.project_id), Some(&cmd.feature_id)));
    };

    if !plan.selected_feature_ids.contains(&cmd.feature_id) {
        return Err(rejected(&cmd.command_id, "FORECAST_SCOPE_INVALID", None, Some(&cmd.project_id), Some(&cmd.feature_id)));
    }

    let parallel_groups = plan.parallel_groups;
    let roster = plan.roster;
    let mut assignments = plan.assignments;
    let policy_version = plan.policy_version;

    let node_effort: Option<Option<i64>> = tx
        .query_row(
            "SELECT effort_points FROM nodes WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![cmd.feature_id, cmd.project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal_rejection(&cmd.command_id))?;

    let Some(effort) = node_effort else {
        return Err(rejected(&cmd.command_id, "FORECAST_SCOPE_INVALID", None, Some(&cmd.project_id), Some(&cmd.feature_id)));
    };

    if !roster.iter().any(|p| p.id == cmd.person_id) {
        return Err(forecast_assignment_invalid_person(&cmd.command_id, &cmd.person_id));
    }

    let prior_person_ids = assignments.get(&cmd.feature_id).cloned().unwrap_or_default();
    let is_assigned = prior_person_ids.contains(&cmd.person_id);
    if cmd.assigned == is_assigned {
        return Err(rejected(&cmd.command_id, "FORECAST_ASSIGNMENT_INVALID", None, Some(&cmd.project_id), None));
    }
    if cmd.assigned && effort == Some(0) {
        return Err(forecast_assignment_zero_work(&cmd.command_id, &cmd.feature_id));
    }

    let next_person_ids: Vec<String> = if cmd.assigned {
        let mut ids = prior_person_ids.clone();
        ids.push(cmd.person_id.clone());
        ids
    } else {
        prior_person_ids.iter().filter(|id| *id != &cmd.person_id).cloned().collect()
    };

    if next_person_ids.is_empty() {
        assignments.remove(&cmd.feature_id);
    } else {
        assignments.insert(cmd.feature_id.clone(), next_person_ids.clone());
    }

    if policy_version == "staffed-capacity-v1" {
        if let Some((conflict_person, conflicting_features)) = find_staffing_concurrency_conflict(
            tx,
            &cmd.project_id,
            &parallel_groups,
            &assignments,
            &roster,
        )? {
            return Err(forecast_assignment_conflict(&cmd.command_id, &conflict_person, conflicting_features));
        }
    }

    tx.execute(
        "UPDATE forecast_plans SET assignments = ?1 WHERE project_id = ?2",
        rusqlite::params![
            serde_json::to_string(&assignments).unwrap_or_else(|_| "{}".to_string()),
            cmd.project_id,
        ],
    )
    .map_err(|_| internal_rejection(&cmd.command_id))?;

    let changes = vec![NodeChange::ForecastAssignmentsSet {
        project_id: cmd.project_id.clone(),
        feature_id: cmd.feature_id,
        person_ids: next_person_ids,
        prior_person_ids,
    }];

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

fn apply_set_forecast_policy(
    tx: &mut Transaction,
    cmd: SetForecastPolicyCommand,
) -> Result<ProductCommandResult, ProductCommandResult> {
    if cmd.policy_version != "shared-capacity-v1" && cmd.policy_version != "staffed-capacity-v1" {
        return Err(rejected(&cmd.command_id, "FORECAST_POLICY_INVALID", None, Some(&cmd.project_id), None));
    }

    let stored_plan = read_stored_forecast_plan(tx, &cmd.project_id, &cmd.command_id)?;
    let had_prior = stored_plan.is_some();
    let (prior_policy, parallel_groups, assignments, roster) = match stored_plan {
        Some(p) => (p.policy_version, p.parallel_groups, p.assignments, p.roster),
        None => (
            "shared-capacity-v1".to_string(),
            Vec::new(),
            HashMap::new(),
            Vec::new(),
        ),
    };

    if prior_policy == cmd.policy_version {
        return Err(rejected(&cmd.command_id, "FORECAST_POLICY_INVALID", None, Some(&cmd.project_id), None));
    }

    if cmd.policy_version == "staffed-capacity-v1" && had_prior {
        if let Some((conflict_person, conflicting_features)) = find_staffing_concurrency_conflict(
            tx,
            &cmd.project_id,
            &parallel_groups,
            &assignments,
            &roster,
        )? {
            return Err(forecast_assignment_conflict(&cmd.command_id, &conflict_person, conflicting_features));
        }
    }

    if !had_prior {
        tx.execute(
            "INSERT INTO forecast_plans(
                project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
                sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version
             ) VALUES(?1, '[]', '[]', '[]', NULL, NULL, 'fixed-contiguous', NULL, NULL, ?2)",
            rusqlite::params![cmd.project_id, cmd.policy_version],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    } else {
        tx.execute(
            "UPDATE forecast_plans SET policy_version = ?1 WHERE project_id = ?2",
            rusqlite::params![cmd.policy_version, cmd.project_id],
        )
        .map_err(|_| internal_rejection(&cmd.command_id))?;
    }

    let mut changes = Vec::new();
    if !had_prior {
        changes.push(NodeChange::ForecastPlanCreated {
            project_id: cmd.project_id.clone(),
        });
    }
    changes.push(NodeChange::ForecastPolicySet {
        project_id: cmd.project_id.clone(),
        policy_version: cmd.policy_version,
        prior_policy_version: prior_policy,
    });

    Ok(applied(
        &cmd.command_id,
        &cmd.project_id,
        cmd.base_revision,
        cmd.expected_revision,
        Some(change_set(&cmd.project_id, cmd.base_revision, cmd.expected_revision, changes)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    

    const PROJECT_ID: &str = "0198a000-0000-7000-8000-000000000002";
    #[test]
    fn sprint_plan_canonicalizes_like_the_browser() {
        use serde_json::json;
        let a = "0198a000-0000-7000-8000-00000000000a";
        let b = "0198a000-0000-7000-8000-00000000000b";
        let canonical = canonical_sprint_plan(&json!({
            "placements": [{ "itemId": a, "sprint": 3 }, { "itemId": b, "sprint": 2 }, { "itemId": a, "sprint": 4 }],
            "capacities": { "10": 5, "2": 0 }
        }))
        .unwrap();
        assert_eq!(canonical["placements"], json!([{ "itemId": b, "sprint": 2 }, { "itemId": a, "sprint": 4 }]));
        assert_eq!(canonical["capacities"], json!({ "2": 0, "10": 5 }));
        assert_eq!(canonical_sprint_plan(&json!({})).unwrap(), json!({ "placements": [], "capacities": {} }));
        for bad in [
            json!([]),
            json!({ "placements": [{ "itemId": "nope", "sprint": 1 }] }),
            json!({ "placements": [{ "itemId": a, "sprint": 0 }] }),
            json!({ "capacities": { "01": 3 } }),
            json!({ "capacities": { "2": -1 } }),
            json!({ "other": 1 }),
        ] {
            assert!(canonical_sprint_plan(&bad).is_none(), "{bad}");
        }
    }

    const COMMAND_ID: &str = "0198a000-0000-7000-8000-000000000001";
    const NODE_ID: &str = "0198a000-0000-7000-8000-000000000003";

    #[test]
    fn shared_stale_client_base_retains_authoritative_receipt_cut() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        apply(&mut conn, create_project_cmd()).unwrap();
        conn.execute("UPDATE projects SET revision = 8 WHERE id = ?1", [PROJECT_ID]).unwrap();
        let result = apply_shared_with_capture(
            &mut conn,
            create_node_cmd("0198a000-0000-7000-8000-000000000004"),
            |tx| project_revision(tx, PROJECT_ID),
            |tx, before, id, revision| {
                assert_eq!(before, Some(8));
                assert_eq!(revision, 9);
                let receipt: String = tx.query_row(
                    "SELECT result_json FROM product_command_receipt WHERE command_id = ?1",
                    [id], |row| row.get(0),
                ).unwrap();
                let ProductCommandResult::ProductCommandApplied(applied) =
                    serde_json::from_str(&receipt).unwrap() else { panic!("applied receipt"); };
                assert_eq!((applied.base_revision, applied.target_revision), (8, 9));
                let changes = applied.change_set.unwrap();
                assert_eq!((changes.base_revision, changes.target_revision), (8, 9));
                Ok(())
            },
        ).unwrap();
        let ProductCommandResult::ProductCommandApplied(applied) = result else { panic!("applied result"); };
        assert_eq!((applied.base_revision, applied.target_revision), (8, 9));
        let stored_base: i64 = conn.query_row(
            "SELECT base_revision FROM product_command_receipt WHERE command_id = ?1",
            ["0198a000-0000-7000-8000-000000000004"], |row| row.get(0),
        ).unwrap();
        assert_eq!(stored_base, 1, "immutable original command binding");
    }

    fn create_project_cmd() -> ProductCommand {
        ProductCommand::CreateProject(CreateProjectCommand {
            type_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: COMMAND_ID.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 0,
            expected_revision: 1,
            actor_id: None,
            name: "Test Project".to_string(),
        })
    }

    fn create_node_cmd(command_id: &str) -> ProductCommand {
        ProductCommand::CreateNode(CreateNodeCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 1,
            expected_revision: 2,
            actor_id: None,
            node_id: NODE_ID.to_string(),
            parent_id: None,
            position: "4294967296".to_string(),
            title: "Root".to_string(),
        })
    }

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        initialize_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn composite_rejection_rolls_back_nodes_receipts_and_revision() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let first_id = "0198a000-0000-7000-8000-000000000010";
        let invalid = ProductCommand::SetNodeTitle(SetNodeTitleCommand {
            command_name: String::new(), protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "0198a000-0000-7000-8000-000000000011".to_string(),
            project_id: PROJECT_ID.to_string(), base_revision: 2, expected_revision: 3,
            actor_id: None, node_id: "0198a000-0000-7000-8000-000000000099".to_string(),
            title: "Unapplied".to_string(),
        });
        let results = apply_batch(&mut conn, vec![create_node_cmd(first_id), invalid]).unwrap();
        assert!(matches!(&results[0], ProductCommandResult::ProductCommandRejected(_)));
        assert_eq!(project_revision(&conn, PROJECT_ID).unwrap(), Some(1));
        let nodes: i64 = conn.query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0)).unwrap();
        let receipts: i64 = conn.query_row("SELECT COUNT(*) FROM product_command_receipt WHERE command_id = ?1", [first_id], |row| row.get(0)).unwrap();
        assert_eq!(nodes, 0);
        assert_eq!(receipts, 0);
        assert!(matches!(apply(&mut conn, create_node_cmd(first_id)).unwrap(), ProductCommandResult::ProductCommandApplied(_)));
    }

    #[test]
    fn plain_edit_on_a_shared_project_is_refused_without_writing() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        conn.execute("INSERT INTO collaboration_cursor(project_id, cursor) VALUES(?1, 1)", [PROJECT_ID]).unwrap();
        let node_id = "0198a000-0000-7000-8000-000000000013";
        let result = apply(&mut conn, create_node_cmd(node_id)).unwrap();
        assert_eq!(serde_json::to_value(&result).unwrap()["code"], "SHARED_PROJECT_NOT_CONNECTED");
        let nodes: i64 = conn.query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0)).unwrap();
        assert_eq!(nodes, 0);
        assert_eq!(project_revision(&conn, PROJECT_ID).unwrap(), Some(1));
    }

    #[test]
    fn composite_on_synced_project_is_refused_whole() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        conn.execute("INSERT INTO collaboration_cursor(project_id, cursor) VALUES(?1, 1)", [PROJECT_ID]).unwrap();
        let first_id = "0198a000-0000-7000-8000-000000000012";
        let results = apply_batch(&mut conn, vec![create_node_cmd(first_id)]).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(serde_json::to_value(&results[0]).unwrap()["code"], "SHARED_ATOMIC_GROUP_UNAVAILABLE");
        assert_eq!(project_revision(&conn, PROJECT_ID).unwrap(), Some(1));
        let nodes: i64 = conn.query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0)).unwrap();
        assert_eq!(nodes, 0);
    }

    #[test]
    fn applies_create_project_and_advances_revision() {
        let mut conn = setup();
        let result = apply(&mut conn, create_project_cmd()).unwrap();
        match result {
            ProductCommandResult::ProductCommandApplied(a) => {
                assert_eq!(a.outcome, "VfsCommitAccepted");
                assert_eq!(a.target_revision, 1);
                assert_eq!(a.disposition, "NewCommit");
            }
            _ => panic!("expected applied"),
        }
        let revision = project_revision(&conn, PROJECT_ID).unwrap().unwrap();
        assert_eq!(revision, 1);
        let receipt_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM product_command_receipt", [], |r| r.get(0))
            .unwrap();
        assert_eq!(receipt_count, 1);
    }

    #[test]
    fn duplicate_command_id_replays_stored_result_without_mutation() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        // Duplicate same commandId.
        let dup = apply(&mut conn, create_project_cmd()).unwrap();
        match dup {
            ProductCommandResult::ProductCommandApplied(a) => {
                assert_eq!(a.disposition, "StoredResultReturned");
                assert_eq!(a.target_revision, 1);
            }
            _ => panic!("expected replay"),
        }
        let receipt_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM product_command_receipt", [], |r| r.get(0))
            .unwrap();
        assert_eq!(receipt_count, 1, "receipt must not be duplicated");
        let revision = project_revision(&conn, PROJECT_ID).unwrap().unwrap();
        assert_eq!(revision, 1, "revision must not advance");
    }

    #[test]
    fn stale_base_revision_returns_revision_conflict_without_mutation() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        // Project is at revision 1; send a command claiming base revision 0.
        let stale = ProductCommand::CreateNode(CreateNodeCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "0198a000-0000-7000-8000-000000000005".to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 0,
            expected_revision: 1,
            actor_id: None,
            node_id: NODE_ID.to_string(),
            parent_id: None,
            position: "4294967296".to_string(),
            title: "Root".to_string(),
        });
        let result = apply(&mut conn, stale).unwrap();
        match result {
            ProductCommandResult::ProductCommandRejected(r) => {
                assert_eq!(r.code, "REVISION_CONFLICT");
                assert_eq!(r.expected_revision, Some(1));
            }
            _ => panic!("expected conflict"),
        }
        let node_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM nodes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(node_count, 0, "no partial mutation");
        let receipt_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM product_command_receipt", [], |r| r.get(0))
            .unwrap();
        assert_eq!(receipt_count, 1);
    }

    #[test]
    fn applies_create_node_with_revision_advance_and_change_set() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let result = apply(&mut conn, create_node_cmd("0198a000-0000-7000-8000-000000000004")).unwrap();
        match result {
            ProductCommandResult::ProductCommandApplied(a) => {
                assert_eq!(a.target_revision, 2);
                let cs = a.change_set.as_ref().unwrap();
                assert_eq!(cs.changes.len(), 1);
                assert!(matches!(cs.changes[0], NodeChange::NodeCreated { .. }));
            }
            _ => panic!("expected applied"),
        }
        let revision = project_revision(&conn, PROJECT_ID).unwrap().unwrap();
        assert_eq!(revision, 2);
    }

    #[test]
    fn invalid_protocol_version_rejected_before_mutation() {
        let mut conn = setup();
        let mut cmd = create_project_cmd();
        match &mut cmd {
            ProductCommand::CreateProject(c) => c.protocol_version = "9.9.9".to_string(),
            _ => unreachable!(),
        }
        let err = apply(&mut conn, cmd).unwrap_err();
        assert_eq!(err, RepositoryError::InvalidRequest);
        let project_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(project_count, 0);
    }

    fn set_node_status_cmd(command_id: &str, base_revision: i64, status: &str) -> ProductCommand {
        ProductCommand::SetNodeStatus(SetNodeStatusCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision,
            expected_revision: base_revision + 1,
            actor_id: None,
            node_id: NODE_ID.to_string(),
            delivery_status: status.to_string(),
        })
    }

    #[test]
    fn applies_set_node_status_with_change_set() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        apply(&mut conn, create_node_cmd("0198a000-0000-7000-8000-000000000004")).unwrap();

        let result = apply(
            &mut conn,
            set_node_status_cmd("0198a000-0000-7000-8000-000000000006", 2, "in_progress"),
        )
        .unwrap();
        match result {
            ProductCommandResult::ProductCommandApplied(a) => {
                assert_eq!(a.target_revision, 3);
                let cs = a.change_set.as_ref().unwrap();
                assert!(matches!(
                    &cs.changes[0],
                    NodeChange::NodeStatusSet { delivery_status, prior_delivery_status, .. }
                        if delivery_status == "in_progress" && prior_delivery_status == "not_started"
                ));
            }
            _ => panic!("expected applied"),
        }

        let stored: Option<String> = conn
            .query_row(
                "SELECT delivery_status FROM nodes WHERE id = ?1",
                [NODE_ID],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored.as_deref(), Some("in_progress"));
    }

    #[test]
    fn set_node_status_on_missing_node_rejects() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();

        let result = apply(
            &mut conn,
            set_node_status_cmd("0198a000-0000-7000-8000-000000000007", 1, "delivered"),
        )
        .unwrap();
        match result {
            ProductCommandResult::ProductCommandRejected(r) => assert_eq!(r.code, "NODE_NOT_FOUND"),
            _ => panic!("expected rejection"),
        }
    }

    #[test]
    fn set_node_status_rejects_an_unrecognised_value() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        apply(&mut conn, create_node_cmd("0198a000-0000-7000-8000-000000000008")).unwrap();

        let result = apply(
            &mut conn,
            set_node_status_cmd("0198a000-0000-7000-8000-000000000009", 2, "shipped"),
        )
        .unwrap();
        assert!(matches!(
            result,
            ProductCommandResult::ProductCommandRejected(_)
        ));
    }

    // ── Epic 18 forecast handler parity (review 2026-09-06) ───────────────

    fn configure_forecast_cmd(
        command_id: &str,
        base_revision: i64,
        points: Option<i64>,
        length: Option<i64>,
        ordinal: Option<i64>,
        date: Option<&str>,
    ) -> ProductCommand {
        configure_forecast_cmd_with_level(command_id, base_revision, points, length, ordinal, date, None)
    }

    fn configure_forecast_cmd_with_level(
        command_id: &str,
        base_revision: i64,
        points: Option<i64>,
        length: Option<i64>,
        ordinal: Option<i64>,
        date: Option<&str>,
        level: Option<&str>,
    ) -> ProductCommand {
        ProductCommand::ConfigureForecastPlan(ConfigureForecastPlanCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision,
            expected_revision: base_revision + 1,
            actor_id: None,
            points_per_sprint: points,
            sprint_length_days: length,
            start_sprint_ordinal: ordinal,
            start_date: date.map(|s| s.to_string()),
            planning_level: level.map(|s| s.to_string()),
        })
    }

    fn create_typed_feature(command_id: &str, node_id: &str, parent: Option<&str>, base: i64) -> [ProductCommand; 2] {
        [
            ProductCommand::CreateNode(CreateNodeCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: command_id.to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: base,
                expected_revision: base + 1,
                actor_id: None,
                node_id: node_id.to_string(),
                parent_id: parent.map(|s| s.to_string()),
                position: "4294967296".to_string(),
                title: "F".to_string(),
            }),
            ProductCommand::SetNodeType(SetNodeTypeCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: format!("{command_id}a"),
                project_id: PROJECT_ID.to_string(),
                base_revision: base + 1,
                expected_revision: base + 2,
                actor_id: None,
                node_id: node_id.to_string(),
                node_type: Some("Feature".to_string()),
            }),
        ]
    }

    fn membership_cmd(command_id: &str, base: i64, feature_id: &str, included: bool) -> ProductCommand {
        ProductCommand::SetForecastMembership(SetForecastMembershipCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            feature_id: feature_id.to_string(),
            included,
        })
    }

    fn blocker_cmd(command_id: &str, base: i64, feature_id: &str, blocked: bool) -> ProductCommand {
        ProductCommand::SetForecastBlocker(SetForecastBlockerCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            feature_id: feature_id.to_string(),
            blocked,
        })
    }

    // ── Epic 20: SetForecastBlocker handler parity (Story 20.1) ──────────

    #[test]
    fn set_forecast_blocker_marks_clears_and_survives_reload() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let f = "0198a000-0000-7000-8000-00000000ab01";
        for cmd in create_typed_feature("0198a000-0000-7000-8000-00000000ab02", f, None, 1) {
            apply(&mut conn, cmd).unwrap();
        }
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-00000000ab03", 3, f, true)).unwrap();

        let marked = apply(&mut conn, blocker_cmd("0198a000-0000-7000-8000-00000000ab04", 4, f, true)).unwrap();
        match marked {
            ProductCommandResult::ProductCommandApplied(a) => {
                let cs = a.change_set.as_ref().unwrap();
                assert!(matches!(&cs.changes[0], NodeChange::ForecastBlockerSet { feature_id, blocked, prior_blocked }
                    if feature_id == f && *blocked && !*prior_blocked));
            }
            _ => panic!("expected applied"),
        }
        let stored: String = conn
            .query_row("SELECT blocked_feature_ids FROM forecast_plans WHERE project_id = ?1", [PROJECT_ID], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, format!("[\"{f}\"]"));

        apply(&mut conn, blocker_cmd("0198a000-0000-7000-8000-00000000ab05", 5, f, false)).unwrap();
        let after: String = conn
            .query_row("SELECT blocked_feature_ids FROM forecast_plans WHERE project_id = ?1", [PROJECT_ID], |r| r.get(0))
            .unwrap();
        assert_eq!(after, "[]");
    }

    #[test]
    fn set_forecast_blocker_rejects_non_member_and_redundant_state() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let f = "0198a000-0000-7000-8000-00000000ac01";
        for cmd in create_typed_feature("0198a000-0000-7000-8000-00000000ac02", f, None, 1) {
            apply(&mut conn, cmd).unwrap();
        }
        // Not in scope → FORECAST_SCOPE_INVALID.
        let ghost = apply(&mut conn, blocker_cmd("0198a000-0000-7000-8000-00000000ac03", 3, f, true)).unwrap();
        assert!(matches!(ghost, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_SCOPE_INVALID"));

        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-00000000ac04", 3, f, true)).unwrap();
        apply(&mut conn, blocker_cmd("0198a000-0000-7000-8000-00000000ac05", 4, f, true)).unwrap();
        // Already blocked → FORECAST_BLOCKER_INVALID.
        let again = apply(&mut conn, blocker_cmd("0198a000-0000-7000-8000-00000000ac06", 5, f, true)).unwrap();
        assert!(matches!(again, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_BLOCKER_INVALID"));
    }

    // ── Epic 20: Forecast scenario handler parity (Story 20.4) ──────────

    #[test]
    fn create_remove_restore_forecast_scenario_round_trips_verbatim() {
      for level in ["Feature", "Theme", "Component"] {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let f = "0198a000-0000-7000-8000-00000000ce01";
        for cmd in create_typed_feature("0198a000-0000-7000-8000-00000000ce02", f, None, 1) {
            apply(&mut conn, cmd).unwrap();
        }
        apply(&mut conn, configure_forecast_cmd("0198a000-0000-7000-8000-00000000ce03", 3, Some(10), Some(14), Some(1), Some("2026-09-07"))).unwrap();
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-00000000ce04", 4, f, true)).unwrap();
        conn.execute("UPDATE nodes SET node_type = ?1, effort_points = 20 WHERE id = ?2", rusqlite::params![level, f]).unwrap();
        conn.execute("UPDATE forecast_plans SET planning_level = ?1 WHERE project_id = ?2", rusqlite::params![level, PROJECT_ID]).unwrap();

        let material = serde_json::json!({
            "policyVersion": "shared-capacity-v1",
            "selectedFeatureIds": [f],
            "estimates": { (f): 20 },
            "pointsPerSprint": 10,
            "sprintLengthDays": 14,
            "startSprintOrdinal": 1,
            "startDate": "2026-09-07",
            "parallelGroups": [],
            "blockedFeatureIds": [],
        });
        let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&material).unwrap()));

        let scenario_id = "0198a000-0000-7000-8000-00000000ce05";
        let create = ProductCommand::CreateForecastScenario(CreateForecastScenarioCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "0198a000-0000-7000-8000-00000000ce06".to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 5,
            expected_revision: 6,
            actor_id: None,
            scenario_id: scenario_id.to_string(),
            label: "Native scenario".to_string(),
            baseline_revision: 5,
            expected_material_fingerprint: fingerprint,
            created_at_iso: "2026-09-08T00:00:00.000Z".to_string(),
            patch: serde_json::json!({ "pointsPerSprint": 20 }),
        });
        let res = apply(&mut conn, create.clone()).unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandApplied(_)));
        let replay = apply(&mut conn, create.clone()).unwrap();
        assert!(matches!(replay, ProductCommandResult::ProductCommandApplied(ref a) if a.disposition == "StoredResultReturned"));
        let mut changed = create;
        if let ProductCommand::CreateForecastScenario(ref mut command) = changed { command.label = "Changed".to_string(); }
        let conflict = apply(&mut conn, changed).unwrap();
        assert!(matches!(conflict, ProductCommandResult::ProductCommandRejected(ref r) if r.code == "COMMAND_IDENTITY_CONFLICT"));

        let (label, baseline_json, patch_json): (String, String, String) = conn
            .query_row(
                "SELECT label, baseline_json, patch_json FROM forecast_scenarios WHERE scenario_id = ?1",
                [scenario_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(label, "Native scenario");
        assert!(baseline_json.contains("factMap"));
        let baseline: serde_json::Value = serde_json::from_str(&baseline_json).unwrap();
        assert_eq!(baseline["planningLevel"], level);
        assert_eq!(baseline["factMap"][f]["nodeType"], level);
        assert_eq!(baseline["factMap"][f]["effortPoints"], 20);
        assert_eq!(patch_json, "{\"pointsPerSprint\":20}");

        // Remove then restore — the row returns byte-identical.
        let remove = ProductCommand::RemoveForecastScenario(RemoveForecastScenarioCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "0198a000-0000-7000-8000-00000000ce07".to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 6,
            expected_revision: 7,
            actor_id: None,
            scenario_id: scenario_id.to_string(),
        });
        let removed = apply(&mut conn, remove).unwrap();
        let removed_scenario = match removed {
            ProductCommandResult::ProductCommandApplied(a) => match &a.change_set.as_ref().unwrap().changes[0] {
                NodeChange::ForecastScenarioRemoved { scenario, .. } => scenario.clone(),
                _ => panic!("expected ForecastScenarioRemoved"),
            },
            _ => panic!("expected applied"),
        };
        let count: i64 = conn.query_row("SELECT COUNT(1) FROM forecast_scenarios", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);

        let restore = ProductCommand::RestoreForecastScenario(RestoreForecastScenarioCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "0198a000-0000-7000-8000-00000000ce08".to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 7,
            expected_revision: 8,
            actor_id: None,
            scenario: removed_scenario.clone(),
        });
        apply(&mut conn, restore).unwrap();
        let (rlabel, rpatch): (String, String) = conn
            .query_row("SELECT label, patch_json FROM forecast_scenarios WHERE scenario_id = ?1", [scenario_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(rlabel, "Native scenario");
        assert_eq!(rpatch, "{\"pointsPerSprint\":20}");
      }
    }

    #[test]
    fn create_forecast_scenario_rejects_a_stale_preview() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        // Live revision is 1; a preview taken at revision 5 is stale.
        let create = ProductCommand::CreateForecastScenario(CreateForecastScenarioCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "0198a000-0000-7000-8000-00000000cf01".to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 1,
            expected_revision: 2,
            actor_id: None,
            scenario_id: "0198a000-0000-7000-8000-00000000cf02".to_string(),
            label: "Stale".to_string(),
            baseline_revision: 5,
            expected_material_fingerprint: "0".repeat(64),
            created_at_iso: "2026-09-08T00:00:00.000Z".to_string(),
            patch: serde_json::json!({}),
        });
        let res = apply(&mut conn, create).unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_SCENARIO_STALE"));
    }

    #[test]
    fn excluding_a_blocked_feature_clears_the_blocker_atomically() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let a = "0198a000-0000-7000-8000-00000000ad01";
        let b = "0198a000-0000-7000-8000-00000000ad03";
        for cmd in create_typed_feature("0198a000-0000-7000-8000-00000000ad02", a, None, 1) {
            apply(&mut conn, cmd).unwrap();
        }
        for cmd in create_typed_feature("0198a000-0000-7000-8000-00000000ad04", b, None, 3) {
            apply(&mut conn, cmd).unwrap();
        }
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-00000000ad05", 5, a, true)).unwrap();
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-00000000ad06", 6, b, true)).unwrap();
        apply(&mut conn, blocker_cmd("0198a000-0000-7000-8000-00000000ad07", 7, a, true)).unwrap();

        let excluded = apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-00000000ad08", 8, a, false)).unwrap();
        match excluded {
            ProductCommandResult::ProductCommandApplied(app) => {
                let cs = app.change_set.as_ref().unwrap();
                assert!(cs.changes.iter().any(|c| matches!(c, NodeChange::ForecastScopeSet { blocked_feature_ids, prior_blocked_feature_ids, .. }
                    if prior_blocked_feature_ids == &vec![a.to_string()] && blocked_feature_ids.is_empty())));
            }
            _ => panic!("expected applied"),
        }
        let stored: String = conn
            .query_row("SELECT blocked_feature_ids FROM forecast_plans WHERE project_id = ?1", [PROJECT_ID], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, "[]");
    }

    #[test]
    fn configure_forecast_plan_rejects_an_impossible_calendar_date() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let res = apply(
            &mut conn,
            configure_forecast_cmd("0198a000-0000-7000-8000-0000000000c1", 1, Some(10), Some(14), Some(12), Some("2026-02-30")),
        )
        .unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_CONFIG_INVALID"));
        let count: i64 = conn
            .query_row("SELECT COUNT(1) FROM forecast_plans", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "no plan row on rejection");
    }

    #[test]
    fn configure_forecast_plan_rejects_negative_capacity() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let res = apply(
            &mut conn,
            configure_forecast_cmd("0198a000-0000-7000-8000-0000000000c2", 1, Some(-5), Some(14), Some(12), Some("2026-09-07")),
        )
        .unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_CONFIG_INVALID"));
    }

    #[test]
    fn configure_forecast_plan_accepts_a_valid_group_and_persists_it() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let res = apply(
            &mut conn,
            configure_forecast_cmd("0198a000-0000-7000-8000-0000000000c3", 1, Some(10), Some(14), Some(12), Some("2026-09-07")),
        )
        .unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandApplied(_)));
        let (points, policy): (Option<i64>, String) = conn
            .query_row(
                "SELECT points_per_sprint, policy_version FROM forecast_plans WHERE project_id = ?1",
                [PROJECT_ID],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(points, Some(10));
        assert_eq!(policy, "shared-capacity-v1");
    }

    // ── Epic 21: atomic plan creation + its removal inverse (Story 21.13 D5) ──

    #[test]
    fn configure_forecast_plan_creation_carries_the_planning_level_atomically() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let res = apply(
            &mut conn,
            configure_forecast_cmd_with_level(
                "0198a000-0000-7000-8000-0000000000c4",
                1,
                Some(10),
                Some(14),
                Some(12),
                Some("2026-09-07"),
                Some("Theme"),
            ),
        )
        .unwrap();
        match res {
            ProductCommandResult::ProductCommandApplied(a) => {
                let changes = a.change_set.as_ref().map(|c| c.changes.as_slice()).unwrap_or(&[]);
                // One command: created + configured + level-set, in order.
                assert_eq!(changes.len(), 3, "creation is one command: {changes:?}");
                assert!(matches!(changes[0], NodeChange::ForecastPlanCreated { .. }));
                assert!(matches!(changes[1], NodeChange::ForecastConfigurationSet { .. }));
                assert!(matches!(
                    changes[2],
                    NodeChange::ForecastPlanningLevelSet { ref planning_level, .. } if planning_level == "Theme"
                ));
            }
            other => panic!("expected applied, got {other:?}"),
        }
        let level: String = conn
            .query_row(
                "SELECT planning_level FROM forecast_plans WHERE project_id = ?1",
                [PROJECT_ID],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(level, "Theme");
    }

    #[test]
    fn configure_forecast_plan_edit_preserves_the_stored_level_and_rejects_invalid_creation_levels() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        apply(
            &mut conn,
            configure_forecast_cmd_with_level(
                "0198a000-0000-7000-8000-0000000000c5",
                1,
                Some(10),
                Some(14),
                Some(12),
                Some("2026-09-07"),
                Some("Theme"),
            ),
        )
        .unwrap();
        // Edit-in-place carries no level — Theme must survive.
        apply(
            &mut conn,
            configure_forecast_cmd("0198a000-0000-7000-8000-0000000000c6", 2, Some(20), Some(14), Some(12), Some("2026-09-07")),
        )
        .unwrap();
        let level: String = conn
            .query_row(
                "SELECT planning_level FROM forecast_plans WHERE project_id = ?1",
                [PROJECT_ID],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(level, "Theme");
    }

    #[test]
    fn configure_forecast_plan_rejects_an_invalid_carried_level_at_creation() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let res = apply(
            &mut conn,
            configure_forecast_cmd_with_level(
                "0198a000-0000-7000-8000-0000000000c7",
                1,
                Some(10),
                Some(14),
                Some(12),
                Some("2026-09-07"),
                Some("Epic"),
            ),
        )
        .unwrap();
        assert!(
            matches!(res, ProductCommandResult::ProductCommandRejected(r) if r.code == "INVALID_PLANNING_LEVEL"),
            "an unknown level must be rejected, not silently coerced"
        );
    }

    #[test]
    fn remove_forecast_plan_deletes_the_row_and_reports_the_removal() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        apply(
            &mut conn,
            configure_forecast_cmd_with_level(
                "0198a000-0000-7000-8000-0000000000c8",
                1,
                Some(10),
                Some(14),
                Some(12),
                Some("2026-09-07"),
                Some("Theme"),
            ),
        )
        .unwrap();
        let res = apply(
            &mut conn,
            ProductCommand::RemoveForecastPlan(RemoveForecastPlanCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "0198a000-0000-7000-8000-0000000000r2".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: 2,
                expected_revision: 3,
                actor_id: None,
            }),
        )
        .unwrap();
        match res {
            ProductCommandResult::ProductCommandApplied(a) => {
                let changes = a.change_set.as_ref().map(|c| c.changes.as_slice()).unwrap_or(&[]);
                assert_eq!(changes.len(), 1);
                assert!(matches!(changes[0], NodeChange::ForecastPlanRemoved { .. }));
            }
            other => panic!("expected applied, got {other:?}"),
        }
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM forecast_plans WHERE project_id = ?1",
                [PROJECT_ID],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "undo of creation removes the plan row entirely");
    }

    #[test]
    fn set_forecast_membership_rejects_parent_descendant_overlap() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let parent = "0198a000-0000-7000-8000-0000000000d1";
        let child = "0198a000-0000-7000-8000-0000000000d2";
        for cmd in create_typed_feature("0198a000-0000-7000-8000-0000000000e1", parent, None, 1) {
            apply(&mut conn, cmd).unwrap();
        }
        for cmd in create_typed_feature("0198a000-0000-7000-8000-0000000000e2", child, Some(parent), 3) {
            apply(&mut conn, cmd).unwrap();
        }
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f1", 5, parent, true)).unwrap();
        let res = apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f2", 6, child, true)).unwrap();
        assert!(
            matches!(res, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_SCOPE_INVALID"),
            "a descendant of a selected Feature must be rejected (AR-4)"
        );
    }

    #[test]
    fn set_forecast_membership_rejects_excluding_a_non_member() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let f = "0198a000-0000-7000-8000-0000000000d9";
        for cmd in create_typed_feature("0198a000-0000-7000-8000-0000000000e9", f, None, 1) {
            apply(&mut conn, cmd).unwrap();
        }
        let res = apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f9", 3, f, false)).unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_SCOPE_INVALID"));
    }

    // ── Epic 19 sequence & parallel group handler parity (Story 19.2) ─────

    fn reorder_forecast_cmd(command_id: &str, base: i64, feature_ids: Vec<&str>) -> ProductCommand {
        ProductCommand::ReorderForecastFeatures(ReorderForecastFeaturesCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            feature_ids: feature_ids.into_iter().map(|s| s.to_string()).collect(),
        })
    }

    fn set_parallel_groups_cmd(command_id: &str, base: i64, groups: Vec<Vec<&str>>) -> ProductCommand {
        ProductCommand::SetForecastParallelGroups(SetForecastParallelGroupsCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            parallel_groups: groups
                .into_iter()
                .map(|f_ids| ParallelGroup {
                    feature_ids: f_ids.into_iter().map(|f| f.to_string()).collect(),
                })
                .collect(),
        })
    }

    fn restore_forecast_scope_cmd(
        command_id: &str,
        base: i64,
        feature_ids: Vec<&str>,
        groups: Vec<Vec<&str>>,
    ) -> ProductCommand {
        ProductCommand::RestoreForecastScope(RestoreForecastScopeCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            selected_feature_ids: feature_ids.into_iter().map(|s| s.to_string()).collect(),
            parallel_groups: groups
                .into_iter()
                .map(|f_ids| ParallelGroup {
                    feature_ids: f_ids.into_iter().map(|f| f.to_string()).collect(),
                })
                .collect(),
            blocked_feature_ids: Vec::new(),
            assignments: None,
        })
    }

    #[test]
    fn reorder_forecast_features_rejects_non_permutation() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let fa = "0198a000-0000-7000-8000-0000000000a1";
        let fb = "0198a000-0000-7000-8000-0000000000a2";
        let fc = "0198a000-0000-7000-8000-0000000000a3";
        for (i, f) in [fa, fb, fc].iter().enumerate() {
            for cmd in create_typed_feature(&format!("0198a000-0000-7000-8000-0000000000e{}", i + 1), f, None, 1 + i as i64 * 2) {
                apply(&mut conn, cmd).unwrap();
            }
        }
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f1", 7, fa, true)).unwrap();
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f2", 8, fb, true)).unwrap();
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f3", 9, fc, true)).unwrap();

        // Missing fc
        let res1 = apply(&mut conn, reorder_forecast_cmd("0198a000-0000-7000-8000-0000000000r1", 10, vec![fa, fb])).unwrap();
        assert!(matches!(res1, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_SCOPE_INVALID"));

        // Unknown feature
        let res2 = apply(&mut conn, reorder_forecast_cmd("0198a000-0000-7000-8000-0000000000r2", 10, vec![fa, fb, "unknown"])).unwrap();
        assert!(matches!(res2, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_SCOPE_INVALID"));

        // Duplicate feature
        let res3 = apply(&mut conn, reorder_forecast_cmd("0198a000-0000-7000-8000-0000000000r3", 10, vec![fa, fb, fb])).unwrap();
        assert!(matches!(res3, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_SCOPE_INVALID"));
    }

    #[test]
    fn reorder_forecast_features_rejects_group_split() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let fa = "0198a000-0000-7000-8000-0000000000a1";
        let fb = "0198a000-0000-7000-8000-0000000000a2";
        let fc = "0198a000-0000-7000-8000-0000000000a3";
        for (i, f) in [fa, fb, fc].iter().enumerate() {
            for cmd in create_typed_feature(&format!("0198a000-0000-7000-8000-0000000000e{}", i + 1), f, None, 1 + i as i64 * 2) {
                apply(&mut conn, cmd).unwrap();
            }
        }
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f1", 7, fa, true)).unwrap();
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f2", 8, fb, true)).unwrap();
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f3", 9, fc, true)).unwrap();

        // Create parallel group for [fb, fc]
        apply(&mut conn, set_parallel_groups_cmd("0198a000-0000-7000-8000-0000000000g1", 10, vec![vec![fb, fc]])).unwrap();

        // Reordering to [fb, fa, fc] splits [fb, fc]!
        let res = apply(&mut conn, reorder_forecast_cmd("0198a000-0000-7000-8000-0000000000r4", 11, vec![fb, fa, fc])).unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_GROUP_SPLIT"));
    }

    #[test]
    fn reorder_forecast_features_applies_and_updates_order() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let fa = "0198a000-0000-7000-8000-0000000000a1";
        let fb = "0198a000-0000-7000-8000-0000000000a2";
        let fc = "0198a000-0000-7000-8000-0000000000a3";
        for (i, f) in [fa, fb, fc].iter().enumerate() {
            for cmd in create_typed_feature(&format!("0198a000-0000-7000-8000-0000000000e{}", i + 1), f, None, 1 + i as i64 * 2) {
                apply(&mut conn, cmd).unwrap();
            }
        }
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f1", 7, fa, true)).unwrap();
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f2", 8, fb, true)).unwrap();
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f3", 9, fc, true)).unwrap();

        let res = apply(&mut conn, reorder_forecast_cmd("0198a000-0000-7000-8000-0000000000r5", 10, vec![fc, fa, fb])).unwrap();
        match res {
            ProductCommandResult::ProductCommandApplied(a) => {
                assert_eq!(a.target_revision, 11);
                let cs = a.change_set.as_ref().unwrap();
                assert!(matches!(&cs.changes[0], NodeChange::ForecastOrderSet { selected_feature_ids, prior_selected_feature_ids }
                    if selected_feature_ids == &[fc, fa, fb] && prior_selected_feature_ids == &[fa, fb, fc]
                ));
            }
            _ => panic!("expected applied"),
        }

        let stored: String = conn
            .query_row("SELECT selected_feature_ids FROM forecast_plans WHERE project_id = ?1", [PROJECT_ID], |r| r.get(0))
            .unwrap();
        let ids: Vec<String> = serde_json::from_str(&stored).unwrap();
        assert_eq!(ids, vec![fc, fa, fb]);
    }

    #[test]
    fn set_forecast_parallel_groups_validates_and_persists() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let fa = "0198a000-0000-7000-8000-0000000000a1";
        let fb = "0198a000-0000-7000-8000-0000000000a2";
        let fc = "0198a000-0000-7000-8000-0000000000a3";
        for (i, f) in [fa, fb, fc].iter().enumerate() {
            for cmd in create_typed_feature(&format!("0198a000-0000-7000-8000-0000000000e{}", i + 1), f, None, 1 + i as i64 * 2) {
                apply(&mut conn, cmd).unwrap();
            }
        }
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f1", 7, fa, true)).unwrap();
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f2", 8, fb, true)).unwrap();
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f3", 9, fc, true)).unwrap();

        // Group < 2 features rejected
        let res1 = apply(&mut conn, set_parallel_groups_cmd("0198a000-0000-7000-8000-0000000000g2", 10, vec![vec![fa]])).unwrap();
        assert!(matches!(res1, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_GROUP_INVALID"));

        // Non-contiguous group [fa, fc] rejected
        let res2 = apply(&mut conn, set_parallel_groups_cmd("0198a000-0000-7000-8000-0000000000g3", 10, vec![vec![fa, fc]])).unwrap();
        assert!(matches!(res2, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_GROUP_INVALID"));

        // Valid contiguous group [fa, fb] applied
        let res3 = apply(&mut conn, set_parallel_groups_cmd("0198a000-0000-7000-8000-0000000000g4", 10, vec![vec![fa, fb]])).unwrap();
        match res3 {
            ProductCommandResult::ProductCommandApplied(a) => {
                assert_eq!(a.target_revision, 11);
                let cs = a.change_set.as_ref().unwrap();
                assert!(matches!(&cs.changes[0], NodeChange::ForecastParallelGroupsSet { parallel_groups, prior_parallel_groups }
                    if parallel_groups.len() == 1 && parallel_groups[0].feature_ids == &[fa, fb] && prior_parallel_groups.is_empty()
                ));
            }
            _ => panic!("expected applied"),
        }

        let stored: String = conn
            .query_row("SELECT parallel_groups FROM forecast_plans WHERE project_id = ?1", [PROJECT_ID], |r| r.get(0))
            .unwrap();
        let groups: Vec<ParallelGroup> = serde_json::from_str(&stored).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].feature_ids, vec![fa, fb]);
    }

    #[test]
    fn restore_forecast_scope_restores_members_and_groups() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let fa = "0198a000-0000-7000-8000-0000000000a1";
        let fb = "0198a000-0000-7000-8000-0000000000a2";
        let fc = "0198a000-0000-7000-8000-0000000000a3";
        for (i, f) in [fa, fb, fc].iter().enumerate() {
            for cmd in create_typed_feature(&format!("0198a000-0000-7000-8000-0000000000e{}", i + 1), f, None, 1 + i as i64 * 2) {
                apply(&mut conn, cmd).unwrap();
            }
        }
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f1", 7, fa, true)).unwrap();

        // Non-existent feature node rejected
        let res1 = apply(&mut conn, restore_forecast_scope_cmd("0198a000-0000-7000-8000-0000000000s1", 8, vec![fa, "missing"], vec![])).unwrap();
        assert!(matches!(res1, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_SCOPE_INVALID"));

        // Valid restore with members and parallel group
        let res2 = apply(&mut conn, restore_forecast_scope_cmd("0198a000-0000-7000-8000-0000000000s2", 8, vec![fa, fb, fc], vec![vec![fb, fc]])).unwrap();
        match res2 {
            ProductCommandResult::ProductCommandApplied(a) => {
                assert_eq!(a.target_revision, 9);
                let cs = a.change_set.as_ref().unwrap();
                assert_eq!(cs.changes.len(), 1);
                assert!(matches!(&cs.changes[0], NodeChange::ForecastScopeSet { selected_feature_ids, parallel_groups, .. }
                    if selected_feature_ids == &[fa, fb, fc] && parallel_groups.len() == 1 && parallel_groups[0].feature_ids == &[fb, fc]
                ));
            }
            _ => panic!("expected applied"),
        }

        let (ids_raw, groups_raw): (String, String) = conn
            .query_row("SELECT selected_feature_ids, parallel_groups FROM forecast_plans WHERE project_id = ?1", [PROJECT_ID], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        let ids: Vec<String> = serde_json::from_str(&ids_raw).unwrap();
        let groups: Vec<ParallelGroup> = serde_json::from_str(&groups_raw).unwrap();
        assert_eq!(ids, vec![fa, fb, fc]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].feature_ids, vec![fb, fc]);
    }

    #[test]
    fn component_ranks_between_theme_and_feature() {
        // Mirrors node-hierarchy.policy.ts HIERARCHY_RANKS.
        assert_eq!(node_type_rank(Some("Theme")), 1);
        assert_eq!(node_type_rank(Some("Component")), 2);
        assert_eq!(node_type_rank(Some("Feature")), 3);
        assert_eq!(node_type_rank(Some("AcceptanceCriterion")), 4);

        assert!(can_parent_node_type(Some("Theme"), Some("Component")));
        assert!(can_parent_node_type(Some("Component"), Some("Component")));
        assert!(can_parent_node_type(Some("Component"), Some("Feature")));
        assert!(!can_parent_node_type(Some("Component"), Some("Theme")));
        assert!(!can_parent_node_type(Some("Feature"), Some("Component")));
        // Untyped stays permissive on either side.
        assert!(can_parent_node_type(None, Some("Component")));
        assert!(can_parent_node_type(Some("Component"), None));
    }

    // ── Epic 21: SetForecastPlanningLevel / RestoreForecastPlanningLevel (Story 21.7) ──

    fn set_planning_level_cmd(command_id: &str, base: i64, level: &str) -> ProductCommand {
        ProductCommand::SetForecastPlanningLevel(SetForecastPlanningLevelCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            planning_level: level.to_string(),
        })
    }

    fn restore_planning_level_cmd(
        command_id: &str,
        base: i64,
        level: &str,
        feature_ids: Vec<&str>,
        groups: Vec<Vec<&str>>,
        blocked: Vec<&str>,
    ) -> ProductCommand {
        ProductCommand::RestoreForecastPlanningLevel(RestoreForecastPlanningLevelCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            planning_level: level.to_string(),
            selected_feature_ids: feature_ids.into_iter().map(|s| s.to_string()).collect(),
            parallel_groups: groups
                .into_iter()
                .map(|f_ids| ParallelGroup {
                    feature_ids: f_ids.into_iter().map(|f| f.to_string()).collect(),
                })
                .collect(),
            blocked_feature_ids: blocked.into_iter().map(|s| s.to_string()).collect(),
            assignments: None,
        })
    }

    #[test]
    fn set_forecast_planning_level_clears_scope_groups_and_blockers_atomically() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let fa = "0198a000-0000-7000-8000-0000000000a1";
        for cmd in create_typed_feature("0198a000-0000-7000-8000-0000000000e1", fa, None, 1) {
            apply(&mut conn, cmd).unwrap();
        }
        // create_project (0->1) + create_typed_feature (1->3) = revision 3.
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f1", 3, fa, true)).unwrap();
        apply(&mut conn, blocker_cmd("0198a000-0000-7000-8000-0000000000g1", 4, fa, true)).unwrap();

        let res = apply(&mut conn, set_planning_level_cmd("0198a000-0000-7000-8000-0000000000h1", 5, "Theme")).unwrap();
        match res {
            ProductCommandResult::ProductCommandApplied(a) => {
                assert_eq!(a.target_revision, 6);
                let cs = a.change_set.as_ref().unwrap();
                assert_eq!(cs.changes.len(), 1);
                assert!(matches!(&cs.changes[0], NodeChange::ForecastPlanningLevelSet {
                    planning_level, prior_planning_level, prior_selected_feature_ids, prior_blocked_feature_ids, ..
                } if planning_level == "Theme"
                    && prior_planning_level == "Feature"
                    && prior_selected_feature_ids == &[fa.to_string()]
                    && prior_blocked_feature_ids == &[fa.to_string()]
                ));
            }
            _ => panic!("expected applied"),
        }

        let (ids_raw, groups_raw, blocked_raw, level): (String, String, String, String) = conn
            .query_row(
                "SELECT selected_feature_ids, parallel_groups, blocked_feature_ids, planning_level FROM forecast_plans WHERE project_id = ?1",
                [PROJECT_ID],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        let ids: Vec<String> = serde_json::from_str(&ids_raw).unwrap();
        let groups: Vec<ParallelGroup> = serde_json::from_str(&groups_raw).unwrap();
        let blocked: Vec<String> = serde_json::from_str(&blocked_raw).unwrap();
        assert!(ids.is_empty());
        assert!(groups.is_empty());
        assert!(blocked.is_empty());
        assert_eq!(level, "Theme");
    }

    #[test]
    fn set_forecast_planning_level_rejects_a_noop_switch() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let res = apply(&mut conn, set_planning_level_cmd("0198a000-0000-7000-8000-0000000000h2", 1, "Feature")).unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_CONFIG_INVALID"));
    }

    #[test]
    fn unknown_stored_level_uses_feature_membership_rules() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let fa = "0198a000-0000-7000-8000-0000000000a1";
        for cmd in create_typed_feature("0198a000-0000-7000-8000-0000000000e1", fa, None, 1) {
            apply(&mut conn, cmd).unwrap();
        }
        conn.execute("INSERT INTO forecast_plans(project_id, planning_level) VALUES(?1, 'unknown')", [PROJECT_ID]).unwrap();
        let result = apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f1", 3, fa, true)).unwrap();
        assert!(matches!(result, ProductCommandResult::ProductCommandApplied(_)));
        for (sql, expected) in [("SELECT NULL", "Feature"), ("SELECT 42", "Feature"), ("SELECT 'Theme'", "Theme"), ("SELECT 'Component'", "Component")] {
            let level = conn.query_row(sql, [], |row| Ok(read_planning_level(row, 0))).unwrap();
            assert_eq!(level, expected);
        }
    }

    #[test]
    fn restore_forecast_planning_level_restores_all_four_columns() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let fa = "0198a000-0000-7000-8000-0000000000a1";
        for cmd in create_typed_feature("0198a000-0000-7000-8000-0000000000e1", fa, None, 1) {
            apply(&mut conn, cmd).unwrap();
        }
        // create_project (0->1) + create_typed_feature (1->3) = revision 3.
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f1", 3, fa, true)).unwrap();
        apply(&mut conn, set_planning_level_cmd("0198a000-0000-7000-8000-0000000000h1", 4, "Component")).unwrap();

        let res = apply(
            &mut conn,
            restore_planning_level_cmd("0198a000-0000-7000-8000-0000000000r1", 5, "Feature", vec![fa], vec![], vec![]),
        )
        .unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandApplied(_)));

        let (ids_raw, level): (String, String) = conn
            .query_row(
                "SELECT selected_feature_ids, planning_level FROM forecast_plans WHERE project_id = ?1",
                [PROJECT_ID],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let ids: Vec<String> = serde_json::from_str(&ids_raw).unwrap();
        assert_eq!(ids, vec![fa]);
        assert_eq!(level, "Feature");
        // A receipt written before forward level-delta fields were added
        // remains replayable and restores the original scope, not live state.
        conn.execute("UPDATE product_command_receipt SET result_json = json_remove(result_json,
            '$.changeSet.changes[0].selectedFeatureIds', '$.changeSet.changes[0].parallelGroups',
            '$.changeSet.changes[0].blockedFeatureIds') WHERE command_id = ?1",
            ["0198a000-0000-7000-8000-0000000000r1"]).unwrap();
        let replay = apply(&mut conn, restore_planning_level_cmd(
            "0198a000-0000-7000-8000-0000000000r1", 5, "Feature", vec![fa], vec![], vec![])).unwrap();
        let replay_json = serde_json::to_value(replay).unwrap();
        assert_eq!(replay_json["changeSet"]["changes"][0]["selectedFeatureIds"], serde_json::json!([fa]));
    }

    #[test]
    fn set_forecast_membership_validates_against_the_plan_level() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let fa = "0198a000-0000-7000-8000-0000000000a1";
        for cmd in create_typed_feature("0198a000-0000-7000-8000-0000000000e1", fa, None, 1) {
            apply(&mut conn, cmd).unwrap();
        }
        // create_project (0->1) + create_typed_feature (1->3) = revision 3.
        apply(&mut conn, set_planning_level_cmd("0198a000-0000-7000-8000-0000000000h1", 3, "Theme")).unwrap();

        // The seeded node is a Feature; a Theme-level plan must refuse it.
        let res = apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000000f1", 4, fa, true)).unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_SCOPE_INVALID"));
    }

    // ── Epic 22: Forecast Roster Tests (Story 22.3) ──────────────────────────

    fn add_forecast_person_cmd(command_id: &str, base: i64, person_id: &str, name: &str, weight_units: i64) -> ProductCommand {
        ProductCommand::AddForecastPerson(AddForecastPersonCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            person_id: person_id.to_string(),
            name: name.to_string(),
            weight_units,
        })
    }

    fn update_forecast_person_cmd(command_id: &str, base: i64, person_id: &str, name: &str, weight_units: i64) -> ProductCommand {
        ProductCommand::UpdateForecastPerson(UpdateForecastPersonCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            person_id: person_id.to_string(),
            name: name.to_string(),
            weight_units,
        })
    }

    fn remove_forecast_person_cmd(command_id: &str, base: i64, person_id: &str) -> ProductCommand {
        ProductCommand::RemoveForecastPerson(RemoveForecastPersonCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            person_id: person_id.to_string(),
        })
    }

    fn restore_forecast_person_cmd(command_id: &str, base: i64, person: ForecastPersonDto) -> ProductCommand {
        ProductCommand::RestoreForecastPerson(RestoreForecastPersonCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            person,
            assignments: None,
        })
    }

    #[test]
    fn add_update_remove_restore_forecast_person_lifecycle() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();

        // 1. Add person to project without existing forecast plan -> creates plan + adds person
        let res1 = apply(&mut conn, add_forecast_person_cmd("cmd-roster-1", 1, "p-alice", "Alice", 100)).unwrap();
        match res1 {
            ProductCommandResult::ProductCommandApplied(a) => {
                let changes = a.change_set.as_ref().map(|c| c.changes.as_slice()).unwrap_or(&[]);
                assert_eq!(changes.len(), 2);
                assert!(matches!(changes[0], NodeChange::ForecastPlanCreated { .. }));
                assert!(matches!(&changes[1], NodeChange::ForecastPersonAdded { person, .. } if person.id == "p-alice" && person.name == "Alice" && person.weight_units == 100));
            }
            other => panic!("expected applied, got {other:?}"),
        }

        // Duplicate replay returns identical result
        let replay = apply(&mut conn, add_forecast_person_cmd("cmd-roster-1", 1, "p-alice", "Alice", 100)).unwrap();
        assert!(matches!(replay, ProductCommandResult::ProductCommandApplied(_)));

        // Duplicate person ID rejected
        let dup_id = apply(&mut conn, add_forecast_person_cmd("cmd-roster-dup", 2, "p-alice", "Alice 2", 100)).unwrap();
        assert!(matches!(dup_id, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_PERSON_EXISTS"));

        // Invalid validation rejected
        let blank_name = apply(&mut conn, add_forecast_person_cmd("cmd-roster-blank", 2, "p-bob", "  ", 100)).unwrap();
        assert!(matches!(blank_name, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_PERSON_INVALID"));

        let zero_weight = apply(&mut conn, add_forecast_person_cmd("cmd-roster-zero", 2, "p-bob", "Bob", 0)).unwrap();
        assert!(matches!(zero_weight, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_PERSON_INVALID"));

        // 2. Add second person
        let res2 = apply(&mut conn, add_forecast_person_cmd("cmd-roster-2", 2, "p-bob", "Bob", 150)).unwrap();
        assert!(matches!(res2, ProductCommandResult::ProductCommandApplied(_)));

        // 3. Update person
        let res3 = apply(&mut conn, update_forecast_person_cmd("cmd-roster-3", 3, "p-alice", "Alice Smith", 80)).unwrap();
        match res3 {
            ProductCommandResult::ProductCommandApplied(a) => {
                let changes = a.change_set.as_ref().map(|c| c.changes.as_slice()).unwrap_or(&[]);
                assert_eq!(changes.len(), 1);
                assert!(matches!(&changes[0], NodeChange::ForecastPersonUpdated {
                    person_id, name, weight_units, prior_name, prior_weight_units, ..
                } if person_id == "p-alice" && name == "Alice Smith" && *weight_units == 80 && prior_name == "Alice" && *prior_weight_units == 100));
            }
            other => panic!("expected applied, got {other:?}"),
        }

        // Update missing person rejected
        let missing = apply(&mut conn, update_forecast_person_cmd("cmd-roster-missing", 4, "p-ghost", "Ghost", 100)).unwrap();
        assert!(matches!(missing, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_PERSON_NOT_FOUND"));

        // 4. Remove person
        let res4 = apply(&mut conn, remove_forecast_person_cmd("cmd-roster-4", 4, "p-alice")).unwrap();
        match res4 {
            ProductCommandResult::ProductCommandApplied(a) => {
                let changes = a.change_set.as_ref().map(|c| c.changes.as_slice()).unwrap_or(&[]);
                assert_eq!(changes.len(), 1);
                assert!(matches!(&changes[0], NodeChange::ForecastPersonRemoved { person, .. } if person.id == "p-alice"));
            }
            other => panic!("expected applied, got {other:?}"),
        }

        // 5. Restore person
        let restored_dto = ForecastPersonDto {
            id: "p-alice".to_string(),
            name: "Alice Smith".to_string(),
            weight_units: 80,
        };
        let res5 = apply(&mut conn, restore_forecast_person_cmd("cmd-roster-5", 5, restored_dto)).unwrap();
        assert!(matches!(res5, ProductCommandResult::ProductCommandApplied(_)));

        // Verify roster in database
        let roster_json: String = conn
            .query_row(
                "SELECT roster FROM forecast_plans WHERE project_id = ?1",
                [PROJECT_ID],
                |r| r.get(0),
            )
            .unwrap();
        let roster: Vec<ForecastPersonDto> = serde_json::from_str(&roster_json).unwrap();
        assert_eq!(roster.len(), 2);
        assert_eq!(roster[0].id, "p-bob");
        assert_eq!(roster[1].id, "p-alice");
        assert_eq!(roster[1].name, "Alice Smith");
        assert_eq!(roster[1].weight_units, 80);
    }

    fn set_forecast_assignments_cmd(
        command_id: &str,
        base: i64,
        feature_id: &str,
        person_ids: Vec<&str>,
    ) -> ProductCommand {
        ProductCommand::SetForecastAssignments(SetForecastAssignmentsCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            feature_id: feature_id.to_string(),
            person_ids: person_ids.into_iter().map(|s| s.to_string()).collect(),
        })
    }

    fn set_forecast_policy_cmd(
        command_id: &str,
        base: i64,
        policy_version: &str,
    ) -> ProductCommand {
        ProductCommand::SetForecastPolicy(SetForecastPolicyCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            policy_version: policy_version.to_string(),
        })
    }

    #[test]
    fn forecast_assignments_and_policy_lifecycle() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();

        let feat1 = "0198a000-0000-7000-8000-000000000011";
        let feat2 = "0198a000-0000-7000-8000-000000000012";
        let [n1, t1] = create_typed_feature("c-node-1", feat1, None, 1);
        apply(&mut conn, n1).unwrap();
        apply(&mut conn, t1).unwrap();
        let [n2, t2] = create_typed_feature("c-node-2", feat2, None, 3);
        apply(&mut conn, n2).unwrap();
        apply(&mut conn, t2).unwrap();

        apply(&mut conn, ProductCommand::SetNodeEffort(SetNodeEffortCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "c-eff-1".to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 5,
            expected_revision: 6,
            actor_id: None,
            node_id: feat1.to_string(),
            effort_points: Some(5),
            restored_assignments: None,
        })).unwrap();
        apply(&mut conn, ProductCommand::SetNodeEffort(SetNodeEffortCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "c-eff-2".to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 6,
            expected_revision: 7,
            actor_id: None,
            node_id: feat2.to_string(),
            effort_points: Some(8),
            restored_assignments: None,
        })).unwrap();

        apply(&mut conn, membership_cmd("c-mem-1", 7, feat1, true)).unwrap();
        apply(&mut conn, membership_cmd("c-mem-2", 8, feat2, true)).unwrap();

        apply(&mut conn, add_forecast_person_cmd("c-ros-1", 9, "p-alice", "Alice", 100)).unwrap();
        apply(&mut conn, add_forecast_person_cmd("c-ros-2", 10, "p-bob", "Bob", 100)).unwrap();

        // 1. Assign Alice to feat1
        let assign_res = apply(&mut conn, set_forecast_assignments_cmd("c-asg-1", 11, feat1, vec!["p-alice"])).unwrap();
        match assign_res {
            ProductCommandResult::ProductCommandApplied(a) => {
                let changes = a.change_set.as_ref().map(|c| c.changes.as_slice()).unwrap_or(&[]);
                assert_eq!(changes.len(), 1);
                assert!(matches!(&changes[0], NodeChange::ForecastAssignmentsSet {
                    feature_id, person_ids, prior_person_ids, ..
                } if feature_id == feat1 && person_ids == &["p-alice".to_string()] && prior_person_ids.is_empty()));
            }
            other => panic!("expected applied, got {other:?}"),
        }

        // 2. Reject duplicate person IDs
        let dup = apply(&mut conn, set_forecast_assignments_cmd("c-asg-dup", 12, feat1, vec!["p-alice", "p-alice"])).unwrap();
        assert!(matches!(dup, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_ASSIGNMENT_INVALID"));

        // 3. Reject unknown person ID
        let unknown = apply(&mut conn, set_forecast_assignments_cmd("c-asg-unk", 12, feat1, vec!["p-unknown"])).unwrap();
        assert!(matches!(unknown, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_ASSIGNMENT_INVALID" && r.person_id == Some("p-unknown".to_string())));

        // 4. Assign Alice to feat2 as well (sequential reuse in shared-capacity-v1 is fine)
        let asg2 = apply(&mut conn, set_forecast_assignments_cmd("c-asg-2", 12, feat2, vec!["p-alice"])).unwrap();
        assert!(matches!(asg2, ProductCommandResult::ProductCommandApplied(_)));

        // 5. Group feat1 and feat2 into a parallel bucket while in shared-capacity-v1 (allowed)
        let grp = apply(&mut conn, set_parallel_groups_cmd("c-grp-1", 13, vec![vec![feat1, feat2]])).unwrap();
        assert!(matches!(grp, ProductCommandResult::ProductCommandApplied(_)));

        // 6. Switching to staffed-capacity-v1 must REFUSE because Alice is assigned to both parallel features
        let switch_refused = apply(&mut conn, set_forecast_policy_cmd("c-pol-1", 14, "staffed-capacity-v1")).unwrap();
        match switch_refused {
            ProductCommandResult::ProductCommandRejected(r) => {
                assert_eq!(r.code, "FORECAST_ASSIGNMENT_CONFLICT");
                assert_eq!(r.person_id, Some("p-alice".to_string()));
                assert_eq!(r.conflicting_feature_ids, Some(vec![feat1.to_string(), feat2.to_string()]));
            }
            other => panic!("expected conflict rejection, got {other:?}"),
        }

        // 7. Repair conflict: reassign feat2 to Bob
        let repair = apply(&mut conn, set_forecast_assignments_cmd("c-asg-3", 14, feat2, vec!["p-bob"])).unwrap();
        assert!(matches!(repair, ProductCommandResult::ProductCommandApplied(_)));

        // 8. Now switch to staffed-capacity-v1 succeeds
        let switch_ok = apply(&mut conn, set_forecast_policy_cmd("c-pol-2", 15, "staffed-capacity-v1")).unwrap();
        assert!(matches!(switch_ok, ProductCommandResult::ProductCommandApplied(_)));

        // 9. In staffed-capacity-v1, attempting to assign Alice to feat2 is refused
        let conflict_blocked = apply(&mut conn, set_forecast_assignments_cmd("c-asg-4", 16, feat2, vec!["p-alice", "p-bob"])).unwrap();
        assert!(matches!(conflict_blocked, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_ASSIGNMENT_CONFLICT"));

        // 10. Zero-effort feature rejection
        // Set feat2 effort to 0 -> clears assignments
        let zero_eff = apply(&mut conn, ProductCommand::SetNodeEffort(SetNodeEffortCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "c-eff-zero".to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 16,
            expected_revision: 17,
            actor_id: None,
            node_id: feat2.to_string(),
            effort_points: Some(0),
            restored_assignments: None,
        })).unwrap();
        match zero_eff {
            ProductCommandResult::ProductCommandApplied(a) => {
                let changes = a.change_set.as_ref().map(|c| c.changes.as_slice()).unwrap_or(&[]);
                assert!(matches!(&changes[0], NodeChange::NodeEffortSet {
                    cleared_assignments: Some(c), ..
                } if c == &["p-bob".to_string()]));
            }
            other => panic!("expected applied, got {other:?}"),
        }

        // Attempting to assign a person to 0-effort feature is rejected with FORECAST_ASSIGNMENT_ZERO_WORK
        let asg_zero = apply(&mut conn, set_forecast_assignments_cmd("c-asg-zero", 17, feat2, vec!["p-bob"])).unwrap();
        assert!(matches!(asg_zero, ProductCommandResult::ProductCommandRejected(r) if r.code == "FORECAST_ASSIGNMENT_ZERO_WORK" && r.feature_id == Some(feat2.to_string())));

        // 11. Removing an assigned person (Alice) cascades to clean up assignments
        let rm_person = apply(&mut conn, remove_forecast_person_cmd("c-rm-alice", 17, "p-alice")).unwrap();
        match rm_person {
            ProductCommandResult::ProductCommandApplied(a) => {
                let changes = a.change_set.as_ref().map(|c| c.changes.as_slice()).unwrap_or(&[]);
                assert!(matches!(&changes[0], NodeChange::ForecastPersonRemoved {
                    person, prior_assignments: Some(asg), ..
                } if person.id == "p-alice" && asg.contains_key(feat1)));
            }
            other => panic!("expected applied, got {other:?}"),
        }
    }

    /// Story 23.9 (AC 23.9-1/-2): the native command path keeps scenario weight
    /// overrides of 100000 and 100001 hundredths verbatim, on the same basis as
    /// a live weight of 100001; there is no scenario-only maximum.
    #[test]
    fn staffed_scenario_weight_overrides_share_the_live_weight_range() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let f = "0198a000-0000-7000-8000-00000000cf11";
        for cmd in create_typed_feature("0198a000-0000-7000-8000-00000000cf12", f, None, 1) {
            apply(&mut conn, cmd).unwrap();
        }
        apply(&mut conn, configure_forecast_cmd("0198a000-0000-7000-8000-00000000cf13", 3, Some(10), Some(14), Some(1), Some("2026-09-07"))).unwrap();
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-00000000cf14", 4, f, true)).unwrap();
        conn.execute("UPDATE nodes SET effort_points = 20 WHERE id = ?1", rusqlite::params![f]).unwrap();
        let p_ada = "0198a000-0000-7000-8000-00000000cf15";
        let p_bob = "0198a000-0000-7000-8000-00000000cf16";
        apply(&mut conn, add_forecast_person_cmd("0198a000-0000-7000-8000-00000000cf17", 5, p_ada, "Ada", 100)).unwrap();
        apply(&mut conn, add_forecast_person_cmd("0198a000-0000-7000-8000-00000000cf18", 6, p_bob, "Bob", 50)).unwrap();
        apply(&mut conn, set_forecast_assignments_cmd("0198a000-0000-7000-8000-00000000cf19", 7, f, vec![p_ada])).unwrap();
        apply(&mut conn, set_forecast_policy_cmd("0198a000-0000-7000-8000-00000000cf20", 8, "staffed-capacity-v1")).unwrap();

        let mut canonical_roster = vec![
            serde_json::json!({ "id": p_ada, "weightUnits": 100 }),
            serde_json::json!({ "id": p_bob, "weightUnits": 50 }),
        ];
        canonical_roster.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        let material = serde_json::json!({
            "policyVersion": "staffed-capacity-v1",
            "selectedFeatureIds": [f],
            "estimates": { (f): 20 },
            "pointsPerSprint": 10,
            "sprintLengthDays": 14,
            "startSprintOrdinal": 1,
            "startDate": "2026-09-07",
            "parallelGroups": [],
            "blockedFeatureIds": [],
            "roster": canonical_roster,
            "assignments": [{ "featureId": f, "personIds": [p_ada] }],
        });
        let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&material).unwrap()));

        let scenario_id = "0198a000-0000-7000-8000-00000000cf21";
        let create = ProductCommand::CreateForecastScenario(CreateForecastScenarioCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "0198a000-0000-7000-8000-00000000cf22".to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 9,
            expected_revision: 10,
            actor_id: None,
            scenario_id: scenario_id.to_string(),
            label: "Heavy weights".to_string(),
            baseline_revision: 9,
            expected_material_fingerprint: fingerprint,
            created_at_iso: "2026-09-25T00:00:00.000Z".to_string(),
            patch: serde_json::json!({ "weightOverrides": { (p_ada): 100000, (p_bob): 100001 } }),
        });
        assert!(matches!(apply(&mut conn, create).unwrap(), ProductCommandResult::ProductCommandApplied(_)));
        let patch_json: String = conn
            .query_row("SELECT patch_json FROM forecast_scenarios WHERE scenario_id = ?1", [scenario_id], |r| r.get(0))
            .unwrap();
        let patch: serde_json::Value = serde_json::from_str(&patch_json).unwrap();
        assert_eq!(patch["weightOverrides"][p_ada], 100000);
        assert_eq!(patch["weightOverrides"][p_bob], 100001);

        let live = apply(&mut conn, update_forecast_person_cmd("0198a000-0000-7000-8000-00000000cf23", 10, p_bob, "Bob", 100001)).unwrap();
        assert!(matches!(live, ProductCommandResult::ProductCommandApplied(_)));
    }

    #[test]
    fn create_remove_restore_staffed_forecast_scenario_round_trips() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap();
        let f = "0198a000-0000-7000-8000-00000000ce11";
        for cmd in create_typed_feature("0198a000-0000-7000-8000-00000000ce12", f, None, 1) {
            apply(&mut conn, cmd).unwrap();
        }
        apply(&mut conn, configure_forecast_cmd("0198a000-0000-7000-8000-00000000ce13", 3, Some(10), Some(14), Some(1), Some("2026-09-07"))).unwrap();
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-00000000ce14", 4, f, true)).unwrap();
        conn.execute("UPDATE nodes SET effort_points = 20 WHERE id = ?1", rusqlite::params![f]).unwrap();

        // Switch to staffed-capacity-v1 policy and add persons
        let p_ada = "0198a000-0000-7000-8000-00000000ce15";
        let p_bob = "0198a000-0000-7000-8000-00000000ce16";
        apply(&mut conn, add_forecast_person_cmd("0198a000-0000-7000-8000-00000000ce17", 5, p_ada, "Ada", 100)).unwrap();
        apply(&mut conn, add_forecast_person_cmd("0198a000-0000-7000-8000-00000000ce18", 6, p_bob, "Bob", 50)).unwrap();
        apply(&mut conn, set_forecast_assignments_cmd("0198a000-0000-7000-8000-00000000ce19", 7, f, vec![p_ada])).unwrap();
        apply(&mut conn, set_forecast_policy_cmd("0198a000-0000-7000-8000-00000000ce20", 8, "staffed-capacity-v1")).unwrap();

        // Canonical roster: sorted by id
        let mut canonical_roster = vec![
            serde_json::json!({ "id": p_ada, "weightUnits": 100 }),
            serde_json::json!({ "id": p_bob, "weightUnits": 50 }),
        ];
        canonical_roster.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));

        let material = serde_json::json!({
            "policyVersion": "staffed-capacity-v1",
            "selectedFeatureIds": [f],
            "estimates": { (f): 20 },
            "pointsPerSprint": 10,
            "sprintLengthDays": 14,
            "startSprintOrdinal": 1,
            "startDate": "2026-09-07",
            "parallelGroups": [],
            "blockedFeatureIds": [],
            "roster": canonical_roster,
            "assignments": [
                {
                    "featureId": f,
                    "personIds": [p_ada],
                }
            ],
        });
        let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&material).unwrap()));

        let scenario_id = "0198a000-0000-7000-8000-00000000ce21";
        let create = ProductCommand::CreateForecastScenario(CreateForecastScenarioCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "0198a000-0000-7000-8000-00000000ce22".to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 9,
            expected_revision: 10,
            actor_id: None,
            scenario_id: scenario_id.to_string(),
            label: "Staffed scenario".to_string(),
            baseline_revision: 9,
            expected_material_fingerprint: fingerprint.clone(),
            created_at_iso: "2026-09-08T00:00:00.000Z".to_string(),
            patch: serde_json::json!({
                "weightOverrides": { (p_ada): 120 },
                "assignmentOverrides": { (f): [p_ada, p_bob] }
            }),
        });

        let res = apply(&mut conn, create.clone()).unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandApplied(_)));

        // Replay is idempotent
        let replay = apply(&mut conn, create).unwrap();
        assert!(matches!(replay, ProductCommandResult::ProductCommandApplied(ref a) if a.disposition == "StoredResultReturned"));

        // Verify baseline in database captured roster (including idle Bob) and assignments
        let (label, policy_version, baseline_json, patch_json): (String, String, String, String) = conn
            .query_row(
                "SELECT label, policy_version, baseline_json, patch_json FROM forecast_scenarios WHERE scenario_id = ?1",
                [scenario_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(label, "Staffed scenario");
        assert_eq!(policy_version, "staffed-capacity-v1");
        let baseline: serde_json::Value = serde_json::from_str(&baseline_json).unwrap();
        assert_eq!(baseline["roster"].as_array().unwrap().len(), 2);
        assert_eq!(baseline["assignments"][f].as_array().unwrap(), &vec![serde_json::json!(p_ada)]);

        let patch: serde_json::Value = serde_json::from_str(&patch_json).unwrap();
        assert_eq!(patch["weightOverrides"][p_ada], 120);

        // Remove and restore round trip
        let remove = ProductCommand::RemoveForecastScenario(RemoveForecastScenarioCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "0198a000-0000-7000-8000-00000000ce23".to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 10,
            expected_revision: 11,
            actor_id: None,
            scenario_id: scenario_id.to_string(),
        });
        let removed = apply(&mut conn, remove).unwrap();
        let removed_scenario = match removed {
            ProductCommandResult::ProductCommandApplied(a) => match &a.change_set.as_ref().unwrap().changes[0] {
                NodeChange::ForecastScenarioRemoved { scenario, .. } => scenario.clone(),
                _ => panic!("expected ForecastScenarioRemoved"),
            },
            _ => panic!("expected applied"),
        };
        assert_eq!(conn.query_row::<i64, _, _>("SELECT COUNT(1) FROM forecast_scenarios", [], |r| r.get(0)).unwrap(), 0);

        let restore = ProductCommand::RestoreForecastScenario(RestoreForecastScenarioCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "0198a000-0000-7000-8000-00000000ce24".to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 11,
            expected_revision: 12,
            actor_id: None,
            scenario: removed_scenario,
        });
        let restored = apply(&mut conn, restore).unwrap();
        assert!(matches!(restored, ProductCommandResult::ProductCommandApplied(_)));
        assert_eq!(conn.query_row::<i64, _, _>("SELECT COUNT(1) FROM forecast_scenarios", [], |r| r.get(0)).unwrap(), 1);
    }

    fn set_node_effort_cmd(command_id: &str, base: i64, node_id: &str, effort: Option<i64>) -> ProductCommand {
        ProductCommand::SetNodeEffort(SetNodeEffortCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            node_id: node_id.to_string(),
            effort_points: effort,
            restored_assignments: None,
        })
    }

    #[test]
    fn corrupt_forecast_plan_cells_refuse_all_commands_with_column_and_leave_db_unchanged() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap(); // rev 1
        let f1 = "0198a000-0000-7000-8000-0000000000f1";
        for cmd in create_typed_feature("c-f1", f1, None, 1) {
            apply(&mut conn, cmd).unwrap();
        } // rev 3
        apply(&mut conn, set_node_effort_cmd("cmd-effort-init", 3, f1, Some(5))).unwrap(); // rev 4

        let p_ada = "0198a000-0000-7000-8000-0000000000p1";
        let add_person = ProductCommand::AddForecastPerson(AddForecastPersonCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "cmd-p-init".to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 4,
            expected_revision: 5,
            actor_id: None,
            person_id: p_ada.to_string(),
            name: "Ada".to_string(),
            weight_units: 100,
        });
        apply(&mut conn, add_person).unwrap(); // rev 5

        // Populate a healthy plan with all columns set
        let configure = configure_forecast_cmd_with_level(
            "cmd-cfg-init",
            5,
            Some(10),
            Some(14),
            Some(1),
            Some("2026-09-08"),
            Some("Feature"),
        );
        apply(&mut conn, configure).unwrap(); // rev 6

        // Seed valid scope, parallel groups, and assignments
        conn.execute(
            "UPDATE forecast_plans SET selected_feature_ids = ?1, parallel_groups = ?2, blocked_feature_ids = '[]', assignments = ?3 WHERE project_id = ?4",
            rusqlite::params![
                serde_json::to_string(&vec![f1]).unwrap(),
                serde_json::to_string(&vec![ParallelGroup { feature_ids: vec![f1.to_string()] }]).unwrap(),
                serde_json::to_string(&std::collections::HashMap::from([(f1.to_string(), vec![p_ada.to_string()])])).unwrap(),
                PROJECT_ID,
            ],
        ).unwrap();

        let columns = [
            "selected_feature_ids",
            "parallel_groups",
            "blocked_feature_ids",
            "roster",
            "assignments",
        ];

        for col in columns {
            // Damaged cell
            conn.execute(
                &format!("UPDATE forecast_plans SET {} = '{{bad-json' WHERE project_id = ?1", col),
                [PROJECT_ID],
            ).unwrap();

            // Snapshot state before attempted commands
            let rev_before: i64 = conn.query_row("SELECT revision FROM projects WHERE id = ?1", [PROJECT_ID], |r| r.get(0)).unwrap();
            let receipts_before: i64 = conn.query_row("SELECT COUNT(1) FROM product_command_receipt", [], |r| r.get(0)).unwrap();
            let cell_before: String = conn.query_row(&format!("SELECT {} FROM forecast_plans WHERE project_id = ?1", col), [PROJECT_ID], |r| r.get(0)).unwrap();

            // Helper to assert rejection
            let assert_corrupt_rejected = |res: Result<ProductCommandResult, RepositoryError>, expected_col: &str| {
                match res {
                    Ok(ProductCommandResult::ProductCommandRejected(r)) => {
                        assert_eq!(r.code, "FORECAST_PLAN_CORRUPT");
                        assert_eq!(r.column, Some(expected_col.to_string()));
                    }
                    other => panic!("expected FORECAST_PLAN_CORRUPT rejection, got {other:?}"),
                }
            };

            // 1. set_node_effort (effort = 0 would clean up assignments)
            assert_corrupt_rejected(apply(&mut conn, set_node_effort_cmd("cmd-t-effort", rev_before, f1, Some(0))), col);

            // 2. configure_forecast_plan
            let cfg_cmd = configure_forecast_cmd_with_level(
                "cmd-t-cfg",
                rev_before,
                Some(15),
                Some(14),
                Some(1),
                Some("2026-09-08"),
                None,
            );
            assert_corrupt_rejected(apply(&mut conn, cfg_cmd), col);

            // 3. set_forecast_membership
            let mem_cmd = ProductCommand::SetForecastMembership(SetForecastMembershipCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-mem".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                feature_id: f1.to_string(),
                included: false,
            });
            assert_corrupt_rejected(apply(&mut conn, mem_cmd), col);

            // 4. set_forecast_blocker
            let blk_cmd = ProductCommand::SetForecastBlocker(SetForecastBlockerCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-blk".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                feature_id: f1.to_string(),
                blocked: true,
            });
            assert_corrupt_rejected(apply(&mut conn, blk_cmd), col);

            // 5. create_forecast_scenario
            let scn_cmd = ProductCommand::CreateForecastScenario(CreateForecastScenarioCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-scn".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                scenario_id: "0198a000-0000-7000-8000-00000000ce99".to_string(),
                label: "Damaged".to_string(),
                baseline_revision: rev_before,
                expected_material_fingerprint: "irrelevant".to_string(),
                created_at_iso: "2026-09-08T00:00:00.000Z".to_string(),
                patch: serde_json::json!({}),
            });
            assert_corrupt_rejected(apply(&mut conn, scn_cmd), col);

            // 6. reorder_forecast_features
            let reorder_cmd = ProductCommand::ReorderForecastFeatures(ReorderForecastFeaturesCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-reorder".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                feature_ids: vec![f1.to_string()],
            });
            assert_corrupt_rejected(apply(&mut conn, reorder_cmd), col);

            // 7. set_forecast_parallel_groups
            let groups_cmd = ProductCommand::SetForecastParallelGroups(SetForecastParallelGroupsCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-groups".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                parallel_groups: vec![],
            });
            assert_corrupt_rejected(apply(&mut conn, groups_cmd), col);

            // 8. restore_forecast_scope
            let restore_scope_cmd = ProductCommand::RestoreForecastScope(RestoreForecastScopeCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-scope".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                selected_feature_ids: vec![f1.to_string()],
                parallel_groups: vec![],
                blocked_feature_ids: vec![],
                assignments: None,
            });
            assert_corrupt_rejected(apply(&mut conn, restore_scope_cmd), col);

            // 9. set_forecast_sequence
            let seq_cmd = ProductCommand::SetForecastSequence(SetForecastSequenceCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-seq".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                feature_ids: vec![f1.to_string()],
                parallel_groups: vec![],
            });
            assert_corrupt_rejected(apply(&mut conn, seq_cmd), col);

            // 10. set_forecast_planning_level
            let level_cmd = ProductCommand::SetForecastPlanningLevel(SetForecastPlanningLevelCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-level".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                planning_level: "Theme".to_string(),
            });
            assert_corrupt_rejected(apply(&mut conn, level_cmd), col);

            // 11. restore_forecast_planning_level
            let restore_level_cmd = ProductCommand::RestoreForecastPlanningLevel(RestoreForecastPlanningLevelCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-rest-level".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                planning_level: "Feature".to_string(),
                selected_feature_ids: vec![f1.to_string()],
                parallel_groups: vec![],
                blocked_feature_ids: vec![],
                assignments: None,
            });
            assert_corrupt_rejected(apply(&mut conn, restore_level_cmd), col);

            // 12. remove_forecast_plan
            let remove_plan_cmd = ProductCommand::RemoveForecastPlan(RemoveForecastPlanCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-rm-plan".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
            });
            assert_corrupt_rejected(apply(&mut conn, remove_plan_cmd), col);

            // 13. add_forecast_person
            let add_person_cmd = ProductCommand::AddForecastPerson(AddForecastPersonCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-add-p".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                person_id: "p-bob".to_string(),
                name: "Bob".to_string(),
                weight_units: 100,
            });
            assert_corrupt_rejected(apply(&mut conn, add_person_cmd), col);

            // 14. update_forecast_person
            let upd_person_cmd = ProductCommand::UpdateForecastPerson(UpdateForecastPersonCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-upd-p".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                person_id: p_ada.to_string(),
                name: "Ada Lovelace".to_string(),
                weight_units: 120,
            });
            assert_corrupt_rejected(apply(&mut conn, upd_person_cmd), col);

            // 15. remove_forecast_person
            let rm_person_cmd = ProductCommand::RemoveForecastPerson(RemoveForecastPersonCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-rm-p".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                person_id: p_ada.to_string(),
            });
            assert_corrupt_rejected(apply(&mut conn, rm_person_cmd), col);

            // 16. restore_forecast_person
            let rest_person_cmd = ProductCommand::RestoreForecastPerson(RestoreForecastPersonCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-rest-p".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                person: ForecastPersonDto {
                    id: "p-bob".to_string(),
                    name: "Bob".to_string(),
                    weight_units: 100,
                },
                assignments: None,
            });
            assert_corrupt_rejected(apply(&mut conn, rest_person_cmd), col);

            // 17. set_forecast_assignments
            let assign_cmd = ProductCommand::SetForecastAssignments(SetForecastAssignmentsCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-assign".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                feature_id: f1.to_string(),
                person_ids: vec![p_ada.to_string()],
            });
            assert_corrupt_rejected(apply(&mut conn, assign_cmd), col);

            // 18. set_forecast_policy
            let pol_cmd = ProductCommand::SetForecastPolicy(SetForecastPolicyCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-pol".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                policy_version: "staffed-capacity-v1".to_string(),
            });
            assert_corrupt_rejected(apply(&mut conn, pol_cmd), col);

            // 19. delete_subtree — story 22.14 explicitly includes node
            // commands that clean up assignments (review L1).
            let delete_cmd = ProductCommand::DeleteSubtree(DeleteSubtreeCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-del".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                node_id: f1.to_string(),
            });
            assert_corrupt_rejected(apply(&mut conn, delete_cmd), col);

            // 20. remove_forecast_scenario — plan-touching (review L1).
            let remove_scenario_cmd = ProductCommand::RemoveForecastScenario(RemoveForecastScenarioCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-rm-scn".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                scenario_id: "scn-missing".to_string(),
            });
            assert_corrupt_rejected(apply(&mut conn, remove_scenario_cmd), col);

            // 21. restore_forecast_scenario — plan-touching (review L1).
            let restore_scenario_cmd = ProductCommand::RestoreForecastScenario(RestoreForecastScenarioCommand {
                command_name: String::new(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                command_id: "cmd-t-rest-scn".to_string(),
                project_id: PROJECT_ID.to_string(),
                base_revision: rev_before,
                expected_revision: rev_before + 1,
                actor_id: None,
                scenario: serde_json::json!({
                    "scenarioId": "scn-restored",
                    "projectId": PROJECT_ID,
                    "label": "Restored",
                    "baselineRevision": rev_before,
                    "baselineFingerprint": "f".repeat(64),
                    "policyVersion": "shared-capacity-v1",
                    "createdAtISO": "2026-09-26T00:00:00.000Z",
                    "baseline": { "orderedScope": [], "parallelGroups": [], "blockedFeatureIds": [], "planningLevel": "Feature", "factMap": {}, "configuration": {} },
                    "patch": {},
                }),
            });
            assert_corrupt_rejected(apply(&mut conn, restore_scenario_cmd), col);

            // Verify database state is 100% unchanged
            let rev_after: i64 = conn.query_row("SELECT revision FROM projects WHERE id = ?1", [PROJECT_ID], |r| r.get(0)).unwrap();
            assert_eq!(rev_after, rev_before, "revision must not advance");
            let receipts_after: i64 = conn.query_row("SELECT COUNT(1) FROM product_command_receipt", [], |r| r.get(0)).unwrap();
            assert_eq!(receipts_after, receipts_before, "no receipts written");
            let cell_after: String = conn.query_row(&format!("SELECT {} FROM forecast_plans WHERE project_id = ?1", col), [PROJECT_ID], |r| r.get(0)).unwrap();
            assert_eq!(cell_after, cell_before, "corrupt cell was not mutated");
            let scenario_count: i64 = conn.query_row("SELECT COUNT(1) FROM forecast_scenarios", [], |r| r.get(0)).unwrap();
            assert_eq!(scenario_count, 0, "no scenario captured");

            // Reset column to valid state for next iteration
            let valid_val = if col == "assignments" { "{}" } else { "[]" };
            conn.execute(
                &format!("UPDATE forecast_plans SET {} = ?1 WHERE project_id = ?2", col),
                rusqlite::params![valid_val, PROJECT_ID],
            ).unwrap();
        }
    }

    #[test]
    fn legacy_forecast_plan_with_null_staffing_cells_is_accepted() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap(); // rev 1
        let f1 = "0198a000-0000-7000-8000-0000000000f1";
        for cmd in create_typed_feature("c-f1", f1, None, 1) {
            apply(&mut conn, cmd).unwrap();
        } // rev 3

        // Recreate forecast_plans without NOT NULL on roster/assignments to model pre-migration legacy database
        conn.execute_batch(
            "DROP TABLE forecast_plans;
             CREATE TABLE forecast_plans(
                project_id          TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                selected_feature_ids TEXT NOT NULL DEFAULT '[]',
                parallel_groups     TEXT NOT NULL DEFAULT '[]',
                blocked_feature_ids TEXT NOT NULL DEFAULT '[]',
                points_per_sprint   INTEGER,
                sprint_length_days  INTEGER,
                cadence             TEXT NOT NULL DEFAULT 'fixed-contiguous',
                start_sprint_ordinal INTEGER,
                start_date          TEXT,
                policy_version      TEXT NOT NULL DEFAULT 'shared-capacity-v1',
                planning_level      TEXT NOT NULL DEFAULT 'Feature',
                roster              TEXT,
                assignments         TEXT
             );"
        ).unwrap();

        // Insert legacy forecast plan with NULL roster and assignments
        conn.execute(
            "INSERT INTO forecast_plans(
                project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
                sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version, planning_level, roster, assignments
             ) VALUES(?1, '[]', '[]', '[]', 10, 14, 'fixed-contiguous', 1, '2026-09-08', 'shared-capacity-v1', 'Feature', NULL, NULL)",
            [PROJECT_ID],
        ).unwrap();

        // Adding a person should succeed and parse roster as empty
        let add_person = ProductCommand::AddForecastPerson(AddForecastPersonCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "cmd-p-legacy".to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: 3,
            expected_revision: 4,
            actor_id: None,
            person_id: "p-ada".to_string(),
            name: "Ada".to_string(),
            weight_units: 100,
        });
        let res = apply(&mut conn, add_person).unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandApplied(_)));
    }

    #[test]
    fn lenient_parse_gate_in_handler_rs() {
        let src = include_str!("handler.rs");
        // No line in handler.rs should parse forecast plan JSON using unwrap_or_default or unwrap_or_else
        let lines: Vec<&str> = src.lines().collect();
        for (idx, line) in lines.iter().enumerate() {
            let line_num = idx + 1;
            // Lines in read_stored_forecast_plan are the canonical read implementation
            if line_num > 4230 {
                // In test module
                continue;
            }
            if (line.contains("roster") || line.contains("assignments") || line.contains("selected_feature_ids") || line.contains("parallel_groups") || line.contains("blocked_feature_ids"))
                && (line.contains("unwrap_or_default()") || line.contains("unwrap_or_else("))
                && line.contains("serde_json::from_str")
            {
                    panic!("Found lenient parse on forecast plan cell in handler.rs at line {line_num}: {line}");
            }
        }
    }

    // ── Epic 27: single-move command handlers (Story 27.2) ───────────────

    fn move_phase_cmd(
        command_id: &str,
        base: i64,
        phase_id: &str,
        after_id: Option<&str>,
        before_id: Option<&str>,
        intended_index: i64,
    ) -> ProductCommand {
        ProductCommand::MovePhase(MovePhaseCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            phase_id: phase_id.to_string(),
            after_id: after_id.map(|s| s.to_string()),
            before_id: before_id.map(|s| s.to_string()),
            intended_index,
        })
    }

    fn move_node_question_cmd(
        command_id: &str,
        base: i64,
        node_id: &str,
        question_id: &str,
        after_id: Option<&str>,
        before_id: Option<&str>,
        intended_index: i64,
    ) -> ProductCommand {
        ProductCommand::MoveNodeQuestion(MoveNodeQuestionCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            node_id: node_id.to_string(),
            question_id: question_id.to_string(),
            after_id: after_id.map(|s| s.to_string()),
            before_id: before_id.map(|s| s.to_string()),
            intended_index,
        })
    }

    fn move_forecast_feature_cmd(
        command_id: &str,
        base: i64,
        feature_id: &str,
        after_id: Option<&str>,
        before_id: Option<&str>,
        intended_index: i64,
        group_change: ForecastGroupChange,
    ) -> ProductCommand {
        ProductCommand::MoveForecastFeature(MoveForecastFeatureCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            feature_id: feature_id.to_string(),
            after_id: after_id.map(|s| s.to_string()),
            before_id: before_id.map(|s| s.to_string()),
            intended_index,
            group_change,
        })
    }

    fn set_forecast_assignment_cmd(
        command_id: &str,
        base: i64,
        feature_id: &str,
        person_id: &str,
        assigned: bool,
    ) -> ProductCommand {
        ProductCommand::SetForecastAssignment(SetForecastAssignmentCommand {
            command_name: String::new(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            actor_id: None,
            feature_id: feature_id.to_string(),
            person_id: person_id.to_string(),
            assigned,
        })
    }

    fn insert_feature_node(conn: &Connection, node_id: &str, position: i64, effort_points: i64) {
        conn.execute(
            "INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points)
             VALUES(?1, ?2, NULL, 'F', ?3, 'Feature', ?4)",
            rusqlite::params![node_id, PROJECT_ID, position, effort_points],
        )
        .unwrap();
    }

    fn stored_selected_feature_ids(conn: &Connection) -> Vec<String> {
        let raw: String = conn
            .query_row(
                "SELECT selected_feature_ids FROM forecast_plans WHERE project_id = ?1",
                [PROJECT_ID],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    fn stored_parallel_groups(conn: &Connection) -> Vec<ParallelGroup> {
        let raw: String = conn
            .query_row(
                "SELECT parallel_groups FROM forecast_plans WHERE project_id = ?1",
                [PROJECT_ID],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    fn stored_assignments(conn: &Connection) -> HashMap<String, Vec<String>> {
        let raw: String = conn
            .query_row(
                "SELECT assignments FROM forecast_plans WHERE project_id = ?1",
                [PROJECT_ID],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    #[test]
    fn move_phase_reorders_by_anchor() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap(); // rev 1

        let pa = "0198a000-0000-7000-8000-0000000a0001";
        let pb = "0198a000-0000-7000-8000-0000000a0002";
        let pc = "0198a000-0000-7000-8000-0000000a0003";
        for (i, (pid, position)) in [
            (pa, SIBLING_POSITION_GAP.to_string()),
            (pb, (SIBLING_POSITION_GAP * 2).to_string()),
            (pc, (SIBLING_POSITION_GAP * 3).to_string()),
        ]
        .iter()
        .enumerate()
        {
            let res = apply(
                &mut conn,
                ProductCommand::CreatePhase(CreatePhaseCommand {
                    command_name: String::new(),
                    protocol_version: PROTOCOL_VERSION.to_string(),
                    command_id: format!("0198a000-0000-7000-8000-0000000a01{i:02}"),
                    project_id: PROJECT_ID.to_string(),
                    base_revision: 1 + i as i64,
                    expected_revision: 2 + i as i64,
                    actor_id: None,
                    phase_id: pid.to_string(),
                    name: format!("Phase {i}"),
                    position: position.clone(),
                }),
            )
            .unwrap();
            assert!(matches!(res, ProductCommandResult::ProductCommandApplied(_)));
        }

        // Move the third phase to the front (no anchors, intended index 0).
        let res = apply(
            &mut conn,
            move_phase_cmd("0198a000-0000-7000-8000-0000000a0201", 4, pc, None, None, 0),
        )
        .unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandApplied(_)));

        let order: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT id FROM phases WHERE project_id = ?1 ORDER BY position ASC, id ASC")
                .unwrap();
            let rows = stmt.query_map([PROJECT_ID], |r| r.get::<_, String>(0)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        assert_eq!(order, vec![pc, pa, pb]);

        // An anchor that names the moving phase itself is a SELF_ANCHOR rejection.
        let self_anchor = apply(
            &mut conn,
            move_phase_cmd("0198a000-0000-7000-8000-0000000a0202", 5, pb, Some(pb), None, 1),
        )
        .unwrap();
        assert!(matches!(self_anchor, ProductCommandResult::ProductCommandRejected(r) if r.code == "SELF_ANCHOR"));

        let order_after: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT id FROM phases WHERE project_id = ?1 ORDER BY position ASC, id ASC")
                .unwrap();
            let rows = stmt.query_map([PROJECT_ID], |r| r.get::<_, String>(0)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        assert_eq!(order_after, vec![pc, pa, pb], "a rejected move must not mutate order");
    }

    #[test]
    fn move_node_question_reorders_and_rejects_unknown() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap(); // rev 1
        apply(&mut conn, create_node_cmd("0198a000-0000-7000-8000-0000000b0101")).unwrap(); // rev 2

        let q1 = "0198a000-0000-7000-8000-0000000b0201";
        let q2 = "0198a000-0000-7000-8000-0000000b0202";
        let q3 = "0198a000-0000-7000-8000-0000000b0203";
        for (i, q) in [q1, q2, q3].iter().enumerate() {
            let res = apply(
                &mut conn,
                ProductCommand::AddNodeQuestion(AddNodeQuestionCommand {
                    command_name: String::new(),
                    protocol_version: PROTOCOL_VERSION.to_string(),
                    command_id: format!("0198a000-0000-7000-8000-0000000b03{i:02}"),
                    project_id: PROJECT_ID.to_string(),
                    base_revision: 2 + i as i64,
                    expected_revision: 3 + i as i64,
                    actor_id: None,
                    question_id: q.to_string(),
                    node_id: NODE_ID.to_string(),
                    question_text: format!("Question {i}"),
                    position: format!("{}", i + 1),
                    created_at_iso: "2026-09-30T00:00:00.000Z".to_string(),
                }),
            )
            .unwrap();
            assert!(matches!(res, ProductCommandResult::ProductCommandApplied(_)));
        }

        // Move the last question to the front (no anchors, intended index 0).
        let res = apply(
            &mut conn,
            move_node_question_cmd(
                "0198a000-0000-7000-8000-0000000b0401",
                5,
                NODE_ID,
                q3,
                None,
                None,
                0,
            ),
        )
        .unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandApplied(_)));

        let order: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT id FROM node_open_questions WHERE project_id = ?1 AND node_id = ?2 ORDER BY position ASC")
                .unwrap();
            let rows = stmt
                .query_map(rusqlite::params![PROJECT_ID, NODE_ID], |r| r.get::<_, String>(0))
                .unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        assert_eq!(order, vec![q3, q1, q2]);

        // A question id that is not a child of the node is a NODE_NOT_FOUND rejection.
        let unknown = apply(
            &mut conn,
            move_node_question_cmd(
                "0198a000-0000-7000-8000-0000000b0402",
                6,
                NODE_ID,
                "0198a000-0000-7000-8000-0000000bdead",
                None,
                None,
                0,
            ),
        )
        .unwrap();
        assert!(matches!(unknown, ProductCommandResult::ProductCommandRejected(r) if r.code == "NODE_NOT_FOUND"));
    }

    #[test]
    fn move_forecast_feature_reorders_and_joins_group() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap(); // rev 1

        let f1 = "0198a000-0000-7000-8000-0000000c0101";
        let f2 = "0198a000-0000-7000-8000-0000000c0102";
        let f3 = "0198a000-0000-7000-8000-0000000c0103";
        let f4 = "0198a000-0000-7000-8000-0000000c0104";
        for (i, f) in [f1, f2, f3, f4].iter().enumerate() {
            insert_feature_node(&conn, f, i as i64 + 1, 10);
        }
        for (i, f) in [f1, f2, f3, f4].iter().enumerate() {
            let res = apply(
                &mut conn,
                membership_cmd(&format!("0198a000-0000-7000-8000-0000000c02{i:02}"), 1 + i as i64, f, true),
            )
            .unwrap();
            assert!(matches!(res, ProductCommandResult::ProductCommandApplied(_)));
        }
        assert_eq!(stored_selected_feature_ids(&conn), vec![f1, f2, f3, f4]);

        // Move the third feature to the front; group membership is unchanged.
        let res = apply(
            &mut conn,
            move_forecast_feature_cmd(
                "0198a000-0000-7000-8000-0000000c0301",
                5,
                f3,
                None,
                None,
                0,
                ForecastGroupChange::Unchanged,
            ),
        )
        .unwrap();
        match res {
            ProductCommandResult::ProductCommandApplied(a) => {
                assert_eq!(a.target_revision, 6);
                let cs = a.change_set.as_ref().unwrap();
                assert!(matches!(&cs.changes[0], NodeChange::ForecastOrderSet { selected_feature_ids, prior_selected_feature_ids }
                    if selected_feature_ids == &[f3, f1, f2, f4]
                        && prior_selected_feature_ids == &[f1, f2, f3, f4]
                ));
            }
            _ => panic!("expected applied"),
        }
        assert_eq!(stored_selected_feature_ids(&conn), vec![f3, f1, f2, f4]);

        // Move f4 next to f1 and join f1's group.
        let res = apply(
            &mut conn,
            move_forecast_feature_cmd(
                "0198a000-0000-7000-8000-0000000c0302",
                6,
                f4,
                Some(f1),
                None,
                0,
                ForecastGroupChange::Join { partner_id: f1.to_string() },
            ),
        )
        .unwrap();
        match res {
            ProductCommandResult::ProductCommandApplied(a) => {
                assert_eq!(a.target_revision, 7);
                let cs = a.change_set.as_ref().unwrap();
                assert!(cs.changes.iter().any(|c| matches!(c, NodeChange::ForecastParallelGroupsSet { parallel_groups, prior_parallel_groups }
                    if parallel_groups.len() == 1
                        && parallel_groups[0].feature_ids == vec![f1.to_string(), f4.to_string()]
                        && prior_parallel_groups.is_empty()
                )));
            }
            _ => panic!("expected applied"),
        }
        let groups = stored_parallel_groups(&conn);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].feature_ids, vec![f1, f4]);
    }

    #[test]
    fn set_forecast_assignment_single_person() {
        let mut conn = setup();
        apply(&mut conn, create_project_cmd()).unwrap(); // rev 1

        let f = "0198a000-0000-7000-8000-0000000d0101";
        let p = "0198a000-0000-7000-8000-0000000d0102";
        for cmd in create_typed_feature("0198a000-0000-7000-8000-0000000d0103", f, None, 1) {
            apply(&mut conn, cmd).unwrap(); // rev 3
        }
        apply(&mut conn, add_forecast_person_cmd("0198a000-0000-7000-8000-0000000d0104", 3, p, "Ada", 100)).unwrap(); // rev 4
        apply(&mut conn, membership_cmd("0198a000-0000-7000-8000-0000000d0105", 4, f, true)).unwrap(); // rev 5

        let res = apply(
            &mut conn,
            set_forecast_assignment_cmd("0198a000-0000-7000-8000-0000000d0201", 5, f, p, true),
        )
        .unwrap();
        match res {
            ProductCommandResult::ProductCommandApplied(a) => {
                assert_eq!(a.target_revision, 6);
                let cs = a.change_set.as_ref().unwrap();
                assert!(matches!(&cs.changes[0], NodeChange::ForecastAssignmentsSet { feature_id, person_ids, prior_person_ids, .. }
                    if feature_id == f && person_ids == &[p.to_string()] && prior_person_ids.is_empty()
                ));
            }
            _ => panic!("expected applied"),
        }
        let assignments = stored_assignments(&conn);
        assert_eq!(assignments.get(f), Some(&vec![p.to_string()]));

        // Unassign removes the feature's entry entirely.
        let res = apply(
            &mut conn,
            set_forecast_assignment_cmd("0198a000-0000-7000-8000-0000000d0202", 6, f, p, false),
        )
        .unwrap();
        assert!(matches!(res, ProductCommandResult::ProductCommandApplied(_)));
        let assignments = stored_assignments(&conn);
        assert!(!assignments.contains_key(f));

        // An unknown person id is a FORECAST_ASSIGNMENT_INVALID rejection.
        let unknown_person = "0198a000-0000-7000-8000-0000000ddead";
        let unknown = apply(
            &mut conn,
            set_forecast_assignment_cmd("0198a000-0000-7000-8000-0000000d0203", 7, f, unknown_person, true),
        )
        .unwrap();
        assert!(matches!(unknown, ProductCommandResult::ProductCommandRejected(r)
            if r.code == "FORECAST_ASSIGNMENT_INVALID" && r.person_id == Some(unknown_person.to_string())
        ));
    }
}
