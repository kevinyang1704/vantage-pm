//! Backup configuration (Story 27.5, D4/R5).
//!
//! The service continuously backs up every database (membership + one file per
//! project) to object storage we control (Cloudflare R2 or Backblaze B2, both
//! S3-compatible). Configuration comes from the environment — secrets live in
//! Railway Variables, never in the repository.
//!
//! Operational cadence/retention are chosen to satisfy the ratified RPO/RTO
//! (R5: RPO <= 15 minutes, RTO <= 4 hours). This module holds the config and the
//! checkpoint/manifest contract; `backup.rs` performs the upload.

use std::time::Duration;

const MAX_INTERVAL_SECONDS: u64 = 900;
pub const MIN_RETENTION_SECONDS: u64 = 30 * 24 * 60 * 60 + 3600;

fn seconds(value: Option<String>, name: &str, default: u64) -> Result<u64, String> {
    match value {
        None => Ok(default),
        Some(value) => value.parse::<u64>().map_err(|_| format!("{name} must be an unsigned integer")),
    }
}

/// Backup provider (both S3-compatible).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupProvider {
    R2,
    B2,
}

impl BackupProvider {
    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "r2" | "cloudflare" => Some(BackupProvider::R2),
            "b2" | "backblaze" => Some(BackupProvider::B2),
            _ => None,
        }
    }

    /// S3 SigV4 signing region token. R2 accepts `auto`; B2 uses the bucket's
    /// region, but `us-east-1` is accepted for the S3-compatible API.
    pub fn default_region(&self) -> &'static str {
        match self {
            BackupProvider::R2 => "auto",
            BackupProvider::B2 => "us-east-1",
        }
    }
}

/// Resolved backup configuration.
#[derive(Debug, Clone)]
pub struct BackupConfig {
    pub provider: BackupProvider,
    pub bucket: String,
    /// S3 endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`.
    pub endpoint: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Target start-to-start cadence. This alone does not prove measured RPO.
    pub interval: Duration,
    /// How long to retain backup generations before pruning (never delete a
    /// generation younger than the offline/retry window).
    pub retention: Duration,
}

impl BackupConfig {
    /// Build from environment. Returns `Ok(None)` when backup is not configured
    /// (a local/test run), and an error when it is partially configured, so a
    /// misconfiguration is loud rather than silently dropping backups.
    pub fn from_env() -> Result<Option<Self>, String> {
        Self::from_values(|name| std::env::var(name).ok())
    }

    fn from_values(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let provider_raw = get("PMAPP_BACKUP_PROVIDER");
        let bucket = get("PMAPP_BACKUP_BUCKET");
        let endpoint = get("PMAPP_BACKUP_ENDPOINT");

        // Fully absent → backups disabled (local dev/test).
        if provider_raw.is_none() && bucket.is_none() && endpoint.is_none()
            && ["PMAPP_BACKUP_ACCESS_KEY_ID", "PMAPP_BACKUP_SECRET_ACCESS_KEY", "PMAPP_BACKUP_REGION", "PMAPP_BACKUP_INTERVAL_SECONDS", "PMAPP_BACKUP_RETENTION_SECONDS"].iter().all(|name| get(name).is_none()) {
            return Ok(None);
        }

        let provider_raw = provider_raw.ok_or("PMAPP_BACKUP_PROVIDER is required")?;
        let provider = BackupProvider::parse(&provider_raw)
            .ok_or("PMAPP_BACKUP_PROVIDER must be r2 or b2")?;
        let bucket = bucket.ok_or("PMAPP_BACKUP_BUCKET is required")?;
        let endpoint = endpoint.ok_or("PMAPP_BACKUP_ENDPOINT is required")?;
        let parsed_endpoint = reqwest::Url::parse(&endpoint).map_err(|_| "PMAPP_BACKUP_ENDPOINT must be an HTTPS origin")?;
        if parsed_endpoint.scheme() != "https" || parsed_endpoint.host_str().is_none()
            || !parsed_endpoint.username().is_empty() || parsed_endpoint.password().is_some()
            || parsed_endpoint.path() != "/" || parsed_endpoint.query().is_some() || parsed_endpoint.fragment().is_some() {
            return Err("PMAPP_BACKUP_ENDPOINT must be an HTTPS origin".into());
        }
        let access_key_id = get("PMAPP_BACKUP_ACCESS_KEY_ID")
            .filter(|value| !value.is_empty()).ok_or("PMAPP_BACKUP_ACCESS_KEY_ID is required")?;
        let secret_access_key = get("PMAPP_BACKUP_SECRET_ACCESS_KEY")
            .filter(|value| !value.is_empty()).ok_or("PMAPP_BACKUP_SECRET_ACCESS_KEY is required")?;
        let region = get("PMAPP_BACKUP_REGION").unwrap_or_else(|| provider.default_region().to_string());

        // Cadence: default 15 minutes (RPO). Retention: default 30 days + 1 hour
        // (covers the D9 30-day offline/retry window). Reject unsafe values so
        // configuration errors cannot silently change the operator's policy.
        let interval_secs = seconds(get("PMAPP_BACKUP_INTERVAL_SECONDS"), "PMAPP_BACKUP_INTERVAL_SECONDS", MAX_INTERVAL_SECONDS)?;
        if interval_secs == 0 || interval_secs > MAX_INTERVAL_SECONDS {
            return Err("PMAPP_BACKUP_INTERVAL_SECONDS must be between 1 and 900".into());
        }
        let retention_secs = seconds(get("PMAPP_BACKUP_RETENTION_SECONDS"), "PMAPP_BACKUP_RETENTION_SECONDS", MIN_RETENTION_SECONDS)?;
        if retention_secs < MIN_RETENTION_SECONDS {
            return Err("PMAPP_BACKUP_RETENTION_SECONDS must be at least 2595600".into());
        }

        Ok(Some(Self {
            provider,
            bucket,
            endpoint: endpoint.trim_end_matches('/').to_string(),
            region,
            access_key_id,
            secret_access_key,
            interval: Duration::from_secs(interval_secs),
            retention: Duration::from_secs(retention_secs),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_parsing() {
        assert_eq!(BackupProvider::parse("r2"), Some(BackupProvider::R2));
        assert_eq!(BackupProvider::parse("B2"), Some(BackupProvider::B2));
        assert_eq!(BackupProvider::parse("gcs"), None);
    }

    fn configured(overrides: &[(&str, &str)]) -> Result<Option<BackupConfig>, String> {
        let mut values = std::collections::HashMap::from([
            ("PMAPP_BACKUP_PROVIDER", "r2"),
            ("PMAPP_BACKUP_BUCKET", "synthetic-backups"),
            ("PMAPP_BACKUP_ENDPOINT", "https://synthetic.example"),
            ("PMAPP_BACKUP_ACCESS_KEY_ID", "synthetic-key"),
            ("PMAPP_BACKUP_SECRET_ACCESS_KEY", "synthetic-secret"),
        ]);
        for (name, value) in overrides { values.insert(*name, *value); }
        BackupConfig::from_values(|name| values.get(name).map(|value| value.to_string()))
    }

    #[test]
    fn absent_disables_but_orphaned_configuration_errors() {
        assert!(BackupConfig::from_values(|_| None).unwrap().is_none());
        for name in ["PMAPP_BACKUP_PROVIDER", "PMAPP_BACKUP_SECRET_ACCESS_KEY", "PMAPP_BACKUP_INTERVAL_SECONDS"] {
            assert!(BackupConfig::from_values(|key| (key == name).then(|| "synthetic".to_string())).is_err());
        }
    }

    #[test]
    fn accepts_https_and_operational_boundaries() {
        let config = configured(&[]).unwrap().unwrap();
        assert_eq!(config.interval, Duration::from_secs(900));
        assert_eq!(config.retention, Duration::from_secs(2595600));
        assert!(configured(&[("PMAPP_BACKUP_INTERVAL_SECONDS", "1")]).is_ok());
        assert!(configured(&[("PMAPP_BACKUP_RETENTION_SECONDS", "2595601")]).is_ok());
    }

    #[test]
    fn rejects_insecure_or_ambiguous_endpoints_without_echoing_values() {
        for endpoint in ["http://synthetic.example", "https://synthetic.example/path", "https://user:synthetic-secret@synthetic.example", "https://synthetic.example?secret=synthetic-secret", "https://synthetic.example#fragment", "invalid"] {
            let err = configured(&[("PMAPP_BACKUP_ENDPOINT", endpoint)]).unwrap_err();
            assert_eq!(err, "PMAPP_BACKUP_ENDPOINT must be an HTTPS origin");
        }
    }

    #[test]
    fn rejects_unsafe_and_malformed_cadence_and_retention() {
        for value in ["0", "901", "-1", "nope", "", "18446744073709551616"] {
            assert!(configured(&[("PMAPP_BACKUP_INTERVAL_SECONDS", value)]).is_err(), "interval {value}");
        }
        for value in ["0", "2595599", "-1", "nope", "", "18446744073709551616"] {
            assert!(configured(&[("PMAPP_BACKUP_RETENTION_SECONDS", value)]).is_err(), "retention {value}");
        }
    }
}
