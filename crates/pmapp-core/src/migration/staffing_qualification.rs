//! Native staffing schema upgrade qualification (Story 22.13, AC 22.13-1..4;
//! review R13).
//!
//! Every case opens a real on-disk database through the production startup
//! path, `db::runtime::open_connection` (pre-migration snapshot, ordered
//! transactional steps, workspace backfill, quick_check, foreign_key_check).
//! Predecessor databases are built from DDL extracted VERBATIM from the builds
//! that created them (`tests/fixtures/staffing-migration/legacy-schemas.json`,
//! shared with the browser qualification) and populated with synthetic facts.
//!
//! Interruption uses a real process death: the test binary re-launches itself
//! as a child that runs the registry's own step SQL inside the runner's
//! IMMEDIATE transaction and calls `std::process::abort()` before commit (or
//! between steps). The parent then inspects the file and restarts it.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::{types::ValueRef, Connection, TransactionBehavior};
use serde_json::{json, Value};

use crate::db::runtime::{open_connection, query_project_snapshot};
use crate::db::schema::CURRENT_SCHEMA_VERSION;
use crate::migration::registry::migration_steps;
use crate::migration::runner::{adjudicate_startup, StartupState};

const FIXTURE: &str = include_str!("../../../../tests/fixtures/staffing-migration/legacy-schemas.json");
const CRASH_ENV: &str = "PMAPP_STAFFING_CRASH_BOUNDARY";
const CRASH_DB_ENV: &str = "PMAPP_STAFFING_CRASH_DB";

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("legacy-schemas.json parses")
}

fn source(version: i64) -> Value {
    fixture()["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["version"].as_i64() == Some(version))
        .cloned()
        .unwrap_or_else(|| panic!("no fixture for v{version}"))
}

fn project_id() -> String {
    fixture()["ids"]["project"].as_str().unwrap().to_string()
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pmapp-22-13-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A database exactly as the predecessor build left it: its DDL, synthetic
/// facts, its own `user_version`, WAL as the native runtime always sets.
fn legacy_file(dir: &Path, version: i64) -> PathBuf {
    let src = source(version);
    let path = dir.join(format!("legacy-v{version}.sqlite"));
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.pragma_update(None, "application_id", crate::db::schema::PMAPP_APPLICATION_ID).unwrap();
    for ddl in src["nativeDdl"].as_array().unwrap() {
        conn.execute_batch(ddl.as_str().unwrap()).unwrap();
    }
    for statement in src["data"].as_array().unwrap() {
        conn.execute_batch(statement.as_str().unwrap()).unwrap();
    }
    conn.pragma_update(None, "user_version", version).unwrap();
    drop(conn);
    path
}

fn read_only(path: &Path) -> Connection {
    Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

fn user_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
}

fn tables(conn: &Connection) -> Vec<String> {
    conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn column_names(conn: &Connection, table: &str) -> Vec<String> {
    conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .unwrap()
        .query_map([], |r| r.get(1))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// Column contract keyed by name: type, notnull, default, pk.
fn columns(conn: &Connection) -> BTreeMap<String, BTreeMap<String, Value>> {
    tables(conn)
        .into_iter()
        .map(|t| {
            let cols = conn
                .prepare(&format!("PRAGMA table_info(\"{t}\")"))
                .unwrap()
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(1)?,
                        json!({
                            "type": r.get::<_, String>(2)?,
                            "notnull": r.get::<_, i64>(3)?,
                            "dflt": r.get::<_, Option<String>>(4)?,
                            "pk": r.get::<_, i64>(5)?,
                        }),
                    ))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect();
            (t, cols)
        })
        .collect()
}

fn value_of(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => json!(format!("blob:{}", b.len())),
    }
}

/// Every row of every table in storage order, as column-name -> value maps.
fn dump(conn: &Connection) -> BTreeMap<String, Vec<BTreeMap<String, Value>>> {
    tables(conn)
        .into_iter()
        .map(|t| {
            let names = column_names(conn, &t);
            let rows = conn
                .prepare(&format!("SELECT * FROM \"{t}\" ORDER BY rowid"))
                .unwrap()
                .query_map([], |r| {
                    Ok(names
                        .iter()
                        .enumerate()
                        .map(|(i, n)| (n.clone(), value_of(r.get_ref(i).unwrap())))
                        .collect::<BTreeMap<_, _>>())
                })
                .unwrap()
                .map(Result::unwrap)
                .collect();
            (t, rows)
        })
        .collect()
}

/// `after` restricted to the columns that existed in `before`, table by table.
fn assert_prior_facts_preserved(
    before: &BTreeMap<String, Vec<BTreeMap<String, Value>>>,
    after: &BTreeMap<String, Vec<BTreeMap<String, Value>>>,
    context: &str,
) {
    for (table, rows) in before {
        let projected: Vec<BTreeMap<String, Value>> = after[table]
            .iter()
            .map(|row| row.iter().filter(|(k, _)| rows.first().map_or(false, |r| r.contains_key(*k))).map(|(k, v)| (k.clone(), v.clone())).collect())
            .collect();
        assert_eq!(&projected, rows, "{context}: table {table} lost or changed a prior fact");
    }
}

fn integrity_ok(conn: &Connection) {
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
    assert_eq!(integrity, "ok");
    let fk = conn.prepare("PRAGMA foreign_key_check").unwrap().query_map([], |_| Ok(())).unwrap().count();
    assert_eq!(fk, 0, "foreign key violations");
}

fn open_startup(path: &Path) -> Result<Connection, crate::protocol::errors::RepositoryError> {
    let mut slot = None;
    let result = open_connection(&mut slot, &path.to_path_buf())?;
    assert_eq!(result.user_version, CURRENT_SCHEMA_VERSION);
    Ok(slot.take().unwrap())
}

fn fresh_baseline_columns() -> BTreeMap<String, BTreeMap<String, Value>> {
    let dir = temp_dir("fresh");
    let conn = open_startup(&dir.join("fresh.sqlite")).unwrap();
    columns(&conn)
}

fn pre_migration_path(db: &Path, version: i64) -> PathBuf {
    db.with_extension(format!("pre-migration-v{version}.sqlite"))
}

// ── AC 22.13-1: populated predecessors upgrade through the real startup path ──

#[test]
fn populated_predecessors_upgrade_through_native_startup() {
    let baseline = fresh_baseline_columns();
    for version in [9_i64, 12, 13] {
        let dir = temp_dir(&format!("upgrade-v{version}"));
        let path = legacy_file(&dir, version);
        let before = dump(&read_only(&path));

        let conn = open_startup(&path).unwrap_or_else(|e| panic!("v{version} failed to open: {e:?}"));
        assert_eq!(user_version(&conn), CURRENT_SCHEMA_VERSION, "v{version}");
        let after = dump(&conn);
        assert_prior_facts_preserved(&before, &after, &format!("v{version}"));
        assert_eq!(after["projects"][0]["revision"], json!(7), "v{version} revision");
        assert_eq!(after["product_command_receipt"].len(), 2, "v{version} receipts");
        assert_eq!(columns(&conn), baseline, "v{version}: migrated schema differs from fresh baseline");
        integrity_ok(&conn);

        // A legacy plan reads as shared, with empty staffing, through the reader
        // the webview uses.
        let snapshot = query_project_snapshot(&conn, &project_id()).unwrap();
        if version >= 12 {
            let plan = snapshot.forecast_plan.expect("legacy plan survives");
            assert_eq!(plan.policy_version, "shared-capacity-v1");
            assert!(plan.roster.is_empty() && plan.assignments.is_empty(), "v{version}: staffing fabricated");
            assert_eq!(plan.planning_level, "Feature");
            assert_eq!(plan.selected_feature_ids.len(), 2);
            assert_eq!(after["forecast_plans"][0]["roster"], json!("[]"));
            assert_eq!(after["forecast_plans"][0]["assignments"], json!("{}"));
        } else {
            assert!(snapshot.forecast_plan.is_none());
        }

        // The verified pre-migration snapshot holds the untouched predecessor.
        let pre = read_only(&pre_migration_path(&path, version));
        assert_eq!(user_version(&pre), version);
        assert_eq!(dump(&pre), before, "v{version}: pre-migration snapshot is not the predecessor");
        println!("QUALIFY upgrade v{version} -> v{CURRENT_SCHEMA_VERSION}: ok (facts preserved, integrity ok, pre-migration snapshot v{version} verified)");
    }
}

#[test]
fn v13_applies_exactly_the_two_staffing_steps() {
    // Steps after v13: v14 roster, v15 assignments (Story 22.4), then v16
    // points-done (Story 26.5) and v17 actor-id (Epic 27, Story 27.3) — later,
    // unrelated steps, followed by v18 collaboration journals and v19
    // recovery/stream-epoch sidecars and v21 the Delivery Board sprint plan.
    // The first two are the staffing steps this test names.
    let pending: Vec<i64> = migration_steps().iter().map(|s| s.version).filter(|v| *v > 13).collect();
    assert_eq!(pending, vec![14, 15, 16, 17, 18, 19, 20, 21]);
    let sql: Vec<&str> = migration_steps().iter().filter(|s| s.version > 13).map(|s| s.sql).collect();
    assert!(sql[0].contains("ADD COLUMN roster") && sql[1].contains("ADD COLUMN assignments"));
    assert!(sql[2].contains("ADD COLUMN effort_points_done"));
    assert!(sql[3].contains("ADD COLUMN actor_id"));
    assert!(sql[4].contains("CREATE TABLE IF NOT EXISTS collaboration_outbox"));
    assert!(sql[5].contains("collaboration_recovery_archive"));
    assert!(sql[6].contains("local_file_state"));
    assert!(sql[7].contains("ADD COLUMN sprint_plan"));
}

// ── AC 22.13-2: repeating startup is a no-op ──────────────────────────────

#[test]
fn repeated_startup_is_idempotent() {
    let dir = temp_dir("idempotent");
    let path = legacy_file(&dir, 13);
    let once = {
        let conn = open_startup(&path).unwrap();
        (dump(&conn), columns(&conn))
    };
    for _ in 0..2 {
        let conn = open_startup(&path).unwrap();
        assert_eq!((dump(&conn), columns(&conn)), once);
        assert_eq!(user_version(&conn), CURRENT_SCHEMA_VERSION);
    }
    assert!(
        !pre_migration_path(&path, CURRENT_SCHEMA_VERSION).exists(),
        "a current database must not be re-migrated or re-snapshotted"
    );
    println!("QUALIFY repeat startup x2 on migrated v13: no change");
}

// ── AC 22.13-3: process death at the staffing migration boundaries ─────────

/// Child half of the crash tests. A no-op unless launched by `crash_at`.
#[test]
fn staffing_migration_crash_child() {
    let Ok(boundary) = std::env::var(CRASH_ENV) else { return };
    let path = PathBuf::from(std::env::var(CRASH_DB_ENV).unwrap());
    let mut conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.pragma_update(None, "synchronous", "FULL").unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    let step = |version: i64| migration_steps().iter().find(|s| s.version == version).unwrap();

    // Exactly the runner's per-step shape: IMMEDIATE tx, step SQL, version bump, commit.
    let mut run_step = |conn: &mut Connection, version: i64, commit: bool| {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
        tx.execute_batch(step(version).sql).unwrap();
        tx.pragma_update(None, "user_version", version).unwrap();
        if commit {
            tx.commit().unwrap();
        } else {
            // Die with the transaction open: no commit, no rollback, no drop.
            std::process::abort();
        }
    };
    match boundary.as_str() {
        "inside-v14" => run_step(&mut conn, 14, false),
        "between-v14-v15" => {
            run_step(&mut conn, 14, true);
            std::process::abort();
        }
        "inside-v15" => {
            run_step(&mut conn, 14, true);
            run_step(&mut conn, 15, false);
        }
        // Story 26.5 (v16 points done): die with the v16 ALTER either open or
        // committed — the crash must leave an all-or-nothing schema.
        "inside-v16" => {
            run_step(&mut conn, 14, true);
            run_step(&mut conn, 15, true);
            run_step(&mut conn, 16, false);
        }
        "between-v15-v16" => {
            run_step(&mut conn, 14, true);
            run_step(&mut conn, 15, true);
            std::process::abort();
        }
        other => panic!("unknown boundary {other}"),
    }
    unreachable!("the child must die at its boundary");
}

fn crash_at(boundary: &str, path: &Path) {
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "migration::staffing_qualification::staffing_migration_crash_child",
            "--test-threads=1",
            "--nocapture",
        ])
        .env(CRASH_ENV, boundary)
        .env(CRASH_DB_ENV, path)
        .status()
        .unwrap();
    assert!(!status.success(), "{boundary}: the child process must die, not exit cleanly");
}

#[test]
fn process_death_at_each_staffing_boundary_recovers_to_a_whole_state() {
    // (boundary, committed version the crash must leave, roster present, assignments present)
    let cases = [
        ("inside-v14", 13, false, false),
        ("between-v14-v15", 14, true, false),
        ("inside-v15", 14, true, false),
        ("between-v15-v16", 15, true, true),
        ("inside-v16", 15, true, true),
    ];
    for (boundary, expected_version, roster, assignments) in cases {
        let dir = temp_dir(&format!("crash-{boundary}"));
        let path = legacy_file(&dir, 13);
        let before = dump(&read_only(&path));

        crash_at(boundary, &path);

        // What the crash actually left on disk: never a mixed version/schema.
        let (observed_version, has_roster, has_assignments, has_points_done) = {
            let conn = Connection::open(&path).unwrap();
            let cols = column_names(&conn, "forecast_plans");
            let node_cols = column_names(&conn, "nodes");
            (
                user_version(&conn),
                cols.contains(&"roster".to_string()),
                cols.contains(&"assignments".to_string()),
                node_cols.contains(&"effort_points_done".to_string()),
            )
        };
        assert_eq!(
            (observed_version, has_roster, has_assignments),
            (expected_version, roster, assignments),
            "{boundary}: on-disk state after process death"
        );
        // The v16 column appears exactly when the v16 step committed.
        assert_eq!(
            has_points_done,
            observed_version >= 16,
            "{boundary}: effort_points_done must track the committed version"
        );

        // Restart through the real startup path: resumes from the whole state.
        let conn = open_startup(&path).unwrap_or_else(|e| panic!("{boundary}: restart failed: {e:?}"));
        assert_eq!(user_version(&conn), CURRENT_SCHEMA_VERSION);
        assert_prior_facts_preserved(&before, &dump(&conn), boundary);
        integrity_ok(&conn);
        assert!(
            pre_migration_path(&path, observed_version).exists(),
            "{boundary}: restart snapshots the intact v{observed_version} state first"
        );
        println!(
            "QUALIFY crash {boundary}: disk after death = v{observed_version} (roster={has_roster}, assignments={has_assignments}); restart -> v{CURRENT_SCHEMA_VERSION}, facts preserved, integrity ok"
        );
    }
}

// ── AC 22.13-4: a newer writer's database is refused without mutation ─────

fn file_bytes(path: &Path) -> Vec<u8> {
    fs::read(path).unwrap()
}

#[test]
fn newer_schema_is_refused_without_mutation_and_with_guidance() {
    let dir = temp_dir("future");
    let path = legacy_file(&dir, 13);
    drop(open_startup(&path).unwrap()); // a real staffed-era v15 database …
    {
        // … written by a newer build.
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 1).unwrap();
        conn.pragma_update(None, "journal_mode", "DELETE").unwrap();
    }
    let bytes_before = file_bytes(&path);

    let mut slot = None;
    let result = open_connection(&mut slot, &path.to_path_buf());
    drop(slot);
    assert!(result.is_err(), "a newer schema must be refused");
    assert!(!pre_migration_path(&path, CURRENT_SCHEMA_VERSION + 1).exists(), "no migration attempted");
    assert_eq!(file_bytes(&path), bytes_before, "refusal must not modify the newer database");

    let state = adjudicate_startup(&read_only(&path)).unwrap();
    match state {
        StartupState::ReadOnlyRecovery { cause } => {
            assert!(cause.contains("newer PMApp build") && cause.contains("Update the app"), "guidance: {cause}");
            println!("QUALIFY future v{}: refused, file unchanged, guidance: {cause}", CURRENT_SCHEMA_VERSION + 1);
        }
        other => panic!("expected read-only recovery guidance, got {other:?}"),
    }
}
