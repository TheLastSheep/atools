//! Bounded, content-free checkpoints for the opt-in native fixture only.
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{path::PathBuf, time::Instant};
use tauri::Manager;

pub(super) struct Progress {
    path: PathBuf,
    started: Instant,
    state: Mutex<State>,
}

struct State {
    finished: bool,
    history: Vec<Value>,
}

impl Progress {
    pub(super) fn new(path: PathBuf) -> Self {
        Self {
            path,
            started: Instant::now(),
            state: Mutex::new(State {
                finished: false,
                history: Vec::new(),
            }),
        }
    }

    pub(super) fn record(&self, phase: &str) -> Result<(), String> {
        if phase.is_empty()
            || phase.len() > 64
            || !phase
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err("Fixture phase must be a bounded content-free label".into());
        }
        let mut state = self.state.lock();
        if state.finished {
            return Ok(());
        }
        if state.history.len() >= 64 {
            return Err("Fixture phase history is full".into());
        }
        let elapsed_ms = self.started.elapsed().as_millis() as u64;
        state
            .history
            .push(json!({"phase":phase,"elapsedMs":elapsed_ms}));
        eprintln!("[main-push-smoke] {phase} {elapsed_ms}ms");
        let checkpoint = json!({"passed":false,"cleanupComplete":false,
            "checkpointOnly":true,"phase":phase,"phases":state.history});
        std::fs::write(&self.path, serde_json::to_vec_pretty(&checkpoint).unwrap())
            .map_err(|error| error.to_string())
    }

    pub(super) fn finish(&self) -> Value {
        let mut state = self.state.lock();
        state.finished = true;
        json!(state.history)
    }
}

#[tauri::command]
pub(super) fn native_main_push_phase(app: tauri::AppHandle, phase: String) -> Result<(), String> {
    app.state::<Progress>().record(&phase)
}
