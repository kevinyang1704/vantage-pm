//! Transaction-scoped complete deletion bundles; no unrelated project restoration.
use rusqlite::{Transaction, OptionalExtension};
use std::collections::{HashMap, HashSet};
use crate::protocol::{commands::NodeSnapshot, deletion_bundle::*};
const SUBTREE: &str = "WITH RECURSIVE s(id,depth) AS (SELECT id,0 FROM nodes WHERE id=?1 AND project_id=?2 UNION ALL SELECT n.id,s.depth+1 FROM nodes n JOIN s ON n.parent_id=s.id WHERE n.project_id=?2) ";
pub fn capture(tx: &Transaction<'_>, project: &str, root: &str) -> rusqlite::Result<DeletionBundle> {
    let nodes = {
        let mut stmt = tx.prepare(&format!("{SUBTREE}SELECT n.id,n.project_id,n.parent_id,n.title,n.body_text,n.position,s.depth,n.node_type,n.start_date,n.end_date,n.duration_days,n.schedule_source_mode,n.completed,n.effort_points,n.effort_points_done,n.strategic_weight,n.phase_id,n.delivery_status FROM nodes n JOIN s ON n.id=s.id ORDER BY s.depth,n.position"))?;
        let rows = stmt.query_map(rusqlite::params![root, project], |r| Ok(CompleteDeletedNode {
            node_id: r.get(0)?,
            project_id: r.get(1)?,
            parent_id: r.get(2)?,
            title: r.get(3)?,
            body_text: r.get(4)?,
            position: r.get::<_, i64>(5)?.to_string(),
            depth: r.get(6)?,
            node_type: r.get(7)?,
            start_date: r.get(8)?,
            end_date: r.get(9)?,
            duration_days: r.get(10)?,
            schedule_source_mode: r.get(11)?,
            completed: match r.get::<_, i64>(12)? { 0 => false, 1 => true, _ => return Err(rusqlite::Error::InvalidQuery) },
            effort_points: r.get(13)?,
            effort_points_done: r.get(14)?,
            strategic_weight: r.get(15)?,
            phase_id: r.get(16)?,
            delivery_status: r.get(17)?,
        }))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let custom_fields = {
        let mut stmt = tx.prepare(&format!("{SUBTREE}SELECT node_id,field_key,field_value FROM node_custom_fields WHERE project_id=?2 AND (node_id IN (SELECT id FROM s)) ORDER BY rowid"))?;
        let rows = stmt.query_map(rusqlite::params![root, project], |r| Ok(DeletedCustomField {
            node_id: r.get(0)?,
            field_key: r.get(1)?,
            field_value: r.get(2)?,
        }))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let open_questions = {
        let mut stmt = tx.prepare(&format!("{SUBTREE}SELECT id,node_id,question_text,status,decision_text,position,resolved_at_iso,created_at_iso FROM node_open_questions WHERE project_id=?2 AND (node_id IN (SELECT id FROM s)) ORDER BY rowid"))?;
        let rows = stmt.query_map(rusqlite::params![root, project], |r| Ok(DeletedQuestion {
            id: r.get(0)?,
            node_id: r.get(1)?,
            question_text: r.get(2)?,
            status: r.get(3)?,
            decision_text: r.get(4)?,
            position: r.get::<_, i64>(5)?.to_string(),
            resolved_at_iso: r.get(6)?,
            created_at_iso: r.get(7)?,
        }))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let unlock_edges = {
        let mut stmt = tx.prepare(&format!("{SUBTREE}SELECT id,source_node_id,target_node_id FROM unlock_edges WHERE project_id=?2 AND (source_node_id IN (SELECT id FROM s) OR target_node_id IN (SELECT id FROM s)) ORDER BY rowid"))?;
        let rows = stmt.query_map(rusqlite::params![root, project], |r| Ok(DeletedEdge {
            id: r.get(0)?,
            source_node_id: r.get(1)?,
            target_node_id: r.get(2)?,
        }))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let affected_reasons = {
        let mut stmt = tx.prepare(&format!("{SUBTREE}SELECT id,affected_node_id,causal_node_id,causal_node_title,delta_days,causal_date_summary,created_at,acknowledged_at FROM affected_reasons WHERE project_id=?2 AND (affected_node_id IN (SELECT id FROM s) OR causal_node_id IN (SELECT id FROM s)) ORDER BY rowid"))?;
        let rows = stmt.query_map(rusqlite::params![root, project], |r| Ok(DeletedAffectedReason {
            id: r.get(0)?,
            affected_node_id: r.get(1)?,
            causal_node_id: r.get(2)?,
            causal_node_title: r.get(3)?,
            delta_days: r.get(4)?,
            causal_date_summary: r.get(5)?,
            created_at: r.get(6)?,
            acknowledged_at: r.get(7)?,
        }))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(DeletionBundle { version: 1, project_id: project.into(), root_node_id: root.into(), nodes, custom_fields, open_questions, unlock_edges, affected_reasons })
}
fn exists(tx: &Transaction<'_>, table: &str, id: &str) -> rusqlite::Result<bool> {
    Ok(tx.query_row(&format!("SELECT id FROM {table} WHERE id=?1"), [id], |r| r.get::<_,String>(0)).optional()?.is_some())
}
fn endpoint(tx: &Transaction<'_>, project: &str, id: &str, nodes: &HashMap<&str,&CompleteDeletedNode>) -> rusqlite::Result<bool> {
    Ok(nodes.contains_key(id) || tx.query_row("SELECT id FROM nodes WHERE id=?1 AND project_id=?2", rusqlite::params![id,project], |r| r.get::<_,String>(0)).optional()?.is_some())
}
fn rank(t: Option<&str>) -> Option<usize> {
    ["Vision","Theme","Component","Feature","AcceptanceCriterion"].iter().position(|v| Some(*v)==t)
}
/// Domain refusal is returned before any insert; storage errors remain errors.
pub fn restore(tx: &Transaction<'_>, bundle: &DeletionBundle, project: &str, root: &str, basic: &[NodeSnapshot]) -> rusqlite::Result<Option<&'static str>> {
    if bundle.validate(project,root,basic).is_err() {
        return Ok(Some("INVALID_DELETION_BUNDLE"));
    }
    let nodes: HashMap<&str,&CompleteDeletedNode> = bundle.nodes.iter().map(|n|(n.node_id.as_str(),n)).collect();
    let mut positions = HashSet::new();
    for n in &bundle.nodes {
        if exists(tx,"nodes",&n.node_id)? {
            return Ok(Some("RESTORE_IDENTITY_CONFLICT"));
        }
        if let Some(phase) = &n.phase_id {
            if tx.query_row("SELECT id FROM phases WHERE id=?1 AND project_id=?2",
            rusqlite::params![phase,project],|r|r.get::<_,String>(0)).optional()?.is_none() {
                return Ok(Some("RESTORE_DEPENDENCY_MISSING"));
            }
        }
        let parent_type = if let Some(parent) = &n.parent_id {
            if let Some(parent) = nodes.get(parent.as_str()) { parent.node_type.clone() }
            else {
                let found = tx.query_row("SELECT node_type FROM nodes WHERE id=?1 AND project_id=?2",
            rusqlite::params![parent,project],|r|r.get::<_,Option<String>>(0)).optional()?;
                match found { Some(t)=>t, None=>return Ok(Some("RESTORE_DEPENDENCY_MISSING")) }
            }
        } else { None };
        if let (Some(p),Some(c)) = (rank(parent_type.as_deref()),rank(n.node_type.as_deref())) {
            if p>c {
                return Ok(Some("HIERARCHY_CONFLICT"));
            }
        }
        let position = n.position.parse::<i64>().map_err(|_|rusqlite::Error::InvalidQuery)?;
        if !positions.insert((n.parent_id.clone(),position)) || tx.query_row("SELECT id FROM nodes WHERE project_id=?1 AND parent_id IS ?2 AND position=?3",
            rusqlite::params![project,n.parent_id,position],|r|r.get::<_,String>(0)).optional()?.is_some() {
            return Ok(Some("RESTORE_POSITION_CONFLICT"));
        }
    }
    for q in &bundle.open_questions { if exists(tx,"node_open_questions",&q.id)? {
            return Ok(Some("RESTORE_IDENTITY_CONFLICT"));
        } }
    for e in &bundle.unlock_edges {
        if !endpoint(tx,project,&e.source_node_id,&nodes)? || !endpoint(tx,project,&e.target_node_id,&nodes)? {
            return Ok(Some("RESTORE_DEPENDENCY_MISSING"));
        }
        if exists(tx,"unlock_edges",&e.id)? || tx.query_row("SELECT id FROM unlock_edges WHERE project_id=?1 AND source_node_id=?2 AND target_node_id=?3",
            rusqlite::params![project,e.source_node_id,e.target_node_id],|r|r.get::<_,String>(0)).optional()?.is_some() {
            return Ok(Some("RESTORE_IDENTITY_CONFLICT"));
        }
    }
    for r in &bundle.affected_reasons {
        if !endpoint(tx,project,&r.affected_node_id,&nodes)? || !endpoint(tx,project,&r.causal_node_id,&nodes)? {
            return Ok(Some("RESTORE_DEPENDENCY_MISSING"));
        }
        if exists(tx,"affected_reasons",&r.id)? {
            return Ok(Some("RESTORE_IDENTITY_CONFLICT"));
        }
    }
    let mut sorted: Vec<_> = bundle.nodes.iter().collect();
    sorted.sort_by_key(|n|n.depth);
    for n in sorted {
        tx.execute(
            "INSERT INTO nodes(id,project_id,parent_id,title,body_text,position,node_type,start_date,end_date,duration_days,schedule_source_mode,completed,effort_points,effort_points_done,strategic_weight,phase_id,delivery_status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
            rusqlite::params![n.node_id, project, n.parent_id, n.title, n.body_text, n.position.parse::<i64>().map_err(|_|rusqlite::Error::InvalidQuery)?, n.node_type, n.start_date, n.end_date, n.duration_days, n.schedule_source_mode, i64::from(n.completed), n.effort_points, n.effort_points_done, n.strategic_weight, n.phase_id, n.delivery_status],
        )?;
    }
    for v in &bundle.custom_fields {
        tx.execute(
            "INSERT INTO node_custom_fields(project_id,node_id,field_key,field_value) VALUES(?1,?2,?3,?4)",
            rusqlite::params![project, v.node_id, v.field_key, v.field_value],
        )?;
    }
    for v in &bundle.open_questions {
        tx.execute(
            "INSERT INTO node_open_questions(project_id,id,node_id,question_text,status,decision_text,position,resolved_at_iso,created_at_iso) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            rusqlite::params![project, v.id, v.node_id, v.question_text, v.status, v.decision_text, v.position.parse::<i64>().map_err(|_|rusqlite::Error::InvalidQuery)?, v.resolved_at_iso, v.created_at_iso],
        )?;
    }
    for v in &bundle.unlock_edges {
        tx.execute(
            "INSERT INTO unlock_edges(project_id,id,source_node_id,target_node_id) VALUES(?1,?2,?3,?4)",
            rusqlite::params![project, v.id, v.source_node_id, v.target_node_id],
        )?;
    }
    for v in &bundle.affected_reasons {
        tx.execute(
            "INSERT INTO affected_reasons(project_id,id,affected_node_id,causal_node_id,causal_node_title,delta_days,causal_date_summary,created_at,acknowledged_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            rusqlite::params![project, v.id, v.affected_node_id, v.causal_node_id, v.causal_node_title, v.delta_days, v.causal_date_summary, v.created_at, v.acknowledged_at],
        )?;
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{handler,collaboration};
    use crate::protocol::commands::{ProductCommand,ProductCommandResult};
    use rusqlite::Connection;
    use serde_json::json;
    const P: &str="019ffe00-0000-7000-8000-000000000001";
    const N: &str="019ffe00-0000-7000-8000-000000000002";
    fn id(n:u32)->String {
        format!("019ffe00-0000-7000-8000-{n:012x}")}
    fn fixture()->Connection {
        let conn=Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        handler::initialize_schema(&conn).unwrap();
        conn.execute_batch(include_str!("deletion-fixture.sql")).unwrap();
        conn
    }
    fn delete()->ProductCommand {
        serde_json::from_value(json!({"type":"DeleteSubtree","protocolVersion":"1.0.0","commandId":id(100),"projectId":P,"baseRevision":1,"expectedRevision":2,"nodeId":N})).unwrap()
    }
    fn bundle(conn:&mut Connection)->DeletionBundle {
        let tx=conn.transaction().unwrap();capture(&tx,P,N).unwrap()
    }
    fn restored(receipt:&ProductCommandResult)->ProductCommand {
        let receipt=serde_json::to_value(receipt).unwrap();
        let change=&receipt["changeSet"]["changes"][0];
        serde_json::from_value(json!({"type":"RestoreSubtree","protocolVersion":"1.0.0","commandId":id(101),"projectId":P,"baseRevision":2,"expectedRevision":3,"rootNodeId":N,"nodes":change["nodes"],"deletionBundle":change["deletionBundle"]})).unwrap()
    }
    fn dump(conn:&Connection)->String {
        let mut stmt=conn.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").unwrap();
        let tables=stmt.query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        let mut result=String::new();
        for table in tables {
            let mut stmt=conn.prepare(&format!("SELECT * FROM {table} ORDER BY rowid")).unwrap();
            let columns=stmt.column_count();
            let data=stmt.query_map([],|r|(0..columns).map(|i|r.get::<_,rusqlite::types::Value>(i)).collect::<rusqlite::Result<Vec<_>>>()).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
            result.push_str(&format!("{table}:{data:?}\n"));
        }
        result
    }
    fn entry(command:ProductCommand)->collaboration::OutboxEntry {
        collaboration::OutboxEntry {command_id:command.command_id().into(),command,commit_attempt_id:1,queued_at_iso:"2026-10-05T00:00:00Z".into(),group_id:None,group_index:None}
    }
    #[test]
    fn enriched_roundtrip_preserves_all_authored_facts_and_exact_incident_dependencies() {
        let mut conn=fixture();
        let before=bundle(&mut conn);
        assert_eq!(before.unlock_edges.len(),2);
        assert_eq!(before.affected_reasons.len(),2);
        let result=handler::apply(&mut conn,delete()).unwrap();
        let value=serde_json::to_value(&result).unwrap();
        assert_eq!(value["changeSet"]["changes"][0]["deletionBundle"],serde_json::to_value(&before).unwrap());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM unlock_edges",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert!(matches!(handler::apply(&mut conn,restored(&result)).unwrap(),ProductCommandResult::ProductCommandApplied(_)));
        assert_eq!(bundle(&mut conn),before);
        for (table,count) in [("unlock_edges",3),("affected_reasons",3),("type_template_fields",1)] {
            assert_eq!(conn.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|r|r.get::<_,i64>(0)).unwrap(),count);
        }
        assert_eq!(conn.query_row("SELECT revision FROM projects WHERE id=?1",[id(7)],|r|r.get::<_,i64>(0)).unwrap(),8);
        assert_eq!(before.nodes[1].node_type.as_deref(),Some("LegacyVocabulary"));
        assert_eq!(before.nodes[0].effort_points_done,Some(0));
        assert_eq!(before.affected_reasons[0].acknowledged_at.as_deref(),Some("2026-10-03T00:00:00Z"));
    }
    #[test]
    fn conflicting_dependencies_positions_identity_and_changed_hierarchy_are_atomic_named_refusals() {
        for kind in ["external","phase","parent","position","identity","hierarchy"] {
            let mut conn=fixture();
        let result=handler::apply(&mut conn,delete()).unwrap();
            let sql=match kind {
                "external"=>format!("DELETE FROM nodes WHERE id='{}'",id(4)),
                "phase"=>format!("UPDATE phases SET project_id='{}' WHERE id='{}'",id(7),id(6)),
                "parent"=>format!("DELETE FROM nodes WHERE id='{}'",id(5)),
                "position"=>format!("INSERT INTO nodes(id,project_id,parent_id,title,position) VALUES('{}','{P}','{}','Occupied',1000)",id(80),id(5)),
                "identity"=>format!("INSERT INTO node_open_questions VALUES('{}','{P}','{}','Occupied','OPEN',NULL,2000,NULL,'2026-10-01')",id(20),id(4)),
                _=>format!("UPDATE nodes SET node_type='AcceptanceCriterion' WHERE id='{}'",id(5)),
            };
            conn.execute_batch(&sql).unwrap();
        let before=dump(&conn);
            let outcome=handler::apply(&mut conn,restored(&result)).unwrap();
            let value=serde_json::to_value(outcome).unwrap();
            assert_eq!(value["type"],"ProductCommandRejected","{kind}");
            assert_ne!(value["code"],"INTERNAL");
        assert_eq!(dump(&conn),before,"{kind}");
        }
    }
    #[test]
    fn complete_shared_restore_is_unavailable_without_authoritative_delete_authorization() {
        let mut conn=fixture();
        let result=handler::apply(&mut conn,delete()).unwrap();
        let before=dump(&conn);
        let outcome=handler::apply_shared(&mut conn,restored(&result),|_,_,_|Ok(())).unwrap();
        assert_eq!(serde_json::to_value(outcome).unwrap()["code"],"SHARED_BUNDLED_RESTORE_UNAVAILABLE");
        assert_eq!(dump(&conn),before);
    }
    #[test]
    fn invalid_bundle_and_missing_nullable_metadata_are_refused_without_fabricating_legacy_data() {
        let mut conn=fixture();
        let result=handler::apply(&mut conn,delete()).unwrap();
        let mut value=serde_json::to_value(restored(&result)).unwrap();
        value["deletionBundle"]["unlockEdges"]=json!([{"id":id(90),"sourceNodeId":id(4),"targetNodeId":id(5)}]);
        let before=dump(&conn);
        let command=serde_json::from_value(value).unwrap();
        assert_eq!(serde_json::to_value(handler::apply(&mut conn,command).unwrap()).unwrap()["code"],"INVALID_DELETION_BUNDLE");
        assert_eq!(dump(&conn),before);
        let mut value=serde_json::to_value(restored(&result)).unwrap();
        value["deletionBundle"]["nodes"][0].as_object_mut().unwrap().remove("bodyText");
        assert!(serde_json::from_value::<ProductCommand>(value).is_err());
        let mut value=serde_json::to_value(restored(&result)).unwrap();value.as_object_mut().unwrap().remove("deletionBundle");
        let legacy:ProductCommand=serde_json::from_value(value).unwrap();
        assert!(serde_json::to_value(&legacy).unwrap().get("deletionBundle").is_none());
        assert!(matches!(handler::apply(&mut conn,legacy).unwrap(),ProductCommandResult::ProductCommandApplied(_)));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM node_open_questions",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[test]
    fn storage_faults_abort_outer_attempt_and_identical_wire_retry_is_not_cached_as_rejection() {
        for fault in ["delete","receipt","secondDependency","existingMultiwrite"] {
            let mut conn=fixture();
            let command=if fault=="secondDependency" {
                let result=handler::apply(&mut conn,delete()).unwrap();restored(&result)
            } else if fault=="existingMultiwrite" {
                serde_json::from_value(json!({"type":"DuplicateSubtree","protocolVersion":"1.0.0","commandId":id(110),"projectId":P,"baseRevision":1,"expectedRevision":2,"sourceNodeId":N,"newRootId":id(90),"newPosition":"2000","idMap":{(N):id(90),(id(3)):id(91)}})).unwrap()
            } else {delete()};
            let before=dump(&conn);
            let trigger=match fault {
                "delete"=>"CREATE TRIGGER injected BEFORE DELETE ON nodes BEGIN SELECT RAISE(ABORT,'synthetic'); END".into(),
                "receipt"=>"CREATE TRIGGER injected BEFORE INSERT ON product_command_receipt BEGIN SELECT RAISE(ABORT,'synthetic'); END".into(),
                "secondDependency"=>"CREATE TRIGGER injected BEFORE INSERT ON node_custom_fields WHEN NEW.field_key='nullable' BEGIN SELECT RAISE(ABORT,'synthetic'); END".into(),
                _=>format!("CREATE TRIGGER injected BEFORE INSERT ON nodes WHEN NEW.id='{}' BEGIN SELECT RAISE(ABORT,'synthetic'); END",id(91)),
            };
            conn.execute_batch(&trigger).unwrap();
            assert!(collaboration::commit(&mut conn,P,command.clone(),entry(command.clone())).is_err(),"{fault}");
            assert_eq!(dump(&conn),before,"{fault}");
            conn.execute_batch("DROP TRIGGER injected").unwrap();
            assert!(matches!(collaboration::commit(&mut conn,P,command.clone(),entry(command)).unwrap(),ProductCommandResult::ProductCommandApplied(_)),"{fault}");
        }
    }
    #[test]
    fn valid_domain_refusal_retains_typed_attempt_without_mutation() {
        let mut conn=fixture();
        let result=handler::apply(&mut conn,delete()).unwrap();
        conn.execute("DELETE FROM nodes WHERE id=?1",[id(4)]).unwrap();
        let command=restored(&result);
        let outcome=collaboration::commit(&mut conn,P,command.clone(),entry(command.clone())).unwrap();
        assert_eq!(serde_json::to_value(&outcome).unwrap()["code"],"RESTORE_DEPENDENCY_MISSING");
        let before=dump(&conn);
        assert_eq!(collaboration::commit(&mut conn,P,command.clone(),entry(command)).unwrap(),outcome);
        assert_eq!(dump(&conn),before);
        assert_eq!(conn.query_row("SELECT revision FROM projects WHERE id=?1",[P],|r|r.get::<_,i64>(0)).unwrap(),2);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM nodes WHERE id=?1",[N],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
}
