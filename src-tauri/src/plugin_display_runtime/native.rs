//! One live main-thread metadata read per request. No observer, tap, timer or cache.
use super::sessions::Session;
use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

pub(super) async fn snapshot(app: &AppHandle, session: Arc<Session>) -> Result<Value, String> {
    let db = app.state::<crate::state::AppState>().db.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    let cancelled = Arc::new(AtomicBool::new(false));
    struct Cancel(Arc<AtomicBool>);
    impl Drop for Cancel {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    let _cancel = Cancel(cancelled.clone());
    let deadline = Instant::now() + Duration::from_secs(6);
    app.run_on_main_thread(move || {
        if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
            return;
        }
        let active = session.active.lock();
        let result = if !*active || session.document.as_ref().is_some_and(|d| !d.is_active()) {
            Err("Display session closed".into())
        } else {
            super::validate_session(&db, &session).and_then(|_| platform_snapshot())
        };
        // A timed-out waiter never receives a delayed observation.
        if !cancelled.load(Ordering::Acquire) && Instant::now() < deadline {
            let _ = send.send(result);
        }
    })
    .map_err(|_| "Display main-thread observation unavailable")?;
    tokio::time::timeout(Duration::from_secs(6), receive)
        .await
        .map_err(|_| "Display main-thread observation deadline")?
        .map_err(|_| "Display main-thread observation interrupted")?
}
#[cfg(not(target_os = "macos"))]
fn platform_snapshot() -> Result<Value, String> {
    Err("Native display metadata is unsupported on this platform".into())
}

#[cfg(target_os = "macos")]
fn platform_snapshot() -> Result<Value, String> {
    use super::geometry::{top_left_point, top_left_rect, Point, Rect};
    use core_graphics::display::CGDisplay;
    use objc2::{msg_send, MainThreadMarker};
    use objc2_app_kit::{NSEvent, NSScreen};
    use objc2_foundation::NSString;
    use serde_json::json;
    let marker = MainThreadMarker::new().ok_or("Display observation requires the main thread")?;
    objc2::rc::autoreleasepool(|_| {
        let screens = NSScreen::screens(marker);
        if screens.is_empty() || screens.len() > 32 {
            return Err("Native display count exceeds supported bounds".into());
        }
        let primary_id = CGDisplay::main().id;
        let key = NSString::from_str("NSScreenNumber");
        let mut entries = Vec::with_capacity(screens.len());
        let mut ids = std::collections::HashSet::new();
        for screen in &screens {
            let description = screen.deviceDescription();
            let number = description
                .objectForKey(&key)
                .ok_or("Native display identity unavailable")?;
            // AppKit specifies NSScreenNumber as an NSNumber containing CGDirectDisplayID.
            let id: u32 = unsafe { msg_send![&*number, unsignedIntValue] };
            if id == 0 || !ids.insert(id) {
                return Err("Native display identity is ambiguous".into());
            }
            let frame = screen.frame();
            let work = screen.visibleFrame();
            let rect = |f: objc2_foundation::NSRect| Rect {
                x: f.origin.x,
                y: f.origin.y,
                width: f.size.width,
                height: f.size.height,
            };
            let bounds = rect(frame).validate()?;
            let work = rect(work).validate()?;
            let scale = screen.backingScaleFactor();
            let display = CGDisplay::new(id);
            let rotation = display.rotation();
            let label = screen.localizedName().to_string();
            if !scale.is_finite() || scale <= 0.0 || !rotation.is_finite() || label.len() > 1024 {
                return Err("Native display metadata exceeds supported bounds".into());
            }
            entries.push((
                id,
                bounds,
                work,
                scale,
                rotation,
                display.is_builtin(),
                label,
            ));
        }
        let primary = entries
            .iter()
            .find(|(id, ..)| *id == primary_id)
            .ok_or("Primary native display is unavailable")?;
        let top = primary.1.y + primary.1.height;
        let mouse = NSEvent::mouseLocation();
        let cursor = top_left_point(
            Point {
                x: mouse.x,
                y: mouse.y,
            },
            top,
        )?;
        let mut displays = Vec::with_capacity(entries.len());
        for (id, bounds, work, scale, rotation, internal, label) in entries {
            let bounds = top_left_rect(bounds, top)?;
            let work = top_left_rect(work, top)?;
            displays.push(json!({"id":id,"bounds":bounds,"workArea":work,"size":bounds.size(),
                "workAreaSize":work.size(),"scaleFactor":scale,"rotation":rotation,"internal":internal,"label":label}));
        }
        let result = json!({"schemaVersion":1,"platform":"darwin","primaryId":primary_id,"cursor":cursor,"displays":displays});
        if serde_json::to_vec(&json!({"ok":true,"result":&result}))
            .map_err(|_| "Display encoding failed")?
            .len()
            > 64 * 1024
        {
            return Err("Native display snapshot exceeds 64 KiB".into());
        }
        Ok(result)
    })
}
