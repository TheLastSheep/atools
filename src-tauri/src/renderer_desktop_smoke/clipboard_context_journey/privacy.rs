use crate::renderer_desktop_smoke::profile::Profile;
use atools_core::{
    agent::{AuditLogEntry, AuditStatus},
    task_run::{TaskRun, TaskRunStatus},
    Database,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(super) struct DatabaseFacts {
    pub(super) task_runs: Vec<TaskRun>,
    pub(super) audits: Vec<AuditLogEntry>,
    pub(super) native_items_empty: bool,
    pub(super) history_count: usize,
    pub(super) history_hash: String,
    pub(super) history_payload_absent: bool,
}

pub(super) fn database_facts(
    db: &Database,
    profile: &Profile,
) -> Result<DatabaseFacts, &'static str> {
    let task_runs = db
        .list_task_runs(5000)
        .map_err(|_| super::report::PRIVACY_AUDIT_FAILED)?;
    let audits = db
        .list_audit_entries(5000)
        .map_err(|_| super::report::PRIVACY_AUDIT_FAILED)?;
    let page = db
        .clipboard_history_page("", 1, 1000)
        .map_err(|_| super::report::PRIVACY_AUDIT_FAILED)?;
    if page.total > page.items.len() || page.total > 1000 {
        return Err(super::report::PRIVACY_AUDIT_FAILED);
    }
    let native_items_empty = db
        .search_pasteboard_items("", None, &[], 1, 0)
        .map_err(|_| super::report::PRIVACY_AUDIT_FAILED)?
        .is_empty();
    let markers = PrivateMarkers::new(profile);
    let history_payload_absent = page
        .items
        .iter()
        .all(|item| !contains_private_payload_string(&item.content, &markers, 0));
    let encoded =
        serde_json::to_vec(&page.items).map_err(|_| super::report::PRIVACY_AUDIT_FAILED)?;
    Ok(DatabaseFacts {
        task_runs,
        audits,
        native_items_empty,
        history_count: page.total,
        history_hash: Sha256::digest(encoded)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        history_payload_absent,
    })
}

pub(super) fn task_payload_absent(run: &TaskRun, profile: &Profile) -> bool {
    serde_json::to_value(run)
        .map(|value| !contains_private_payload_value(&value, profile, 0))
        .unwrap_or(false)
}

pub(super) fn audit_metadata_only(entry: &AuditLogEntry, profile: &Profile) -> bool {
    audit_input_is_allowed(&entry.input)
        && serde_json::to_value(entry)
            .map(|value| !contains_private_payload_value(&value, profile, 0))
            .unwrap_or(false)
}

fn audit_input_is_allowed(input: &Value) -> bool {
    let Some(fields) = input.as_object() else {
        return false;
    };
    if fields.len() != 1 {
        return false;
    }
    match fields.get("timeLimit") {
        Some(Value::Null) => true,
        Some(Value::Number(value)) => value.as_f64().is_some_and(|number| number == 1.0),
        _ => false,
    }
}

pub(super) fn task_summary_only(run: &TaskRun) -> bool {
    if run.status == TaskRunStatus::Cancelled {
        return run.output.is_null()
            && run.errors.len() == 1
            && run.errors[0].code == "permission_denied"
            && run.errors[0].message == "Permission denied"
            && run.errors[0].details.is_null();
    }
    let Some(output) = run.output.as_object() else {
        return false;
    };
    if output.len() != 3
        || output.get("contentRedacted").and_then(Value::as_bool) != Some(true)
        || output.get("available").and_then(Value::as_bool).is_none()
    {
        return false;
    }
    match output.get("summary") {
        Some(Value::Null) => !output
            .get("available")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        Some(Value::Object(summary)) => {
            summary.len() == 4
                && summary
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| matches!(kind, "text" | "image" | "file"))
                && summary
                    .get("payloadBytes")
                    .and_then(Value::as_u64)
                    .is_some()
                && summary.get("fileCount").and_then(Value::as_u64).is_some()
                && summary.get("timestamp").and_then(Value::as_u64).is_some()
        }
        _ => false,
    }
}

pub(super) fn task_status_counts(runs: &[TaskRun]) -> (u32, u32, u32, bool) {
    let (mut succeeded, mut cancelled, mut other, mut all_terminal) = (0, 0, 0, true);
    for run in runs {
        all_terminal &= run.status.is_terminal();
        match run.status {
            TaskRunStatus::Succeeded => succeeded += 1,
            TaskRunStatus::Cancelled => cancelled += 1,
            _ => other += 1,
        }
    }
    (succeeded, cancelled, other, all_terminal)
}

pub(super) fn audit_status_counts(entries: &[AuditLogEntry]) -> (u32, u32, u32, bool) {
    let (mut confirmed, mut denied, mut other, mut finalized) = (0, 0, 0, true);
    for entry in entries {
        finalized &= matches!(entry.status, AuditStatus::Confirmed | AuditStatus::Denied);
        match entry.status {
            AuditStatus::Confirmed => confirmed += 1,
            AuditStatus::Denied => denied += 1,
            _ => other += 1,
        }
    }
    (confirmed, denied, other, finalized)
}

#[cfg(test)]
fn contains_private_payload_bytes(bytes: &[u8], profile: &Profile) -> bool {
    let markers = PrivateMarkers::new(profile);
    contains_private_payload_bytes_with_markers(bytes, &markers)
}

const MAX_ENCODED_JSON_DEPTH: usize = 16;

struct PrivateMarkers(Vec<String>);

impl PrivateMarkers {
    fn new(profile: &Profile) -> Self {
        let fixture = crate::pasteboard_native::clipboard_fixture::FIXTURE_TEXT;
        let fixture_name = crate::pasteboard_native::clipboard_fixture::FIXTURE_FILE_NAME;
        let fixture_dir = profile.root.join("clipboard-fixture");
        let fixture_path = fixture_dir.join(fixture_name);
        let raw = [
            fixture.to_owned(),
            fixture.trim().to_owned(),
            fixture_name.to_owned(),
            profile.root.to_string_lossy().into_owned(),
            fixture_dir.to_string_lossy().into_owned(),
            fixture_path.to_string_lossy().into_owned(),
            "data:image/png;base64,".to_owned(),
        ];
        let mut markers = Vec::with_capacity(raw.len() * 2);
        for marker in raw {
            if marker.is_empty() {
                continue;
            }
            if !markers.contains(&marker) {
                markers.push(marker.clone());
            }
            if let Ok(encoded) = serde_json::to_string(&marker) {
                let escaped = encoded[1..encoded.len() - 1].to_owned();
                if !escaped.is_empty() && !markers.contains(&escaped) {
                    markers.push(escaped);
                }
            }
        }
        Self(markers)
    }

    fn matches(&self, text: &str) -> bool {
        self.0.iter().any(|marker| text.contains(marker))
    }

    #[cfg(test)]
    fn matches_bytes(&self, bytes: &[u8]) -> bool {
        self.0.iter().any(|marker| {
            let needle = marker.as_bytes();
            bytes.windows(needle.len()).any(|window| window == needle)
        })
    }
}

#[cfg(test)]
fn contains_private_payload_bytes_with_markers(bytes: &[u8], markers: &PrivateMarkers) -> bool {
    if markers.matches_bytes(bytes) {
        return true;
    }
    serde_json::from_slice::<Value>(bytes)
        .map(|value| contains_private_payload_value_with_markers(&value, markers, 0))
        .unwrap_or(false)
}

fn contains_private_payload_value(value: &Value, profile: &Profile, depth: usize) -> bool {
    contains_private_payload_value_with_markers(value, &PrivateMarkers::new(profile), depth)
}

fn contains_private_payload_value_with_markers(
    value: &Value,
    markers: &PrivateMarkers,
    depth: usize,
) -> bool {
    if depth >= MAX_ENCODED_JSON_DEPTH {
        return true;
    }
    match value {
        Value::String(text) => contains_private_payload_string(text, markers, depth),
        Value::Array(values) => values
            .iter()
            .any(|value| contains_private_payload_value_with_markers(value, markers, depth + 1)),
        Value::Object(values) => values.iter().any(|(key, value)| {
            contains_private_payload_string(key, markers, depth + 1)
                || contains_private_payload_value_with_markers(value, markers, depth + 1)
        }),
        _ => false,
    }
}

fn contains_private_payload_string(text: &str, markers: &PrivateMarkers, depth: usize) -> bool {
    if markers.matches(text) {
        return true;
    }
    let candidate = text.trim_start();
    if !candidate.starts_with('{') && !candidate.starts_with('[') && !candidate.starts_with('"') {
        return false;
    }
    if depth >= MAX_ENCODED_JSON_DEPTH {
        return true;
    }
    match serde_json::from_str::<Value>(text) {
        Ok(value) => contains_private_payload_value_with_markers(&value, markers, depth + 1),
        Err(_) => false,
    }
}

#[cfg(test)]
#[path = "privacy_tests.rs"]
mod tests;
