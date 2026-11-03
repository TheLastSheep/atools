//! Opt-in fixture-only OS foreground evidence. DOM focus is never treated as OS activation.
#[path = "desktop_smoke_activation_observation.rs"]
mod activation;
#[path = "desktop_smoke_keyboard_owner.rs"]
mod keyboard_owner;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::time::Instant;
use tauri::{AppHandle, Manager, WindowEvent};

pub(crate) struct PanelForeground {
    required: bool,
    started: Instant,
    events: Mutex<NativeEvents>,
    activation: Option<std::sync::Arc<activation::Observation>>,
}
const MAX_NATIVE_EVENTS: usize = 128;
#[derive(Default)]
struct NativeEvents {
    entries: Vec<Value>,
    total: u32,
    overflow: u32,
}
impl NativeEvents {
    fn record(&mut self, event: &'static str, elapsed_ms: f64) {
        self.total = self.total.saturating_add(1);
        if self.entries.len() < MAX_NATIVE_EVENTS {
            self.entries
                .push(json!({"event":event,"elapsedMs":elapsed_ms}));
        } else {
            self.overflow = self.overflow.saturating_add(1);
        }
    }
}
impl PanelForeground {
    pub(crate) fn from_environment() -> Result<Self, String> {
        let mode =
            std::env::var("ATOOLS_PANEL_FOREGROUND_MODE").unwrap_or_else(|_| "observe".into());
        if !matches!(mode.as_str(), "observe" | "required") {
            return Err("Invalid panel foreground mode".into());
        }
        Ok(Self {
            required: mode == "required",
            started: Instant::now(),
            events: Mutex::new(NativeEvents::default()),
            activation: activation::Observation::from_environment()?,
        })
    }
    pub(crate) fn mode(&self) -> &'static str {
        if self.required {
            "foreground"
        } else {
            "observe"
        }
    }
    fn record(&self, event: &'static str) {
        self.events
            .lock()
            .record(event, self.started.elapsed().as_secs_f64() * 1000.0);
    }
}
pub(crate) fn record_window_event(app: &AppHandle, label: &str, event: &WindowEvent) {
    if label != "main" {
        return;
    }
    let Some(state) = app.try_state::<PanelForeground>() else {
        return;
    };
    match event {
        WindowEvent::Focused(true) => state.record("native-focus-gained"),
        WindowEvent::Focused(false) => state.record("native-focus-lost"),
        WindowEvent::CloseRequested { .. } => state.record("native-close-requested"),
        WindowEvent::Destroyed => {
            state.record("native-destroyed");
            if let Some(observation) = &state.activation {
                activation::cancel(app, observation);
            }
        }
        _ => {}
    }
}
pub(crate) fn event_snapshot(app: &AppHandle) -> Value {
    let state = app.state::<PanelForeground>();
    let events = state.events.lock();
    json!({"mode":state.mode(),"events":events.entries,"eventTotal":events.total,
        "eventOverflow":events.overflow,"maxEvents":MAX_NATIVE_EVENTS,
        "activationObservation":state.activation.as_ref().map(|value|value.snapshot()),
        "scope":"Only this fixture's native window events; no production blur/hide handler installed"})
}

#[tauri::command]
pub(crate) async fn native_panel_foreground(app: AppHandle, ensure: bool) -> Result<Value, String> {
    if ensure && !app.state::<PanelForeground>().required {
        return Err("Foreground restoration requires explicit fixture mode".into());
    }
    if ensure {
        let observation = app.state::<PanelForeground>().activation.clone();
        if let Some(observation) = observation {
            return activation::observe_request(app, observation).await;
        }
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let observed_app = app.clone();
    app.run_on_main_thread(move || {
        let result = foreground_request_on_main_thread(&observed_app, ensure);
        let _ = sender.send(result);
    })
    .map_err(|e| e.to_string())?;
    receiver
        .await
        .map_err(|_| "Native foreground snapshot interrupted".to_string())?
}

fn foreground_request_on_main_thread(
    observed_app: &AppHandle,
    ensure: bool,
) -> Result<Value, String> {
    let state = observed_app.state::<PanelForeground>();
    if ensure {
        state.record("fixture-foreground-request");
        crate::window::show_main_window(&observed_app).map_err(|e| e.to_string())?;
    }
    foreground_snapshot_on_main_thread(observed_app)
}

fn foreground_snapshot_on_main_thread(observed_app: &AppHandle) -> Result<Value, String> {
    let state = observed_app.state::<PanelForeground>();
    let window = observed_app
        .get_webview_window("main")
        .ok_or("Fixture main window unavailable")?;
    #[cfg(target_os = "macos")]
    let (
        app_active,
        app_hidden,
        frontmost_is_self,
        window_occlusion_visible,
        keyboard_responder_class,
        keyboard_ownership,
    ) = {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSApplication, NSWindow, NSWindowOcclusionState, NSWorkspace};
        let marker =
            MainThreadMarker::new().ok_or("Native foreground evidence requires the main thread")?;
        let application = NSApplication::sharedApplication(marker);
        let frontmost = NSWorkspace::sharedWorkspace().frontmostApplication();
        let native_window = window.ns_window().map_err(|error| error.to_string())?;
        if native_window.is_null() {
            return Err("Fixture native window pointer unavailable".into());
        }
        // Tauri owns this live window; the snapshot runs synchronously on its main thread.
        let native_window = unsafe { &*native_window.cast::<NSWindow>() };
        let (responder_class, ownership) = keyboard_owner::observe(&window)?;
        (
            application.isActive(),
            application.isHidden(),
            frontmost
                .is_some_and(|process| process.processIdentifier() == std::process::id() as i32),
            Some(
                native_window
                    .occlusionState()
                    .contains(NSWindowOcclusionState::Visible),
            ),
            responder_class,
            ownership,
        )
    };
    #[cfg(not(target_os = "macos"))]
    let (
        app_active,
        app_hidden,
        frontmost_is_self,
        window_occlusion_visible,
        keyboard_responder_class,
        keyboard_ownership,
    ): (_, _, _, Option<bool>, Option<String>, _) = (
        false,
        false,
        false,
        None,
        None,
        keyboard_owner::KeyboardOwnership::unknown(),
    );
    state.record("native-foreground-observed");
    Ok(
        json!({"mode":state.mode(),"nativeVisible":window.is_visible().map_err(|e|e.to_string())?,
                "nativeFocused":window.is_focused().map_err(|e|e.to_string())?,"appActive":app_active,"appHidden":app_hidden,
                "frontmostIsSelf":frontmost_is_self,"elapsedMs":state.started.elapsed().as_secs_f64()*1000.0,
                "windowOcclusionVisible":window_occlusion_visible,
                "keyboardResponderClass":keyboard_responder_class,"webviewKeyboardOwnerVerified":keyboard_ownership.verified(),
                "keyboardOwner":keyboard_ownership,
                "scope":"Fixture main window visibility/focus, AppKit activation/occlusion, frontmost PID equality, bounded firstResponder class and exact main WKWebView identity or at most 64 owned NSView nodes; ownership does not prove editor focus or display-awake"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_event_history_keeps_first_128_and_counts_drops() {
        let mut events = NativeEvents::default();
        for n in 0..140 {
            events.record("native-foreground-observed", n as f64);
        }
        assert_eq!(events.entries.len(), 128);
        assert_eq!(events.total, 140);
        assert_eq!(events.overflow, 12);
        assert_eq!(events.entries[127]["elapsedMs"], 127.0);
    }
    #[test]
    fn native_event_counters_saturate_without_allocating_more_entries() {
        let mut events = NativeEvents::default();
        for _ in 0..128 {
            events.record("native-focus-gained", 0.0);
        }
        events.total = u32::MAX;
        events.overflow = u32::MAX;
        events.record("native-focus-lost", 1.0);
        assert_eq!(events.entries.len(), 128);
        assert_eq!((events.total, events.overflow), (u32::MAX, u32::MAX));
    }
}
