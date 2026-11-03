//! Bounded experimental policy evidence. No ordinary-build observer is installed.
use super::{navigation_observer, navigation_policy, registry, require_enabled};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{sync::Arc, time::Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

struct Probe {
    started: Instant,
    state: Mutex<State>,
    revoke: bool,
}
#[derive(Default)]
struct State {
    installed: bool,
    events: Vec<Value>,
    dropped: usize,
}

fn mode() -> Result<Option<bool>, String> {
    let args: Vec<_> = std::env::args().collect();
    let observe = args
        .iter()
        .any(|arg| arg == "--atools-page-navigation-observe");
    let revoke = args
        .iter()
        .any(|arg| arg == "--atools-page-navigation-revoke");
    if observe && revoke {
        return Err("Choose one native page navigation mode".into());
    }
    if !observe && !revoke {
        return Ok(None);
    }
    if std::env::var("ATOOLS_PAGE_NAVIGATION_ACCEPTANCE").as_deref() != Ok("true") {
        return Err("Native page navigation requires its explicit isolated fixture".into());
    }
    Ok(Some(revoke))
}

pub(crate) async fn ensure(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let Some(revoke) = mode()? else {
        return Ok(());
    };
    require_enabled(app)?;
    super::parent_origin(app, window.label())?;
    if app.try_state::<Arc<Probe>>().is_none() {
        app.manage(Arc::new(Probe {
            started: Instant::now(),
            state: Mutex::new(State::default()),
            revoke,
        }));
    }
    let probe = app.state::<Arc<Probe>>().inner().clone();
    let observed_app = app.clone();
    let label = window.label().to_string();
    navigation_observer::ensure(
        window,
        Arc::new(move |navigation| {
            observe(&observed_app, &label, &probe, navigation);
        }),
    )
    .await?;
    app.state::<Arc<Probe>>().state.lock().installed = true;
    Ok(())
}

fn observe(
    app: &AppHandle,
    window: &str,
    probe: &Probe,
    navigation: navigation_observer::FrameNavigation,
) {
    let frame = navigation.target_frame.as_ref();
    let origin = frame.and_then(navigation_policy::page_frame_origin);
    let registry = registry(app);
    let active = origin
        .as_deref()
        .and_then(|origin| registry.for_origin(origin, window));
    let active_before = active.is_some();
    let id = active
        .as_ref()
        .map(|document| document.binding.id().to_owned());
    // No await, emitted event, filesystem read or delegate Allow can precede
    // this shared-binding revocation. Cleanup may follow asynchronously.
    let removed = if probe.revoke && active_before {
        registry.close_native_frame(window, origin.as_deref().unwrap())
    } else {
        Vec::new()
    };
    {
        let mut state = probe.state.lock();
        let sequence = state.events.len() + state.dropped + 1;
        if state.events.len() < 128 {
            state.events.push(json!({"sequence":sequence,"elapsedMicros":probe.started.elapsed().as_micros(),
                "requestedKind":navigation_policy::request_kind(navigation.requested_url.as_deref()),
                "targetRequestKind":navigation_policy::request_kind(frame.and_then(|frame|frame.request_url.as_deref())),
                "targetUrlOversized":frame.map(|frame|frame.request_url_oversized),
                "targetIsMainFrame":frame.map(|frame|frame.is_main_frame),"targetOriginMatches":origin.is_some(),
                "matchedPageDocumentId":id,"activeBefore":active_before,"revoked":!removed.is_empty(),
                "beforeDelegateForward":true}));
        } else {
            state.dropped += 1;
        }
    }
    for id in removed {
        let _ = app.emit_to(
            window,
            "plugin-page-revoked",
            json!({"pageDocumentId":id,"reason":"navigation"}),
        );
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            super::commands::close_document(&app, &id).await;
        });
    }
}

#[tauri::command]
pub(crate) fn native_page_navigation_snapshot(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Value, String> {
    require_enabled(&app)?;
    super::parent_origin(&app, window.label())?;
    let mode = mode()?.ok_or("Native navigation fixture not selected")?;
    let Some(probe) = app.try_state::<Arc<Probe>>() else {
        return Ok(
            json!({"enabled":true,"installed":false,"policy":if mode {"revoke"}else{"observe"},"events":[],"droppedEvents":0}),
        );
    };
    let state = probe.state.lock();
    Ok(
        json!({"enabled":true,"installed":state.installed,"policy":if probe.revoke {"revoke"}else{"observe"},
        "events":state.events,"droppedEvents":state.dropped,
        "scope":"Copied native target frame request and origin at the pre-Wry navigation policy callback; bounded categories only"}),
    )
}
