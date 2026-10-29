//! Exact-origin CORS (Story 27.5/27.9 reachability, item 10).
//!
//! The browser build calls the service cross-origin and the desktop webview
//! sends its own app origin. Only origins listed exactly in
//! `PMAPP_ALLOWED_ORIGINS` (comma-separated, scheme://host[:port]) receive CORS
//! headers. A request that carries any other `Origin` — including a WebSocket
//! upgrade — is refused with 403, which also closes cross-site WebSocket and
//! simple-request CSRF paths. Requests without an `Origin` header (server-side
//! tools, health checks) are unaffected; they still need credentials.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::sync::Arc;

const ALLOW_HEADERS: &str = "content-type, x-pmapp-device, x-pmapp-bearer, x-pmapp-nonce, x-pmapp-timestamp, x-pmapp-signature, x-pmapp-protocol-version, x-pmapp-schema-version";
const ALLOW_METHODS: &str = "GET, POST, DELETE, OPTIONS";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AllowedOrigins(Arc<Vec<String>>);

impl AllowedOrigins {
    /// Parse a comma-separated list. Every entry must be an exact origin:
    /// `https://host[:port]`, `http://localhost[:port]`/`http://127.0.0.1[:port]`
    /// for development, or a desktop webview scheme (`tauri://localhost`,
    /// `http://tauri.localhost`). Wildcards, paths and credentials are refused.
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        let mut origins = Vec::new();
        for raw in value.unwrap_or("").split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if raw.contains('*') || raw.ends_with('/') { return Err("PMAPP_ALLOWED_ORIGINS entries must be exact origins".into()); }
            let url = reqwest::Url::parse(raw).map_err(|_| "PMAPP_ALLOWED_ORIGINS entries must be exact origins".to_string())?;
            let host = url.host_str().unwrap_or("");
            let local = matches!(host, "localhost" | "127.0.0.1" | "tauri.localhost");
            let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && local) || (url.scheme() == "tauri" && host == "localhost");
            if !scheme_ok || host.is_empty() || !(url.path() == "/" || url.path().is_empty()) || url.query().is_some() || url.fragment().is_some()
                || !url.username().is_empty() || url.password().is_some() {
                return Err("PMAPP_ALLOWED_ORIGINS entries must be exact origins".into());
            }
            // `tauri://` is an opaque origin to the URL crate; browsers send it as written.
            origins.push(if url.scheme() == "tauri" { "tauri://localhost".to_string() } else { url.origin().ascii_serialization() });
        }
        Ok(Self(Arc::new(origins)))
    }

    pub fn from_env() -> Result<Self, String> {
        Self::parse(std::env::var("PMAPP_ALLOWED_ORIGINS").ok().as_deref())
    }

    pub fn allows(&self, origin: &str) -> bool { self.0.iter().any(|o| o == origin) }
}

fn cors_headers(headers: &mut HeaderMap, origin: &HeaderValue) {
    headers.insert("access-control-allow-origin", origin.clone());
    headers.insert("access-control-allow-headers", HeaderValue::from_static(ALLOW_HEADERS));
    headers.insert("access-control-allow-methods", HeaderValue::from_static(ALLOW_METHODS));
    headers.insert("access-control-max-age", HeaderValue::from_static("600"));
    headers.insert("access-control-expose-headers", HeaderValue::from_static("x-pmapp-role"));
    headers.append("vary", HeaderValue::from_static("Origin"));
}

pub async fn enforce(State(allowed): State<AllowedOrigins>, request: Request<Body>, next: Next) -> Response {
    let Some(origin) = request.headers().get("origin").cloned() else {
        return next.run(request).await;
    };
    let permitted = origin.to_str().map(|o| allowed.allows(o)).unwrap_or(false);
    if !permitted {
        return (StatusCode::FORBIDDEN, "ORIGIN_NOT_ALLOWED").into_response();
    }
    if request.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        cors_headers(response.headers_mut(), &origin);
        return response;
    }
    let mut response = next.run(request).await;
    cors_headers(response.headers_mut(), &origin);
    response
}

/// Wrap a router with exact-origin enforcement.
pub fn with_cors(router: axum::Router, allowed: AllowedOrigins) -> axum::Router {
    router.layer(axum::middleware::from_fn_with_state(allowed, enforce))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    fn app() -> axum::Router {
        let allowed = AllowedOrigins::parse(Some("https://app.example, tauri://localhost, http://127.0.0.1:5173")).unwrap();
        with_cors(crate::routes::router(crate::routes::AppState::in_memory()), allowed)
    }

    fn request(method: &str, origin: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder().method(method).uri("/healthz");
        if let Some(origin) = origin { builder = builder.header("origin", origin); }
        builder.body(Body::empty()).unwrap()
    }

    #[test]
    fn parsing_accepts_exact_origins_only() {
        assert!(AllowedOrigins::parse(None).unwrap().0.is_empty());
        let ok = AllowedOrigins::parse(Some("https://app.example:8443,http://localhost:5173,http://tauri.localhost,tauri://localhost")).unwrap();
        assert!(ok.allows("https://app.example:8443") && ok.allows("tauri://localhost") && ok.allows("http://tauri.localhost"));
        for bad in ["*", "https://*.example", "https://app.example/", "https://app.example/path", "http://app.example", "https://u:p@app.example", "nonsense"] {
            assert!(AllowedOrigins::parse(Some(bad)).is_err(), "{bad} accepted");
        }
    }

    #[tokio::test]
    async fn allowed_origin_gets_headers_and_preflight() {
        let response = app().oneshot(request("GET", Some("https://app.example"))).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["access-control-allow-origin"], "https://app.example");
        assert!(response.headers()["access-control-allow-headers"].to_str().unwrap().contains("x-pmapp-signature"));
        let preflight = app().oneshot(request("OPTIONS", Some("tauri://localhost"))).await.unwrap();
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(preflight.headers()["access-control-allow-origin"], "tauri://localhost");
    }

    #[tokio::test]
    async fn foreign_origin_is_refused_and_originless_requests_pass() {
        let foreign = app().oneshot(request("GET", Some("https://evil.example"))).await.unwrap();
        assert_eq!(foreign.status(), StatusCode::FORBIDDEN);
        assert!(foreign.headers().get("access-control-allow-origin").is_none());
        let preflight = app().oneshot(request("OPTIONS", Some("https://evil.example"))).await.unwrap();
        assert_eq!(preflight.status(), StatusCode::FORBIDDEN);
        let plain = app().oneshot(request("GET", None)).await.unwrap();
        assert_eq!(plain.status(), StatusCode::OK);
        assert!(plain.headers().get("access-control-allow-origin").is_none());
    }
}
