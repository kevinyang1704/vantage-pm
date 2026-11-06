//! Offline file contribution state and graph commits on the repository actor.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::protocol::{recovery::RecoveryGraph, RepositoryError};
use super::recovery_graph;
fn storage(_: rusqlite::Error) -> RepositoryError{
    RepositoryError::IntegrityFailed
}
pub const DDL: &str="CREATE TABLE IF NOT EXISTS local_file_state(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,state_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_file_recovery(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,snapshot_json TEXT NOT NULL,state_json TEXT,applied_revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS local_file_receipt(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,operation_id TEXT NOT NULL,payload_hash TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(project_id,operation_id));";
fn invalid() -> RepositoryError{
    RepositoryError::InvalidRequest
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, RepositoryError>{
    value.get(key).and_then(Value::as_str).ok_or_else(invalid)
}
fn digest(value: &Value) -> Result<String, RepositoryError>{
    let canonical=serde_json_canonicalizer::to_string(value).map_err(|_|invalid())?;
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}
fn snapshot_hash(snapshot: &Value) -> Result<String, RepositoryError>{
    let mut content=snapshot.clone();
    let object=content.as_object_mut().ok_or_else(invalid)?;
    let project=object.remove("projectId").ok_or_else(invalid)?;
    let name=object.remove("projectName").ok_or_else(invalid)?;
    object.remove("projectRevision");
    object.insert("schemaVersion".into(), json!(9));
    object.insert("exportedAt".into(), json!("2026-01-01T00:00:00.000Z"));
    object.insert("project".into(), json!({
        "id": project,"name": name
    }
    ));
    for key in ["nodes","phases","nodeCustomFields","typeTemplateFields","unlockEdges","findingDismissals","affectedReasons","openQuestions","forecastScenarios"] {
        if let Some(Value::Array(rows))=object.get_mut(key){
            let mut keyed=rows.iter().map(|row|Ok((digest(row)?, row.clone()))).collect::<Result<Vec<_>, RepositoryError>>()?;
            keyed.sort_by(|a, b|a.0.cmp(&b.0));
            *rows=keyed.into_iter().map(|(_, row)|row).collect();
        }
    }
    digest(&content)
}
pub fn validate_state(raw: &str, project: &str) -> Result<(), RepositoryError>{
    if raw.len()>30*1024*1024{
        return Err(invalid());
    }
    let value: Value=serde_json::from_str(raw).map_err(|_|invalid())?;
    if value["version"]!=1||!crate::protocol::uuid_v7::is_uuid_v7(text(&value,"lineageId")?)||!crate::protocol::uuid_v7::is_uuid_v7(text(&value,"replicaId")?){
        return Err(invalid());
    }
    if let Some(sequence) = value.get("exportSequence") {
        if sequence.as_u64().filter(|n| *n <= 9_007_199_254_740_991).is_none() { return Err(invalid()); }
    }
    let checkpoints=value["checkpoints"].as_array().ok_or_else(invalid)?;
    if checkpoints.is_empty()||checkpoints.len()>32{
        return Err(invalid());
    }
    for checkpoint in checkpoints{
        let snapshot=checkpoint.get("snapshot").ok_or_else(invalid)?;
        if text(snapshot,"projectId")?!=project||text(checkpoint,"hash")?!=snapshot_hash(snapshot)?{
            return Err(invalid());
        }
        let revision=snapshot["projectRevision"].as_i64().filter(|n|*n>=1&&*n<9_007_199_254_740_991).ok_or_else(invalid)?;
        graph(snapshot, revision)?;
    }
    let decisions=value["decisions"].as_object().ok_or_else(invalid)?;
    for (key, v) in decisions{
        if key.len()!=64||!key.bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c))||!matches!(v.as_str(), Some("accept"|"decline")){
            return Err(invalid());
        }
    }
    for (key, branch) in value["branches"].as_object().ok_or_else(invalid)?{
        if !crate::protocol::uuid_v7::is_uuid_v7(key){
            return Err(invalid());
        }
        for (from, to) in branch["mapping"].as_object().ok_or_else(invalid)? {
            if !crate::protocol::uuid_v7::is_uuid_v7(from)||!to.as_str().is_some_and(crate::protocol::uuid_v7::is_uuid_v7){
                return Err(invalid());
            }
        }
        if !branch["base"].is_object()||(!branch["parentId"].is_null()&&!branch["parentId"].as_str().is_some_and(crate::protocol::uuid_v7::is_uuid_v7)){
            return Err(invalid());
        }
    }
    if let Some(sources)=value.get("sources"){
        for (key, snapshot) in sources.as_object().ok_or_else(invalid)?{
            if !crate::protocol::uuid_v7::is_uuid_v7(key)||!snapshot.is_object(){
                return Err(invalid());
            }
        }
    }
    Ok(())
}
/// Preserve the sending clock when graph/merge state is restored to an older cut.
/// A null recovery state remains null: it does not acquire the current lineage.
fn restore_state(previous: Option<&str>, current: Option<&str>) -> Result<Option<String>, RepositoryError> {
    let Some(previous) = previous else { return Ok(None); };
    let Some(current) = current else { return Ok(Some(previous.to_string())); };
    let mut restored: Value = serde_json::from_str(previous).map_err(|_| invalid())?;
    let active: Value = serde_json::from_str(current).map_err(|_| invalid())?;
    let restored_sequence = restored.get("exportSequence").and_then(Value::as_u64).unwrap_or(0);
    let active_sequence = active.get("exportSequence").and_then(Value::as_u64).unwrap_or(0);
    if restored.get("replicaId") == active.get("replicaId") && active_sequence > restored_sequence {
        restored["exportSequence"] = json!(active_sequence);
        return Ok(Some(restored.to_string()));
    }
    Ok(Some(previous.to_string()))
}

pub fn read(conn: &Connection, project: &str) -> Result<Option<String>, RepositoryError>{
    conn.query_row("SELECT state_json FROM local_file_state WHERE project_id=?1", [project], |r|r.get(0)).optional().map_err(storage)
}
fn set_state(conn: &Connection, project: &str, value: Option<&str>) -> Result<(), RepositoryError>{
    if let Some(raw)=value {
        conn.execute("INSERT INTO local_file_state(project_id,state_json) VALUES(?1,?2) ON CONFLICT(project_id) DO UPDATE SET state_json=excluded.state_json", params![project, raw]).map_err(storage)?;
    }
    else{
        conn.execute("DELETE FROM local_file_state WHERE project_id=?1", [project]).map_err(storage)?;
    }
    Ok(())
}
fn check(conn: &Connection, project: &str, expected: i64) -> Result<(), RepositoryError>{
    let rev: Option<i64>=conn.query_row("SELECT revision FROM projects WHERE id=?1", [project], |r|r.get(0)).optional().map_err(storage)?;
    if rev.is_none(){
        return Err(RepositoryError::ProjectNotFound);
    }
    if expected<0||expected>=9_007_199_254_740_991{
        return Err(invalid());
    }
    if rev!=Some(expected){
        return Err(RepositoryError::revision_conflict(rev.unwrap_or(0)));
    }
    let online: bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_cursor WHERE project_id=?1)", [project], |r|r.get(0)).map_err(storage)?;
    if online{
        return Err(invalid());
    }
    Ok(())
}
const COLLECTIONS: [(&str, &str);
8]=[("phases","phases"), ("nodes","nodes"), ("nodeCustomFields","customFields"), ("typeTemplateFields","typeTemplateFields"), ("unlockEdges","unlockEdges"), ("findingDismissals","dismissals"), ("affectedReasons","affectedReasons"), ("openQuestions","openQuestions")];
fn graph(snapshot: &Value, revision: i64) -> Result<RecoveryGraph, RepositoryError>{
    let allowed=["projectId","projectName","projectRevision","phases","nodes","nodeCustomFields","typeTemplateFields","unlockEdges","findingDismissals","affectedReasons","openQuestions","forecastPlan","forecastScenarios"];
    if snapshot.as_object().ok_or_else(invalid)?.keys().any(|key|!allowed.contains(&key.as_str())) || snapshot.to_string().len()>10*1024*1024{
        return Err(invalid());
    }
    fn safe_text(value: &Value) -> bool {
        match value {
            Value::String(text)=>{
                let mut chars=text.chars();
                let mut previous=' ';
                for ch in chars.by_ref(){
                    if previous=='<'&&ch.is_ascii_alphabetic(){
                        return false;
                    }
                    previous=ch;
                }
                !text.chars().filter(|ch|!ch.is_whitespace()).collect::<String>().to_ascii_lowercase().contains("javascript:")
            }
            , Value::Array(items)=>items.iter().all(safe_text), Value::Object(items)=>items.values().all(safe_text), _=>true
        }
    }
    if !safe_text(snapshot){
        return Err(invalid());
    }
    for (field, maximum) in [("nodes", 5000), ("phases", 200), ("unlockEdges", 2000), ("affectedReasons", 2000)] {
        if snapshot.get(field).and_then(Value::as_array).ok_or_else(invalid)?.len()>maximum{
            return Err(invalid());
        }
    }
    let project=text(snapshot,"projectId")?;
    let name=text(snapshot,"projectName")?;
    if !crate::protocol::uuid_v7::is_uuid_v7(project)||name.trim().is_empty()||name.chars().count()>200{
        return Err(invalid());
    }
    let mut result=json!({
        "project": {
            "id": project,"name": name,"revision": revision
        }
        ,"forecastPlans": [],"forecastScenarios": []
    }
    );
    for (portable, recovery) in COLLECTIONS {
        let rows=snapshot.get(portable).and_then(Value::as_array).ok_or_else(invalid)?;
        let mut out=Vec::new();
        for row in rows{
            let mut row=row.clone();
            let object=row.as_object_mut().ok_or_else(invalid)?;
            object.insert("projectId".into(), json!(project));
            if let Some(position)=object.get("position"){
                let n=position.as_str().and_then(|s|s.parse::<i64>().ok()).or_else(||position.as_i64()).ok_or_else(invalid)?;
                object.insert("position".into(), json!(n));
            }
            if portable=="nodes" {
                object.entry("deliveryStatus").or_insert(json!("not_started"));
            }
            if portable=="openQuestions" {
                if let Some(v)=object.remove("createdAtISO"){
                    object.insert("createdAtIso".into(), v);
                }
                if let Some(v)=object.remove("resolvedAtISO"){
                    object.insert("resolvedAtIso".into(), v);
                }
            }
            out.push(row);
        }
        result[recovery]=Value::Array(out);
    }
    if let Some(plan)=snapshot.get("forecastPlan").filter(|p|!p.is_null()) {
        let mut plan=plan.clone();
        let o=plan.as_object_mut().ok_or_else(invalid)?;
        o.insert("projectId".into(), json!(project));
        for field in ["selectedFeatureIds","parallelGroups","blockedFeatureIds","roster","assignments","sprintPlan"]{
            let value=o.remove(field).unwrap_or_else(||if field=="assignments"||field=="sprintPlan"{
                json!({
                }
                )
            }
            else{
                json!([])
            }
            );
            o.insert(field.into(), json!(value.to_string()));
        }
        o.entry("planningLevel").or_insert(json!("Feature"));
        result["forecastPlans"]=json!([plan]);
    }
    if let Some(scenarios)=snapshot.get("forecastScenarios").and_then(Value::as_array){
        let mut out=Vec::new();
        for scenario in scenarios{
            let mut row=scenario.clone();
            let o=row.as_object_mut().ok_or_else(invalid)?;
            o.insert("projectId".into(), json!(project));
            for (from, to) in [("baseline","baselineJson"), ("patch","patchJson")]{
                let v=o.remove(from).ok_or_else(invalid)?;
                o.insert(to.into(), json!(v.to_string()));
            }
            if let Some(v)=o.remove("createdAtISO"){
                o.insert("createdAtIso".into(), v);
            }
            out.push(row);
        }
        result["forecastScenarios"]=Value::Array(out);
    }
    let result: RecoveryGraph=serde_json::from_value(result).map_err(|_|invalid())?;
    result.validate(project)?;
    if result.unlock_edges.iter().any(|edge|edge.source_node_id==edge.target_node_id){return Err(invalid());}

    for node in &result.nodes {
        if node.node_type.as_deref().is_some_and(|kind|!["Vision","Theme","Component","Feature","AcceptanceCriterion"].contains(&kind)) || node.schedule_source_mode.as_deref().is_some_and(|mode|!["start_end","start_duration","end_duration","none"].contains(&mode)) || node.delivery_status.as_deref().is_some_and(|status|!["not_started","in_progress","delivered"].contains(&status)){
            return Err(invalid());
        }
    }
    Ok(result)
}
pub fn validate_snapshot(snapshot: &Value) -> Result<(), RepositoryError> {
    let revision = snapshot.get("projectRevision").and_then(Value::as_i64).filter(|value| *value >= 1 && *value < 9_007_199_254_740_991).ok_or_else(invalid)?;
    graph(snapshot, revision).map(|_| ())
}

fn portable(graph: &RecoveryGraph) -> Result<Value, RepositoryError>{
    let g=serde_json::to_value(graph).map_err(|_|invalid())?;
    let mut result=json!({
        "projectId": graph.project.id,"projectName": graph.project.name,"projectRevision": graph.project.revision
    }
    );
    for (portable, recovery) in COLLECTIONS {
        let mut rows=g[recovery].as_array().ok_or_else(invalid)?.clone();
        for row in &mut rows{
            let o=row.as_object_mut().ok_or_else(invalid)?;
            o.remove("projectId");
            if let Some(position)=o.get("position"){
                if portable!="typeTemplateFields"{
                    let n=position.as_i64().ok_or_else(invalid)?;
                    o.insert("position".into(), json!(n.to_string()));
                }
            }
            if portable=="openQuestions" {
                if let Some(v)=o.remove("createdAtIso"){
                    o.insert("createdAtISO".into(), v);
                }
                if let Some(v)=o.remove("resolvedAtIso"){
                    o.insert("resolvedAtISO".into(), v);
                }
            }
        }
        result[portable]=Value::Array(rows);
    }
    if let Some(plan)=g["forecastPlans"].as_array().and_then(|a|a.first()){
        let mut plan=plan.clone();
        let o=plan.as_object_mut().ok_or_else(invalid)?;
        o.remove("projectId");
        for field in ["selectedFeatureIds","parallelGroups","blockedFeatureIds","roster","assignments","sprintPlan"]{
            let raw=o.get(field).and_then(Value::as_str).ok_or_else(invalid)?;
            let v=serde_json::from_str(raw).map_err(|_|invalid())?;
            o.insert(field.into(), v);
        }
        result["forecastPlan"]=plan;
    }
    let mut scenarios=Vec::new();
    for scenario in g["forecastScenarios"].as_array().ok_or_else(invalid)?{
        let mut row=scenario.clone();
        let o=row.as_object_mut().ok_or_else(invalid)?;
        o.remove("projectId");
        for (from, to) in [("baselineJson","baseline"), ("patchJson","patch")]{
            let raw=o.remove(from).ok_or_else(invalid)?;
            o.insert(to.into(), serde_json::from_str(raw.as_str().ok_or_else(invalid)?).map_err(|_|invalid())?);
        }
        if let Some(v)=o.remove("createdAtIso"){
            o.insert("createdAtISO".into(), v);
        }
        scenarios.push(row);
    }
    if !scenarios.is_empty(){
        result["forecastScenarios"]=Value::Array(scenarios);
    }
    Ok(result)
}
pub fn recovery(conn: &Connection, project: &str) -> Result<Value, RepositoryError>{
    let row: Option<(String, Option<String>, i64)>=conn.query_row("SELECT snapshot_json,state_json,applied_revision FROM local_file_recovery WHERE project_id=?1", [project], |r|Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().map_err(storage)?;
    match row{
        None=>Ok(Value::Null), Some((raw, state, rev))=>Ok(json!({
            "snapshot": serde_json::from_str::<Value>(&raw).map_err(|_|invalid())?,"stateJson": state,"appliedRevision": rev
        }
        ))
    }
}
pub fn operate(conn: &mut Connection, operation: &str, input: Value) -> Result<Value, RepositoryError>{
    let project=text(&input,"projectId")?.to_owned();
    if operation=="read"{
        return Ok(json!(read(conn, &project)?));
    }
    if operation=="recovery"{
        return recovery(conn, &project);
    }
    let expected=input.get("expectedRevision").and_then(Value::as_i64).ok_or_else(invalid)?;
    if expected<0||expected>=9_007_199_254_740_991{
        return Err(invalid());
    }
    if operation=="write"{
        let raw=text(&input,"stateJson")?;
        validate_state(raw, &project)?;
        let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
        check(&tx, &project, expected)?;
        set_state(&tx, &project, Some(raw))?;
        tx.commit().map_err(storage)?;
        return Ok(Value::Null);
    }
    let id=text(&input,"operationId")?;
    if id.is_empty()||id.len()>200{
        return Err(invalid());
    }
    let payload=digest(&input)?;
    let prepared=if operation=="apply"{
        let raw=text(&input,"stateJson")?;
        validate_state(raw, &project)?;
        let snapshot=input.get("snapshot").ok_or_else(invalid)?;
        if text(snapshot,"projectId")?!=project{
            return Err(invalid());
        }
        Some(graph(snapshot, expected+1)?)
    }
    else if operation=="restore"{
        None
    }
    else{
        return Err(invalid());
    };
    let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
    let prior: Option<(String, i64)>=tx.query_row("SELECT payload_hash,revision FROM local_file_receipt WHERE project_id=?1 AND operation_id=?2", params![project, id], |r|Ok((r.get(0)?, r.get(1)?))).optional().map_err(storage)?;
    if let Some((prior, rev))=prior {
        if prior!=payload{
            return Err(RepositoryError::CommandIdentityConflict);
        }
        tx.commit().map_err(storage)?;
        return Ok(json!({
            "revision": rev
        }
        ));
    }
    check(&tx, &project, expected)?;
    if let Some(candidate)=prepared {
        let before=portable(&recovery_graph::capture_graph(&tx, &project)?)?;
        let old=read(&tx, &project)?;
        tx.execute("INSERT INTO local_file_recovery(project_id,snapshot_json,state_json,applied_revision) VALUES(?1,?2,?3,?4) ON CONFLICT(project_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,state_json=excluded.state_json,applied_revision=excluded.applied_revision", params![project, before.to_string(), old, expected+1]).map_err(storage)?;
        recovery_graph::replace_graph(&tx, &candidate, &project)?;
        set_state(&tx, &project, Some(text(&input,"stateJson")?))?;
    }
    else{
        let previous=recovery(&tx, &project)?;
        if previous.is_null(){
            return Err(invalid());
        }
        let current=portable(&recovery_graph::capture_graph(&tx, &project)?)?;
        let current_state=read(&tx, &project)?;
        if let Some(raw)=previous["stateJson"].as_str(){validate_state(raw, &project)?;}
    let candidate=graph(&previous["snapshot"], expected+1)?;
        recovery_graph::replace_graph(&tx, &candidate, &project)?;
        let restored_state = restore_state(previous["stateJson"].as_str(), current_state.as_deref())?;
        set_state(&tx, &project, restored_state.as_deref())?;
        tx.execute("DELETE FROM local_file_receipt WHERE project_id=?1", [&project]).map_err(storage)?;
        tx.execute("UPDATE local_file_recovery SET snapshot_json=?1,state_json=?2,applied_revision=?3 WHERE project_id=?4", params![current.to_string(), current_state, expected+1, project]).map_err(storage)?;
    }
    tx.execute("DELETE FROM product_command_receipt WHERE project_id=?1", [&project]).map_err(storage)?;
    tx.execute("INSERT INTO local_file_receipt(project_id,operation_id,payload_hash,revision) VALUES(?1,?2,?3,?4)", params![project, id, payload, expected+1]).map_err(storage)?;
    tx.commit().map_err(storage)?;
    Ok(json!({
        "revision": expected+1
    }
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    const P: &str="0198a000-0000-7000-8000-000000000001";
    const N: &str="0198a000-0000-7000-8000-000000000002";
    fn setup() -> Connection {
        let conn=Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        crate::db::handler::initialize_schema(&conn).unwrap();
        conn.execute("INSERT INTO projects(id,name,revision) VALUES(?1,'Synthetic',1)", [P]).unwrap();
        conn.execute("INSERT INTO nodes(id,project_id,title,position) VALUES(?1,?2,'Before',0)", params![N, P]).unwrap();
        conn
    }
    fn metadata(conn: &Connection, other: bool) -> String{
        let snapshot=portable(&recovery_graph::capture_graph(conn, P).unwrap()).unwrap();
        json!({
            "version": 1,"lineageId": P,"replicaId": if other{
                N
            }
            else{
                P
            }
            ,"checkpoints": [{
                "hash": snapshot_hash(&snapshot).unwrap(),"snapshot": snapshot
            }
            ],"decisions": {
            }
            ,"branches": {
            }
        }
        ).to_string()
    }
    fn contribution(conn: &Connection) -> Value{
        let mut snapshot=portable(&recovery_graph::capture_graph(conn, P).unwrap()).unwrap();
        snapshot["nodes"][0]["title"]=json!("Incoming");
        json!({
            "projectId": P,"expectedRevision": 1,"operationId": "synthetic-operation","stateJson": metadata(conn, true),"snapshot": snapshot
        }
        )
    }
    fn title(conn: &Connection) -> String{
        conn.query_row("SELECT title FROM nodes WHERE id=?1", [N], |r|r.get(0)).unwrap()
    }
    #[test]
    fn applies_once_and_recovers_graph_and_metadata_after_intervening_edits(){
        let mut conn=setup();
        let before=metadata(&conn, false);
        operate(&mut conn,"write", json!({
            "projectId": P,"expectedRevision": 1,"stateJson": before
        }
        )).unwrap();
        let input=contribution(&conn);
        assert_eq!(operate(&mut conn,"apply", input.clone()).unwrap()["revision"], 2);
        assert_eq!(title(&conn),"Incoming");
        assert_eq!(read(&conn, P).unwrap(), input["stateJson"].as_str().map(str::to_owned));
        assert_eq!(operate(&mut conn,"apply", input).unwrap()["revision"], 2);
        conn.execute("UPDATE projects SET revision=3 WHERE id=?1", [P]).unwrap();
        let restore=json!({
            "projectId": P,"expectedRevision": 3,"operationId": "synthetic-restore"
        }
        );
        assert_eq!(operate(&mut conn,"restore", restore.clone()).unwrap()["revision"], 4);
        assert_eq!(title(&conn),"Before");
        assert_eq!(read(&conn, P).unwrap(), Some(before));
        assert_eq!(recovery(&conn, P).unwrap()["snapshot"]["nodes"][0]["title"],"Incoming");
        assert_eq!(operate(&mut conn,"restore", restore).unwrap()["revision"], 4);
    }
    #[test]
    fn rejects_stale_review_and_rolls_back_graph_state_and_recovery_on_sql_failure(){
        let mut conn=setup();
        let mut stale=contribution(&conn);
        stale["expectedRevision"]=json!(0);
        assert!(operate(&mut conn,"apply", stale).is_err());
        conn.execute_batch("CREATE TEMP TRIGGER reject_file BEFORE INSERT ON nodes WHEN NEW.title='Incoming' BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        let input=contribution(&conn);
        assert!(operate(&mut conn,"apply", input).is_err());
        assert_eq!(title(&conn),"Before");
        assert!(read(&conn, P).unwrap().is_none());
        assert!(recovery(&conn, P).unwrap().is_null());
    }
    #[test]
    fn rejects_cycles_before_replacement_and_same_id_different_payload(){
        let mut conn=setup();
        let mut input=contribution(&conn);
        input["snapshot"]["nodes"][0]["parentId"]=json!(N);
        assert!(operate(&mut conn,"apply", input).is_err());
        let mut valid=contribution(&conn);
        operate(&mut conn,"apply", valid.clone()).unwrap();
        valid["stateJson"]=json!(metadata(&conn, false));
        assert!(operate(&mut conn,"apply", valid).is_err());
    }
    #[test]
    fn refuses_invalid_lineage_and_self_unlocks_before_mutation() {
        let mut conn = setup();
        assert!(operate(&mut conn, "write", json!({"projectId":P,"expectedRevision":1,"stateJson":"{\"version\":2}"})).is_err());
        let mut input = contribution(&conn);
        input["snapshot"]["unlockEdges"] = json!([{"id":"0198a000-0000-7000-8000-000000000003","sourceNodeId":N,"targetNodeId":N}]);
        assert!(operate(&mut conn,"apply",input).is_err());
        assert_eq!(title(&conn), "Before");
        assert!(read(&conn,P).unwrap().is_none());
        assert!(recovery(&conn,P).unwrap().is_null());
    }
    #[test]
    fn recovery_preserves_export_sequence_for_same_replica_and_toggle() {
        let mut conn = setup();
        let mut before: Value = serde_json::from_str(&metadata(&conn, false)).unwrap();
        before["exportSequence"] = json!(5);
        operate(&mut conn, "write", json!({"projectId":P,"expectedRevision":1,"stateJson":before.to_string()})).unwrap();
        let mut contribution = contribution(&conn);
        let mut applied = before.clone();
        applied["exportSequence"] = json!(6);
        contribution["stateJson"] = json!(applied.to_string());
        operate(&mut conn,"apply",contribution).unwrap();
        let mut latest = before.clone();
        latest["exportSequence"] = json!(7);
        operate(&mut conn,"write",json!({"projectId":P,"expectedRevision":2,"stateJson":latest.to_string()})).unwrap();
        operate(&mut conn,"restore",json!({"projectId":P,"expectedRevision":2,"operationId":"restore-sequence"})).unwrap();
        let restored: Value = serde_json::from_str(&read(&conn,P).unwrap().unwrap()).unwrap();
        assert_eq!(restored["exportSequence"],7);
        assert_eq!(restored["replicaId"],before["replicaId"]);
        assert_eq!(title(&conn),"Before");
        operate(&mut conn,"restore",json!({"projectId":P,"expectedRevision":3,"operationId":"toggle-sequence"})).unwrap();
        let toggled: Value = serde_json::from_str(&read(&conn,P).unwrap().unwrap()).unwrap();
        assert_eq!(toggled["exportSequence"],7);
        assert_eq!(title(&conn),"Incoming");
        assert!(restore_state(None,Some(&latest.to_string())).unwrap().is_none());
        let other = json!({"replicaId":N,"exportSequence":99}).to_string();
        assert_eq!(restore_state(Some(&before.to_string()),Some(&other)).unwrap(),Some(before.to_string()));
    }
}
