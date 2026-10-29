//! Validation of captured forecast facts; stale and historical node references
//! remain authored facts, not lookups against the current live graph.
use std::collections::HashSet;
use serde_json::{Map, Value};
use super::recovery::{RecoveryForecastPlansRow, RecoveryForecastScenariosRow};
use super::RepositoryError;

const MAX: i64 = 9_007_199_254_740_991;
fn invalid() -> RepositoryError { RepositoryError::InvalidRequest }
fn object(value: &Value) -> Result<&Map<String, Value>, RepositoryError> { value.as_object().ok_or_else(invalid) }
fn allowed(value: &Map<String, Value>, keys: &[&str]) -> bool { value.keys().all(|key| keys.contains(&key.as_str())) }
fn exact(value: &Map<String, Value>, keys: &[&str]) -> bool { value.len() == keys.len() && allowed(value, keys) }
fn uuid(value: &Value) -> bool { value.as_str().is_some_and(super::uuid_v7::is_uuid_v7) }
fn number(value: &Value, min: i64) -> bool { value.as_i64().is_some_and(|n| n >= min && n <= MAX) }
fn nullable_number(value: &Value, min: i64) -> bool { value.is_null() || number(value, min) }
fn policy(value: &str) -> bool { matches!(value, "shared-capacity-v1" | "staffed-capacity-v1") }
fn level(value: &str) -> bool { matches!(value, "Theme" | "Component" | "Feature") }
fn ids(value: &Value, unique: bool) -> Result<Vec<String>, RepositoryError> {
    let values = value.as_array().ok_or_else(invalid)?;
    if values.iter().any(|id| !uuid(id)) { return Err(invalid()); }
    let values = values.iter().map(|id| id.as_str().unwrap().to_owned()).collect::<Vec<_>>();
    if unique && values.iter().collect::<HashSet<_>>().len() != values.len() { return Err(invalid()); }
    Ok(values)
}
fn roster(value: &Value) -> Result<HashSet<String>, RepositoryError> {
    let mut people = HashSet::new();
    for person in value.as_array().ok_or_else(invalid)? {
        let person = object(person)?;
        if !exact(person, &["id", "name", "weightUnits"]) || !uuid(&person["id"])
            || person["name"].as_str().map_or(true, |name| name.trim().is_empty())
            || !number(&person["weightUnits"], 1) || !people.insert(person["id"].as_str().unwrap().into()) { return Err(invalid()); }
    }
    Ok(people)
}
fn groups(value: &Value, scope: &[String], live: bool) -> Result<(), RepositoryError> {
    let mut grouped = HashSet::new();
    for group in value.as_array().ok_or_else(invalid)? {
        let group = object(group)?;
        if !exact(group, &["featureIds"]) { return Err(invalid()); }
        let members = ids(&group["featureIds"], live)?;
        if members.len() < 2 || members.iter().any(|id| !scope.contains(id)) { return Err(invalid()); }
        if live {
            let mut indices = members.iter().map(|id| scope.iter().position(|item| item == id).unwrap()).collect::<Vec<_>>();
            indices.sort_unstable();
            if indices.windows(2).any(|pair| pair[1] != pair[0] + 1)
                || members.iter().any(|id| !grouped.insert(id.clone())) { return Err(invalid()); }
        }
    }
    Ok(())
}
fn assignments(value: &Value, people: &HashSet<String>, facts: Option<&Map<String, Value>>) -> Result<(), RepositoryError> {
    for (item, assigned) in object(value)? {
        if !super::uuid_v7::is_uuid_v7(item) { return Err(invalid()); }
        let assigned = ids(assigned, true)?;
        if assigned.iter().any(|id| !people.contains(id)) { return Err(invalid()); }
        if let Some(facts) = facts.filter(|facts| !facts.is_empty()) {
            let fact = facts.get(item).ok_or_else(invalid)?;
            if fact.get("effortPoints").and_then(Value::as_i64) == Some(0) && !assigned.is_empty() { return Err(invalid()); }
        }
    }
    Ok(())
}

pub fn validate_plan(plan: &RecoveryForecastPlansRow) -> Result<(), RepositoryError> {
    if !policy(&plan.policy_version) || !level(&plan.planning_level) || plan.cadence != "fixed-contiguous"
        || plan.points_per_sprint.is_some_and(|n| !(0..=MAX).contains(&n))
        || plan.sprint_length_days.is_some_and(|n| !(1..=MAX).contains(&n))
        || plan.start_sprint_ordinal.is_some_and(|n| !(1..=MAX).contains(&n))
        || plan.start_date.as_deref().is_some_and(|date| !crate::db::handler::is_valid_iso_calendar_date(date)) { return Err(invalid()); }
    let parse = |raw: &str| serde_json::from_str::<Value>(raw).map_err(|_| invalid());
    let scope = ids(&parse(&plan.selected_feature_ids)?, true)?;
    let blocked = ids(&parse(&plan.blocked_feature_ids)?, true)?;
    if blocked.iter().any(|id| !scope.contains(id)) { return Err(invalid()); }
    groups(&parse(&plan.parallel_groups)?, &scope, true)?;
    let people = roster(&parse(&plan.roster)?)?;
    assignments(&parse(&plan.assignments)?, &people, None)
}

pub fn validate_scenario(row: &RecoveryForecastScenariosRow, project: &str) -> Result<(), RepositoryError> {
    if !policy(&row.policy_version) || row.label.trim().is_empty() || !(0..=MAX).contains(&row.baseline_revision)
        || row.baseline_fingerprint.len() != 64 || !row.baseline_fingerprint.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        || chrono::DateTime::parse_from_rfc3339(&row.created_at_iso).is_err() { return Err(invalid()); }
    let baseline: Value = serde_json::from_str(&row.baseline_json).map_err(|_| invalid())?;
    let patch: Value = serde_json::from_str(&row.patch_json).map_err(|_| invalid())?;
    let baseline = object(&baseline)?;
    let patch = object(&patch)?;
    let staffed = row.policy_version == "staffed-capacity-v1";
    let keys = ["orderedScope", "configuration", "parallelGroups", "blockedFeatureIds", "factMap", "planningLevel", "projectId", "baselineRevision", "policyVersion", "roster", "assignments"];
    if !allowed(baseline, &keys) || (!staffed && (baseline.contains_key("roster") || baseline.contains_key("assignments")))
        || baseline.get("planningLevel").is_some_and(|value| value.as_str().map_or(true, |value| !level(value))) { return Err(invalid()); }
    let scope = ids(baseline.get("orderedScope").ok_or_else(invalid)?, true)?;
    let blocked = ids(baseline.get("blockedFeatureIds").ok_or_else(invalid)?, false)?;
    if blocked.iter().any(|id| !scope.contains(id)) { return Err(invalid()); }
    groups(baseline.get("parallelGroups").ok_or_else(invalid)?, &scope, false)?;
    let configuration = object(baseline.get("configuration").ok_or_else(invalid)?)?;
    if !exact(configuration, &["pointsPerSprint", "sprintLengthDays", "cadence", "startSprintOrdinal", "startDate"])
        || !nullable_number(&configuration["pointsPerSprint"], 0) || !nullable_number(&configuration["sprintLengthDays"], 1)
        || !nullable_number(&configuration["startSprintOrdinal"], 1) || configuration["cadence"] != "fixed-contiguous" { return Err(invalid()); }
    if !configuration["startDate"].is_null() {
        let date = configuration["startDate"].as_str().ok_or_else(invalid)?;
        let bytes = date.as_bytes();
        // Historical baseline contract preserves regex-shaped dates unchanged.
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' || bytes.iter().enumerate().any(|(i, c)| i != 4 && i != 7 && !c.is_ascii_digit()) { return Err(invalid()); }
    }
    let facts = object(baseline.get("factMap").ok_or_else(invalid)?)?;
    for (id, value) in facts {
        let fact = object(value)?;
        if !super::uuid_v7::is_uuid_v7(id) || !(exact(fact, &["effortPoints", "nodeType", "projectId", "ancestorIds"])
            && fact["nodeType"].is_string() || exact(fact, &["effortPoints", "isFeature", "projectId", "ancestorIds"]) && fact["isFeature"].is_boolean())
            || !nullable_number(&fact["effortPoints"], 0) || fact["projectId"].as_str() != Some(project) { return Err(invalid()); }
        ids(&fact["ancestorIds"], false)?;
    }
    let people = if staffed {
        let people = roster(baseline.get("roster").ok_or_else(invalid)?)?;
        assignments(baseline.get("assignments").ok_or_else(invalid)?, &people, Some(facts))?;
        people
    } else { HashSet::new() };
    if !allowed(patch, &["orderedScope", "pointOverrides", "pointsPerSprint", "policyVersion", "parallelGroups", "weightOverrides", "assignmentOverrides"])
        || patch.get("policyVersion").is_some_and(|value| value.as_str().map_or(true, |value| !policy(value)))
        || patch.get("parallelGroups").is_some_and(|value| !value.is_array()) { return Err(invalid()); }
    if let Some(value) = patch.get("orderedScope") { ids(value, false)?; }
    if patch.get("pointsPerSprint").is_some_and(|value| !nullable_number(value, 0)) { return Err(invalid()); }
    if let Some(overrides) = patch.get("pointOverrides") {
        for (id, value) in object(overrides)? { if !super::uuid_v7::is_uuid_v7(id) || !nullable_number(value, 0) { return Err(invalid()); } }
    }
    let variant_staffed = patch.get("policyVersion").and_then(Value::as_str).unwrap_or(&row.policy_version) == "staffed-capacity-v1";
    if !variant_staffed && (patch.contains_key("weightOverrides") || patch.contains_key("assignmentOverrides")) { return Err(invalid()); }
    if let Some(overrides) = patch.get("weightOverrides") {
        for (id, value) in object(overrides)? {
            if !super::uuid_v7::is_uuid_v7(id) || !number(value, 1) || staffed && !people.is_empty() && !people.contains(id) { return Err(invalid()); }
        }
    }
    if let Some(overrides) = patch.get("assignmentOverrides") {
        for (id, value) in object(overrides)? {
            if !super::uuid_v7::is_uuid_v7(id) { return Err(invalid()); }
            let assigned = ids(value, true)?;
            if !facts.is_empty() && !facts.contains_key(id) || facts.get(id).and_then(|fact| fact.get("effortPoints")).and_then(Value::as_i64) == Some(0) && !assigned.is_empty()
                || staffed && !people.is_empty() && assigned.iter().any(|id| !people.contains(id)) { return Err(invalid()); }
        }
    }
    Ok(())
}
