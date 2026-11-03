use std::path::PathBuf;

use tauri::utils::config::FrontendDist;

use super::{is_original_config, ORIGINAL_APP_IDENTIFIER, ORIGINAL_FRONTEND_DIST};

#[test]
fn only_the_exact_ztools_renderer_build_config_owns_main_material() {
    let dist = FrontendDist::Directory(PathBuf::from(ORIGINAL_FRONTEND_DIST));
    assert!(is_original_config(
        ORIGINAL_APP_IDENTIFIER,
        false,
        Some(&dist),
        true,
    ));

    let default_svelte_dist = FrontendDist::Directory(PathBuf::from("../dist"));
    assert!(!is_original_config(
        ORIGINAL_APP_IDENTIFIER,
        false,
        Some(&default_svelte_dist),
        true,
    ));
    assert!(!is_original_config(
        ORIGINAL_APP_IDENTIFIER,
        true,
        Some(&dist),
        true,
    ));
    assert!(!is_original_config(
        "dev.atools.renderer-settings-input.0123456789abcdef0123456789abcdef",
        false,
        Some(&dist),
        true,
    ));
    assert!(!is_original_config(
        ORIGINAL_APP_IDENTIFIER,
        false,
        Some(&dist),
        false,
    ));
    assert!(!is_original_config(
        ORIGINAL_APP_IDENTIFIER,
        false,
        Some(&FrontendDist::Url(
            tauri::Url::parse("https://example.invalid").unwrap()
        )),
        true,
    ));
}

#[test]
fn trusted_frontend_path_matches_the_renderer_build_config() {
    let configured: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.ztools-renderer.conf.json")).unwrap();
    assert_eq!(
        configured["build"]["frontendDist"].as_str(),
        Some(ORIGINAL_FRONTEND_DIST)
    );
    assert!(configured["build"]["devUrl"].is_null());
}

#[cfg(feature = "legacy-node-smoke")]
#[test]
fn fixture_identifier_requires_the_exact_settings_input_prefix_and_uuid() {
    use super::valid_run_id;

    assert!(valid_run_id("0123456789abcdef0123456789abcdef"));
    assert!(!valid_run_id("0123456789abcdef0123456789abcdeg"));
    assert!(!valid_run_id("0123456789ABCDEF0123456789ABCDEF"));
    assert!(!valid_run_id("0123456789abcdef"));
}
