//! Local service entry point (Story 27.4/27.5).
//!
//! Starts the membership + sync service. On Railway the platform injects
//! `PORT` and a persistent volume at `/data` (see `docs/operations/railway.md`).
//! Locally, `PMAPP_SERVER_ADDR` or a default `127.0.0.1:8787` is used.

use pmapp_server::routes::{router, AppState};

/// Private restore drill (Story 27.5): `pmapp-server restore-drill <manifest-key>`
/// or `pmapp-server restore-drill latest` for the newest published generation.
/// Reads object storage only, restores into a fresh isolated directory under
/// `PMAPP_RESTORE_DRILL_DIR` (default: the system temp dir), never touches the
/// live data directory and never listens. Prints code/count/hash/timing
/// evidence as JSON. Exit 0 verified, 2 refused, 64 usage/configuration.
async fn restore_drill_cli(manifest_key: Option<&str>) -> i32 {
    let Some(manifest_key) = manifest_key else {
        eprintln!("usage: pmapp-server restore-drill latest | <generations/<id>/manifest.json>");
        return 64;
    };
    let config = match pmapp_server::backup_config::BackupConfig::from_env() {
        Ok(Some(config)) => config,
        Ok(None) => { eprintln!("restore-drill: PMAPP_BACKUP_* configuration is required"); return 64; }
        Err(err) => { eprintln!("restore-drill: configuration error: {err}"); return 64; }
    };
    let store = match pmapp_server::backup_store::S3Store::new(config) {
        Ok(store) => store,
        Err(err) => { eprintln!("restore-drill: store unavailable code={err}"); return 64; }
    };
    let manifest_key = if manifest_key == "latest" {
        match pmapp_server::restore_drill::latest_manifest_key(&store).await {
            Ok(key) => { eprintln!("restore-drill: latest is {key}"); key }
            Err(err) => {
                println!("{}", serde_json::json!({ "result": "refused", "code": err.0 }));
                return 2;
            }
        }
    } else {
        manifest_key.to_string()
    };
    let manifest_key = manifest_key.as_str();
    let target_root = std::env::var("PMAPP_RESTORE_DRILL_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    let live = std::path::PathBuf::from(std::env::var("PMAPP_DATA_DIR").unwrap_or_else(|_| "./data".to_string()));
    match pmapp_server::restore_drill::run_restore_drill(&store, manifest_key, &target_root, Some(&live)).await {
        Ok(evidence) => {
            println!("{}", serde_json::to_string_pretty(&evidence).unwrap_or_default());
            0
        }
        Err(err) => {
            println!("{}", serde_json::json!({ "result": "refused", "code": err.0 }));
            2
        }
    }
}

fn store_from_env(command: &str) -> Result<pmapp_server::backup_store::S3Store, i32> {
    let config = match pmapp_server::backup_config::BackupConfig::from_env() {
        Ok(Some(config)) => config,
        Ok(None) => { eprintln!("{command}: PMAPP_BACKUP_* configuration is required"); return Err(64); }
        Err(err) => { eprintln!("{command}: configuration error: {err}"); return Err(64); }
    };
    pmapp_server::backup_store::S3Store::new(config).map_err(|err| { eprintln!("{command}: store unavailable code={err}"); 64 })
}

/// `pmapp-server rpo-report` (Story 28.3): sustained RPO over every published
/// generation, from the bucket listing alone. Exit 0 within budget, 2 not.
async fn rpo_report_cli() -> i32 {
    let store = match store_from_env("rpo-report") { Ok(store) => store, Err(code) => return code };
    match pmapp_server::backup_evidence::rpo_report(&store, chrono::Utc::now().timestamp()).await {
        Ok(report) => {
            println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
            if report.within_rpo { 0 } else { 2 }
        }
        Err(code) => { println!("{}", serde_json::json!({ "result": "refused", "code": code })); 2 }
    }
}

/// `pmapp-server rto-bench [projects] [nodes-per-project] [history-per-project]`
/// (Story 28.3): RTO on production-sized synthetic data through the configured
/// object store, isolated under `bench/<id>/` and deleted afterwards. Never
/// touches the live data directory. Exit 0 verified within RTO, 2 otherwise.
async fn rto_bench_cli(args: &[String]) -> i32 {
    let mut shape = pmapp_server::backup_evidence::PRODUCTION_SHAPE;
    let parse = |i: usize, default: u32| args.get(i).map(|v| v.parse::<u32>().ok().filter(|n| *n > 0)).unwrap_or(Some(default));
    match (parse(0, shape.projects), parse(1, shape.nodes_per_project), parse(2, shape.history_per_project)) {
        (Some(p), Some(n), Some(h)) if h <= n => { shape.projects = p; shape.nodes_per_project = n; shape.history_per_project = h; }
        _ => { eprintln!("usage: pmapp-server rto-bench [projects] [nodes-per-project] [history-per-project<=nodes]"); return 64; }
    }
    let store = match store_from_env("rto-bench") { Ok(store) => store, Err(code) => return code };
    let work_root = std::env::var("PMAPP_RESTORE_DRILL_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    eprintln!("rto-bench: seeding {} projects x {} nodes ({} with history)", shape.projects, shape.nodes_per_project, shape.history_per_project);
    match pmapp_server::backup_evidence::rto_bench(&store, &work_root, shape).await {
        Ok(bench) => {
            println!("{}", serde_json::to_string_pretty(&bench).unwrap_or_default());
            if bench.drill.within_rto && bench.cleaned_up { 0 } else { 2 }
        }
        Err(code) => { println!("{}", serde_json::json!({ "result": "refused", "code": code })); 2 }
    }
}

/// Run the startup migration, or exit without serving.
async fn migrate_or_exit(data_path: &std::path::Path, state: &AppState, backup: Option<pmapp_server::backup_config::BackupConfig>) {
    use pmapp_server::server_migration::{self, SERVER_DATA_VERSION};
    let target = match std::env::var("PMAPP_SERVER_DATA_VERSION") {
        Ok(raw) => raw.trim().parse::<i64>().unwrap_or_else(|_| { eprintln!("migration: PMAPP_SERVER_DATA_VERSION must be an integer"); std::process::exit(64) }),
        Err(_) => SERVER_DATA_VERSION,
    };
    let fresh = match server_migration::needs_fresh_backup(data_path, target) {
        Ok(fresh) => fresh,
        Err(err) => { eprintln!("migration: refused code={err}; not serving"); std::process::exit(1) }
    };
    let mut remote_generation = None;
    if fresh {
        if let Some(config) = backup {
            let policy = pmapp_server::backup_retention::RetentionPolicy::from_config(&config);
            let store = pmapp_server::backup_store::S3Store::new(config).unwrap_or_else(|err| {
                eprintln!("migration: backup store unavailable code={err}; not migrating, not serving");
                std::process::exit(1)
            });
            let staging = data_path.join(".backup-staging");
            match pmapp_server::backup_loop::run_iteration(&store, &state.capture_sources(), &staging, policy).await {
                Ok(published) => {
                    eprintln!("migration: pre-migration backup published generation={}", published.manifest.generation_id);
                    remote_generation = Some(published.manifest.generation_id);
                }
                Err(code) => { eprintln!("migration: pre-migration backup failed code={code}; not migrating, not serving"); std::process::exit(1) }
            }
        } else {
            eprintln!("migration: object storage not configured; local copies only");
        }
    }
    match server_migration::run(data_path, target, remote_generation, None) {
        Ok(report) if report.migrated.is_empty() && !report.resumed => {}
        Ok(report) => eprintln!(
            "migration: data at version {} files_migrated={} resumed={} local_backup={}",
            report.target, report.migrated.len(), report.resumed, report.backup_dir.unwrap_or_default(),
        ),
        Err(err) => { eprintln!("migration: failed code={err}; journal kept, not serving (restart resumes)"); std::process::exit(1) }
    }
    if target != SERVER_DATA_VERSION {
        eprintln!("migration: data rolled back to version {target}; this release serves version {SERVER_DATA_VERSION}. Deploy the release that serves version {target}.");
        std::process::exit(0);
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("restore-drill") => std::process::exit(restore_drill_cli(args.get(2).map(String::as_str)).await),
        Some("rpo-report") => std::process::exit(rpo_report_cli().await),
        Some("rto-bench") => std::process::exit(rto_bench_cli(&args[2..]).await),
        _ => {}
    }

    // Data directory: the persistent volume in production.
    let data_dir = std::env::var("PMAPP_DATA_DIR").unwrap_or_else(|_| "./data".to_string());
    let data_path = std::path::PathBuf::from(&data_dir);
    if let Err(err) = std::fs::create_dir_all(&data_path) {
        panic!("failed to create data dir {data_dir}: {err}");
    }

    // Story 28.3 (AC 27.9-4, R10): bring the data to this release's version
    // BEFORE the listener binds, so no write is admitted while it runs. A
    // fresh migration is backed up first: a remote generation when object
    // storage is configured (refused if that fails), plus local copies. A
    // failure leaves the journal in progress and the process exits without
    // serving; the next start resumes. `PMAPP_SERVER_DATA_VERSION` set below
    // this release's version rolls the data back and exits without serving.
    let state = AppState::with_data_dir(&data_path);
    let backup_config = pmapp_server::backup_config::BackupConfig::from_env();
    migrate_or_exit(&data_path, &state, backup_config.as_ref().ok().and_then(|c| c.clone())).await;

    // Bind address: Railway injects PORT and expects 0.0.0.0.
    let addr = match std::env::var("PMAPP_SERVER_ADDR") {
        Ok(addr) => addr,
        Err(_) => match std::env::var("PORT") {
            Ok(port) => format!("0.0.0.0:{port}"),
            Err(_) => "127.0.0.1:8787".to_string(),
        },
    };

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|err| panic!("failed to bind {addr}: {err}"));
    eprintln!("pmapp-server listening on http://{addr} (data dir {data_dir})");

    // Continuous backups to object storage (D4/R5/H10). A no-op when the
    // PMAPP_BACKUP_* variables are absent (local/test). A partial configuration
    // is loud, not silently dropped.
    match backup_config {
        Ok(config) => pmapp_server::backup_loop::spawn_backup_loop(config, state.capture_sources()),
        Err(err) => eprintln!("backup: configuration error: {err}"),
    }

    // History compaction (Story 28.3): off unless configured; a bad value is
    // loud, not silently ignored.
    match pmapp_server::compaction::CompactionConfig::from_env() {
        Ok(config) => pmapp_server::compaction::spawn_compaction_loop(config, state.capture_sources()),
        Err(err) => panic!("compaction: {err}"),
    }

    // Exact-origin CORS for the browser build and desktop webview (item 10).
    let allowed = pmapp_server::cors::AllowedOrigins::from_env()
        .unwrap_or_else(|err| panic!("{err}"));
    axum::serve(listener, pmapp_server::cors::with_cors(router(state), allowed))
        .await
        .expect("server error");
}
