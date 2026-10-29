//! Throwaway spike for Story 27.1, AC 27.1-6.
//!
//! Two replicas (desktop clients) submit commands to a minimal service that
//! orders them and applies them with the same *shape* as the native handler:
//! one "transaction" per command, a receipt ledger keyed by `command_id`, and a
//! convergence check by canonical state compare. The server assigns contiguous
//! revisions in arrival order and streams them back; each client replays the
//! server order.
//!
//! Three D8 cases are exercised:
//!   1. concurrent renames (same-field, later-confirmed wins);
//!   2. concurrent reorders (placement, after/before anchors with fallback);
//!   3. a delete racing an edit (delete beats edit; edit rejected TargetDeleted).
//!
//! The goal is to discover whether the existing handler/receipt/revision shape
//! is sufficient for D2/D3, not to be production code.

use std::collections::{BTreeMap, BTreeSet};

pub type Id = String;
pub type CommandId = String;
pub type ActorId = String;

/// A list node: parent + neighbor-based ordering, mirroring `MoveNode` intent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    pub title: String,
    pub parent: Id,
    pub position: Vec<Id>,
}

/// Minimal project state shared by both replicas and the service.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Project {
    pub nodes: BTreeMap<Id, Node>,
    /// Deterministic tombstones, so a rejected edit names a deleted target.
    pub deleted: BTreeSet<Id>,
}

/// The server-ordered command set relevant to the spike.
#[derive(Clone, Debug)]
pub enum Command {
    Rename {
        command_id: CommandId,
        actor: ActorId,
        target: Id,
        title: String,
    },
    /// A move carries both neighbors, "after Y, before Z"; either may be empty.
    Move {
        command_id: CommandId,
        actor: ActorId,
        target: Id,
        after: Option<Id>,
        before: Option<Id>,
        intended_index: usize,
    },
    Delete {
        command_id: CommandId,
        actor: ActorId,
        target: Id,
    },
    /// Today's whole-list shape (`ReorderForecastFeatures`): the full order,
    /// with no anchors. Included only to demonstrate its concurrent behaviour.
    SetOrder {
        command_id: CommandId,
        actor: ActorId,
        order: Vec<Id>,
    },
}

impl Command {
    pub fn command_id(&self) -> &str {
        match self {
            Command::Rename { command_id, .. }
            | Command::Move { command_id, .. }
            | Command::Delete { command_id, .. }
            | Command::SetOrder { command_id, .. } => command_id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rejection {
    TargetDeleted,
    DestinationMissing,
    WouldCreateCycle,
    SelfAnchor,
}

/// The terminal outcome, mirroring `ProductCommandResult`'s shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Applied,
    Rejected(Rejection),
    /// Re-use of a command id with a different payload.
    CommandIdReuse,
}

/// One server-ordered log entry: the command plus its assigned server revision.
#[derive(Clone, Debug)]
pub struct LogEntry {
    pub server_revision: i64,
    pub command: Command,
    pub outcome: Outcome,
}

// ── Minimal service (D1): orders every command and assigns revisions ──────

pub struct Service {
    pub order: Vec<LogEntry>,
    /// commandId -> (payload digest, terminal result). Bound per R2.
    receipts: BTreeMap<CommandId, (u64, Outcome)>,
    pub next_revision: i64,
}

impl Service {
    pub fn new() -> Self {
        Service {
            order: Vec::new(),
            receipts: BTreeMap::new(),
            next_revision: 1,
        }
    }

    /// Accepts in arrival order, applies with the handler shape, assigns the
    /// next contiguous revision, and records the terminal result.
    pub fn submit(&mut self, state: &mut Project, command: Command) -> Outcome {
        let digest = payload_digest(&command);
        if let Some((stored_digest, stored_outcome)) = self.receipts.get(command.command_id()) {
            if *stored_digest != digest {
                return Outcome::CommandIdReuse;
            }
            // Identical retry: return the recorded terminal result, no re-apply.
            return stored_outcome.clone();
        }

        let outcome = apply_one(state, &command);
        self.order.push(LogEntry {
            server_revision: self.next_revision,
            command: command.clone(),
            outcome: outcome.clone(),
        });
        self.next_revision += 1;
        self.receipts
            .insert(command.command_id().to_string(), (digest, outcome.clone()));
        outcome
    }
}

impl Default for Service {
    fn default() -> Self {
        Self::new()
    }
}

/// Applies one command with D8 rules. This is the native handler's shape:
/// the mutation happens only for the `Applied` outcome.
pub fn apply_one(state: &mut Project, command: &Command) -> Outcome {
    match command {
        Command::Rename { target, title, .. } => {
            if state.deleted.contains(target) || !state.nodes.contains_key(target) {
                return Outcome::Rejected(Rejection::TargetDeleted);
            }
            // D8(a) same-field later-confirmed wins: server order is the order.
            if let Some(node) = state.nodes.get_mut(target) {
                node.title = title.clone();
            }
            Outcome::Applied
        }
        Command::Delete { target, .. } => {
            // D8(b) delete beats a concurrent edit: applying the delete removes
            // the node and records the tombstone; a later edit is rejected.
            if state.nodes.remove(target).is_some() {
                state.deleted.insert(target.clone());
                Outcome::Applied
            } else {
                Outcome::Rejected(Rejection::TargetDeleted)
            }
        }
        Command::Move {
            target,
            after,
            before,
            intended_index,
            ..
        } => {
            if state.deleted.contains(target) || !state.nodes.contains_key(target) {
                return Outcome::Rejected(Rejection::TargetDeleted);
            }
            if after.as_deref() == Some(target.as_str())
                || before.as_deref() == Some(target.as_str())
            {
                return Outcome::Rejected(Rejection::SelfAnchor);
            }
            let parent = state.nodes[target].parent.clone();

            // Siblings in current order.
            let mut siblings: Vec<Id> = state
                .nodes
                .iter()
                .filter(|(id, n)| n.parent == parent && *id != target)
                .map(|(id, _)| id.clone())
                .collect();
            siblings.sort_by(|a, b| {
                state.nodes[a]
                    .position
                    .cmp(&state.nodes[b].position)
                    .then_with(|| a.cmp(b))
            });

            // D8(c) ordered fallback: after Y; else before Z; else intended
            // index clamped; never silently to the end.
            let insert_at = resolve_index(&siblings, after, before, *intended_index);

            // Detect a cycle: the target cannot move inside its own subtree.
            if let Some(anchor) = after.as_ref().or(before.as_ref()) {
                if is_descendant(&state.nodes, anchor, target) {
                    return Outcome::Rejected(Rejection::WouldCreateCycle);
                }
            }

            siblings.insert(insert_at.min(siblings.len()), target.clone());
            apply_order(state, &parent, &siblings);
            Outcome::Applied
        }
        Command::SetOrder { order, .. } => {
            for target in order {
                if state.deleted.contains(target) || !state.nodes.contains_key(target) {
                    return Outcome::Rejected(Rejection::TargetDeleted);
                }
            }
            let parent = state
                .nodes
                .get(&order[0])
                .map(|n| n.parent.clone())
                .unwrap_or_default();
            apply_order(state, &parent, order);
            Outcome::Applied
        }
    }
}

/// D8(c): after Y; else before Z; else the intended index, clamped.
fn resolve_index(
    siblings: &[Id],
    after: &Option<Id>,
    before: &Option<Id>,
    intended: usize,
) -> usize {
    if let Some(after) = after {
        if let Some(pos) = siblings.iter().position(|s| s == after) {
            return pos + 1;
        }
    }
    if let Some(before) = before {
        if let Some(pos) = siblings.iter().position(|s| s == before) {
            return pos;
        }
    }
    intended.min(siblings.len())
}

fn is_descendant(nodes: &BTreeMap<Id, Node>, candidate: &str, ancestor: &str) -> bool {
    let mut current = Some(candidate.to_string());
    let mut guard = 0;
    while let Some(id) = current {
        if id == ancestor {
            return true;
        }
        guard += 1;
        if guard > nodes.len() {
            return false;
        }
        current = nodes.get(&id).map(|n| n.parent.clone());
    }
    false
}

/// Reassigns a deterministic order (integer positions) to a sibling list.
fn apply_order(state: &mut Project, _parent: &str, siblings: &[Id]) {
    for (i, id) in siblings.iter().enumerate() {
        if let Some(node) = state.nodes.get_mut(id) {
            node.position = vec![format!("{i:08}")];
        }
    }
}

/// R2 payload digest surrogate: a stable hash of the command body with the
/// command id omitted. Real binding is SHA-256; a stable fold is enough here.
fn payload_digest(command: &Command) -> u64 {
    let canonical = match command {
        Command::Rename { actor, target, title, .. } => format!("Rename|{actor}|{target}|{title}"),
        Command::Move {
            actor,
            target,
            after,
            before,
            intended_index,
            ..
        } => format!(
            "Move|{actor}|{target}|{:?}|{:?}|{intended_index}",
            after, before
        ),
        Command::Delete { actor, target, .. } => format!("Delete|{actor}|{target}"),
        Command::SetOrder { actor, order, .. } => format!("SetOrder|{actor}|{}", order.join(",")),
    };
    // FNV-1a, stable and dependency-free.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in canonical.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

// ── Client replica (D1): applies the server order ─────────────────────────

#[derive(Clone, Default)]
pub struct Replica {
    pub state: Project,
    /// Highest server revision applied.
    pub cursor: i64,
}

impl Replica {
    pub fn new() -> Self {
        Replica {
            state: Project::default(),
            cursor: 0,
        }
    }

    /// Catches up to the server order, applying only confirmed entries after
    /// the cursor (the R4 rebase, reduced: no unconfirmed local queue here).
    pub fn catch_up(&mut self, service: &Service) {
        let cursor = self.cursor;
        for entry in service.order.iter().filter(|e| e.server_revision > cursor) {
            if matches!(entry.outcome, Outcome::Applied) {
                let outcome = apply_one(&mut self.state, &entry.command);
                debug_assert_eq!(outcome, Outcome::Applied);
            }
            self.cursor = entry.server_revision;
        }
    }
}

/// R11 canonical state compare: sorted, tombstone-aware.
pub fn canonical(state: &Project) -> String {
    let mut out = String::new();
    for (id, node) in &state.nodes {
        out.push_str(&format!(
            "{id}|{}|{}|{:?}\n",
            node.title, node.parent, node.position
        ));
    }
    out.push_str("--deleted--\n");
    for id in &state.deleted {
        out.push_str(&format!("{id}\n"));
    }
    out
}


