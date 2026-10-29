//! Collaboration credential commands (Story 27.4, D5, R6).
//!
//! The desktop app keeps its guest device bearer credential in the OS keychain
//! via the `keyring` crate. The webview never persists a secret; it asks these
//! commands for the bearer only when a request needs it. The server stores only
//! `sha256(bearer)`, so the keychain is the sole place the secret lives.
//!
//! Only compiled when the desktop feature set includes the credential commands;
//! a local project never calls them.

const SERVICE: &str = "com.vantage.pmapp.collaboration";

fn entry(actor_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, actor_id).map_err(|err| format!("KEYCHAIN_ERROR: {err}"))
}

/// Store the device bearer credential for an actor in the OS keychain.
#[tauri::command]
pub fn collaboration_credential_set(actor_id: String, bearer: String) -> Result<(), String> {
    entry(&actor_id)?
        .set_password(&bearer)
        .map_err(|err| format!("KEYCHAIN_ERROR: {err}"))
}

/// Read the device bearer credential, or null when none is stored.
#[tauri::command]
pub fn collaboration_credential_get(actor_id: String) -> Result<Option<String>, String> {
    match entry(&actor_id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("KEYCHAIN_ERROR: {err}")),
    }
}

/// Delete the device bearer credential (leave / stop sharing).
#[tauri::command]
pub fn collaboration_credential_delete(actor_id: String) -> Result<(), String> {
    match entry(&actor_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("KEYCHAIN_ERROR: {err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_name_is_stable() {
        assert_eq!(SERVICE, "com.vantage.pmapp.collaboration");
    }
}
