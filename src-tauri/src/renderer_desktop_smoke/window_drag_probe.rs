use crate::renderer_desktop_smoke::{
    catalog_journey::{self, report::NativeObservation, Harness as CatalogHarness},
    profile::Profile,
};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::{fs::OpenOptions, io::Write, path::PathBuf, time::Instant};
use tauri::{AppHandle, Manager, State, Webview, Wry};
use tokio::sync::oneshot;

const REPORT_LIMIT_BYTES: usize = 1024 * 1024;
const MAIN_LABEL: &str = "main";

#[path = "window_drag_probe_lifecycle.rs"]
mod lifecycle;
#[path = "window_drag_probe_schema.rs"]
mod schema;
use schema::{validate_stage, DomObservation, DragNativeObservation, StageObservation, STAGES};
pub(super) use schema::{Dimensions, Point};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeReport {
    schema_version: u8,
    journey: &'static str,
    scope: &'static str,
    run_id: String,
    identifier: String,
    root: String,
    pid: u32,
    passed: bool,
    errors: Vec<&'static str>,
    stages: Vec<StageObservation>,
}

struct Inner {
    stages: Vec<StageObservation>,
    errors: Vec<&'static str>,
    next_stage: usize,
    pending: bool,
    finished: bool,
}

pub(super) struct Harness {
    run_id: String,
    identifier: String,
    root: String,
    token: String,
    report_path: PathBuf,
    started: Instant,
    lifecycle: lifecycle::DocumentLifecycle,
    inner: Mutex<Inner>,
}

impl Harness {
    pub(super) fn new(profile: &Profile) -> Result<Self, &'static str> {
        let report_path = profile
            .output
            .parent()
            .ok_or("window-drag-report-path-unavailable")?
            .join("window-drag-native.json");
        Ok(Self {
            run_id: profile.run_id.clone(),
            identifier: profile.identifier.clone(),
            root: profile.root.to_string_lossy().into_owned(),
            token: uuid::Uuid::new_v4().simple().to_string(),
            report_path,
            started: Instant::now(),
            lifecycle: lifecycle::DocumentLifecycle::new(),
            inner: Mutex::new(Inner {
                stages: Vec::with_capacity(STAGES.len()),
                errors: Vec::new(),
                next_stage: 0,
                pending: false,
                finished: false,
            }),
        })
    }

    pub(super) fn token(&self) -> &str {
        &self.token
    }

    pub(super) fn document_id(&self) -> String {
        self.lifecycle.document_id()
    }

    pub(super) fn mark_initial_probe_injected(&self) -> bool {
        self.lifecycle.mark_initial_probe_injected()
    }

    pub(super) fn mark_resume_probe_injected(&self) -> bool {
        self.lifecycle.mark_resume_probe_injected()
    }

    pub(super) fn page_load_started(&self) -> Result<(), &'static str> {
        self.lifecycle.observe_page_load_started().map_err(|error| {
            self.record_error(error);
            error
        })
    }

    pub(super) fn page_load_finished(&self) -> Result<String, &'static str> {
        self.lifecycle
            .observe_page_load_finished()
            .map(|observation| observation.document_id)
    }

    pub(super) fn write_failure_report(&self, error: &'static str) {
        self.record_error(error);
        let _ = self.write_report();
    }

    pub(super) fn baseline_geometry(&self) -> Result<(Point, Dimensions), &'static str> {
        let inner = self.inner.lock();
        let baseline = inner
            .stages
            .first()
            .ok_or("window-drag-baseline-unavailable")?;
        Ok((
            baseline
                .native
                .position
                .ok_or("window-drag-baseline-unavailable")?,
            baseline
                .native
                .inner_size
                .ok_or("window-drag-baseline-unavailable")?,
        ))
    }

    fn record_error(&self, error: &'static str) {
        push_error(&mut self.inner.lock().errors, error);
    }

    fn authorize_navigation(&self, token: &str, document_id: &str) -> Result<(), &'static str> {
        if !self.token_matches(token) {
            return Err("window-drag-probe-token-rejected");
        }
        if document_id != self.lifecycle.document_id() {
            return Err("window-drag-document-identity-mismatch");
        }
        let inner = self.inner.lock();
        let stage = inner
            .stages
            .last()
            .ok_or("window-drag-redrag-stage-missing")?;
        if inner.finished
            || inner.pending
            || inner.next_stage != 8
            || stage.stage != "redragged"
            || !stage.errors.is_empty()
            || stage.native.locked != Some(true)
        {
            return Err("window-drag-navigation-stage-rejected");
        }
        drop(inner);
        self.lifecycle.authorize_navigation()
    }

    fn token_matches(&self, token: &str) -> bool {
        token.len() == 32
            && token == self.token
            && token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    fn start_stage(&self, token: &str, stage: &str) -> Result<usize, &'static str> {
        if !self.token_matches(token) {
            return Err("window-drag-probe-token-rejected");
        }
        let mut inner = self.inner.lock();
        let expected = STAGES.get(inner.next_stage).copied();
        if inner.finished || inner.pending || expected != Some(stage) {
            push_error(&mut inner.errors, "window-drag-stage-order-rejected");
            return Err("window-drag-stage-order-rejected");
        }
        inner.pending = true;
        Ok(inner.next_stage)
    }

    fn complete_stage(
        &self,
        index: usize,
        dom: DomObservation,
        native: DragNativeObservation,
    ) -> Result<DragNativeObservation, &'static str> {
        let mut inner = self.inner.lock();
        if inner.finished || !inner.pending || inner.next_stage != index {
            push_error(&mut inner.errors, "window-drag-stage-order-rejected");
            return Err("window-drag-stage-order-rejected");
        }
        let errors = validate_stage(index, &dom, &native, &inner.stages);
        let stage = StageObservation {
            stage: STAGES[index],
            elapsed_ms: self.started.elapsed().as_millis().min(120_000) as u64,
            dom,
            native: native.clone(),
            errors: errors.clone(),
        };
        for error in &errors {
            push_error(&mut inner.errors, error);
        }
        inner.stages.push(stage);
        inner.pending = false;
        inner.next_stage += 1;
        if errors.is_empty() {
            Ok(native)
        } else {
            Err(errors[0])
        }
    }

    fn fail_pending(&self, error: &'static str) {
        let mut inner = self.inner.lock();
        inner.pending = false;
        push_error(&mut inner.errors, error);
    }

    fn add_probe_errors(&self, errors: Vec<String>) {
        let mut inner = self.inner.lock();
        if errors.len() > 24 {
            push_error(&mut inner.errors, "window-drag-probe-error-limit");
        }
        for error in errors.into_iter().take(24) {
            let safe = match error.as_str() {
                "window-drag-dom-not-ready" => "window-drag-dom-not-ready",
                "window-drag-position-read-failed" => "window-drag-position-read-failed",
                "window-drag-mousedown-not-started" => "window-drag-mousedown-not-started",
                "window-drag-move-not-settled" => "window-drag-move-not-settled",
                "window-drag-native-move-not-observed" => "window-drag-native-move-not-observed",
                "window-drag-resize-not-observed" => "window-drag-resize-not-observed",
                "window-drag-mouseup-not-settled" => "window-drag-mouseup-not-settled",
                "window-drag-restore-not-settled" => "window-drag-restore-not-settled",
                "window-drag-hide-lock-not-started" => "window-drag-hide-lock-not-started",
                "window-drag-hide-lock-not-observed" => "window-drag-hide-lock-not-observed",
                "window-drag-hide-api-unavailable" => "window-drag-hide-api-unavailable",
                "window-drag-hide-not-settled" => "window-drag-hide-not-settled",
                "window-drag-hide-did-not-clear-lock" => "window-drag-hide-did-not-clear-lock",
                "window-drag-hide-mouseup-not-settled" => "window-drag-hide-mouseup-not-settled",
                "window-drag-post-hide-mousedown-not-started" => {
                    "window-drag-post-hide-mousedown-not-started"
                }
                "window-drag-post-hide-move-not-settled" => {
                    "window-drag-post-hide-move-not-settled"
                }
                "window-drag-post-hide-redrag-not-observed" => {
                    "window-drag-post-hide-redrag-not-observed"
                }
                "window-drag-navigation-unavailable" => "window-drag-navigation-unavailable",
                "window-drag-navigation-while-unlocked" => "window-drag-navigation-while-unlocked",
                "window-drag-navigation-main-webview-unavailable" => {
                    "window-drag-navigation-main-webview-unavailable"
                }
                "window-drag-navigation-eval-failed" => "window-drag-navigation-eval-failed",
                "window-drag-navigation-stage-rejected" => "window-drag-navigation-stage-rejected",
                "window-drag-baseline-unavailable" => "window-drag-baseline-unavailable",
                "window-drag-observation-failed" => "window-drag-observation-failed",
                "window-drag-post-navigation-mousedown-not-started" => {
                    "window-drag-post-navigation-mousedown-not-started"
                }
                "window-drag-post-navigation-move-not-settled" => {
                    "window-drag-post-navigation-move-not-settled"
                }
                "window-drag-probe-timeout" => "window-drag-probe-timeout",
                _ => "window-drag-probe-error-unrecognized",
            };
            push_error(&mut inner.errors, safe);
        }
    }

    fn write_report(&self) -> Result<bool, &'static str> {
        let inner = self.inner.lock();
        if inner.finished || inner.pending {
            return Err("window-drag-report-finish-rejected");
        }
        let complete = inner.next_stage == STAGES.len() && inner.stages.len() == STAGES.len();
        let passed = complete && inner.errors.is_empty();
        let report = NativeReport {
            schema_version: 2,
            journey: "window-drag",
            scope: "hidden-original-vue-searchbox-events",
            run_id: self.run_id.clone(),
            identifier: self.identifier.clone(),
            root: self.root.clone(),
            pid: std::process::id(),
            passed,
            errors: inner.errors.clone(),
            stages: inner.stages.clone(),
        };
        let bytes =
            serde_json::to_vec(&report).map_err(|_| "window-drag-report-serialize-failed")?;
        if bytes.len() > REPORT_LIMIT_BYTES {
            return Err("window-drag-report-limit-exceeded");
        }
        write_new_private_file(&self.report_path, &bytes)?;
        drop(inner);
        self.inner.lock().finished = true;
        Ok(passed)
    }
}

#[tauri::command]
pub(super) async fn window_drag_probe_observe(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    harness: State<'_, Harness>,
    catalog: State<'_, CatalogHarness>,
    token: String,
    stage: String,
    dom: Value,
) -> Result<DragNativeObservation, String> {
    validate_main_source(&app, &webview).map_err(str::to_owned)?;
    let harness = harness.inner();
    let index = harness.start_stage(&token, &stage).map_err(str::to_owned)?;
    let dom: DomObservation = match serde_json::from_value(dom) {
        Ok(dom) => dom,
        Err(_) => {
            harness.fail_pending("window-drag-dom-shape-rejected");
            return Err("window-drag-dom-shape-rejected".to_owned());
        }
    };
    let lifecycle = harness.lifecycle.snapshot();
    let native = match capture_native(&app, catalog.inner(), lifecycle).await {
        Ok(native) => native,
        Err(error) => {
            harness.fail_pending(error);
            return Err(error.to_owned());
        }
    };
    harness
        .complete_stage(index, dom, native)
        .map_err(str::to_owned)
}

#[tauri::command]
pub(super) fn window_drag_probe_finish(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    harness: State<'_, Harness>,
    catalog: State<'_, CatalogHarness>,
    token: String,
    document_id: String,
    errors: Vec<String>,
) -> Result<(), String> {
    validate_main_source(&app, &webview).map_err(str::to_owned)?;
    let harness = harness.inner();
    if !harness.token_matches(&token) {
        return Err("window-drag-probe-token-rejected".to_owned());
    }
    if harness.lifecycle.document_id() != document_id {
        return Err("window-drag-document-identity-mismatch".to_owned());
    }
    harness.add_probe_errors(errors);
    let passed = harness.write_report().map_err(str::to_owned)?;
    if passed {
        Ok(())
    } else {
        catalog.fail_ready("window-drag-report-incomplete");
        Err("window-drag-report-incomplete".to_owned())
    }
}

#[tauri::command]
pub(super) fn window_drag_probe_navigate(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    harness: State<'_, Harness>,
    token: String,
    document_id: String,
) -> Result<(), String> {
    validate_main_source(&app, &webview).map_err(str::to_owned)?;
    let harness = harness.inner();
    #[cfg(feature = "legacy-node-smoke")]
    let locked = crate::renderer_window_drag::locked(&app);
    #[cfg(not(feature = "legacy-node-smoke"))]
    let locked = None;
    if locked != Some(true) {
        return Err("window-drag-navigation-while-unlocked".to_owned());
    }
    harness
        .authorize_navigation(&token, &document_id)
        .map_err(str::to_owned)?;
    let primary = crate::window::main_webview(&app)
        .map_err(|_| "window-drag-navigation-main-webview-unavailable")?;
    if primary.label() != MAIN_LABEL || primary.window().label() != MAIN_LABEL {
        return Err("window-drag-navigation-main-webview-unavailable".to_owned());
    }
    if primary.eval("window.location.reload()").is_err() {
        harness.record_error("window-drag-navigation-eval-failed");
        return Err("window-drag-navigation-eval-failed".to_owned());
    }
    Ok(())
}

fn validate_main_source(app: &AppHandle<Wry>, webview: &Webview<Wry>) -> Result<(), &'static str> {
    if webview.label() != MAIN_LABEL || webview.window().label() != MAIN_LABEL {
        return Err("window-drag-command-source-rejected");
    }
    let url = webview
        .url()
        .map_err(|_| "window-drag-command-source-rejected")?;
    if !crate::renderer_desktop_smoke::controller::is_local_root_url(&url) {
        return Err("window-drag-command-source-rejected");
    }
    let primary =
        crate::window::main_webview(app).map_err(|_| "window-drag-command-source-rejected")?;
    if primary.label() != MAIN_LABEL || primary.window().label() != MAIN_LABEL {
        return Err("window-drag-command-source-rejected");
    }
    Ok(())
}

async fn capture_native(
    app: &AppHandle<Wry>,
    catalog: &CatalogHarness,
    lifecycle: lifecycle::Observation,
) -> Result<DragNativeObservation, &'static str> {
    let shared: NativeObservation = catalog_journey::driver::capture_native(app, catalog).await?;
    let (sender, receiver) = oneshot::channel();
    let observed_app = app.clone();
    app.run_on_main_thread(move || {
        let observation = crate::window::main_window(&observed_app)
            .map_err(|_| "window-drag-native-window-unavailable")
            .map(|window| {
                let scale_factor = window.scale_factor().ok();
                let position = window.outer_position().ok().and_then(|position| {
                    let scale = scale_factor?;
                    (scale.is_finite() && scale > 0.0).then_some(Point {
                        x: f64::from(position.x) / scale,
                        y: f64::from(position.y) / scale,
                    })
                });
                let inner_size = window.inner_size().ok().and_then(|size| {
                    let scale = scale_factor?;
                    (scale.is_finite() && scale > 0.0).then_some(Dimensions {
                        width: f64::from(size.width) / scale,
                        height: f64::from(size.height) / scale,
                    })
                });
                #[cfg(feature = "legacy-node-smoke")]
                let locked = crate::renderer_window_drag::locked(&observed_app);
                #[cfg(not(feature = "legacy-node-smoke"))]
                let locked = None;
                DragNativeObservation {
                    position,
                    inner_size,
                    scale_factor,
                    locked,
                    visible: window.is_visible().ok(),
                    focused: window.is_focused().ok(),
                    focus_gained_events: shared.focus_gained_events,
                    active_child_layouts: shared.active_child_layouts,
                    child_webviews: shared.child_webviews,
                    data_store_persistent: shared.data_store_persistent,
                    document_generation: lifecycle.document_generation,
                    page_load_starts: lifecycle.page_load_starts,
                    page_load_finishes: lifecycle.page_load_finishes,
                    document_id: lifecycle.document_id,
                }
            });
        let _ = sender.send(observation);
    })
    .map_err(|_| "window-drag-main-thread-dispatch-failed")?;
    tokio::time::timeout(std::time::Duration::from_secs(2), receiver)
        .await
        .map_err(|_| "window-drag-main-thread-timeout")?
        .map_err(|_| "window-drag-main-thread-interrupted")?
}

fn push_error(errors: &mut Vec<&'static str>, error: &'static str) {
    if !errors.contains(&error) {
        errors.push(error);
    }
}

fn write_new_private_file(path: &std::path::Path, bytes: &[u8]) -> Result<(), &'static str> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "window-drag-report-create-failed")?;
    file.write_all(bytes)
        .map_err(|_| "window-drag-report-write-failed")?;
    file.sync_all()
        .map_err(|_| "window-drag-report-sync-failed")
}
