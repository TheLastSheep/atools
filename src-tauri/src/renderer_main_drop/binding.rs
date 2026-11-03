use super::*;
use tauri::{
    webview::{PageLoadEvent, PageLoadPayload},
    DragDropEvent, WebviewEvent,
};
pub(crate) fn prepare(app: &AppHandle) {
    if source_enabled(app) && runtime(app).is_none() {
        app.manage(Arc::new(Runtime {
            state: Mutex::new(state::State::default()),
            delivery: Mutex::new(()),
            #[cfg(test)]
            revoke_attempt: Mutex::new(None),
        }));
    }
}
pub(crate) fn bind_main(webview: &Webview<Wry>) -> Result<(), String> {
    let app = webview.app_handle();
    if !source_enabled(app) {
        return Ok(());
    }
    if webview.label() != "main" || webview.window().label() != "main" {
        return Err(REJECTED.into());
    }
    let r = runtime(app).ok_or(REJECTED)?;
    let binding = uuid::Uuid::new_v4().simple().to_string();
    {
        let _delivery = r.delivery.lock();
        let mut s = r.state.lock();
        if !s.binding.is_empty() && !s.stopped {
            return Err(REJECTED.into());
        }
        if s.stopped && s.running {
            return Err(REJECTED.into());
        }
        if s.stopped {
            *s = state::State::default();
        }
        s.rotate();
        s.binding = binding.clone();
    }
    let app = app.clone();
    webview.on_webview_event(move |event| {
        if let WebviewEvent::DragDrop(event) = event {
            handle(&app, &binding, event)
        }
    });
    Ok(())
}
pub(crate) fn on_page_load(view: &Webview<Wry>, payload: &PageLoadPayload<'_>) {
    if view.label() != "main" || view.window().label() != "main" {
        return;
    }
    let app = view.app_handle();
    let Some(r) = runtime(app) else { return };
    let delivery = r.delivery.lock();
    let mut s = r.state.lock();
    if payload.event() == PageLoadEvent::Started {
        s.rotate();
        s.document_live = false
    } else {
        s.document_live = trusted(payload.url());
    }
    drop(s);
    drop(delivery);
    #[cfg(feature = "legacy-node-smoke")]
    if payload.event() == PageLoadEvent::Finished {
        crate::renderer_desktop_smoke::main_drop_probe::install_reader(app);
    }
}
pub(super) fn handle(app: &AppHandle, binding: &str, event: &DragDropEvent) {
    if !current(app) || settings_present(app) {
        return;
    }
    let Some(r) = runtime(app) else { return };
    let scale = match crate::window::main_window(app).and_then(|w| w.scale_factor()) {
        Ok(v) => v,
        Err(_) => return,
    };
    let _delivery = r.delivery.lock();
    let mut s = r.state.lock();
    if s.binding != binding || !s.enabled() {
        return;
    }
    let action = dispatch(&mut s, event, scale, cfg!(target_os = "macos"));
    drop(s);
    for notice in action.notices {
        emit(app, Some(notice));
    }
    drop(_delivery);
    if let Some(job) = action.job {
        work::start(app.clone(), r, job);
    }
}
#[derive(Default)]
struct Action {
    notices: Vec<Value>,
    job: Option<state::Job>,
}
fn dispatch(s: &mut state::State, event: &DragDropEvent, scale: f64, mac: bool) -> Action {
    let mut action = Action::default();
    if !s.enabled() {
        return action;
    }
    let hit = |s: &state::State, x: f64, y: f64| {
        s.lease.as_ref().is_some_and(|l| {
            physical_point(x, y, scale, mac).is_some_and(|(x, y)| l.rect.hit(x, y, scale))
        })
    };
    match event {
        DragDropEvent::Enter { position, .. } | DragDropEvent::Over { position } => {
            let inside = hit(s, position.x, position.y);
            action.notices.extend(s.hover(inside));
        }
        DragDropEvent::Leave => action.notices.extend(s.hover(false)),
        DragDropEvent::Drop { paths, position } => {
            let inside = hit(s, position.x, position.y);
            action.notices.extend(s.hover(false));
            if inside {
                match metadata::validate(paths) {
                    Ok(paths) => action.job = s.accept(paths),
                    Err(()) => {
                        s.cancel();
                        action
                            .notices
                            .extend(s.notice(Payload::Error(protocol::ErrorCode::InvalidBatch)));
                    }
                }
            }
        }
        _ => {}
    }
    action
}
// Locked Wry0.55.1 wkwebview/drag_drop.rs40-42,57-59,85-87 emits truncated
// AppKit logical points; runtime-wry2.11.2 labels them PhysicalPosition without scale.
// Normalize only this Main boundary. Precision already lost upstream is not recoverable.
fn physical_point(x: f64, y: f64, scale: f64, mac: bool) -> Option<(f64, f64)> {
    if !scale.is_finite() || scale <= 0.0 || !x.is_finite() || !y.is_finite() {
        None
    } else {
        let point = if mac { (x * scale, y * scale) } else { (x, y) };
        (point.0.is_finite() && point.1.is_finite()).then_some(point)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn live() -> state::State {
        let mut s = state::State::default();
        s.document_live = true;
        let c = s.context.clone();
        s.set(
            &c,
            None,
            Some(protocol::Rect {
                x: 10.,
                y: 20.,
                width: 100.,
                height: 40.,
            }),
        )
        .unwrap();
        s
    }
    fn over(x: f64, y: f64) -> DragDropEvent {
        DragDropEvent::Over {
            position: tauri::PhysicalPosition::new(x, y),
        }
    }
    #[test]
    fn actual_handler_uses_css_region_and_only_hover_transitions() {
        let mut s = live();
        assert_eq!(
            dispatch(&mut s, &over(22., 42.), 2., false).notices.len(),
            1
        );
        assert!(dispatch(&mut s, &over(30., 50.), 2., false)
            .notices
            .is_empty());
        assert_eq!(
            dispatch(&mut s, &over(220., 50.), 2., false).notices[0]["hovered"],
            false
        );
    }
    #[test]
    fn actual_drop_ends_hover_then_starts_one_worker_and_leave_keeps_result_valid() {
        let mut s = live();
        dispatch(&mut s, &over(22., 42.), 2., false);
        let drop = DragDropEvent::Drop {
            paths: vec!["/one".into()],
            position: tauri::PhysicalPosition::new(22., 42.),
        };
        let action = dispatch(&mut s, &drop, 2., false);
        assert_eq!(action.notices[0]["hovered"], false);
        let job = action.job.unwrap();
        assert!(dispatch(&mut s, &DragDropEvent::Leave, 2., false)
            .job
            .is_none());
        assert!(s.matches(&job));
    }
    #[test]
    fn invalid_latest_drop_cancels_older_result_without_releasing_running_work() {
        let mut s = live();
        let old = s.accept(vec!["/one".into()]).unwrap();
        let event = DragDropEvent::Drop {
            paths: vec!["relative".into()],
            position: tauri::PhysicalPosition::new(22., 42.),
        };
        let action = dispatch(&mut s, &event, 2., false);
        assert_eq!(action.notices[0]["code"], "INVALID_BATCH");
        assert!(!s.matches(&old));
        assert!(s.running);
    }
    #[test]
    fn mac_actual_raw_point_must_hit_at_css_11_21_not_half_of_it() {
        let mut s = live();
        let action = dispatch(&mut s, &over(11., 21.), 2., true);
        assert_eq!(action.notices.len(), 1);
        assert_eq!(action.notices[0]["hovered"], true);
    }
    #[test]
    fn nonmac_physical_coordinates_are_not_scaled_and_invalid_values_fail_closed() {
        assert_eq!(physical_point(22., 42., 2., false), Some((22., 42.)));
        let mut s = live();
        assert_eq!(
            dispatch(&mut s, &over(22., 42.), 2., false).notices[0]["hovered"],
            true
        );
        for scale in [0., -1., f64::NAN, f64::INFINITY] {
            assert!(physical_point(11., 21., scale, true).is_none());
        }
        assert!(physical_point(f64::MAX, 21., 2., true).is_none());
    }
}
