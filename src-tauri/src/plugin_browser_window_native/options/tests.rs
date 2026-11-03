use super::WindowSpec;
use serde_json::{json, Value};

const LABEL: &str = "atools-native-browser-0123456789abcdef0123456789abcdef";

fn spec(options: Value) -> Result<WindowSpec, String> {
    WindowSpec::from_options(LABEL.into(), &options)
}

#[test]
fn allows_negative_positions_and_large_native_dimensions() {
    let parsed = spec(json!({"x": -2048, "y": -120, "width": 4096, "height": 2160})).unwrap();
    assert_eq!(parsed.x, Some(-2048.0));
    assert_eq!(parsed.width, 4096.0);
}

#[test]
fn treats_zero_maximum_as_unbounded() {
    let parsed = spec(json!({"maxWidth": 0, "maxHeight": 0})).unwrap();
    assert_eq!(parsed.max_width, None);
    assert_eq!(parsed.max_height, None);
}

#[test]
fn rejects_out_of_budget_geometry_and_renderer_preferences_at_the_native_boundary() {
    assert!(spec(json!({"x": -1_000_001})).is_err());
    assert!(spec(json!({"width": 16_385})).is_err());
    assert!(spec(json!({"webPreferences": {"nodeIntegration": true}}))
        .unwrap_err()
        .contains("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED"));
}

#[test]
fn background_throttling_defaults_to_the_webview_policy_and_requires_a_boolean() {
    assert!(spec(json!({})).unwrap().background_throttling);
    assert!(
        spec(json!({"backgroundThrottling": true}))
            .unwrap()
            .background_throttling
    );
    assert!(spec(json!({"backgroundThrottling": "false"})).is_err());
    assert!(
        spec(json!({"webPreferences": {"backgroundThrottling": false}}))
            .unwrap_err()
            .contains("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED")
    );
}

#[test]
fn explicit_background_throttling_disable_requires_a_supported_native_platform() {
    let supported = super::super::background_throttling::current_platform_supports();
    let result = spec(json!({"backgroundThrottling": false}));
    eprintln!(
        "backgroundThrottling probe: native_supported={supported}, explicit_false_parser={}",
        if result.is_ok() {
            "accepted"
        } else {
            "rejected"
        }
    );
    if supported {
        assert!(!result.unwrap().background_throttling);
    } else {
        assert!(result
            .unwrap_err()
            .contains("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED"));
    }
}

#[test]
fn rejects_conflicting_size_constraints_before_native_creation() {
    assert!(spec(json!({"minWidth": 900, "maxWidth": 600})).is_err());
}

#[test]
fn original_snipaste_native_options_survive_host_preload_separation() {
    let full_original = json!({
        "title": "Snipaste Paster #1",
        "x": -120,
        "y": 60,
        "width": 320,
        "height": 220,
        "useContentSize": true,
        "frame": false,
        "transparent": true,
        "alwaysOnTop": true,
        "resizable": true,
        "minimizable": false,
        "maximizable": false,
        "fullscreenable": false,
        "hasShadow": true,
        "skipTaskbar": true,
        "backgroundColor": "#00000000",
        "webPreferences": {"preload": "preload/services.cjs"}
    });
    assert!(spec(full_original.clone())
        .unwrap_err()
        .contains("webPreferences"));

    let host_stripped = json!({
        "title": "Snipaste Paster #1",
        "x": -120,
        "y": 60,
        "width": 320,
        "height": 220,
        "useContentSize": true,
        "frame": false,
        "transparent": true,
        "alwaysOnTop": true,
        "resizable": true,
        "minimizable": false,
        "maximizable": false,
        "fullscreenable": false,
        "hasShadow": true,
        "skipTaskbar": true,
        "backgroundColor": "#00000000"
    });
    #[cfg(target_os = "macos")]
    {
        let parsed = spec(host_stripped).unwrap();
        assert_eq!(parsed.width, 320.0);
        assert_eq!(parsed.height, 220.0);
        assert_eq!(parsed.x, Some(-120.0));
        assert_eq!(parsed.y, Some(60.0));
        assert!(parsed.use_content_size);
        assert!(!parsed.fullscreenable);
        assert!(!parsed.frame);
        assert!(parsed.transparent);
        assert!(parsed.always_on_top);
        assert!(parsed.resizable);
        assert!(parsed.has_shadow);
        assert!(parsed.skip_taskbar);
        assert_eq!(parsed.background_color, Some([0, 0, 0, 0]));
    }
    #[cfg(not(target_os = "macos"))]
    assert!(spec(host_stripped)
        .unwrap_err()
        .contains("fullscreenable=false"));
}

#[test]
fn parses_original_snipaste_fullscreen_overlay_options() {
    let full_original = json!({
        "title": "Snipaste Overlay",
        "x": -1920,
        "y": 0,
        "width": 1920,
        "height": 1080,
        "useContentSize": true,
        "frame": false,
        "transparent": true,
        "backgroundColor": "#00000000",
        "hasShadow": false,
        "alwaysOnTop": true,
        "skipTaskbar": true,
        "resizable": false,
        "minimizable": false,
        "maximizable": false,
        "fullscreenable": false,
        "webPreferences": {"preload": "preload/services.cjs"}
    });
    assert!(spec(full_original).unwrap_err().contains("webPreferences"));

    let host_stripped = json!({
        "title": "Snipaste Overlay",
        "x": -1920,
        "y": 0,
        "width": 1920,
        "height": 1080,
        "useContentSize": true,
        "frame": false,
        "transparent": true,
        "backgroundColor": "#00000000",
        "hasShadow": false,
        "alwaysOnTop": true,
        "skipTaskbar": true,
        "resizable": false,
        "minimizable": false,
        "maximizable": false,
        "fullscreenable": false
    });
    #[cfg(target_os = "macos")]
    {
        let parsed = spec(host_stripped).unwrap();
        assert_eq!(parsed.width, 1920.0);
        assert_eq!(parsed.height, 1080.0);
        assert_eq!(parsed.x, Some(-1920.0));
        assert!(parsed.use_content_size);
        assert!(!parsed.frame);
        assert!(parsed.transparent);
        assert_eq!(parsed.background_color, Some([0, 0, 0, 0]));
        assert!(!parsed.has_shadow);
        assert!(parsed.always_on_top);
        assert!(parsed.skip_taskbar);
        assert!(!parsed.resizable);
        assert!(!parsed.minimizable);
        assert!(!parsed.maximizable);
        assert!(!parsed.fullscreenable);
    }
    #[cfg(not(target_os = "macos"))]
    assert!(spec(host_stripped)
        .unwrap_err()
        .contains("fullscreenable=false"));
}

#[test]
fn parses_electron_content_size_and_fullscreenable_aliases_strictly() {
    let defaults = spec(json!({})).unwrap();
    assert!(!defaults.use_content_size);
    assert!(defaults.fullscreenable);

    let parsed = spec(json!({"useContentSize": true, "fullScreenable": false, "frame": false}));
    #[cfg(target_os = "macos")]
    {
        let parsed = parsed.unwrap();
        assert!(parsed.use_content_size);
        assert!(!parsed.fullscreenable);
    }
    #[cfg(not(target_os = "macos"))]
    assert!(parsed.unwrap_err().contains("fullscreenable=false"));

    assert!(spec(json!({"useContentSize": "true"})).is_err());
    assert!(spec(json!({"fullscreenable": 0})).is_err());
    #[cfg(target_os = "macos")]
    assert!(spec(json!({"fullscreen": true, "fullscreenable": false})).is_err());
}

#[test]
fn supports_only_strict_hex_background_colors() {
    assert_eq!(
        spec(json!({"backgroundColor": "#1020fF"}))
            .unwrap()
            .background_color,
        Some([16, 32, 255, 255])
    );
    assert_eq!(
        spec(json!({"backgroundColor": "#1020fF80"}))
            .unwrap()
            .background_color,
        Some([16, 32, 255, 128])
    );
    assert!(spec(json!({"backgroundColor": "red"}))
        .unwrap_err()
        .contains("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED"));
    assert!(spec(json!({"backgroundColor": "#12345é"}))
        .unwrap_err()
        .contains("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED"));
    assert!(spec(json!({"backgroundColor": 0}))
        .unwrap_err()
        .contains("ERR_ATOOLS_NATIVE_WINDOW_INVALID_OPTIONS"));
}

#[test]
fn accepts_constraints_in_each_constructor_size_basis() {
    assert!(spec(json!({"minWidth": 240})).is_ok());
    assert!(spec(json!({"frame": false, "minWidth": 240})).is_ok());
    assert!(spec(json!({"useContentSize": true, "minWidth": 240})).is_ok());
    assert!(spec(json!({"frame": false, "useContentSize": true, "minWidth": 240})).is_ok());
}

#[test]
fn rejects_initial_sizes_outside_constraints_in_declared_basis() {
    assert!(spec(json!({"width": 220, "minWidth": 240})).is_err());
    assert!(spec(json!({"useContentSize": true, "width": 220, "minWidth": 240})).is_err());
    assert!(spec(json!({"height": 500, "maxHeight": 400})).is_err());
}
