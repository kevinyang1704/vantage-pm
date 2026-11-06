//! Explicit authored graph I/O. Caller owns the read/write transaction cut.
use rusqlite::{Connection,Transaction};
use serde::{de::DeserializeOwned,Serialize};
use serde_json::{Value,Map};
use crate::protocol::{recovery::*,errors::RepositoryError};
fn storage(_:rusqlite::Error)->RepositoryError {RepositoryError::IntegrityFailed}
fn read<T:DeserializeOwned>(conn:&Connection,sql:&str,project:&str)->Result<Vec<T>,RepositoryError> {
    let mut stmt=conn.prepare(sql).map_err(storage)?;
    let names=stmt.column_names().iter().map(|n|n.to_string()).collect::<Vec<_>>();
    let rows=stmt.query_map([project],|row|{
        let mut value=Map::new();
        for (index,name) in names.iter().enumerate() {
            let field=match row.get_ref(index)? {
                rusqlite::types::ValueRef::Null=>Value::Null,
                rusqlite::types::ValueRef::Integer(n) if name=="completed"=>match n {0=>Value::Bool(false),1=>Value::Bool(true),_=>return Err(rusqlite::Error::InvalidQuery)},
                rusqlite::types::ValueRef::Integer(n) if n.unsigned_abs()<=9_007_199_254_740_991=>Value::from(n),
                rusqlite::types::ValueRef::Text(raw)=>Value::String(std::str::from_utf8(raw).map_err(|_|rusqlite::Error::InvalidQuery)?.into()),
                _=>return Err(rusqlite::Error::InvalidQuery),
            };
            value.insert(name.clone(),field);
        }
        Ok(Value::Object(value))
    }).map_err(storage)?.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)?;
    rows.into_iter().map(|row|serde_json::from_value(row).map_err(|_|RepositoryError::IntegrityFailed)).collect()
}
pub fn capture_graph(conn:&Connection,project:&str)->Result<RecoveryGraph,RepositoryError> {
    let graph=RecoveryGraph {
        project: read(conn,r#"SELECT id AS "id",name AS "name",revision AS "revision" FROM projects WHERE id=?1 ORDER BY rowid"#,project)?.into_iter().next().ok_or(RepositoryError::ProjectNotFound)?,
        phases: read(conn,r#"SELECT id AS "id",project_id AS "projectId",name AS "name",position AS "position" FROM phases WHERE project_id=?1 ORDER BY rowid"#,project)?,
        nodes: read(conn,r#"SELECT id AS "id",project_id AS "projectId",parent_id AS "parentId",title AS "title",body_text AS "bodyText",position AS "position",node_type AS "nodeType",start_date AS "startDate",end_date AS "endDate",duration_days AS "durationDays",schedule_source_mode AS "scheduleSourceMode",completed AS "completed",effort_points AS "effortPoints",effort_points_done AS "effortPointsDone",strategic_weight AS "strategicWeight",phase_id AS "phaseId",delivery_status AS "deliveryStatus" FROM nodes WHERE project_id=?1 ORDER BY rowid"#,project)?,
        custom_fields: read(conn,r#"SELECT project_id AS "projectId",node_id AS "nodeId",field_key AS "fieldKey",field_value AS "fieldValue" FROM node_custom_fields WHERE project_id=?1 ORDER BY rowid"#,project)?,
        type_template_fields: read(conn,r#"SELECT project_id AS "projectId",node_type AS "nodeType",field_key AS "fieldKey",field_label AS "fieldLabel",position AS "position" FROM type_template_fields WHERE project_id=?1 ORDER BY rowid"#,project)?,
        unlock_edges: read(conn,r#"SELECT id AS "id",project_id AS "projectId",source_node_id AS "sourceNodeId",target_node_id AS "targetNodeId" FROM unlock_edges WHERE project_id=?1 ORDER BY rowid"#,project)?,
        dismissals: read(conn,r#"SELECT project_id AS "projectId",finding_id AS "findingId",finding_kind AS "findingKind",target_id AS "targetId",fingerprint AS "fingerprint",dismissed_at AS "dismissedAt" FROM finding_dismissals WHERE project_id=?1 ORDER BY rowid"#,project)?,
        affected_reasons: read(conn,r#"SELECT id AS "id",project_id AS "projectId",affected_node_id AS "affectedNodeId",causal_node_id AS "causalNodeId",causal_node_title AS "causalNodeTitle",delta_days AS "deltaDays",causal_date_summary AS "causalDateSummary",created_at AS "createdAt",acknowledged_at AS "acknowledgedAt" FROM affected_reasons WHERE project_id=?1 ORDER BY rowid"#,project)?,
        open_questions: read(conn,r#"SELECT id AS "id",project_id AS "projectId",node_id AS "nodeId",question_text AS "questionText",status AS "status",decision_text AS "decisionText",position AS "position",resolved_at_iso AS "resolvedAtIso",created_at_iso AS "createdAtIso" FROM node_open_questions WHERE project_id=?1 ORDER BY rowid"#,project)?,
        forecast_plans: read(conn,r#"SELECT project_id AS "projectId",selected_feature_ids AS "selectedFeatureIds",parallel_groups AS "parallelGroups",blocked_feature_ids AS "blockedFeatureIds",points_per_sprint AS "pointsPerSprint",sprint_length_days AS "sprintLengthDays",cadence AS "cadence",start_sprint_ordinal AS "startSprintOrdinal",start_date AS "startDate",policy_version AS "policyVersion",planning_level AS "planningLevel",roster AS "roster",assignments AS "assignments",sprint_plan AS "sprintPlan" FROM forecast_plans WHERE project_id=?1 ORDER BY rowid"#,project)?,
        forecast_scenarios: read(conn,r#"SELECT scenario_id AS "scenarioId",project_id AS "projectId",label AS "label",baseline_revision AS "baselineRevision",baseline_fingerprint AS "baselineFingerprint",policy_version AS "policyVersion",created_at_iso AS "createdAtIso",baseline_json AS "baselineJson",patch_json AS "patchJson" FROM forecast_scenarios WHERE project_id=?1 ORDER BY rowid"#,project)?,
    };
    graph.validate(project)?;
    Ok(graph)
}
fn scalar(value:&Value)->Result<rusqlite::types::Value,RepositoryError> {
    Ok(match value {
        Value::Null=>rusqlite::types::Value::Null,
        Value::Bool(v)=>rusqlite::types::Value::Integer(i64::from(*v)),
        Value::String(v)=>rusqlite::types::Value::Text(v.clone()),
        Value::Number(v)=>rusqlite::types::Value::Integer(v.as_i64().filter(|n|n.unsigned_abs()<=9_007_199_254_740_991).ok_or(RepositoryError::InvalidRequest)?),
        _=>return Err(RepositoryError::InvalidRequest),
    })
}
fn insert<T:Serialize>(tx:&Transaction,table:&str,columns:&[(&str,&str)],rows:&[T])->Result<(),RepositoryError> {
    let sql=format!("INSERT INTO {table}({}) VALUES({})",columns.iter().map(|(_,sql)|*sql).collect::<Vec<_>>().join(","),vec!["?";columns.len()].join(","));
    for row in rows {
        let value=serde_json::to_value(row).map_err(|_|RepositoryError::InvalidRequest)?;
        let params=columns.iter().map(|(wire,_)|scalar(&value[*wire])).collect::<Result<Vec<_>,_>>()?;
        tx.execute(&sql,rusqlite::params_from_iter(params)).map_err(storage)?;
    }
    Ok(())
}
pub fn replace_graph(tx:&Transaction,graph:&RecoveryGraph,project:&str)->Result<(),RepositoryError> {
    graph.validate(project)?;
    tx.execute_batch("PRAGMA defer_foreign_keys=ON").map_err(storage)?;
    tx.execute("DELETE FROM forecast_scenarios WHERE project_id=?1",[project]).map_err(storage)?;
    tx.execute("DELETE FROM forecast_plans WHERE project_id=?1",[project]).map_err(storage)?;
    tx.execute("DELETE FROM node_open_questions WHERE project_id=?1",[project]).map_err(storage)?;
    tx.execute("DELETE FROM affected_reasons WHERE project_id=?1",[project]).map_err(storage)?;
    tx.execute("DELETE FROM finding_dismissals WHERE project_id=?1",[project]).map_err(storage)?;
    tx.execute("DELETE FROM unlock_edges WHERE project_id=?1",[project]).map_err(storage)?;
    tx.execute("DELETE FROM type_template_fields WHERE project_id=?1",[project]).map_err(storage)?;
    tx.execute("DELETE FROM node_custom_fields WHERE project_id=?1",[project]).map_err(storage)?;
    tx.execute("DELETE FROM nodes WHERE project_id=?1",[project]).map_err(storage)?;
    tx.execute("DELETE FROM phases WHERE project_id=?1",[project]).map_err(storage)?;
    tx.execute("INSERT INTO projects(id,name,revision) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision",rusqlite::params![project,graph.project.name,graph.project.revision]).map_err(storage)?;
    insert(tx,"phases",&[("id","id"),("projectId","project_id"),("name","name"),("position","position")],&graph.phases)?;
    insert(tx,"nodes",&[("id","id"),("projectId","project_id"),("parentId","parent_id"),("title","title"),("bodyText","body_text"),("position","position"),("nodeType","node_type"),("startDate","start_date"),("endDate","end_date"),("durationDays","duration_days"),("scheduleSourceMode","schedule_source_mode"),("completed","completed"),("effortPoints","effort_points"),("effortPointsDone","effort_points_done"),("strategicWeight","strategic_weight"),("phaseId","phase_id"),("deliveryStatus","delivery_status")],&graph.nodes)?;
    insert(tx,"node_custom_fields",&[("projectId","project_id"),("nodeId","node_id"),("fieldKey","field_key"),("fieldValue","field_value")],&graph.custom_fields)?;
    insert(tx,"type_template_fields",&[("projectId","project_id"),("nodeType","node_type"),("fieldKey","field_key"),("fieldLabel","field_label"),("position","position")],&graph.type_template_fields)?;
    insert(tx,"unlock_edges",&[("id","id"),("projectId","project_id"),("sourceNodeId","source_node_id"),("targetNodeId","target_node_id")],&graph.unlock_edges)?;
    insert(tx,"finding_dismissals",&[("projectId","project_id"),("findingId","finding_id"),("findingKind","finding_kind"),("targetId","target_id"),("fingerprint","fingerprint"),("dismissedAt","dismissed_at")],&graph.dismissals)?;
    insert(tx,"affected_reasons",&[("id","id"),("projectId","project_id"),("affectedNodeId","affected_node_id"),("causalNodeId","causal_node_id"),("causalNodeTitle","causal_node_title"),("deltaDays","delta_days"),("causalDateSummary","causal_date_summary"),("createdAt","created_at"),("acknowledgedAt","acknowledged_at")],&graph.affected_reasons)?;
    insert(tx,"node_open_questions",&[("id","id"),("projectId","project_id"),("nodeId","node_id"),("questionText","question_text"),("status","status"),("decisionText","decision_text"),("position","position"),("resolvedAtIso","resolved_at_iso"),("createdAtIso","created_at_iso")],&graph.open_questions)?;
    insert(tx,"forecast_plans",&[("projectId","project_id"),("selectedFeatureIds","selected_feature_ids"),("parallelGroups","parallel_groups"),("blockedFeatureIds","blocked_feature_ids"),("pointsPerSprint","points_per_sprint"),("sprintLengthDays","sprint_length_days"),("cadence","cadence"),("startSprintOrdinal","start_sprint_ordinal"),("startDate","start_date"),("policyVersion","policy_version"),("planningLevel","planning_level"),("roster","roster"),("assignments","assignments"),("sprintPlan","sprint_plan")],&graph.forecast_plans)?;
    insert(tx,"forecast_scenarios",&[("scenarioId","scenario_id"),("projectId","project_id"),("label","label"),("baselineRevision","baseline_revision"),("baselineFingerprint","baseline_fingerprint"),("policyVersion","policy_version"),("createdAtIso","created_at_iso"),("baselineJson","baseline_json"),("patchJson","patch_json")],&graph.forecast_scenarios)?;
    Ok(())
}
/// Structured overlap targets use JSON-encoded composite identities, never
/// ambiguous delimiters. Both sides of references and both child orders survive
/// deletion/movement so inverse dependencies include facts no longer in graph.
pub fn cut_footprints(
    command: &ImmutableCommand,
    before: &RecoveryGraph,
    after: &RecoveryGraph,
) -> Result<(RecoveryFootprints, RecoveryFootprints), RepositoryError> {
    use crate::protocol::recovery::FootprintTarget;
    use std::collections::{BTreeMap, BTreeSet};
    fn add(out: &mut BTreeMap<String, FootprintTarget>, target: FootprintTarget) {
        out.insert(serde_json::to_string(&target).expect("serializable footprint"), target);
    }
    let mut command_targets = known_targets(&command.wire);
    let precise = match command.typed.kind() {
        "RenameProject" => Some(("project", "projectId", &["name"][..])),
        "SetNodeTitle" => Some(("nodes", "nodeId", &["title"][..])),
        "SetNodeBodyText" => Some(("nodes", "nodeId", &["bodyText"][..])),
        "SetNodeType" => Some(("nodes", "nodeId", &["nodeType"][..])),
        "SetNodeSchedule" => Some(("nodes", "nodeId", &["startDate", "endDate", "durationDays", "scheduleSourceMode"][..])),
        "ToggleNodeCompleted" => Some(("nodes", "nodeId", &["completed"][..])),
        "SetNodeEffort" => Some(("nodes", "nodeId", &["effortPoints", "effortPointsDone"][..])),
        "SetNodeStatus" => Some(("nodes", "nodeId", &["deliveryStatus"][..])),
        "SetThemeWeight" => Some(("nodes", "nodeId", &["strategicWeight"][..])),
        "AssignNodePhase" => Some(("nodes", "nodeId", &["phaseId"][..])),
        "RenamePhase" => Some(("phases", "phaseId", &["name"][..])),
        "UpdateNodeQuestion" => Some(("openQuestions", "questionId", &["questionText"][..])),
        "ResolveNodeQuestion" => Some(("openQuestions", "questionId", &["status", "decisionText", "resolvedAtIso"][..])),
        "AcknowledgeAffectedReason" => Some(("affectedReasons", "reasonId", &["acknowledgedAt"][..])),
        "SetForecastPolicy" => Some(("forecastPlans", "projectId", &["policyVersion"][..])),
        _ => None,
    };
    if let Some((entity_type, key, fields)) = precise {
        if let Some(id) = command.wire.get(key).and_then(Value::as_str) {
            command_targets.retain(|_, target| !matches!(target, FootprintTarget::Entity { entity_type: kind, id: target } if kind == entity_type && target == id));
            for field in fields { add(&mut command_targets, FootprintTarget::Field { entity_type: entity_type.into(), id: id.into(), field: (*field).into() }); }
            add(&mut command_targets, FootprintTarget::Reference { relation: format!("{entity_type}.exists"), source_id: id.into(), target_id: id.into() });
        }
    }
    let mut effects = BTreeMap::new();
    for ((entity_type, old), (_, new)) in graph_rows(before)?.into_iter().zip(graph_rows(after)?) {
        for id in old.keys().chain(new.keys()).cloned().collect::<BTreeSet<_>>() {
            let prior = old.get(&id);
            let current = new.get(&id);
            if prior == current { continue; }
            if prior.is_none() || current.is_none() {
                add(&mut effects, FootprintTarget::Entity { entity_type: entity_type.clone(), id: id.clone() });
            }
            let fields = prior.into_iter().chain(current).flat_map(|row| row.as_object().into_iter().flat_map(|object| object.keys())).cloned().collect::<BTreeSet<_>>();
            for field in fields {
                if entity_type == "project" && field == "revision" { continue; }
                if prior.and_then(|row| row.get(&field)) != current.and_then(|row| row.get(&field)) {
                    add(&mut effects, FootprintTarget::Field { entity_type: entity_type.clone(), id: id.clone(), field });
                }
            }
            for row in prior.into_iter().chain(current) {
                for field in ["nodeId", "sourceNodeId", "targetNodeId", "parentId", "phaseId", "affectedNodeId", "causalNodeId"] {
                    let changed = prior.is_none() || current.is_none()
                        || prior.and_then(|value| value.get(field)) != current.and_then(|value| value.get(field));
                    if let Some(target_id) = row.get(field).and_then(Value::as_str).filter(|_| changed) {
                        add(&mut effects, FootprintTarget::Reference {
                            relation: format!("{entity_type}.{field}"), source_id: id.clone(), target_id: target_id.into(),
                        });
                    }
                }
                if entity_type == "nodes" && (prior.is_none() || current.is_none()
                    || prior.and_then(|row| row.get("parentId")) != current.and_then(|row| row.get("parentId"))
                    || prior.and_then(|row| row.get("position")) != current.and_then(|row| row.get("position"))) {
                    let owner = row.get("parentId").and_then(Value::as_str).unwrap_or(&before.project.id);
                    add(&mut effects, FootprintTarget::Order { collection_type: "children".into(), owner_id: owner.into() });
                }
                if matches!(entity_type.as_str(), "phases" | "openQuestions" | "typeTemplateFields")
                    && (prior.is_none() || current.is_none()
                        || prior.and_then(|row| row.get("position")) != current.and_then(|row| row.get("position"))) {
                    let owner = row.get("nodeId").or_else(|| row.get("nodeType")).and_then(Value::as_str).unwrap_or(&before.project.id);
                    add(&mut effects, FootprintTarget::Order { collection_type: entity_type.clone(), owner_id: owner.into() });
                }
                if entity_type == "forecastPlans" {
                    for field in ["selectedFeatureIds", "parallelGroups", "blockedFeatureIds", "roster", "assignments"] {
                        let changed = prior.is_none() || current.is_none()
                            || prior.and_then(|value| value.get(field)) != current.and_then(|value| value.get(field));
                        if let Some(raw) = row.get(field).and_then(Value::as_str).filter(|_| changed) {
                            let parsed: Value = serde_json::from_str(raw).map_err(|_| RepositoryError::IntegrityFailed)?;
                            for target in known_targets(&Value::Object(serde_json::Map::from_iter([(field.to_string(), parsed)]))).into_values() {
                                if let FootprintTarget::Entity { id: target_id, .. } = target {
                                    add(&mut effects, FootprintTarget::Reference {
                                        relation: format!("forecastPlans.{field}"), source_id: before.project.id.clone(), target_id,
                                    });
                                }
                            }
                            if field != "assignments" {
                                add(&mut effects, FootprintTarget::Order { collection_type: format!("forecastPlans.{field}"), owner_id: before.project.id.clone() });
                            }
                        }
                    }
                }
            }
        }
    }
    if matches!(command.typed.kind(), "MoveNode" | "DeleteSubtree" | "DuplicateSubtree" | "RestoreSubtree") {
        let root = command.wire.get("nodeId").or_else(|| command.wire.get("sourceNodeId")).or_else(|| command.wire.get("rootNodeId")).and_then(Value::as_str);
        if let Some(root) = root {
            for graph in [before, after] {
                for node in &graph.nodes {
                    let mut current = Some(node.id.as_str());
                    let mut guard = 0;
                    while let Some(id) = current {
                        if id == root {
                            let target = FootprintTarget::Entity { entity_type: "nodes".into(), id: node.id.clone() };
                            add(&mut command_targets, target.clone());
                            add(&mut effects, target);
                            break;
                        }
                        guard += 1;
                        if guard > graph.nodes.len() { return Err(RepositoryError::IntegrityFailed); }
                        current = graph.nodes.iter().find(|node| node.id == id).and_then(|node| node.parent_id.as_deref());
                    }
                }
            }
        }
    }
    // Every observed effect is also a command dependency; this includes removed
    // question/reason identities and references outside a deleted subtree.
    command_targets.extend(effects.clone());
    Ok((
        RecoveryFootprints { availability: "complete".into(), known_targets: command_targets.into_values().collect(), reason: None },
        RecoveryFootprints { availability: "complete".into(), known_targets: effects.into_values().collect(), reason: None },
    ))
}

pub fn known_targets(value: &Value) -> std::collections::BTreeMap<String, crate::protocol::recovery::FootprintTarget> {
    use crate::protocol::recovery::FootprintTarget;
    use std::collections::BTreeMap;
    fn visit(value: &Value, key: &str, out: &mut BTreeMap<String, FootprintTarget>) {
        match value {
            Value::String(id) if matches!(key, "nodeId" | "sourceNodeId" | "targetNodeId" | "parentId" | "rootNodeId" | "questionId" | "phaseId" | "edgeId" | "reasonId" | "scenarioId" | "personId" | "id" | "selectedFeatureIds" | "parallelGroups" | "blockedFeatureIds" | "memberIds" | "orderedNodeIds" | "orderedQuestionIds" | "orderedPhaseIds" | "affectedNodeId" | "causalNodeId") && crate::protocol::uuid_v7::is_uuid_v7(id) => {
                let entity_type = match key {
                    "questionId" => "openQuestions", "phaseId" => "phases", "edgeId" => "unlockEdges",
                    "reasonId" => "affectedReasons", "scenarioId" => "forecastScenarios", _ => "nodes",
                };
                let target = FootprintTarget::Entity { entity_type: entity_type.into(), id: id.clone() };
                out.insert(serde_json::to_string(&target).expect("serializable footprint"), target);
            },
            Value::Array(values) => for value in values { visit(value, key, out); },
            Value::Object(values) => for (key, value) in values {
                if crate::protocol::uuid_v7::is_uuid_v7(key) {
                    let target = FootprintTarget::Entity { entity_type: "nodes".into(), id: key.clone() };
                    out.insert(serde_json::to_string(&target).expect("serializable footprint"), target);
                }
                visit(value, key, out);
            },
            _ => {},
        }
    }
    let mut targets = BTreeMap::new();
    visit(value, "", &mut targets);
    targets
}
fn graph_rows(graph:&RecoveryGraph)->Result<Vec<(String,std::collections::BTreeMap<String,Value>)>,RepositoryError> {
    let value=serde_json::to_value(graph).map_err(|_|RepositoryError::IntegrityFailed)?;
    let mut out=Vec::new();
    for (label,rows) in value.as_object().ok_or(RepositoryError::IntegrityFailed)? {
        let rows=if label=="project" {vec![rows]}else{rows.as_array().ok_or(RepositoryError::IntegrityFailed)?.iter().collect()};
        let mut map=std::collections::BTreeMap::new();
        for row in rows {
            let key=if let Some(id)=row.get("id").or_else(||row.get("scenarioId")) {id.as_str().ok_or(RepositoryError::IntegrityFailed)?.to_owned()}
                else if label=="customFields" {serde_json::json!([row["nodeId"],row["fieldKey"]]).to_string()}
                else if label=="typeTemplateFields" {serde_json::json!([row["nodeType"],row["fieldKey"]]).to_string()}
                else if label=="dismissals" {serde_json::json!([row["findingKind"],row["targetId"],row["fingerprint"]]).to_string()}
                else {row["projectId"].as_str().ok_or(RepositoryError::IntegrityFailed)?.to_owned()};
            map.insert(key,row.clone());
        }
        out.push((label.clone(),map));
    }
    Ok(out)
}
