//! Backup generations and their manifest contract (Story 27.5, R5, H10).
//!
//! A generation is one coherent cut: every database copied while all durable
//! writers were excluded, plus a strict version-1 manifest that records, from
//! the captured copies themselves, the membership revision and each project's
//! server revision, stream epoch, history floor and schema version.
//!
//! Publication is manifest-last: every object is uploaded before the manifest,
//! so a reader never sees a manifest naming a missing object. A manifest is the
//! only thing that makes a generation restorable, and it is validated strictly
//! (unknown fields, unsafe names, duplicates and incomplete coverage refuse).

use serde::{Deserialize, Serialize};

pub const MANIFEST_VERSION: u32 = 1;
pub const GENERATIONS_PREFIX: &str = "generations/";
pub const WITNESS_KEY: &str = "witness/stream-epoch.json";
/// Upper bound for a manifest download.
pub const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseKind {
    Membership,
    Project,
}

/// One database file in a generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupFile {
    pub kind: DatabaseKind,
    /// `membership` or `project-<uuid>`.
    pub logical_name: String,
    /// `generations/<generation>/<logical>.sqlite`.
    pub object_key: String,
    pub sha256: String,
    pub size_bytes: u64,
    /// `PRAGMA user_version` (projects) or `membership_meta.schema_version`.
    pub schema_version: i64,
    /// Project fields; absent for the membership database.
    pub project_id: Option<String>,
    pub server_revision: Option<i64>,
    pub stream_epoch: Option<i64>,
    pub history_floor: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupManifest {
    pub manifest_version: u32,
    /// `<YYYYMMDDTHHMMSSZ>-<16 lowercase hex>`: cut instant plus random suffix,
    /// unique across process restarts.
    pub generation_id: String,
    pub cut_at_iso: String,
    pub membership_revision: i64,
    pub files: Vec<BackupFile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestError(pub &'static str);

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}", self.0) }
}

pub fn manifest_key(generation_id: &str) -> String {
    format!("{GENERATIONS_PREFIX}{generation_id}/manifest.json")
}

pub fn object_key(generation_id: &str, logical_name: &str) -> String {
    format!("{GENERATIONS_PREFIX}{generation_id}/{logical_name}.sqlite")
}

/// A fresh generation id for a cut at `cut_at` (RFC 3339 UTC).
pub fn new_generation_id(cut_at: &chrono::DateTime<chrono::Utc>) -> String {
    let suffix: u64 = rand::random();
    format!("{}-{suffix:016x}", cut_at.format("%Y%m%dT%H%M%SZ"))
}

pub fn is_generation_id(value: &str) -> bool {
    let Some((stamp, suffix)) = value.split_once('-') else { return false };
    stamp.len() == 16
        && chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%dT%H%M%SZ").is_ok()
        && suffix.len() == 16
        && suffix.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { matches!(b, b'0'..=b'9' | b'a'..=b'f') })
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The generation id named by an object key under `generations/`, if well formed.
pub fn generation_of_key(key: &str) -> Option<&str> {
    let rest = key.strip_prefix(GENERATIONS_PREFIX)?;
    let (generation, _) = rest.split_once('/')?;
    is_generation_id(generation).then_some(generation)
}

impl BackupManifest {
    pub fn manifest_key(&self) -> String { manifest_key(&self.generation_id) }

    pub fn cut_at_secs(&self) -> Result<i64, ManifestError> {
        chrono::DateTime::parse_from_rfc3339(&self.cut_at_iso)
            .map(|t| t.timestamp())
            .map_err(|_| ManifestError("MANIFEST_CUT_INVALID"))
    }

    /// Highest stream epoch recorded in this generation.
    pub fn max_stream_epoch(&self) -> i64 {
        self.files.iter().filter_map(|f| f.stream_epoch).max().unwrap_or(0)
    }

    /// Strict validation. Every restore, retention and witness decision uses
    /// only manifests that pass this.
    pub fn validate(&self) -> Result<(), ManifestError> {
        let fail = |code| Err(ManifestError(code));
        if self.manifest_version != MANIFEST_VERSION { return fail("MANIFEST_VERSION_UNSUPPORTED"); }
        if !is_generation_id(&self.generation_id) { return fail("MANIFEST_GENERATION_INVALID"); }
        let cut = chrono::DateTime::parse_from_rfc3339(&self.cut_at_iso).map_err(|_| ManifestError("MANIFEST_CUT_INVALID"))?;
        if cut.with_timezone(&chrono::Utc).format("%Y%m%dT%H%M%SZ").to_string() != self.generation_id[..16] {
            return fail("MANIFEST_CUT_MISMATCH");
        }
        if self.membership_revision < 0 { return fail("MANIFEST_MEMBERSHIP_REVISION_INVALID"); }
        let mut names = std::collections::BTreeSet::new();
        let mut membership = 0;
        for file in &self.files {
            if !names.insert(file.logical_name.as_str()) { return fail("MANIFEST_DUPLICATE_FILE"); }
            if file.object_key != object_key(&self.generation_id, &file.logical_name) { return fail("MANIFEST_OBJECT_KEY_INVALID"); }
            if !is_sha256(&file.sha256) { return fail("MANIFEST_HASH_INVALID"); }
            if file.size_bytes == 0 || file.size_bytes > crate::backup_store::MAX_OBJECT_BYTES { return fail("MANIFEST_SIZE_INVALID"); }
            if file.schema_version < 0 { return fail("MANIFEST_SCHEMA_INVALID"); }
            match file.kind {
                DatabaseKind::Membership => {
                    membership += 1;
                    if file.logical_name != "membership" || file.project_id.is_some() || file.server_revision.is_some()
                        || file.stream_epoch.is_some() || file.history_floor.is_some() {
                        return fail("MANIFEST_MEMBERSHIP_ENTRY_INVALID");
                    }
                }
                DatabaseKind::Project => {
                    let Some(project) = file.project_id.as_deref() else { return fail("MANIFEST_PROJECT_ENTRY_INVALID") };
                    if !is_uuid(project) || file.logical_name != format!("project-{project}") { return fail("MANIFEST_PROJECT_NAME_INVALID"); }
                    let (Some(revision), Some(epoch), Some(floor)) = (file.server_revision, file.stream_epoch, file.history_floor) else {
                        return fail("MANIFEST_PROJECT_ENTRY_INVALID");
                    };
                    if revision < 0 || epoch < 1 || floor < 0 || floor > revision { return fail("MANIFEST_PROJECT_CUT_INVALID"); }
                }
            }
        }
        if membership != 1 { return fail("MANIFEST_MEMBERSHIP_COVERAGE"); }
        Ok(())
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, ManifestError> {
        let manifest: Self = serde_json::from_slice(bytes).map_err(|_| ManifestError("MANIFEST_MALFORMED"))?;
        manifest.validate()?;
        Ok(manifest)
    }
}

/// The externally persisted stream-generation witness. It lives in object
/// storage, separate from any restored volume file, and records a value
/// STRICTLY GREATER than every stream epoch in any published generation. A
/// restore rotates a project's epoch to above this bound; a missing, malformed
/// or stale witness (one not above the generation's epochs) never authorizes
/// rotation. Any live rotation must raise the witness before using the epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EpochWitness {
    pub witness_version: u32,
    pub exclusive_high_water: i64,
    pub updated_at_iso: String,
    /// Generation whose publication last raised the witness.
    pub generation_id: String,
}

impl EpochWitness {
    pub fn parse(bytes: &[u8]) -> Result<Self, ManifestError> {
        let witness: Self = serde_json::from_slice(bytes).map_err(|_| ManifestError("WITNESS_MALFORMED"))?;
        if witness.witness_version != 1 || witness.exclusive_high_water < 2 || !is_generation_id(&witness.generation_id)
            || chrono::DateTime::parse_from_rfc3339(&witness.updated_at_iso).is_err() {
            return Err(ManifestError("WITNESS_INVALID"));
        }
        Ok(witness)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const PROJECT: &str = "019ff400-0000-7000-8000-000000000001";

    pub fn manifest() -> BackupManifest {
        let generation_id = "20261006T120000Z-0123456789abcdef".to_string();
        BackupManifest {
            manifest_version: 1,
            cut_at_iso: "2026-10-06T12:00:00Z".into(),
            membership_revision: 7,
            files: vec![
                BackupFile { kind: DatabaseKind::Membership, logical_name: "membership".into(), object_key: object_key(&generation_id, "membership"),
                    sha256: "ab".repeat(32), size_bytes: 10, schema_version: 1, project_id: None, server_revision: None, stream_epoch: None, history_floor: None },
                BackupFile { kind: DatabaseKind::Project, logical_name: format!("project-{PROJECT}"), object_key: object_key(&generation_id, &format!("project-{PROJECT}")),
                    sha256: "cd".repeat(32), size_bytes: 20, schema_version: 0, project_id: Some(PROJECT.into()), server_revision: Some(5), stream_epoch: Some(1), history_floor: Some(0) },
            ],
            generation_id,
        }
    }

    #[test]
    fn valid_manifest_round_trips() {
        let m = manifest();
        m.validate().unwrap();
        assert_eq!(BackupManifest::parse(&serde_json::to_vec(&m).unwrap()).unwrap(), m);
        assert_eq!(m.manifest_key(), "generations/20261006T120000Z-0123456789abcdef/manifest.json");
    }

    #[test]
    fn generation_ids_are_unique_and_shaped() {
        let now = chrono::Utc::now();
        let (a, b) = (new_generation_id(&now), new_generation_id(&now));
        assert_ne!(a, b, "same-instant generations must not collide across restarts");
        assert!(is_generation_id(&a));
        for bad in ["", "20261006T120000Z", "20261006T120000Z-XYZ", "2026-10-06-0123456789abcdef", "../x-0123456789abcdef"] {
            assert!(!is_generation_id(bad), "{bad}");
        }
        assert_eq!(generation_of_key("generations/20261006T120000Z-0123456789abcdef/x.sqlite"), Some("20261006T120000Z-0123456789abcdef"));
        assert_eq!(generation_of_key("generations/evil/x"), None);
        assert_eq!(generation_of_key("other/20261006T120000Z-0123456789abcdef/x"), None);
    }

    #[test]
    fn strict_validation_refuses_unsafe_or_incomplete_manifests() {
        let mut cases: Vec<(&str, BackupManifest)> = Vec::new();
        let mut m = manifest(); m.manifest_version = 2; cases.push(("version", m));
        let mut m = manifest(); m.files[1].logical_name = "../../etc/passwd".into(); cases.push(("traversal name", m));
        let mut m = manifest(); m.files[1].object_key = "generations/other/x.sqlite".into(); cases.push(("foreign key", m));
        let mut m = manifest(); let dup = m.files[1].clone(); m.files.push(dup); cases.push(("duplicate", m));
        let mut m = manifest(); m.files.remove(0); cases.push(("no membership", m));
        let mut m = manifest(); m.files[1].sha256 = "AB".repeat(32); cases.push(("hash case", m));
        let mut m = manifest(); m.files[1].stream_epoch = Some(0); cases.push(("epoch zero", m));
        let mut m = manifest(); m.files[1].history_floor = Some(9); cases.push(("floor above revision", m));
        let mut m = manifest(); m.cut_at_iso = "2026-10-06T12:00:01Z".into(); cases.push(("cut mismatch", m));
        let mut m = manifest(); m.files[0].server_revision = Some(1); cases.push(("membership with revision", m));
        for (name, case) in cases {
            assert!(case.validate().is_err(), "{name} accepted");
        }
        let mut raw = serde_json::to_value(manifest()).unwrap();
        raw["surprise"] = serde_json::json!(true);
        assert!(BackupManifest::parse(raw.to_string().as_bytes()).is_err(), "unknown field accepted");
    }

    #[test]
    fn witness_parsing_is_strict() {
        let ok = serde_json::json!({"witnessVersion":1,"exclusiveHighWater":3,"updatedAtIso":"2026-10-06T12:00:00Z","generationId":"20261006T120000Z-0123456789abcdef"});
        assert_eq!(EpochWitness::parse(ok.to_string().as_bytes()).unwrap().exclusive_high_water, 3);
        let mut bad = ok.clone(); bad["exclusiveHighWater"] = serde_json::json!(1);
        assert!(EpochWitness::parse(bad.to_string().as_bytes()).is_err());
        let mut extra = ok; extra["x"] = serde_json::json!(1);
        assert!(EpochWitness::parse(extra.to_string().as_bytes()).is_err());
    }
}
