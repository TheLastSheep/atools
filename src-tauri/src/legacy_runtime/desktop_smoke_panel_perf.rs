//! Own-process resource samples for the opt-in isolated production-panel fixture.
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::Manager;

pub(crate) struct PanelPerformance {
    started_at: Instant,
    last_sample_at: Mutex<Option<Instant>>,
    system: Mutex<System>,
    phases: Mutex<Vec<Value>>,
}

impl Default for PanelPerformance {
    fn default() -> Self {
        Self {
            started_at: Instant::now(),
            last_sample_at: Mutex::new(None),
            system: Mutex::new(System::new()),
            phases: Mutex::new(Vec::new()),
        }
    }
}

#[tauri::command]
pub(crate) fn native_panel_perf_phase(app: tauri::AppHandle, phase: String) -> Result<(), String> {
    if phase.is_empty()
        || phase.len() > 64
        || !phase
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("Invalid isolated-panel phase marker".into());
    }
    let state = app.state::<PanelPerformance>();
    let mut phases = state.phases.lock();
    if phases.len() < 100 {
        phases.push(
            json!({"phase":phase,"elapsedMs":state.started_at.elapsed().as_secs_f64()*1000.0}),
        );
    }
    Ok(())
}

pub(crate) fn phase_snapshot(app: &tauri::AppHandle) -> Value {
    json!(app.state::<PanelPerformance>().phases.lock().clone())
}

fn sample_process(state: &PanelPerformance) -> Result<Value, String> {
    let pid = Pid::from_u32(std::process::id());
    let mut system = state.system.lock();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_memory().with_cpu(),
    );
    let process = system.process(pid).ok_or_else(|| {
        "Smoke host process disappeared during its own-process sample".to_string()
    })?;
    let now = Instant::now();
    let interval_ms = state
        .last_sample_at
        .lock()
        .replace(now)
        .map(|last| now.duration_since(last).as_secs_f64() * 1000.0);
    Ok(json!({
        "scope": "smoke-host-pid-only",
        "pid": std::process::id(),
        "elapsedSinceSmokeStartMs": state.started_at.elapsed().as_secs_f64() * 1000.0,
        "rssBytes": process.memory(),
        "cpuPercentSincePreviousSample": interval_ms.map(|_| process.cpu_usage()),
        "cpuIntervalMs": interval_ms,
        "excludes": ["WKWebContent", "Node sidecars", "other helper processes", "system-wide totals"]
    }))
}

#[tauri::command]
pub(crate) fn native_panel_perf_snapshot(app: tauri::AppHandle) -> Result<Value, String> {
    sample_process(&app.state::<PanelPerformance>())
}

#[tauri::command]
pub(crate) async fn native_panel_perf_quiet_window(app: tauri::AppHandle) -> Result<Value, String> {
    let state = app.state::<PanelPerformance>();
    let before = sample_process(&state)?;
    let started = Instant::now();
    tokio::time::sleep(Duration::from_millis(750)).await;
    let after = sample_process(&state)?;
    Ok(json!({
        "scope": "smoke-host-pid-only",
        "fixtureBackgroundServices": false,
        "quietWindowMs": started.elapsed().as_secs_f64() * 1000.0,
        "before": before,
        "after": after
    }))
}
