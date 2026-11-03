use crate::updater::backend::updater_smoke_endpoint_allowed;

#[test]
fn updater_smoke_override_requires_debug_flag_and_loopback_http() {
    assert!(!updater_smoke_endpoint_allowed(
        false,
        true,
        "http://127.0.0.1:4321/latest.json"
    ));
    assert!(!updater_smoke_endpoint_allowed(
        true,
        false,
        "http://127.0.0.1:4321/latest.json"
    ));
    assert!(!updater_smoke_endpoint_allowed(
        true,
        true,
        "https://127.0.0.1:4321/latest.json"
    ));
    assert!(!updater_smoke_endpoint_allowed(
        true,
        true,
        "http://localhost:4321/latest.json"
    ));
    assert!(!updater_smoke_endpoint_allowed(
        true,
        true,
        "http://127.0.0.1.evil:4321/latest.json"
    ));
    assert!(updater_smoke_endpoint_allowed(
        true,
        true,
        "http://127.0.0.1:4321/latest.json"
    ));
}
