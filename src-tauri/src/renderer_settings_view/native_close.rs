//! Internal menu/window-close authority: all owned Settings routes, no new renderer command.
use super::{identity, phase::SessionPhase};
use tauri::{AppHandle, Manager};
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NativeCloseTarget {
    pub(crate) id: String,
    label: String,
    origin: String,
    revision: String,
}
pub(crate) enum NativeCloseState {
    Absent,
    Closing,
    Owned(NativeCloseTarget),
    Blocked,
}
fn same_identity(
    target: &NativeCloseTarget,
    id: &str,
    label: &str,
    origin: &str,
    revision: &str,
    bundle_revision: &str,
) -> bool {
    target.id == id
        && target.label == label
        && target.origin == origin
        && target.revision == revision
        && target.revision == bundle_revision
}
fn allowed_url(target: &NativeCloseTarget, parent: &str, url: &tauri::Url) -> bool {
    parent == "main"
        && identity::is_expected_origin(&target.origin, &target.id)
        && identity::is_expected_settings_url(url, &target.id)
}
fn authorized(app: &AppHandle, target: &NativeCloseTarget) -> bool {
    let Ok(runtime) = super::runtime(app) else {
        return false;
    };
    let Ok(session) = runtime.current_for_id(&target.id) else {
        return false;
    };
    let Some(child) = app.get_webview(&target.label) else {
        return false;
    };
    let Ok(url) = child.url() else {
        return false;
    };
    !session.is_revoked()
        && child.label() == target.label
        && same_identity(
            target,
            &session.id,
            &session.label,
            &session.origin,
            &session.bundle_revision,
            session.bundle.revision(),
        )
        && allowed_url(target, child.window().label(), &url)
}
pub(crate) fn capture(app: &AppHandle) -> NativeCloseState {
    let Ok(runtime) = super::runtime(app) else {
        return NativeCloseState::Absent;
    };
    let Ok(current) = runtime.current() else {
        return NativeCloseState::Blocked;
    };
    let Some(session) = current else {
        return if super::snapshot(app)["bundleLoadActive"] == true {
            NativeCloseState::Blocked
        } else {
            NativeCloseState::Absent
        };
    };
    if session.signal().phase == SessionPhase::Closing || session.is_revoked() {
        return NativeCloseState::Closing;
    }
    let target = NativeCloseTarget {
        id: session.id,
        label: session.label,
        origin: session.origin,
        revision: session.bundle_revision,
    };
    if authorized(app, &target) {
        NativeCloseState::Owned(target)
    } else {
        NativeCloseState::Blocked
    }
}
pub(crate) async fn close(app: &AppHandle, target: NativeCloseTarget) -> Result<(), String> {
    if !authorized(app, &target) {
        return Ok(());
    }
    super::cleanup::close_session(app, &target.id, "child-out").await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target() -> NativeCloseTarget {
        let id = "0123456789ab4def8123456789abcdef";
        NativeCloseTarget {
            id: id.into(),
            label: "owned-child".into(),
            origin: format!("atools-settings://{id}.localhost"),
            revision: "revision-one".into(),
        }
    }
    #[test]
    fn native_close_accepts_all_owned_routes_and_rejects_foreign_parent_url() {
        let target = target();
        for route in ["generalSetting", "allCommands", "shortcuts", "localLaunch"] {
            let url = tauri::Url::parse(&format!("{}/index.html#/{route}", target.origin)).unwrap();
            assert!(allowed_url(&target, "main", &url));
            assert!(!allowed_url(&target, "settings", &url));
        }
        assert!(!allowed_url(
            &target,
            "main",
            &tauri::Url::parse("https://example.test/index.html#/generalSetting").unwrap()
        ));
    }
    #[test]
    fn delayed_close_target_cannot_apply_to_reopened_session_or_new_bundle() {
        let target = target();
        assert!(same_identity(
            &target,
            &target.id,
            &target.label,
            &target.origin,
            &target.revision,
            &target.revision
        ));
        assert!(!same_identity(
            &target,
            "new-session",
            &target.label,
            &target.origin,
            &target.revision,
            &target.revision
        ));
        assert!(!same_identity(
            &target,
            &target.id,
            &target.label,
            &target.origin,
            "revision-two",
            "revision-two"
        ));
    }
}
