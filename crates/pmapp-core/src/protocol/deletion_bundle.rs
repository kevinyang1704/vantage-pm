//! Lossless version-one deletion metadata. Missing nullable fields are errors, not invented nulls.
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};
use super::{commands::NodeSnapshot, uuid_v7::is_uuid_v7};
fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// An absent legacy bundle is allowed; an explicitly null complete bundle is invalid.
pub fn present_bundle<'de,D>(deserializer:D) -> Result<Option<DeletionBundle>,D::Error>
where D: Deserializer<'de> {
    DeletionBundle::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompleteDeletedNode {
    pub node_id: String,
    pub project_id: String,
    #[serde(deserialize_with = "required_nullable")]
    pub parent_id: Option<String>,
    pub title: String,
    #[serde(deserialize_with = "required_nullable")]
    pub body_text: Option<String>,
    pub position: String,
    pub depth: i64,
    #[serde(deserialize_with = "required_nullable")]
    pub node_type: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub start_date: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub end_date: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub duration_days: Option<i64>,
    #[serde(deserialize_with = "required_nullable")]
    pub schedule_source_mode: Option<String>,
    pub completed: bool,
    #[serde(deserialize_with = "required_nullable")]
    pub effort_points: Option<i64>,
    #[serde(deserialize_with = "required_nullable")]
    pub effort_points_done: Option<i64>,
    #[serde(deserialize_with = "required_nullable")]
    pub strategic_weight: Option<i64>,
    #[serde(deserialize_with = "required_nullable")]
    pub phase_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub delivery_status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeletedCustomField {
    pub node_id: String,
    pub field_key: String,
    #[serde(deserialize_with = "required_nullable")]
    pub field_value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeletedQuestion {
    pub id: String,
    pub node_id: String,
    pub question_text: String,
    pub status: String,
    #[serde(deserialize_with = "required_nullable")]
    pub decision_text: Option<String>,
    pub position: String,
    #[serde(rename = "resolvedAtISO", deserialize_with = "required_nullable")]
    pub resolved_at_iso: Option<String>,
    #[serde(rename = "createdAtISO")]
    pub created_at_iso: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeletedEdge {
    pub id: String,
    pub source_node_id: String,
    pub target_node_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeletedAffectedReason {
    pub id: String,
    pub affected_node_id: String,
    pub causal_node_id: String,
    pub causal_node_title: String,
    pub delta_days: i64,
    pub causal_date_summary: String,
    pub created_at: String,
    #[serde(deserialize_with = "required_nullable")]
    pub acknowledged_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeletionBundle {
    pub version: u32,
    pub project_id: String,
    pub root_node_id: String,
    pub nodes: Vec<CompleteDeletedNode>,
    pub custom_fields: Vec<DeletedCustomField>,
    pub open_questions: Vec<DeletedQuestion>,
    pub unlock_edges: Vec<DeletedEdge>,
    pub affected_reasons: Vec<DeletedAffectedReason>,
}

fn valid_position(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    !digits.is_empty() && digits.bytes().all(|b|b.is_ascii_digit())
        && value.parse::<i64>().ok().is_some_and(safe)
}
fn safe(n: i64) -> bool {
    (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n)
}
fn unique(values: impl IntoIterator<Item = String>) -> bool {
    let mut seen = HashSet::new();
    values.into_iter().all(|id| seen.insert(id))
}
impl DeletionBundle {
    pub fn validate(&self, project: &str, root: &str, basic: &[NodeSnapshot]) -> Result<(), ()> {
        if self.version != 1 || self.project_id != project || self.root_node_id != root
            || !is_uuid_v7(project) || !is_uuid_v7(root) || self.nodes.is_empty()
            || basic.len() != self.nodes.len() {
            return Err(());
        }
        let nodes: HashMap<_,_> = self.nodes.iter().map(|n| (n.node_id.as_str(),n)).collect();
        if nodes.len() != self.nodes.len() || !nodes.contains_key(root)
            || !unique(basic.iter().map(|n| n.node_id.clone())) {
            return Err(());
        }
        for n in &self.nodes {
            if !is_uuid_v7(&n.node_id) || n.project_id != project || n.depth < 0 || !safe(n.depth)
                || n.parent_id.as_ref().is_some_and(|id| !is_uuid_v7(id))
                || n.phase_id.as_ref().is_some_and(|id| !is_uuid_v7(id))
                || !valid_position(&n.position)
                || [n.duration_days,n.effort_points,n.effort_points_done,n.strategic_weight].iter().flatten().any(|n| !safe(*n)) {
                return Err(());
            }
            if n.node_id == root {
                if n.depth != 0 || n.parent_id.as_ref().is_some_and(|id| nodes.contains_key(id.as_str())) {
                    return Err(());
                }
            } else if n.depth == 0 || n.parent_id.as_ref().and_then(|id| nodes.get(id.as_str())).map_or(true, |parent| parent.depth + 1 != n.depth) {
                return Err(());
            }
            let legacy = basic.iter().find(|row| row.node_id == n.node_id).ok_or(())?;
            if legacy.parent_id != n.parent_id || legacy.title != n.title || legacy.body_text != n.body_text || legacy.position != n.position || legacy.depth != n.depth {
                return Err(());
            }
        }
        if !unique(self.custom_fields.iter().map(|r| format!("{}:{}",r.node_id,r.field_key)))
            || self.custom_fields.iter().any(|r| !nodes.contains_key(r.node_id.as_str())) {
            return Err(());
        }
        if !unique(self.open_questions.iter().map(|r| r.id.clone())) || self.open_questions.iter().any(|r|
            !is_uuid_v7(&r.id) || !nodes.contains_key(r.node_id.as_str())
            || !matches!(r.status.as_str(),"OPEN"|"DECIDED")
            || !valid_position(&r.position)) {
            return Err(());
        }
        if !unique(self.unlock_edges.iter().map(|r| r.id.clone()))
            || !unique(self.unlock_edges.iter().map(|r| format!("{}:{}",r.source_node_id,r.target_node_id)))
            || self.unlock_edges.iter().any(|r| !is_uuid_v7(&r.id) || !is_uuid_v7(&r.source_node_id) || !is_uuid_v7(&r.target_node_id)
                || (!nodes.contains_key(r.source_node_id.as_str()) && !nodes.contains_key(r.target_node_id.as_str()))) {
            return Err(());
        }
        if !unique(self.affected_reasons.iter().map(|r| r.id.clone())) || self.affected_reasons.iter().any(|r|
            !is_uuid_v7(&r.id) || !is_uuid_v7(&r.affected_node_id) || !is_uuid_v7(&r.causal_node_id) || !safe(r.delta_days)
            || (!nodes.contains_key(r.affected_node_id.as_str()) && !nodes.contains_key(r.causal_node_id.as_str()))) {
            return Err(());
        }
        Ok(())
    }
}
