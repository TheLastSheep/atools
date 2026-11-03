use tauri::{Webview, Wry};

pub(super) fn inject(
    webview: &Webview<Wry>,
    harness: &super::protocol::Harness,
) -> Result<(), &'static str> {
    let token = serde_json::to_string(harness.token())
        .map_err(|_| "launch-return-renderer-probe-not-ready")?;
    let first_path = serde_json::to_string(harness.first_path())
        .map_err(|_| "launch-return-renderer-probe-not-ready")?;
    let second_path = serde_json::to_string(harness.second_path())
        .map_err(|_| "launch-return-renderer-probe-not-ready")?;
    let target_kind = serde_json::to_string(harness.profile().launch_target_kind.as_str())
        .map_err(|_| "launch-return-renderer-probe-not-ready")?;
    let registration_source = serde_json::to_string(harness.profile().registration_source.as_str())
        .map_err(|_| "launch-return-renderer-probe-not-ready")?;
    let script = include_str!("probe.js")
        .replace("__ATOOLS_LAUNCH_RETURN_TOKEN__", &token)
        .replace("__ATOOLS_LAUNCH_RETURN_FIRST_PATH__", &first_path)
        .replace("__ATOOLS_LAUNCH_RETURN_SECOND_PATH__", &second_path)
        .replace("__ATOOLS_LAUNCH_RETURN_TARGET_KIND__", &target_kind)
        .replace(
            "__ATOOLS_LAUNCH_RETURN_REGISTRATION_SOURCE__",
            &registration_source,
        );
    webview
        .eval(&script)
        .map_err(|_| "launch-return-renderer-probe-not-ready")
}
