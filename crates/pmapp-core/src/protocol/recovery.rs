//! Typed recovery graph and immutable terminal history. No defaults invent legacy facts.
use serde::{Deserialize,Serialize,Deserializer};
use super::{commands::{ProductCommand,ProductCommandResult},errors::RepositoryError};
/// Validated command semantics with the original wire object retained verbatim.
#[derive(Debug,Clone)]
pub struct ImmutableCommand { pub wire: serde_json::Value, pub typed: ProductCommand }
impl ImmutableCommand {
    pub fn from_wire(wire:serde_json::Value)->Result<Self,RepositoryError> {
        let typed=serde_json::from_value(wire.clone()).map_err(|_|RepositoryError::InvalidRequest)?;
        Ok(Self{wire,typed})
    }
}
impl Serialize for ImmutableCommand {
    fn serialize<S:serde::Serializer>(&self,serializer:S)->Result<S::Ok,S::Error> {self.wire.serialize(serializer)}
}
impl<'de> Deserialize<'de> for ImmutableCommand {
    fn deserialize<D:Deserializer<'de>>(deserializer:D)->Result<Self,D::Error> {
        let wire=serde_json::Value::deserialize(deserializer)?;
        Self::from_wire(wire).map_err(|_|serde::de::Error::custom("INVALID_COMMAND"))
    }
}
fn nullable<'de,D,T>(deserializer:D)->Result<Option<T>,D::Error>
where D:Deserializer<'de>,T:Deserialize<'de> { Option::<T>::deserialize(deserializer) }
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RecoveryProjectRow {
    pub id: String,
    pub name: String,
    pub revision: i64,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RecoveryPhasesRow {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub position: i64,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RecoveryNodesRow {
    pub id: String,
    pub project_id: String,
    #[serde(deserialize_with="nullable")]
    pub parent_id: Option<String>,
    pub title: String,
    #[serde(deserialize_with="nullable")]
    pub body_text: Option<String>,
    pub position: i64,
    #[serde(deserialize_with="nullable")]
    pub node_type: Option<String>,
    #[serde(deserialize_with="nullable")]
    pub start_date: Option<String>,
    #[serde(deserialize_with="nullable")]
    pub end_date: Option<String>,
    #[serde(deserialize_with="nullable")]
    pub duration_days: Option<i64>,
    #[serde(deserialize_with="nullable")]
    pub schedule_source_mode: Option<String>,
    pub completed: bool,
    #[serde(deserialize_with="nullable")]
    pub effort_points: Option<i64>,
    #[serde(deserialize_with="nullable")]
    pub effort_points_done: Option<i64>,
    #[serde(deserialize_with="nullable")]
    pub strategic_weight: Option<i64>,
    #[serde(deserialize_with="nullable")]
    pub phase_id: Option<String>,
    #[serde(deserialize_with="nullable")]
    pub delivery_status: Option<String>,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RecoveryCustomFieldsRow {
    pub project_id: String,
    pub node_id: String,
    pub field_key: String,
    #[serde(deserialize_with="nullable")]
    pub field_value: Option<String>,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RecoveryTypeTemplateFieldsRow {
    pub project_id: String,
    pub node_type: String,
    pub field_key: String,
    pub field_label: String,
    pub position: i64,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RecoveryUnlockEdgesRow {
    pub id: String,
    pub project_id: String,
    pub source_node_id: String,
    pub target_node_id: String,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RecoveryDismissalsRow {
    pub project_id: String,
    pub finding_id: String,
    pub finding_kind: String,
    pub target_id: String,
    pub fingerprint: String,
    pub dismissed_at: String,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RecoveryAffectedReasonsRow {
    pub id: String,
    pub project_id: String,
    pub affected_node_id: String,
    pub causal_node_id: String,
    pub causal_node_title: String,
    pub delta_days: i64,
    pub causal_date_summary: String,
    pub created_at: String,
    #[serde(deserialize_with="nullable")]
    pub acknowledged_at: Option<String>,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RecoveryOpenQuestionsRow {
    pub id: String,
    pub project_id: String,
    pub node_id: String,
    pub question_text: String,
    pub status: String,
    #[serde(deserialize_with="nullable")]
    pub decision_text: Option<String>,
    pub position: i64,
    #[serde(deserialize_with="nullable")]
    pub resolved_at_iso: Option<String>,
    pub created_at_iso: String,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RecoveryForecastPlansRow {
    pub project_id: String,
    pub selected_feature_ids: String,
    pub parallel_groups: String,
    pub blocked_feature_ids: String,
    #[serde(deserialize_with="nullable")]
    pub points_per_sprint: Option<i64>,
    #[serde(deserialize_with="nullable")]
    pub sprint_length_days: Option<i64>,
    pub cadence: String,
    #[serde(deserialize_with="nullable")]
    pub start_sprint_ordinal: Option<i64>,
    #[serde(deserialize_with="nullable")]
    pub start_date: Option<String>,
    pub policy_version: String,
    pub planning_level: String,
    pub roster: String,
    pub assignments: String,
    pub sprint_plan: String,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RecoveryForecastScenariosRow {
    pub scenario_id: String,
    pub project_id: String,
    pub label: String,
    pub baseline_revision: i64,
    pub baseline_fingerprint: String,
    pub policy_version: String,
    pub created_at_iso: String,
    pub baseline_json: String,
    pub patch_json: String,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RecoveryGraph {
    pub project: RecoveryProjectRow,
    pub phases: Vec<RecoveryPhasesRow>,
    pub nodes: Vec<RecoveryNodesRow>,
    pub custom_fields: Vec<RecoveryCustomFieldsRow>,
    pub type_template_fields: Vec<RecoveryTypeTemplateFieldsRow>,
    pub unlock_edges: Vec<RecoveryUnlockEdgesRow>,
    pub dismissals: Vec<RecoveryDismissalsRow>,
    pub affected_reasons: Vec<RecoveryAffectedReasonsRow>,
    pub open_questions: Vec<RecoveryOpenQuestionsRow>,
    pub forecast_plans: Vec<RecoveryForecastPlansRow>,
    pub forecast_scenarios: Vec<RecoveryForecastScenariosRow>,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum FootprintTarget {
    Entity { entity_type: String, id: String },
    Field { entity_type: String, id: String, field: String },
    Order { collection_type: String, owner_id: String },
    Reference { relation: String, source_id: String, target_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryFootprints {
    pub availability: String,
    pub known_targets: Vec<FootprintTarget>,
    #[serde(deserialize_with="nullable")]
    pub reason: Option<String>,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ConfirmedHistoryEntry {
    pub command: ImmutableCommand,
    pub result: ProductCommandResult,
    pub payload_digest: String,
    pub wire_identity_availability: String,
    #[serde(deserialize_with="nullable")]
    pub actor_id: Option<String>,
    pub protocol_version: String,
    pub server_revision: i64,
    pub receipt_revision_availability: String,
    #[serde(deserialize_with="nullable")]
    pub recorded_at_iso: Option<String>,
    #[serde(deserialize_with="nullable")]
    pub label: Option<String>,
    pub command_footprint: RecoveryFootprints,
    pub effect_footprint: RecoveryFootprints,
    pub deletion_metadata: String,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct TerminalRejection {
    pub command: ImmutableCommand,
    pub result: ProductCommandResult,
    pub payload_digest: String,
    pub wire_identity_availability: String,
    #[serde(deserialize_with="nullable")]
    pub actor_id: Option<String>,
    pub protocol_version: String,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RecoveryEnvelope {
    pub version: u32,
    pub protocol_version: String,
    pub project_id: String,
    pub stream_epoch: i64,
    pub server_revision: i64,
    pub history_floor: i64,
    pub dedup_coverage: String,
    pub graph: RecoveryGraph,
    pub confirmed_history: Vec<ConfirmedHistoryEntry>,
    pub terminal_rejections: Vec<TerminalRejection>,
}
pub fn payload_digest(command:&ImmutableCommand)->Result<String,RepositoryError> {
    use sha2::{Digest,Sha256};
    let mut value=command.wire.clone();
    value.as_object_mut().ok_or(RepositoryError::InvalidRequest)?.remove("commandId");
    let bytes=serde_json_canonicalizer::to_vec(&value).map_err(|_|RepositoryError::InvalidRequest)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn safe(value:i64)->bool { (0..=9_007_199_254_740_991).contains(&value) }
fn unique(values:impl IntoIterator<Item=String>)->bool {
    let mut seen=std::collections::HashSet::new();values.into_iter().all(|value|seen.insert(value))
}
fn targets_valid(value:&RecoveryFootprints)->bool {
    unique(value.known_targets.iter().map(|target| serde_json::to_string(target).unwrap_or_default()))
        && value.known_targets.iter().all(|target| match target {
            FootprintTarget::Entity { entity_type, id } => !entity_type.is_empty() && !id.is_empty(),
            FootprintTarget::Field { entity_type, id, field } => !entity_type.is_empty() && !id.is_empty() && !field.is_empty(),
            FootprintTarget::Order { collection_type, owner_id } => !collection_type.is_empty() && !owner_id.is_empty(),
            FootprintTarget::Reference { relation, source_id, target_id } => !relation.is_empty() && !source_id.is_empty() && !target_id.is_empty(),
        })
        && match value.availability.as_str() {
            "complete"=>value.reason.is_none(),
            "unavailable"=>value.reason.as_ref().is_some_and(|s|!s.is_empty()),
            _=>false,
        }
}
pub fn deletion_metadata(result:&ProductCommandResult)->String {
    if let ProductCommandResult::ProductCommandApplied(applied)=result {
        if let Some(changes)=&applied.change_set {
            for change in &changes.changes {
                if let super::commands::NodeChange::SubtreeDeleted{deletion_bundle,..}=change {
                    return if deletion_bundle.is_some(){"complete"}else{"legacy-incomplete"}.into();
                }
            }
        }
    }
    "not-applicable".into()
}
impl RecoveryEnvelope {
    pub fn validate(&self,project:&str)->Result<(),RepositoryError> {
        use super::commands::ProductCommandResult::*;
        let invalid=||RepositoryError::InvalidRequest;
        if self.version!=1 || self.protocol_version!=super::PROTOCOL_VERSION || self.project_id!=project
            || !super::uuid_v7::is_uuid_v7(project) || !safe(self.stream_epoch) || self.stream_epoch==0
            || !safe(self.server_revision) || !safe(self.history_floor) || self.history_floor>self.server_revision
            || !matches!(self.dedup_coverage.as_str(),"complete"|"unavailable")
            || self.graph.project.id!=project || self.graph.project.revision!=self.server_revision {
            return Err(invalid());
        }
        self.graph.validate(project)?;
        let mut ids=std::collections::HashSet::new();
        let mut revision=self.history_floor;
        for entry in &self.confirmed_history {
            let command=&entry.command.typed;
            revision+=1;
            if entry.server_revision!=revision || revision>self.server_revision || command.project_id()!=project
                || !ids.insert(command.command_id().to_string()) || !super::uuid_v7::is_uuid_v7(command.command_id())
                || entry.protocol_version!=command.protocol_version() || command.actor_id().is_some_and(|actor| entry.actor_id.as_deref() != Some(actor))
                || !matches!(entry.wire_identity_availability.as_str(), "original" | "legacy-admitted-wire")
                || payload_digest(&entry.command)?!=entry.payload_digest || !targets_valid(&entry.command_footprint)
                || !targets_valid(&entry.effect_footprint) || deletion_metadata(&entry.result)!=entry.deletion_metadata {
                return Err(invalid());
            }
            super::super::db::handler::validate_command(command)?;
            match &entry.result {
                ProductCommandApplied(applied) if applied.command_id==command.command_id()
                    && applied.project_id==project && applied.protocol_version==self.protocol_version=>{
                        let authoritative = entry.receipt_revision_availability == "authoritative"
                            && applied.base_revision == revision - 1 && applied.target_revision == revision;
                        let legacy = entry.receipt_revision_availability == "legacy-client-revision"
                            && entry.command_footprint.availability == "unavailable"
                            && entry.effect_footprint.availability == "unavailable"
                            && applied.base_revision == command.base_revision()
                            && applied.target_revision == command.expected_revision()
                            && applied.target_revision < revision;
                        if !authoritative && !legacy { return Err(invalid()); }
                        if let Some(changes)=&applied.change_set {
                            if changes.project_id!=project || changes.protocol_version != self.protocol_version
                                || changes.base_revision != applied.base_revision || changes.target_revision != applied.target_revision {
                                return Err(invalid());
                            }
                            for change in &changes.changes {
                                if let super::commands::NodeChange::SubtreeDeleted{root_node_id,nodes,deletion_bundle:Some(bundle)}=change {
                                    bundle.validate(project,root_node_id,nodes).map_err(|_|invalid())?;
                                }
                            }
                        }
                    },
                _=>return Err(invalid()),
            }
        }
        if revision!=self.server_revision {return Err(invalid());}
        for entry in &self.terminal_rejections {
            let command=&entry.command.typed;
            if command.project_id()!=project || !ids.insert(command.command_id().to_string())
                || !super::uuid_v7::is_uuid_v7(command.command_id()) || command.actor_id().is_some_and(|actor| entry.actor_id.as_deref() != Some(actor))
                || entry.protocol_version!=command.protocol_version() || !matches!(entry.wire_identity_availability.as_str(), "original" | "legacy-admitted-wire")
                || payload_digest(&entry.command)?!=entry.payload_digest {
                return Err(invalid());
            }
            super::super::db::handler::validate_command(command)?;
            match &entry.result {
                ProductCommandRejected(rejected) if rejected.command_id==command.command_id()
                    && rejected.protocol_version==self.protocol_version && rejected.project_id.as_deref().map_or(true,|id|id==project)
                    && !matches!(rejected.code.as_str(),"INTERNAL"|"STORAGE_FULL")=>{},
                _=>return Err(invalid()),
            }
        }
        Ok(())
    }
}
impl RecoveryGraph {
    pub fn validate(&self,project:&str)->Result<(),RepositoryError> {
        use std::collections::{HashMap,HashSet};
        let invalid=||RepositoryError::InvalidRequest;
        let node_map:HashMap<_,_>=self.nodes.iter().map(|n|(n.id.as_str(),n)).collect();
        let phases:HashSet<_>=self.phases.iter().map(|p|p.id.as_str()).collect();
        if node_map.len()!=self.nodes.len() || phases.len()!=self.phases.len() || self.forecast_plans.len()>1 {return Err(invalid());}
        let rank=|t:Option<&str>|["Vision","Theme","Component","Feature","AcceptanceCriterion"].iter().position(|v|Some(*v)==t);
        let mut positions=HashSet::new();
        for n in &self.nodes {
            if n.project_id!=project || !super::uuid_v7::is_uuid_v7(&n.id)
                || n.position.unsigned_abs()>9_007_199_254_740_991
                || !positions.insert((n.parent_id.clone(),n.position))
                || n.phase_id.as_deref().is_some_and(|id|!phases.contains(id)) {return Err(invalid());}
            if let Some(parent)=n.parent_id.as_deref() {
                let parent=node_map.get(parent).ok_or_else(invalid)?;
                if let (Some(p),Some(c))=(rank(parent.node_type.as_deref()),rank(n.node_type.as_deref())) {
                    if p>c {return Err(invalid());}
                }
            }
            let mut current=Some(n.id.as_str());let mut seen=HashSet::new();
            while let Some(id)=current {
                if !seen.insert(id) {return Err(invalid());}
                current=node_map.get(id).ok_or_else(invalid)?.parent_id.as_deref();
            }
        }
        for p in &self.phases {if p.project_id!=project || !super::uuid_v7::is_uuid_v7(&p.id) {return Err(invalid());}}
        if !unique(self.custom_fields.iter().map(|r|serde_json::json!([r.node_id,r.field_key]).to_string()))
            || !unique(self.type_template_fields.iter().map(|r|serde_json::json!([r.node_type,r.field_key]).to_string()))
            || !unique(self.unlock_edges.iter().map(|r|r.id.clone()))
            || !unique(self.unlock_edges.iter().map(|r|serde_json::json!([r.source_node_id,r.target_node_id]).to_string()))
            || !unique(self.open_questions.iter().map(|r|r.id.clone()))
            || !unique(self.affected_reasons.iter().map(|r|r.id.clone()))
            || !unique(self.forecast_scenarios.iter().map(|r|r.scenario_id.clone()))
            || !unique(self.dismissals.iter().map(|r|serde_json::json!([r.finding_kind,r.target_id,r.fingerprint]).to_string())) {return Err(invalid());}
        for r in &self.custom_fields {if r.project_id!=project || !node_map.contains_key(r.node_id.as_str()) {return Err(invalid());}}
        for r in &self.type_template_fields {if r.project_id!=project {return Err(invalid());}}
        for r in &self.dismissals {if r.project_id!=project {return Err(invalid());}}
        for r in &self.unlock_edges {if r.project_id!=project || !super::uuid_v7::is_uuid_v7(&r.id) || !node_map.contains_key(r.source_node_id.as_str()) || !node_map.contains_key(r.target_node_id.as_str()) {return Err(invalid());}}
        for r in &self.affected_reasons {if r.project_id!=project || !super::uuid_v7::is_uuid_v7(&r.id) || !node_map.contains_key(r.affected_node_id.as_str()) || !node_map.contains_key(r.causal_node_id.as_str()) {return Err(invalid());}}
        for r in &self.open_questions {if r.project_id!=project || !super::uuid_v7::is_uuid_v7(&r.id) || !node_map.contains_key(r.node_id.as_str()) || !matches!(r.status.as_str(),"OPEN"|"DECIDED") {return Err(invalid());}}
        for r in &self.forecast_plans {
            if r.project_id!=project {return Err(invalid());}
            super::recovery_forecast::validate_plan(r)?;
        }
        for r in &self.forecast_scenarios {
            if r.project_id!=project || !super::uuid_v7::is_uuid_v7(&r.scenario_id) {return Err(invalid());}
            super::recovery_forecast::validate_scenario(r, project)?;
        }
        Ok(())
    }
}

/// Validate one immutable stream receipt using the same history contract as a
/// full envelope. This does not invent a project graph or claim graph coverage.
pub fn validate_history_entry(entry: &ConfirmedHistoryEntry, project: &str) -> Result<(), RepositoryError> {
    let graph = RecoveryGraph {
        project: RecoveryProjectRow { id: project.into(), name: String::new(), revision: entry.server_revision },
        phases: vec![], nodes: vec![], custom_fields: vec![], type_template_fields: vec![], unlock_edges: vec![],
        dismissals: vec![], affected_reasons: vec![], open_questions: vec![], forecast_plans: vec![], forecast_scenarios: vec![],
    };
    RecoveryEnvelope {
        version: 1, protocol_version: super::PROTOCOL_VERSION.into(), project_id: project.into(), stream_epoch: 1,
        server_revision: entry.server_revision, history_floor: entry.server_revision - 1, dedup_coverage: "unavailable".into(),
        graph, confirmed_history: vec![entry.clone()], terminal_rejections: vec![],
    }.validate(project)
}

/// Overlap is semantic: row lifecycle intersects its fields and reference
/// endpoints; unrelated fields and collection orders remain independent.
pub fn footprint_targets_overlap(left: &FootprintTarget, right: &FootprintTarget) -> bool {
    use FootprintTarget::*;
    match (left, right) {
        (Entity { entity_type: a, id: x }, Entity { entity_type: b, id: y })
        | (Entity { entity_type: a, id: x }, Field { entity_type: b, id: y, .. })
        | (Field { entity_type: a, id: x, .. }, Entity { entity_type: b, id: y }) => a == b && x == y,
        (Entity { id, .. }, Reference { source_id, target_id, .. })
        | (Reference { source_id, target_id, .. }, Entity { id, .. }) => id == source_id || id == target_id,
        (Field { entity_type: a, id: x, field: f }, Field { entity_type: b, id: y, field: g }) => a == b && x == y && f == g,
        (Order { collection_type: a, owner_id: x }, Order { collection_type: b, owner_id: y }) => a == b && x == y,
        (Reference { relation: a, source_id: x, target_id: y }, Reference { relation: b, source_id: z, target_id: w }) => a == b && x == z && y == w,
        _ => false,
    }
}

/// Original identities use exact JCS. Historic admitted identities permit only
/// the explicitly documented server actor/default serialization changes.
pub fn immutable_wire_identity_matches(
    pending: &ImmutableCommand,
    authoritative: &ImmutableCommand,
    availability: &str,
    actor: Option<&str>,
) -> Result<bool, RepositoryError> {
    use serde_json::Value;
    let mut original = pending.wire.clone();
    let mut retained = authoritative.wire.clone();
    let command = &pending.typed;
    if command.actor_id().is_some_and(|authored| Some(authored) != actor) { return Ok(false); }
    if availability == "legacy-admitted-wire" {
        if actor.is_none() { return Ok(false); }
        if authoritative.typed.actor_id().is_some_and(|retained| Some(retained) != actor) { return Ok(false); }
        if command.actor_id().is_none() {
            original.as_object_mut().ok_or(RepositoryError::IntegrityFailed)?.remove("actorId");
            retained.as_object_mut().ok_or(RepositoryError::IntegrityFailed)?.remove("actorId");
        }
        // Exactly the legacy Rust serializer defaults documented by the wire
        // contract. Unknown or authored nested nulls retain their identity.
        let fields: &[&str] = match command.kind() {
            "MoveNode" => &["afterId", "beforeId", "intendedIndex"],
            "SetNodeEffort" => &["restoredAssignments"],
            "RestoreForecastScope" | "RestoreForecastPlanningLevel" | "RestoreForecastPerson" => &["assignments"],
            _ => &[],
        };
        for value in [&mut original, &mut retained] {
            let object = value.as_object_mut().ok_or(RepositoryError::IntegrityFailed)?;
            for field in fields {
                if object.get(*field).map_or(true, Value::is_null) { object.remove(*field); }
            }
            if command.kind() == "ConfigureForecastPlan" { object.entry("planningLevel").or_insert(Value::Null); }
            if matches!(command.kind(), "RestoreForecastScope" | "RestoreForecastPlanningLevel") {
                object.entry("blockedFeatureIds").or_insert(Value::Array(vec![]));
            }
        }
    }
    let original = ImmutableCommand::from_wire(original)?;
    let retained = ImmutableCommand::from_wire(retained)?;
    Ok(original.typed.command_id() == retained.typed.command_id()
        && original.typed.project_id() == retained.typed.project_id()
        && payload_digest(&original)? == payload_digest(&retained)?)
}
