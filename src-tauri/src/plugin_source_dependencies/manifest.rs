use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct PackageRecord {
    pub package_path: String,
    pub name: String,
    pub version: String,
    pub archive_id_sha256: String,
    pub archive_bytes: u64,
    pub unpacked_bytes: u64,
    pub file_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct SetManifest {
    pub schema_version: u32,
    pub set_id_sha256: String,
    pub plan_sha256: String,
    pub source_revision_sha256: String,
    pub package_lock_sha256: String,
    pub target: TargetRecord,
    pub packages: Vec<PackageRecord>,
    pub skipped_optional_count: usize,
    pub package_count: usize,
    pub archive_bytes: u64,
    pub unpacked_bytes: u64,
    pub file_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct TargetRecord {
    pub os: String,
    pub cpu: String,
}

impl SetManifest {
    pub fn encoded(&self) -> Result<Vec<u8>, &'static str> {
        serde_json::to_vec(self).map_err(|_| "dependency_manifest_write_failed")
    }

    pub fn sha256(bytes: &[u8]) -> String {
        let digest = Sha256::digest(bytes);
        let mut output = String::with_capacity(64);
        for byte in digest {
            output.push_str(&format!("{byte:02x}"));
        }
        output
    }
}
