use super::{FIXED_CONTENT, FIXED_UUID, PRODUCT_NAME, SOURCE_LABEL, TARGET_LABEL};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Rect {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) width: f64,
    pub(super) height: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindowGeometry {
    pub(super) label: String,
    pub(super) title: String,
    pub(super) requested: Rect,
    pub(super) actual: Option<Rect>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Attempt {
    pub(super) id: u64,
    pub(super) start_ack: bool,
    pub(super) outcome: Option<String>,
    pub(super) ended_at_unix_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TargetDrop {
    pub(super) attempt_id: Option<u64>,
    pub(super) path_count: usize,
    pub(super) path_matches_expected: bool,
    pub(super) content_matches_expected: bool,
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) received_at_unix_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Report {
    pub(super) schema_version: u32,
    pub(super) claim: &'static str,
    pub(super) process_id: u32,
    pub(super) app_identifier: String,
    pub(super) product_name: &'static str,
    pub(super) scratch_root: String,
    pub(super) report_path: String,
    pub(super) event_log_path: String,
    pub(super) input_relative_path: &'static str,
    pub(super) input_uuid: &'static str,
    pub(super) source: WindowGeometry,
    pub(super) target: WindowGeometry,
    pub(super) native_monitor_installed: bool,
    pub(super) start_rejection_count: u64,
    pub(super) last_start_rejection: Option<String>,
    pub(super) attempts: Vec<Attempt>,
    pub(super) target_drops: Vec<TargetDrop>,
    pub(super) passed: bool,
    pub(super) finish_requested: bool,
}

impl Report {
    fn acceptance_passed(&self) -> bool {
        let first = self.attempts.first();
        let second = self.attempts.get(1);
        let third = self.attempts.get(2);
        first.is_some_and(|attempt| {
            attempt.outcome.as_deref() == Some("Dropped")
                && self.has_matching_target_drop(attempt.id)
        }) && second.is_some_and(|attempt| attempt.outcome.as_deref() == Some("Cancelled"))
            && third.is_some_and(|attempt| {
                attempt.outcome.as_deref() == Some("Dropped")
                    && self.has_matching_target_drop(attempt.id)
            })
    }

    fn has_matching_target_drop(&self, attempt_id: u64) -> bool {
        self.target_drops.iter().any(|drop| {
            drop.attempt_id == Some(attempt_id)
                && drop.path_matches_expected
                && drop.content_matches_expected
        })
    }
}

pub(super) struct FixtureState {
    pub(super) root: PathBuf,
    pub(super) input_file: PathBuf,
    pub(super) report_path: PathBuf,
    event_log: Mutex<File>,
    pub(super) report: Mutex<Report>,
    pub(super) prepare_lock: tokio::sync::Mutex<()>,
    pub(super) prepared: AtomicBool,
    pub(super) drag_active: AtomicBool,
    pub(super) current_attempt: AtomicU64,
}

impl FixtureState {
    pub(super) fn create(root: PathBuf, app_identifier: String) -> Result<Arc<Self>, String> {
        let root = validate_scratch_root(root)?;
        fs::create_dir(&root).map_err(|error| format!("Unable to create scratch root: {error}"))?;

        let input_file = root.join("input.txt");
        let mut input = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&input_file)
            .map_err(|error| format!("Unable to create fixed input file: {error}"))?;
        input
            .write_all(FIXED_CONTENT.as_bytes())
            .and_then(|()| input.flush())
            .map_err(|error| format!("Unable to write fixed input file: {error}"))?;
        fs::create_dir(root.join("profile"))
            .map_err(|error| format!("Unable to create private WebView profile: {error}"))?;

        let report_path = root.join("report.json");
        let event_log_path = root.join("events.jsonl");
        let event_log = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&event_log_path)
            .map_err(|error| format!("Unable to create event log: {error}"))?;
        let report = Report {
            schema_version: 1,
            claim:
                "isolated OS native file drag only; not original-package UI or TaskRun acceptance",
            process_id: std::process::id(),
            app_identifier,
            product_name: PRODUCT_NAME,
            scratch_root: root.display().to_string(),
            report_path: report_path.display().to_string(),
            event_log_path: event_log_path.display().to_string(),
            input_relative_path: "input.txt",
            input_uuid: FIXED_UUID,
            source: requested_window(SOURCE_LABEL, "SOURCE — native file drag", 40.0),
            target: requested_window(TARGET_LABEL, "TARGET — real OS drop", 510.0),
            native_monitor_installed: false,
            start_rejection_count: 0,
            last_start_rejection: None,
            attempts: Vec::new(),
            target_drops: Vec::new(),
            passed: false,
            finish_requested: false,
        };
        let state = Arc::new(Self {
            root,
            input_file,
            report_path,
            event_log: Mutex::new(event_log),
            report: Mutex::new(report),
            prepare_lock: tokio::sync::Mutex::new(()),
            prepared: AtomicBool::new(false),
            drag_active: AtomicBool::new(false),
            current_attempt: AtomicU64::new(0),
        });
        state.record("fixture_started", json!({}), |_| {})?;
        Ok(state)
    }

    pub(super) fn record(
        &self,
        event_name: &str,
        detail: Value,
        update: impl FnOnce(&mut Report),
    ) -> Result<(), String> {
        let mut report = self.report.lock();
        update(&mut report);
        report.passed = report.acceptance_passed();
        let event = json!({
            "atUnixMs": unix_time_ms(),
            "event": event_name,
            "detail": detail,
        });
        let mut event_line = serde_json::to_vec(&event)
            .map_err(|error| format!("Unable to encode event log entry: {error}"))?;
        event_line.push(b'\n');
        {
            let mut log = self.event_log.lock();
            log.write_all(&event_line)
                .and_then(|()| log.flush())
                .map_err(|error| format!("Unable to append event log: {error}"))?;
        }
        let encoded = serde_json::to_vec_pretty(&*report)
            .map_err(|error| format!("Unable to encode smoke report: {error}"))?;
        atomic_write(
            &self.report_path,
            &self.root.join("report.json.tmp"),
            &encoded,
        )
    }

    pub(super) fn record_target_drop(
        &self,
        paths: &[PathBuf],
        x: f64,
        y: f64,
    ) -> Result<(), String> {
        // The event may contain arbitrary external paths. Compare them first;
        // only read the fixture's known file after an exact path match.
        let path_matches_expected = paths.len() == 1 && paths.first() == Some(&self.input_file);
        let content_matches_expected = path_matches_expected
            && fs::read(&self.input_file).is_ok_and(|bytes| bytes == FIXED_CONTENT.as_bytes());
        let attempt_id = match self.current_attempt.load(Ordering::Acquire) {
            0 => None,
            id => Some(id),
        };
        let received_at_unix_ms = unix_time_ms();
        let drop = TargetDrop {
            attempt_id,
            path_count: paths.len(),
            path_matches_expected,
            content_matches_expected,
            x,
            y,
            received_at_unix_ms,
        };
        self.record(
            "target_native_drop",
            json!({
                "attemptId": attempt_id,
                "pathCount": paths.len(),
                "pathMatchesExpected": path_matches_expected,
                "contentMatchesExpected": content_matches_expected,
                "position": {"x": x, "y": y},
            }),
            |report| report.target_drops.push(drop),
        )
    }

    pub(super) fn status(&self) -> Value {
        let report = self.report.lock();
        json!({
            "prepared": self.prepared.load(Ordering::Acquire),
            "dragActive": self.drag_active.load(Ordering::Acquire),
            "passed": report.passed,
            "attempts": report.attempts,
            "targetDrops": report.target_drops,
            "startRejectionCount": report.start_rejection_count,
            "lastStartRejection": report.last_start_rejection,
            "reportPath": report.report_path,
            "eventLogPath": report.event_log_path,
        })
    }

    pub(super) fn record_window_layout(
        &self,
        source: WindowGeometry,
        target: WindowGeometry,
    ) -> Result<(), String> {
        self.record(
            "windows_ready",
            json!({"source": source, "target": target}),
            |report| {
                report.source = source;
                report.target = target;
            },
        )
    }
}

pub(super) fn requested_window(label: &str, title: &str, x: f64) -> WindowGeometry {
    WindowGeometry {
        label: label.to_owned(),
        title: title.to_owned(),
        requested: Rect {
            x,
            y: 60.0,
            width: 450.0,
            height: 430.0,
        },
        actual: None,
    }
}

pub(super) fn actual_window(
    label: &str,
    title: &str,
    requested_x: f64,
    window: &tauri::WebviewWindow,
) -> WindowGeometry {
    let mut geometry = requested_window(label, title, requested_x);
    geometry.actual = window
        .outer_position()
        .ok()
        .zip(window.inner_size().ok())
        .map(|(position, size)| Rect {
            x: f64::from(position.x),
            y: f64::from(position.y),
            width: f64::from(size.width),
            height: f64::from(size.height),
        });
    geometry
}

fn validate_scratch_root(root: PathBuf) -> Result<PathBuf, String> {
    if !root.is_absolute() || root.components().any(|part| part == Component::ParentDir) {
        return Err("Scratch root must be an absolute path without parent traversal".into());
    }
    let parent = root
        .parent()
        .ok_or_else(|| "Scratch root has no parent directory".to_string())?;
    let name = root
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Scratch root needs a final directory name".to_string())?;
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Scratch parent must already exist: {error}"))?;
    let temp_dir = fs::canonicalize(std::env::temp_dir())
        .map_err(|error| format!("System temporary directory is unavailable: {error}"))?;
    if !parent.starts_with(&temp_dir) {
        return Err("Scratch root must be inside the system temporary directory".into());
    }
    let root = parent.join(name);
    if root.exists() || fs::symlink_metadata(&root).is_ok() {
        return Err("Scratch root already exists; choose a new temporary directory".into());
    }
    Ok(root)
}

fn atomic_write(destination: &Path, temporary: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(temporary)
        .map_err(|error| format!("Unable to open temporary report: {error}"))?;
    file.write_all(bytes)
        .and_then(|()| file.flush())
        .map_err(|error| format!("Unable to write temporary report: {error}"))?;
    fs::rename(temporary, destination)
        .map_err(|error| format!("Unable to publish smoke report: {error}"))
}

pub(super) fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

pub(super) fn safe_error(error: &str) -> String {
    error
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == ' ' || *ch == '-' || *ch == '_')
        .take(120)
        .collect::<String>()
        .trim()
        .to_owned()
}
