//! One-shot paste path. Payloads are held only in this invocation's memory.
use super::{clipboard::ClipboardAccess, clipboard_image_write, request::ContentPayload};
use super::{
    clipboard_image,
    sessions::{Session, Sessions},
};
use atools_core::db::Database;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};
use std::{thread, time::Duration};
use tauri::Manager;

pub(super) async fn execute_content(
    app: tauri::AppHandle,
    db: Database,
    runtime: Arc<Sessions>,
    session: Arc<Session>,
    backend: Arc<dyn ClipboardAccess>,
    content: ContentPayload,
    paste: bool,
) -> Result<Value, String> {
    let owner = session.owner.clone();
    let commit = RuntimeCommit {
        runtime,
        db,
        session,
    };
    if !paste && !matches!(&content, ContentPayload::Image(_)) {
        let prepared = prepare_content(content)?;
        commit.write(backend.as_ref(), prepared)?;
        return Ok(Value::Null);
    }
    clipboard_image::run_system_limited(move |cancelled| {
        if cancelled.load(Ordering::Acquire) || !commit.valid() {
            return Err("Clipboard session closed or access revoked".into());
        }
        let prepared = prepare_content(content)?;
        if cancelled.load(Ordering::Acquire) || !commit.valid() {
            return Err("Clipboard session closed or access revoked".into());
        }
        if paste {
            let host = SystemPasteHost::new(app);
            write_and_paste(
                backend.as_ref(),
                &host,
                &owner,
                global_paste_gate(),
                &commit,
                prepared,
            )?;
        } else {
            commit.write(backend.as_ref(), prepared)?;
        }
        Ok(Value::Null)
    })
    .await
}

pub(super) enum PreparedContent {
    Text(String),
    Html(super::clipboard_html::HtmlWriteRequest),
    Image(super::clipboard_image_write::RgbaClipboardImage),
    Files(Vec<String>),
}

pub(crate) trait ClipboardCommit {
    fn valid(&self) -> bool;
    fn authorization(&self) -> Arc<dyn Fn() -> bool + Send + Sync>;
    fn write(&self, backend: &dyn ClipboardAccess, content: PreparedContent) -> Result<(), String>;
    fn paste(&self, host: &dyn PasteHost, target: &ForegroundTarget) -> Result<(), String>;
}

#[derive(Default)]
pub(crate) struct PasteGate(AtomicBool);
struct PasteLease<'a>(&'a PasteGate);
impl Drop for PasteLease<'_> {
    fn drop(&mut self) {
        self.0 .0.store(false, Ordering::Release);
    }
}
impl PasteGate {
    fn try_acquire(&self) -> Result<PasteLease<'_>, String> {
        self.0
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| PasteLease(self))
            .map_err(|_| "Another ATools paste is already in progress".into())
    }
}
fn global_paste_gate() -> &'static PasteGate {
    static GATE: OnceLock<PasteGate> = OnceLock::new();
    GATE.get_or_init(PasteGate::default)
}

#[derive(Clone)]
struct RuntimeCommit {
    runtime: Arc<Sessions>,
    db: Database,
    session: Arc<Session>,
}
impl RuntimeCommit {
    fn with_session<T>(
        &self,
        action: impl FnOnce(&parking_lot::MutexGuard<'_, bool>) -> Result<T, String>,
    ) -> Result<T, String> {
        // Match Sessions::rotate_bound lock order, then release the store while
        // retaining the short native commit guard.
        let store = self.runtime.store.lock();
        if !store
            .sessions
            .get(&self.session.id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.session))
        {
            return Err("Clipboard session closed or access revoked".into());
        }
        let active = self.session.active.lock();
        drop(store);
        if !*active || super::validate_session(&self.db, &self.session).is_err() {
            return Err("Clipboard session closed or access revoked".into());
        }
        action(&active)
    }
    fn valid(&self) -> bool {
        self.with_session(|_| Ok(())).is_ok()
    }
    fn authorization(&self) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let commit = self.clone();
        Arc::new(move || commit.valid())
    }
    fn write(&self, backend: &dyn ClipboardAccess, content: PreparedContent) -> Result<(), String> {
        self.with_session(|_| write_prepared(backend, content))
    }
    fn paste(&self, host: &dyn PasteHost, target: &ForegroundTarget) -> Result<(), String> {
        self.with_session(|active| {
            host.paste_if_target_matches(target, &|| {
                **active && super::validate_session(&self.db, &self.session).is_ok()
            })
        })
    }
}
impl ClipboardCommit for RuntimeCommit {
    fn valid(&self) -> bool {
        RuntimeCommit::valid(self)
    }
    fn authorization(&self) -> Arc<dyn Fn() -> bool + Send + Sync> {
        RuntimeCommit::authorization(self)
    }
    fn write(&self, backend: &dyn ClipboardAccess, content: PreparedContent) -> Result<(), String> {
        RuntimeCommit::write(self, backend, content)
    }
    fn paste(&self, host: &dyn PasteHost, target: &ForegroundTarget) -> Result<(), String> {
        RuntimeCommit::paste(self, host, target)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ForegroundTarget {
    pub pid: i32,
    pub bundle_id: Option<String>,
}

pub(crate) trait PasteHost: Send + Sync {
    fn prepare_input(&self) -> Result<(), String>;
    fn capture_target(&self) -> Result<ForegroundTarget, String>;
    fn hide_owner_window(&self, owner: &str) -> Result<(), String>;
    fn restore_target(
        &self,
        expected: &ForegroundTarget,
        authorized: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<(), String>;
    fn target_matches(&self, expected: &ForegroundTarget) -> bool;
    /// Must re-check the target immediately before posting a key event.
    fn paste_if_target_matches(
        &self,
        expected: &ForegroundTarget,
        still_authorized: &dyn Fn() -> bool,
    ) -> Result<(), String>;
}

pub(crate) struct SystemPasteHost(tauri::AppHandle);
impl SystemPasteHost {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self(app)
    }
}
pub(crate) fn capture_external_target_before_show() -> Result<(), String> {
    native::capture_external_target_before_show()
}
impl PasteHost for SystemPasteHost {
    fn prepare_input(&self) -> Result<(), String> {
        native::prepare_input()
    }
    fn capture_target(&self) -> Result<ForegroundTarget, String> {
        native::foreground_target()
    }
    fn hide_owner_window(&self, owner: &str) -> Result<(), String> {
        let Some(rest) = owner.strip_prefix("window:") else {
            return Err("Plugin host window is unavailable".into());
        };
        let Some((label, _instance)) = rest.rsplit_once(':') else {
            return Err("Plugin host window is unavailable".into());
        };
        self.0
            .get_webview_window(label)
            .ok_or("Plugin host window is unavailable")?
            .hide()
            .map_err(|_| "Plugin host window could not be hidden".into())
    }
    fn restore_target(
        &self,
        expected: &ForegroundTarget,
        authorized: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<(), String> {
        super::target_activation::restore_target(&self.0, expected, authorized)
    }
    fn target_matches(&self, expected: &ForegroundTarget) -> bool {
        native::live_foreground_target().is_ok_and(|actual| &actual == expected)
    }
    fn paste_if_target_matches(
        &self,
        expected: &ForegroundTarget,
        still_authorized: &dyn Fn() -> bool,
    ) -> Result<(), String> {
        if !self.target_matches(expected) || !still_authorized() {
            return Err("Foreground target changed".into());
        }
        native::paste_command_v()
    }
}

#[cfg(test)]
pub(crate) fn write_content(
    backend: &dyn ClipboardAccess,
    content: ContentPayload,
) -> Result<(), String> {
    write_prepared(backend, prepare_content(content)?)
}

pub(super) fn prepare_content(content: ContentPayload) -> Result<PreparedContent, String> {
    match content {
        ContentPayload::Text(text) => Ok(PreparedContent::Text(text)),
        ContentPayload::Html(html) => Ok(PreparedContent::Html(html)),
        ContentPayload::Image(image) => Ok(PreparedContent::Image(clipboard_image_write::decode(
            &image,
        )?)),
        ContentPayload::Files(paths) => {
            super::copied_files::describe_paths(paths.clone())?;
            Ok(PreparedContent::Files(paths))
        }
    }
}

pub(super) fn write_prepared(
    backend: &dyn ClipboardAccess,
    content: PreparedContent,
) -> Result<(), String> {
    match content {
        PreparedContent::Text(text) => super::clipboard::exact_write(backend, &text),
        PreparedContent::Html(html) => backend
            .write_html(html.html(), html.text())
            .map_err(|_| "Native clipboard HTML write failed".into()),
        PreparedContent::Image(image) => backend
            .write_image(image)
            .map_err(|_| "Native clipboard image write failed".into()),
        PreparedContent::Files(paths) => backend
            .write_files(&paths)
            .map_err(|_| "Native clipboard file write failed".into()),
    }
}

pub(crate) fn write_and_paste(
    backend: &dyn ClipboardAccess,
    host: &dyn PasteHost,
    owner: &str,
    gate: &PasteGate,
    commit: &dyn ClipboardCommit,
    content: PreparedContent,
) -> Result<(), String> {
    // Serialize the full ATools paste transaction without holding any session lock.
    let _lease = gate.try_acquire()?;
    if !commit.valid() {
        return Err("Clipboard session closed or access revoked".into());
    }
    host.prepare_input()?;
    let target = host.capture_target()?;
    if target.pid <= 0 || target.pid == std::process::id() as i32 {
        return Err("No external foreground target".into());
    }
    host.hide_owner_window(owner)?;
    thread::sleep(Duration::from_millis(60));
    if !commit.valid() {
        return Err("Clipboard session closed or access revoked".into());
    }
    host.restore_target(&target, commit.authorization())?;
    if !commit.valid() || !host.target_matches(&target) {
        return Err("Foreground target could not be restored or access was revoked".into());
    }
    commit.write(backend, content)?;
    if !commit.valid() || !host.target_matches(&target) {
        return Err("Foreground target changed or access revoked".into());
    }
    commit.paste(host, &target)
}

#[cfg(test)]
#[path = "clipboard_html_tests.rs"]
mod clipboard_html_tests;

#[cfg(target_os = "macos")]
mod native {
    use super::ForegroundTarget;
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, KeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use objc2_app_kit::NSWorkspace;
    use objc2_core_graphics::{CGPreflightPostEventAccess, CGRequestPostEventAccess};
    use parking_lot::Mutex;
    use std::sync::OnceLock;

    static PRESENTATION_TARGET: OnceLock<Mutex<Option<ForegroundTarget>>> = OnceLock::new();

    pub(super) fn capture_external_target_before_show() -> Result<(), String> {
        let target = current_target()?;
        if target.pid > 0 && target.pid != std::process::id() as i32 {
            *PRESENTATION_TARGET.get_or_init(|| Mutex::new(None)).lock() = Some(target);
        }
        Ok(())
    }

    fn current_target() -> Result<ForegroundTarget, String> {
        let app = NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .ok_or("No foreground application")?;
        Ok(ForegroundTarget {
            pid: app.processIdentifier(),
            bundle_id: app.bundleIdentifier().map(|value| value.to_string()),
        })
    }
    pub(super) fn live_foreground_target() -> Result<ForegroundTarget, String> {
        current_target()
    }

    pub(super) fn prepare_input() -> Result<(), String> {
        if CGPreflightPostEventAccess() || CGRequestPostEventAccess() {
            Ok(())
        } else {
            Err("Keyboard input permission is unavailable".into())
        }
    }
    pub(super) fn foreground_target() -> Result<ForegroundTarget, String> {
        let current = current_target()?;
        if current.pid != std::process::id() as i32 {
            return Ok(current);
        }
        PRESENTATION_TARGET
            .get()
            .and_then(|state| state.lock().clone())
            .ok_or_else(|| "No previously active external application".into())
    }
    pub(super) fn paste_command_v() -> Result<(), String> {
        if !CGPreflightPostEventAccess() {
            return Err("Keyboard input permission is unavailable".into());
        }
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "Keyboard input is unavailable")?;
        let down = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_V, true)
            .map_err(|_| "Keyboard input is unavailable")?;
        down.set_flags(CGEventFlags::CGEventFlagCommand);
        let up = CGEvent::new_keyboard_event(source, KeyCode::ANSI_V, false)
            .map_err(|_| "Keyboard input is unavailable")?;
        up.set_flags(CGEventFlags::CGEventFlagCommand);
        down.post(CGEventTapLocation::HID);
        up.post(CGEventTapLocation::HID);
        Ok(())
    }
}

#[allow(dead_code)]
pub(crate) fn plan_platform_paste_command(
    os: &str,
    wayland_display: Option<&str>,
) -> Option<(&'static str, Vec<&'static str>)> {
    match os {
        "macos" => Some((
            "osascript",
            vec!["-e", "tell application \"System Events\" to keystroke \"v\" using command down"],
        )),
        "linux" if wayland_display.is_some_and(|v| !v.trim().is_empty()) => {
            Some(("wtype", vec!["-M", "ctrl", "-k", "v", "-m", "ctrl"]))
        }
        "linux" => Some(("xdotool", vec!["key", "--clearmodifiers", "ctrl+v"])),
        "windows" => Some((
            "powershell",
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
            ],
        )),
        _ => None,
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use super::{plan_platform_paste_command, ForegroundTarget};
    use parking_lot::Mutex;
    use std::sync::OnceLock;

    static PRESENTATION_TARGET: OnceLock<Mutex<Option<ForegroundTarget>>> = OnceLock::new();

    pub(super) fn prepare_input() -> Result<(), String> {
        let wayland = std::env::var("WAYLAND_DISPLAY").ok();
        plan_platform_paste_command(std::env::consts::OS, wayland.as_deref())
            .map(|_| ())
            .ok_or_else(|| "Keyboard input is unavailable on this platform".into())
    }

    pub(super) fn capture_external_target_before_show() -> Result<(), String> {
        if let Ok(target) = current_target() {
            if target.pid > 0 && target.pid != std::process::id() as i32 {
                *PRESENTATION_TARGET.get_or_init(|| Mutex::new(None)).lock() = Some(target);
            }
        }
        Ok(())
    }

    fn current_target() -> Result<ForegroundTarget, String> {
        #[cfg(target_os = "linux")]
        let cmd = ("xdotool", ["getactivewindow", "getwindowpid"].as_slice());
        #[cfg(target_os = "windows")]
        let cmd = ("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type @' using System; using System.Runtime.InteropServices; public class Win32 { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId); } '@; $p=0; [Win32]::GetWindowThreadProcessId([Win32]::GetForegroundWindow(), [ref]$p) | Out-Null; $p"].as_slice());
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        if let Ok(out) = std::process::Command::new(cmd.0).args(cmd.1).output() {
            if let Ok(pid) = String::from_utf8_lossy(&out.stdout).trim().parse::<i32>() {
                if out.status.success() {
                    return Ok(ForegroundTarget {
                        pid,
                        bundle_id: None,
                    });
                }
            }
        }
        Err("No foreground application".into())
    }

    pub(super) fn live_foreground_target() -> Result<ForegroundTarget, String> {
        current_target()
    }

    pub(super) fn foreground_target() -> Result<ForegroundTarget, String> {
        if let Ok(current) = current_target() {
            if current.pid != std::process::id() as i32 {
                return Ok(current);
            }
        }
        PRESENTATION_TARGET
            .get()
            .and_then(|state| state.lock().clone())
            .ok_or_else(|| "No previously active external application".into())
    }

    pub(super) fn paste_command_v() -> Result<(), String> {
        let wayland = std::env::var("WAYLAND_DISPLAY").ok();
        let (program, args) = plan_platform_paste_command(std::env::consts::OS, wayland.as_deref())
            .ok_or_else(|| "Keyboard input is unavailable on this platform".to_string())?;
        let status = std::process::Command::new(program)
            .args(&args)
            .status()
            .map_err(|_| "Keyboard input command failed to start".to_string())?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| "Keyboard input command failed".into())
    }
}

#[cfg(test)]
mod paste_planner_tests {
    use super::plan_platform_paste_command;

    #[test]
    fn paste_planner_selects_expected_command_for_macos_linux_and_windows() {
        let mac = plan_platform_paste_command("macos", None).unwrap();
        assert_eq!(mac.0, "osascript");
        let linux_wayland = plan_platform_paste_command("linux", Some("wayland-0")).unwrap();
        assert_eq!(linux_wayland.0, "wtype");
        assert_eq!(linux_wayland.1, vec!["-M", "ctrl", "-k", "v", "-m", "ctrl"]);
        let linux_x11 = plan_platform_paste_command("linux", None).unwrap();
        assert_eq!(linux_x11.0, "xdotool");
        assert_eq!(linux_x11.1, vec!["key", "--clearmodifiers", "ctrl+v"]);
        let windows = plan_platform_paste_command("windows", None).unwrap();
        assert_eq!(windows.0, "powershell");
        assert!(windows.1.iter().any(|arg| arg.contains("SendWait('^v')")));
        assert!(plan_platform_paste_command("freebsd", None).is_none());
    }
}
