//! Story 28.2: `vantage://join?…` and `vantage://recover?…` links open the
//! desktop app. The installer registers the scheme; a debug build registers it
//! for the developer. A link only pre-fills the Join dialog: the user still
//! names themselves and confirms, so an outside link never joins by itself.
//!
//! Windows starts a second process for a clicked link; the single-instance
//! plugin (deep-link feature) forwards its URL here and that process exits.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

/// Webview event carrying an accepted link.
pub const EVENT_VANTAGE_LINK: &str = "vantage-link";

const PREFIXES: [&str; 2] = ["vantage://join?", "vantage://recover?"];
const MAX_LINK_LEN: usize = 4096;

/// Accept only a well-formed invite or recovery link. Anything else (other
/// schemes, file paths, oversized or control-character input) is ignored.
pub fn accepted_link(raw: &str) -> Option<String> {
    let link = raw.trim();
    if link.len() > MAX_LINK_LEN || link.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let lower = link.to_ascii_lowercase();
    // The OS hands links over URL-normalized (`vantage://join/?…`: an empty
    // path becomes `/`); pasted links have no slash. Accept both.
    let (prefix, consumed) = PREFIXES.iter().find_map(|p| {
        let host = &p[..p.len() - 1];
        if lower.starts_with(p) { Some((*p, p.len())) }
        else if lower.starts_with(&format!("{host}/?")) { Some((*p, p.len() + 1)) }
        else { None }
    })?;
    if link.len() == consumed {
        return None;
    }
    // Canonical form (what the Join flow parses); the query is untouched.
    Some(format!("{prefix}{}", &link[consumed..]))
}

/// A link that arrived before the webview was listening (a cold start from a
/// clicked link). The webview takes it once on startup.
#[derive(Default)]
pub struct PendingLink(pub Mutex<Option<String>>);

/// Record an accepted link and tell the webview about it.
pub fn deliver(app: &AppHandle, raw: &str) {
    let Some(link) = accepted_link(raw) else {
        let shape = raw.split('?').next().unwrap_or_default();
        eprintln!("vantage link: ignored shape={shape:?} (not an invite or recovery link)");
        return;
    };
    // Kind only: the query carries a secret token and is never logged.
    eprintln!("vantage link: accepted kind={}", if link.starts_with("vantage://join?") { "join" } else { "recover" });
    if let Some(pending) = app.try_state::<PendingLink>() {
        if let Ok(mut slot) = pending.0.lock() {
            *slot = Some(link.clone());
        }
    }
    let _ = app.emit(EVENT_VANTAGE_LINK, serde_json::json!({ "link": link }));
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// `app_take_pending_link` — returns and clears the link that started the app.
#[tauri::command]
pub fn app_take_pending_link(pending: State<'_, PendingLink>) -> Option<String> {
    pending.0.lock().ok().and_then(|mut slot| slot.take())
}

#[cfg(test)]
mod tests {
    use super::accepted_link;

    #[test]
    fn accepts_invite_and_recovery_links() {
        assert_eq!(accepted_link("vantage://join?p=1&i=2&s=3").as_deref(), Some("vantage://join?p=1&i=2&s=3"));
        assert_eq!(accepted_link("  vantage://recover?p=1&t=2 ").as_deref(), Some("vantage://recover?p=1&t=2"));
        assert_eq!(accepted_link("VANTAGE://JOIN?p=1").as_deref(), Some("vantage://join?p=1"));
        // As Windows delivers a clicked link (URL-normalized with a `/`).
        assert_eq!(accepted_link("vantage://join/?p=1&t=2").as_deref(), Some("vantage://join?p=1&t=2"));
        assert_eq!(accepted_link("vantage://recover/?p=1").as_deref(), Some("vantage://recover?p=1"));
    }

    #[test]
    fn rejects_everything_else() {
        for raw in [
            "", "vantage://join?", "vantage://join/?", "vantage://join//?x=1", "vantage://other?x=1", "https://example.com/?vantage://join?x",
            "C:\\file.pmapp", "vantage://join?p=1 extra", "vantage://join?p=1\nrecover",
            "--flag", "vantage:join?p=1",
        ] {
            assert_eq!(accepted_link(raw), None, "{raw:?}");
        }
        assert_eq!(accepted_link(&format!("vantage://join?{}", "a".repeat(5000))), None);
    }
}
