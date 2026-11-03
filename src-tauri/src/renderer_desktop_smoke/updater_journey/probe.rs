pub(super) fn install(token: &str) -> String {
    include_str!("probe.js").replace(
        "\"__UPDATER_NATIVE_TOKEN__\"",
        &serde_json::to_string(token).expect("string serialization"),
    )
}
pub(super) fn run(stage: &str) -> String {
    format!(
        "void window.__ATOOLS_UPDATER_NATIVE_PROBE__.run({})",
        serde_json::to_string(stage).expect("string serialization")
    )
}
