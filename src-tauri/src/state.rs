//! Managed application state.

pub mod state {
    use std::path::PathBuf;

    use crate::db::runtime::{
        RepositoryRuntime, DEVELOPMENT_DB_FILE, PRODUCTION_DB_FILE,
    };

    /// Resolves the app-managed data directory and database file path
    /// (E9-FR6). Development launches use `pmapp-dev.sqlite`; production
    /// uses `pmapp.sqlite`.
    pub fn resolve_db_path(app_data_dir: &PathBuf, development: bool) -> PathBuf {
        let file = if development { DEVELOPMENT_DB_FILE } else { PRODUCTION_DB_FILE };
        app_data_dir.join(file)
    }

    /// Builds the repository runtime bound to the resolved path.
    ///
    /// `RepositoryRuntime::new` spawns its actor on the ambient Tokio runtime,
    /// and Tauri's `setup` hook runs on the main thread with none entered, so
    /// enter Tauri's app-lifetime reactor for the call (the same reactor the
    /// actor used before `pmapp-core` was extracted; see 1e8a64f). Without
    /// this the desktop app panics at launch with "no reactor running".
    pub fn build_runtime(app_data_dir: &PathBuf, development: bool) -> RepositoryRuntime {
        let handle = tauri::async_runtime::handle();
        let _reactor = handle.inner().enter();
        RepositoryRuntime::new(resolve_db_path(app_data_dir, development))
    }
}
