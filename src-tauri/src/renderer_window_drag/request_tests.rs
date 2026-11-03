use super::{
    is_main_caller, logical_position, logical_size, main_local_root_url, validate_position,
    validate_window_size, Position, Request, WindowSize, INVALID_GEOMETRY,
};
use serde_json::json;
use tauri::{PhysicalPosition, PhysicalSize};

#[test]
fn request_schema_is_tagged_and_rejects_unknown_fields_or_operations() {
    assert_eq!(
        serde_json::from_value::<Request>(json!({"operation":"position"})).unwrap(),
        Request::Position {}
    );
    assert_eq!(
        serde_json::from_value::<Request>(json!({"operation":"lock","locked":true})).unwrap(),
        Request::Lock { locked: true }
    );
    assert_eq!(
        serde_json::from_value::<Request>(json!({"operation":"move","x":-20.5,"y":8.0})).unwrap(),
        Request::Move { x: -20.5, y: 8.0 }
    );

    for invalid in [
        json!({"operation":"position","x":1}),
        json!({"operation":"lock","locked":false,"extra":true}),
        json!({"operation":"move","x":0,"y":0,"window":"other"}),
        json!({"operation":"resize","width":300,"height":200}),
        json!({"locked":true}),
    ] {
        assert!(serde_json::from_value::<Request>(invalid).is_err());
    }
}

#[test]
fn physical_position_conversion_keeps_negative_desktop_coordinates() {
    let position = logical_position(PhysicalPosition::new(-1800, -120), 1.5).unwrap();
    assert_eq!(
        position,
        Position {
            x: -1200.0,
            y: -80.0,
        }
    );
}

#[test]
fn requested_coordinates_require_finite_values_and_physical_representability() {
    assert_eq!(
        validate_position(-1200.5, -45.25, 1.5).unwrap(),
        Position {
            x: -1200.5,
            y: -45.25,
        }
    );
    assert_eq!(validate_position(f64::NAN, 0.0, 1.0), Err(INVALID_GEOMETRY));
    assert_eq!(
        validate_position(f64::INFINITY, 0.0, 1.0),
        Err(INVALID_GEOMETRY)
    );
    assert_eq!(
        validate_position(f64::from(i32::MAX) + 1.0, 0.0, 1.0),
        Err(INVALID_GEOMETRY)
    );
    assert_eq!(validate_position(0.0, 1.0, f64::NAN), Err(INVALID_GEOMETRY));
    assert_eq!(validate_position(0.0, 1.0, 0.0), Err(INVALID_GEOMETRY));
}

#[test]
fn logical_size_conversion_rejects_zero_or_unrepresentable_dimensions() {
    assert_eq!(
        logical_size(PhysicalSize::new(1000, 600), 2.0).unwrap(),
        WindowSize {
            width: 500.0,
            height: 300.0,
        }
    );
    assert_eq!(
        logical_size(PhysicalSize::new(0, 600), 2.0),
        Err(INVALID_GEOMETRY)
    );
    assert_eq!(
        logical_size(PhysicalSize::new(1000, 600), f64::INFINITY),
        Err(INVALID_GEOMETRY)
    );
    assert_eq!(
        validate_window_size(
            WindowSize {
                width: f64::MAX,
                height: 1.0,
            },
            2.0
        ),
        Err(INVALID_GEOMETRY)
    );
}

#[test]
fn caller_origin_must_be_the_local_main_document_root() {
    for allowed in [
        "tauri://localhost/",
        "tauri://localhost/index.html",
        "http://tauri.localhost/",
        "https://tauri.localhost/",
    ] {
        assert!(main_local_root_url(&tauri::Url::parse(allowed).unwrap()));
    }
    for rejected in [
        "https://example.com/",
        "tauri://localhost/settings",
        "tauri://localhost:4321/",
        "tauri://localhost/?next=/",
        "tauri://localhost/#/settings",
        "tauri://user@localhost/",
        "http://tauri.localhost:4321/",
        "https://user:secret@tauri.localhost/",
        "https://tauri.localhost/?next=/",
        "https://tauri.localhost/#/settings",
        "file:///index.html",
    ] {
        assert!(!main_local_root_url(&tauri::Url::parse(rejected).unwrap()));
    }
}

#[test]
fn only_main_webview_inside_main_window_is_an_authorized_caller() {
    assert!(is_main_caller("main", "main"));
    assert!(!is_main_caller("child", "main"));
    assert!(!is_main_caller("main", "settings"));
    assert!(!is_main_caller("child", "settings"));
}
