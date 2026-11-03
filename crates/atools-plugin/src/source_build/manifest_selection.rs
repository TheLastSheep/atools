//! Bounded root/public manifest discovery and identity summaries.
use std::path::{Path, PathBuf};

use atools_core::models::{PluginManifest, PluginRuntimeKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const CANDIDATES: [(&str, ManifestSelection); 2] = [
    ("plugin.json", ManifestSelection::Root),
    ("public/plugin.json", ManifestSelection::Public),
];
const MAX_FEATURE_CODES: usize = 1000;
const MAX_FEATURE_CODE_BYTES: usize = 256;
const MAX_ID_BYTES: usize = 256;
const MAX_VERSION_BYTES: usize = 256;
const MAX_ENTRY_BYTES: usize = 4096;
const MAX_IDENTITY_JSON_BYTES: usize = 270_336;
const MAX_INSPECTION_METADATA_JSON_BYTES: usize = 1_048_576;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManifestSelection {
    Root,
    Public,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestIdentity {
    pub id: String,
    pub version: String,
    pub main: String,
    pub preload: Option<String>,
    pub runtime: String,
    pub feature_codes: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CandidateStatus {
    Missing,
    Invalid,
    Valid,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestCandidate {
    selection: ManifestSelection,
    status: CandidateStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: Option<ManifestIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSelectionInfo {
    pub manifest_selection: Option<ManifestSelection>,
    pub manifest_sha256: Option<String>,
    pub manifest_identity: Option<ManifestIdentity>,
    manifest_candidates: Vec<ManifestCandidate>,
    manifest_differences: Vec<&'static str>,
}


impl ManifestSelectionInfo {
    pub(super) fn empty() -> Self {
        let missing = |selection| ManifestCandidate {
            selection,
            status: CandidateStatus::Missing,
            manifest_sha256: None,
            identity: None,
            code: Some("manifest_missing"),
        };
        Self {
            manifest_selection: None,
            manifest_sha256: None,
            manifest_identity: None,
            manifest_candidates: vec![missing(ManifestSelection::Root), missing(ManifestSelection::Public)],
            manifest_differences: Vec::new(),
        }
    }

    pub(super) fn clear_resolved_manifest(&mut self) {
        self.manifest_selection = None;
        self.manifest_sha256 = None;
        self.manifest_identity = None;
    }
}

pub(super) struct ManifestScan {
    pub info: ManifestSelectionInfo,
    pub selected: Option<SelectedManifest>,
}

pub(super) struct SelectedManifest {
    pub selection: ManifestSelection,
    pub relative_path: PathBuf,
    pub raw: Option<Value>,
    pub parsed: Option<PluginManifest>,
    pub sha256: Option<String>,
    pub identity: Option<ManifestIdentity>,
    pub valid: bool,
    pub code: Option<&'static str>,
    /// Internal diagnostic only; public candidate metadata stays fail-closed.
    pub invalid_plugin_id: bool,
}

struct CandidateRead {
    summary: ManifestCandidate,
    raw: Option<Value>,
    parsed: Option<PluginManifest>,
    invalid_plugin_id: bool,
}

pub(super) fn scan(root: &Path, requested: Option<ManifestSelection>) -> ManifestScan {
    let mut reads = CANDIDATES
        .iter()
        .map(|(relative, selection)| read_candidate(root, relative, *selection))
        .collect::<Vec<_>>();
    let selected_index = requested
        .map(|selection| match selection { ManifestSelection::Root => 0, ManifestSelection::Public => 1 })
        .or_else(|| reads.iter().position(|candidate| candidate.summary.status != CandidateStatus::Missing));
    let selected = selected_index.map(|index| {
        let candidate = &mut reads[index];
        SelectedManifest {
            selection: candidate.summary.selection,
            relative_path: CANDIDATES[index].0.into(),
            raw: candidate.raw.take(),
            parsed: candidate.parsed.take(),
            sha256: candidate.summary.manifest_sha256.clone(),
            identity: candidate.summary.identity.clone(),
            valid: candidate.summary.status == CandidateStatus::Valid,
            code: candidate.summary.code,
            invalid_plugin_id: candidate.invalid_plugin_id,
        }
    });
    let selected_info = selected.as_ref();
    let differences = if reads.len() == 2
        && reads[0].summary.status == CandidateStatus::Valid
        && reads[1].summary.status == CandidateStatus::Valid
    {
        let left = reads[0].summary.identity.as_ref().expect("valid identity");
        let right = reads[1].summary.identity.as_ref().expect("valid identity");
        let mut fields = Vec::new();
        if left.id != right.id { fields.push("id"); }
        if left.version != right.version { fields.push("version"); }
        if left.main != right.main { fields.push("main"); }
        if left.preload != right.preload { fields.push("preload"); }
        if left.runtime != right.runtime { fields.push("runtime"); }
        if left.feature_codes != right.feature_codes { fields.push("featureCodes"); }
        fields
    } else {
        Vec::new()
    };
    let mut info = ManifestSelectionInfo {
        manifest_selection: selected_info.map(|value| value.selection),
        manifest_sha256: selected_info.and_then(|value| value.sha256.clone()),
        manifest_identity: selected_info.and_then(|value| value.identity.clone()),
        manifest_candidates: reads.into_iter().map(|candidate| candidate.summary).collect(),
        manifest_differences: differences,
    };
    if canonical_json_len(&info).is_none_or(|length| length > MAX_INSPECTION_METADATA_JSON_BYTES) {
        invalidate_metadata(&mut info);
        return ManifestScan {
            info,
            selected: selected.map(|mut item| {
                item.raw = None;
                item.parsed = None;
                item.sha256 = None;
                item.identity = None;
                item.valid = false;
                item.code = Some("manifest_invalid");
                item
            }),
        };
    }
    ManifestScan { info, selected }
}

fn read_candidate(root: &Path, relative: &str, selection: ManifestSelection) -> CandidateRead {
    let bytes = match crate::package_resolution::read_package_asset_bytes(
        root,
        Path::new(relative),
        crate::package_resolution::MAX_MANIFEST_BYTES,
    ) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return candidate(selection, CandidateStatus::Missing, None, None, None, Some("manifest_missing")),
        Err(_) => return candidate(selection, CandidateStatus::Invalid, None, None, None, Some("manifest_invalid")),
    };
    let raw = match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) => value,
        Err(_) => return candidate(selection, CandidateStatus::Invalid, None, None, None, Some("manifest_invalid")),
    };
    let parsed = match serde_json::from_value::<PluginManifest>(raw.clone()) {
        Ok(manifest) if manifest.validate_runtime_contract().is_ok() => manifest,
        _ => return candidate(selection, CandidateStatus::Invalid, None, None, None, Some("manifest_invalid")),
    };
    if crate::source_build::policy::stable_installation_id(&parsed.name).is_none() {
        let mut candidate = candidate(selection, CandidateStatus::Invalid, None, None, None, Some("manifest_invalid"));
        candidate.invalid_plugin_id = true;
        return candidate;
    }
    let identity = match identity(&parsed) {
        Some(identity) => identity,
        None => return candidate(selection, CandidateStatus::Invalid, None, None, None, Some("manifest_invalid")),
    };
    let digest = format!("{:x}", Sha256::digest(&bytes));
    candidate(selection, CandidateStatus::Valid, Some(digest), Some(identity), Some((raw, parsed)), None)
}

fn candidate(
    selection: ManifestSelection,
    status: CandidateStatus,
    manifest_sha256: Option<String>,
    identity: Option<ManifestIdentity>,
    contents: Option<(Value, PluginManifest)>,
    code: Option<&'static str>,
) -> CandidateRead {
    let (raw, parsed) = contents.map_or((None, None), |(raw, parsed)| {
        (Some(raw), Some(parsed))
    });
    CandidateRead {
        summary: ManifestCandidate { selection, status, manifest_sha256, identity, code },
        raw,
        parsed,
        invalid_plugin_id: false,
    }
}

pub(super) fn identity(manifest: &PluginManifest) -> Option<ManifestIdentity> {
    ManifestIdentity::from_plugin_manifest(manifest)
}

impl ManifestIdentity {
    #[doc(hidden)]
    pub fn from_plugin_manifest(manifest: &PluginManifest) -> Option<Self> {
    let id = crate::source_build::policy::stable_installation_id(&manifest.name)?;
    let version = bounded(&manifest.version, MAX_VERSION_BYTES)?;
    let main = bounded(manifest.main.as_deref()?, MAX_ENTRY_BYTES)?;
    let preload = match manifest.preload.as_deref() {
        Some(value) => Some(bounded(value, MAX_ENTRY_BYTES)?),
        None => None,
    };
    let runtime = match manifest.effective_runtime_kind() {
        PluginRuntimeKind::Web => "web",
        PluginRuntimeKind::Node => "node",
        PluginRuntimeKind::Rust | PluginRuntimeKind::Wasm => return None,
    };
    if id.len() > MAX_ID_BYTES || manifest.features.len() > MAX_FEATURE_CODES {
        return None;
    }
    let feature_codes = manifest.features.iter().map(|feature| {
        let code = feature.code.as_str();
        if code.trim().is_empty() || code.len() > MAX_FEATURE_CODE_BYTES || code.chars().any(char::is_control) {
            None
        } else {
            Some(code.to_owned())
        }
    }).collect::<Option<Vec<_>>>()?;
    let identity = ManifestIdentity { id, version, main, preload, runtime: runtime.into(), feature_codes };
    if canonical_json_len(&identity)? > MAX_IDENTITY_JSON_BYTES {
        return None;
    }
    Some(identity)
    }
}

fn canonical_json_len<T: Serialize>(value: &T) -> Option<usize> {
    let value = serde_json::to_value(value).ok()?;
    let canonical = atools_core::harness::canonicalize_json(&value);
    serde_json::to_vec(&canonical).ok().map(|bytes| bytes.len())
}

#[cfg(test)]
#[path = "manifest_selection_tests.rs"]
mod tests;

fn invalidate_metadata(info: &mut ManifestSelectionInfo) {
    for candidate in &mut info.manifest_candidates {
        if candidate.status == CandidateStatus::Valid {
            candidate.status = CandidateStatus::Invalid;
            candidate.manifest_sha256 = None;
            candidate.identity = None;
            candidate.code = Some("manifest_invalid");
        }
    }
    info.manifest_sha256 = None;
    info.manifest_identity = None;
    info.manifest_differences.clear();
}

fn bounded(value: &str, max_bytes: usize) -> Option<String> {
    (!value.trim().is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control))
        .then(|| value.to_owned())
}

