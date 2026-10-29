pub mod backup;
pub mod commands;
pub mod db;
pub mod deep_link;
pub mod events;
pub mod fault_injection;
pub mod migration;
pub mod protocol;
pub mod state;

use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;


pub fn run() {
    tauri::Builder::default()
        // E9-FR12: single-instance ownership registered BEFORE storage init.
        // A secondary launch is intercepted, its file-open intent forwarded to
        // the active window, and the second process exits before it ever
        // touches a second SQLite connection.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Forward any file-open intent (e.g. a .pmapp path) to the webview.
            let _ = app.emit(crate::events::EVENT_FILE_OPEN_INTENT, serde_json::json!({
                "args": args,
            }));
            // Focus the primary window.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Story 28.2: vantage:// invite and recovery links. The installer
            // registers the scheme; a debug build registers it for the
            // developer (per-user, pointing at this executable).
            app.manage(deep_link::PendingLink::default());
            #[cfg(any(windows, target_os = "linux"))]
            if cfg!(debug_assertions) {
                if let Err(err) = app.deep_link().register_all() {
                    eprintln!("vantage:// link registration failed: {err}");
                }
            }
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    deep_link::deliver(app.handle(), url.as_str());
                }
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    deep_link::deliver(&handle, url.as_str());
                }
            });
            let app_data_dir = app.path().app_data_dir()?;
            if let Err(err) = std::fs::create_dir_all(&app_data_dir) {
                eprintln!("failed to create app data dir: {err}");
            }
            let runtime = state::state::build_runtime(&app_data_dir, cfg!(debug_assertions));
            app.manage(runtime);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::repository::repository_open,
            commands::repository::repository_apply,
            commands::repository::repository_read_outbox,
            commands::repository::repository_read_collaboration_history,
            commands::repository::repository_forget_collaboration,
            commands::repository::repository_install_collaboration_snapshot,
            commands::repository::repository_local_file_read,
            commands::repository::repository_local_file_write,
            commands::repository::repository_local_file_recovery,
            commands::repository::repository_local_file_apply,
            commands::repository::repository_local_file_restore,
            commands::repository::repository_apply_product_command_batch,
            commands::repository::repository_discard_outbox,
            commands::repository::repository_commit_with_outbox,
            commands::repository::repository_commit_group_with_outbox,
            commands::repository::repository_rebase,
            commands::repository::repository_close,
            commands::repository::repository_pause_intake,
            commands::repository::repository_resume_intake,
            commands::repository::repository_storage_status,
            commands::repository::app_file_open_intent,
            commands::repository::repository_query_projects,
            commands::repository::repository_query_project_snapshot,
            commands::repository::repository_query_view_state,
            commands::repository::repository_upsert_view_state,
            commands::repository::repository_query_workspace_registry,
            commands::repository::repository_mutate_workspace,
            commands::backup::repository_export_package,
            commands::backup::repository_validate_package,
            commands::backup::repository_restore_package,
            commands::backup::repository_read_import_candidate,
            commands::backup::save_office_export,
            commands::backup::save_portable_project,
            commands::repository::repository_startup_state,
            commands::repository::repository_batch_import_portable,
            commands::collaboration::collaboration_credential_get,
            commands::collaboration::collaboration_credential_set,
            commands::collaboration::collaboration_credential_delete,
            deep_link::app_take_pending_link,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Safe shutdown sequence (E9-FR12):
                // 1. halt command intake (returns ShuttingDown to the webview)
                // 2. drain in-flight commands (bounded by the actor queue)
                // 3. WAL checkpoint (TRUNCATE)
                // 4. close SQLite, release the connection
                let app = window.app_handle().clone();
                let runtime = app.state::<crate::db::runtime::RepositoryRuntime>().inner().clone();
                let api_clone = api.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = runtime.pause_intake().await;
                    let _ = runtime.close().await; // drains + checkpoints + drops conn
                    let _ = events::emit_shutdown_complete(&app);
                    api_clone.prevent_close();
                    std::process::exit(0);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running PMApp desktop shell");
}
