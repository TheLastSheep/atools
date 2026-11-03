use super::super::{
    identity::{is_expected_origin, is_expected_settings_url},
    phase::SessionPhase,
};

const ID: &str = "00000000000040008000000000000001";

#[test]
fn session_identity_is_a_version_four_uuid_bound_to_its_private_origin() {
    let origin = format!("atools-settings://{ID}.localhost");
    assert!(is_expected_origin(&origin, ID));
    assert!(!is_expected_origin("atools-settings://wrong.localhost", ID));
    assert!(!is_expected_origin(
        "atools-settings://00000000000010008000000000000001.localhost",
        "00000000000010008000000000000001"
    ));
}

#[test]
fn navigation_requires_the_session_index_and_exact_general_hash_route() {
    let allowed = tauri::Url::parse(&format!(
        "atools-settings://{ID}.localhost/index.html#/generalSetting"
    ))
    .unwrap();
    assert!(is_expected_settings_url(&allowed, ID));

    for url in [
        format!("atools-settings://{ID}.localhost/other.html#/generalSetting"),
        format!("atools-settings://{ID}.localhost/index.html#/plugins"),
        format!("atools-settings://{ID}.localhost/index.html?debug=1#/generalSetting"),
        format!("https://{ID}.localhost/index.html#/generalSetting"),
    ] {
        assert!(!is_expected_settings_url(
            &tauri::Url::parse(&url).unwrap(),
            ID
        ));
    }
}

#[test]
fn navigation_accepts_only_exact_local_launch_route_and_canonical_timestamp() {
    for fragment in [
        "/localLaunch",
        "/localLaunch?_t=1",
        "/localLaunch?_t=1700000000000",
        "/localLaunch?_t=9007199254740991",
    ] {
        let url = tauri::Url::parse(&format!(
            "atools-settings://{ID}.localhost/index.html#{fragment}"
        ))
        .unwrap();
        assert!(is_expected_settings_url(&url, ID), "rejected {fragment}");
        assert!(super::super::identity::is_local_launch_settings_url(
            &url, ID
        ));
    }

    for fragment in [
        "/localLaunch?tab=files",
        "/localLaunch?_t=0",
        "/localLaunch?_t=01",
        "/localLaunch?_t=1x",
        "/localLaunch?_t=12345678901234567",
        "/localLaunch?_t=9007199254740992",
        "/generalSetting?_t=1",
    ] {
        let url = tauri::Url::parse(&format!(
            "atools-settings://{ID}.localhost/index.html#{fragment}"
        ))
        .unwrap();
        assert!(!is_expected_settings_url(&url, ID), "accepted {fragment}");
        assert!(!super::super::identity::is_local_launch_settings_url(
            &url, ID
        ));
    }
}

#[test]
fn lifecycle_phase_names_are_stable() {
    assert_eq!(SessionPhase::Opening.as_str(), "opening");
    assert_eq!(SessionPhase::Open.as_str(), "open");
    assert_eq!(SessionPhase::Closing.as_str(), "closing");
}
