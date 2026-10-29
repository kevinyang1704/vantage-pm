//! Version/capabilities handshake admission (Story 27.9, TC-NFR5, R10, H11).
//!
//! A client sends its protocol + schema versions **before** any snapshot or
//! command admission. The service accepts every supported combination (current
//! and previous release, plus an N-2 still inside the 30-day support window);
//! otherwise it answers `UpdateRequired` and the client keeps working locally
//! and queues. This is the server half of the pure `version-handshake.ts`.

use serde::{Deserialize, Serialize};

/// The wire protocol version the service speaks.
pub const PROTOCOL_VERSION: &str = "1.0.0";
/// The current coordinated browser/native product schema version.
pub const CURRENT_SCHEMA_VERSION: i64 = pmapp_core::db::schema::CURRENT_SCHEMA_VERSION;
/// Support window in days (D9/R10): current + previous release, at least 30 days.
pub const SUPPORT_WINDOW_DAYS: i64 = 30;

/// The checked-in release support registry (R10, gate 10). Every coordinated
/// schema release the service may serve is listed with when it was
/// introduced; retirement is derived from it (see `supported_versions`).
pub const RELEASE_REGISTRY_JSON: &str = include_str!("../release-registry.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryRelease {
    schema_version: i64,
    introduced_at_iso: String,
    source: String,
    #[serde(default)]
    retires_at_iso: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseRegistry {
    registry_version: u32,
    protocol_version: String,
    support_window_days: i64,
    #[allow(dead_code)]
    note: String,
    releases: Vec<RegistryRelease>,
}

/// A supported (protocol, schema) pair with its retirement clock.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportedVersion {
    pub protocol_version: String,
    pub schema_version: i64,
    pub retires_at_iso: Option<String>,
}

fn instant(value: &str) -> Result<chrono::DateTime<chrono::FixedOffset>, String> {
    chrono::DateTime::parse_from_rfc3339(value).map_err(|_| format!("RELEASE_REGISTRY_DATE_INVALID:{value}"))
}

/// Parse and validate the registry, then derive each release's retirement:
/// the newest two never retire; an older release retires
/// `support_window_days` after the release two newer than it was introduced,
/// unless an explicit `retiresAtIso` records an earlier promised decision.
pub fn registry_versions(json: &str) -> Result<Vec<SupportedVersion>, String> {
    let registry: ReleaseRegistry = serde_json::from_str(json).map_err(|e| format!("RELEASE_REGISTRY_MALFORMED:{e}"))?;
    if registry.registry_version != 1 || registry.protocol_version != PROTOCOL_VERSION || registry.support_window_days < SUPPORT_WINDOW_DAYS {
        return Err("RELEASE_REGISTRY_POLICY_INVALID".into());
    }
    let releases = &registry.releases;
    if releases.is_empty() { return Err("RELEASE_REGISTRY_EMPTY".into()); }
    for pair in releases.windows(2) {
        if pair[1].schema_version != pair[0].schema_version + 1 || instant(&pair[1].introduced_at_iso)? < instant(&pair[0].introduced_at_iso)? {
            return Err("RELEASE_REGISTRY_ORDER_INVALID".into());
        }
    }
    if releases.iter().any(|r| r.source.is_empty()) { return Err("RELEASE_REGISTRY_SOURCE_MISSING".into()); }
    for release in releases {
        instant(&release.introduced_at_iso)?;
        if let Some(retires) = &release.retires_at_iso { instant(retires)?; }
    }
    let n = releases.len();
    releases.iter().enumerate().map(|(i, release)| {
        let retires = if i + 2 >= n {
            None
        } else if let Some(explicit) = &release.retires_at_iso {
            Some(instant(explicit)?.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        } else {
            let anchor = instant(&releases[i + 2].introduced_at_iso)?;
            Some((anchor + chrono::Duration::days(registry.support_window_days)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        };
        Ok(SupportedVersion { protocol_version: registry.protocol_version.clone(), schema_version: release.schema_version, retires_at_iso: retires })
    }).collect()
}

/// The versions this service can serve, from the checked-in registry. A
/// registry that fails validation serves only the current release (fail
/// closed for older clients, never open).
pub fn supported_versions() -> Vec<SupportedVersion> {
    match registry_versions(RELEASE_REGISTRY_JSON) {
        Ok(versions) if versions.last().map(|v| v.schema_version) == Some(CURRENT_SCHEMA_VERSION) => versions,
        _ => vec![SupportedVersion { protocol_version: PROTOCOL_VERSION.to_string(), schema_version: CURRENT_SCHEMA_VERSION, retires_at_iso: None }],
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeRequest {
    pub protocol_version: String,
    pub schema_version: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum HandshakeDecision {
    #[serde(rename_all = "camelCase")]
    Accepted { schema_version: i64, protocol_version: String },
    #[serde(rename_all = "camelCase")]
    UpdateRequired { reason: String },
}

/// Pure decision mirroring `handshake()` in the TypeScript domain module.
pub fn decide_handshake(request: &HandshakeRequest, now_iso: &str) -> HandshakeDecision {
    if request.protocol_version != PROTOCOL_VERSION {
        return HandshakeDecision::UpdateRequired { reason: "UNSUPPORTED_PROTOCOL".to_string() };
    }
    let supported = supported_versions();
    let exact = supported.iter().find(|s| {
        s.protocol_version == request.protocol_version && s.schema_version == request.schema_version
    });
    match exact {
        None => HandshakeDecision::UpdateRequired { reason: "UNSUPPORTED_SCHEMA".to_string() },
        Some(v) => {
            if let Some(retires) = &v.retires_at_iso {
                if now_iso >= retires.as_str() {
                    return HandshakeDecision::UpdateRequired { reason: "RETIRED".to_string() };
                }
            }
            HandshakeDecision::Accepted {
                schema_version: request.schema_version,
                protocol_version: request.protocol_version.clone(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-10-04T00:00:00Z";

    #[test]
    fn recovery_upgrade_preserves_v16_promised_retirement_window() {
        let request = HandshakeRequest { protocol_version: PROTOCOL_VERSION.into(), schema_version: 16 };
        assert!(matches!(decide_handshake(&request, "2026-10-30T23:59:59Z"), HandshakeDecision::Accepted { .. }));
        assert!(matches!(decide_handshake(&request, "2026-10-31T00:00:00Z"), HandshakeDecision::UpdateRequired { .. }));
    }

    #[test]
    fn journal_upgrade_preserves_v15_promised_retirement_window() {
        let request = HandshakeRequest {
            protocol_version: PROTOCOL_VERSION.to_string(),
            schema_version: 15,
        };
        assert!(matches!(decide_handshake(&request, "2026-10-30T23:59:59Z"), HandshakeDecision::Accepted { .. }));
        assert!(matches!(decide_handshake(&request, "2026-10-31T00:00:00Z"), HandshakeDecision::UpdateRequired { .. }));
    }

    #[test]
    fn checked_in_registry_is_valid_and_ends_at_the_current_schema() {
        // Bumping the product schema without appending a release here fails.
        let versions = registry_versions(RELEASE_REGISTRY_JSON).unwrap();
        assert_eq!(versions.last().unwrap().schema_version, CURRENT_SCHEMA_VERSION);
        assert!(versions[versions.len() - 1].retires_at_iso.is_none() && versions[versions.len() - 2].retires_at_iso.is_none());
        // N-2 retires 30 days after N was introduced.
        let registry: ReleaseRegistry = serde_json::from_str(RELEASE_REGISTRY_JSON).unwrap();
        let n_introduced = instant(&registry.releases.last().unwrap().introduced_at_iso).unwrap();
        assert_eq!(versions[versions.len() - 3].retires_at_iso.as_deref(), Some((n_introduced + chrono::Duration::days(30)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true).as_str()));
    }

    #[test]
    fn invalid_registries_are_refused() {
        let base = |releases: &str| format!(r#"{{"registryVersion":1,"protocolVersion":"1.0.0","supportWindowDays":30,"note":"x","releases":[{releases}]}}"#);
        for bad in [
            base(r#"{"schemaVersion":18,"introducedAtIso":"2026-10-05T00:00:00Z","source":"a"},{"schemaVersion":20,"introducedAtIso":"2026-10-06T00:00:00Z","source":"b"}"#),
            base(r#"{"schemaVersion":18,"introducedAtIso":"2026-10-05T00:00:00Z","source":"a"},{"schemaVersion":19,"introducedAtIso":"2026-10-01T00:00:00Z","source":"b"}"#),
            base(r#"{"schemaVersion":18,"introducedAtIso":"not a date","source":"a"}"#),
            base(r#"{"schemaVersion":18,"introducedAtIso":"2026-10-05T00:00:00Z","source":""}"#),
            base(""),
            r#"{"registryVersion":1,"protocolVersion":"1.0.0","supportWindowDays":7,"note":"x","releases":[{"schemaVersion":18,"introducedAtIso":"2026-10-05T00:00:00Z","source":"a"}]}"#.to_string(),
        ] {
            assert!(registry_versions(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn accepts_current_and_previous_and_n_minus_2() {
        for schema in [CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION - 1, CURRENT_SCHEMA_VERSION - 2] {
            let d = decide_handshake(&HandshakeRequest { protocol_version: PROTOCOL_VERSION.to_string(), schema_version: schema }, NOW);
            assert!(matches!(d, HandshakeDecision::Accepted { .. }), "schema {schema} should be accepted");
        }
    }

    #[test]
    fn refuses_unknown_protocol_and_too_old_schema() {
        let bad_proto = decide_handshake(&HandshakeRequest { protocol_version: "9.9.9".to_string(), schema_version: CURRENT_SCHEMA_VERSION }, NOW);
        assert!(matches!(bad_proto, HandshakeDecision::UpdateRequired { .. }));
        let old = decide_handshake(&HandshakeRequest { protocol_version: PROTOCOL_VERSION.to_string(), schema_version: 14 }, NOW);
        assert!(matches!(old, HandshakeDecision::UpdateRequired { .. }));
    }

    #[test]
    fn n_minus_2_retires_after_the_support_window() {
        // N-2 is accepted inside the window and refused once the fixed window
        // from the current release has elapsed (a real retirement, not
        // "now + 30d" which never elapses).
        let inside = decide_handshake(
            &HandshakeRequest { protocol_version: PROTOCOL_VERSION.to_string(), schema_version: CURRENT_SCHEMA_VERSION - 2 },
            NOW,
        );
        assert!(matches!(inside, HandshakeDecision::Accepted { .. }));
        let after = decide_handshake(
            &HandshakeRequest { protocol_version: PROTOCOL_VERSION.to_string(), schema_version: CURRENT_SCHEMA_VERSION - 2 },
            "2027-01-01T00:00:00Z",
        );
        assert!(matches!(after, HandshakeDecision::UpdateRequired { .. }));
        // N and N-1 never retire.
        let n_after = decide_handshake(
            &HandshakeRequest { protocol_version: PROTOCOL_VERSION.to_string(), schema_version: CURRENT_SCHEMA_VERSION },
            "2027-01-01T00:00:00Z",
        );
        assert!(matches!(n_after, HandshakeDecision::Accepted { .. }));
    }
}

/// Updates only wait for a **settled local queue and a durable outbox**, never
/// for an unavailable server to drain it (27.9/R10). The browser build already
/// has `decideUpdate` in the durability spike; this mirrors the rule for the
/// collaboration update gate.
pub fn update_may_proceed(queue_settled: bool, outbox_durable: bool) -> bool {
    queue_settled && outbox_durable
}
