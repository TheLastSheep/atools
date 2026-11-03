pub(super) fn install(token: &str) -> String {
    include_str!("probe.js").replace(
        "\"__UPDATER_ABOUT_NATIVE_TOKEN__\"",
        &serde_json::to_string(token).expect("token serialization"),
    )
}
pub(super) fn run(stage: &str) -> String {
    format!(
        "void window.__ATOOLS_UPDATER_ABOUT_NATIVE_PROBE__.run({})",
        serde_json::to_string(stage).expect("stage serialization")
    )
}
pub(super) fn action(action: &str) -> Result<String, String> {
    if !matches!(action, "openSettings" | "closeSettings") {
        return Err("about-action-rejected".into());
    }
    Ok(format!(
        "void window.__ATOOLS_UPDATER_ABOUT_NATIVE_PROBE__.{action}()"
    ))
}
