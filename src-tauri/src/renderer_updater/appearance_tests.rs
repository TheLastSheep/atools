use super::*;
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn expected_config() -> Config {
    Config {
        theme: ThemePreference::System,
        requested_material: Material::None,
        opacity: 1.0,
        acrylic_light_opacity: 78.0,
        acrylic_dark_opacity: 50.0,
    }
}

fn facts() -> NativeFacts {
    NativeFacts {
        platform: Platform::Darwin,
        material: Material::None,
        native_material: NativeMaterial::FullScreenUi,
        material_applied: true,
        effective_theme: EffectiveTheme::Light,
        opacity: Some(1.0),
        opacity_applied: true,
        error: None,
    }
}

#[test]
fn general_defaults_and_known_values_ignore_unrelated_settings() {
    let defaults = expected_config();
    assert_eq!(parse_general(None).unwrap(), defaults);
    assert_eq!(parse_general(Some("{}")).unwrap(), defaults);

    let actual = parse_general(Some(
        r#"{"theme":"dark","opacity":0.84,"windowMaterial":"mica","acrylicLightOpacity":34,"acrylicDarkOpacity":90,"unknown":{"preserve":true}}"#,
    ))
    .unwrap();
    assert_eq!(actual.theme, ThemePreference::Dark);
    assert_eq!(actual.requested_material, Material::Mica);
    assert_eq!(actual.opacity, 0.84);
    assert_eq!(actual.acrylic_light_opacity, 34.0);
    assert_eq!(actual.acrylic_dark_opacity, 90.0);
    assert_eq!(
        parse_general(Some(r#"{"windowMaterial":"tabbed"}"#))
            .unwrap()
            .requested_material,
        Material::Tabbed
    );
}

#[test]
fn general_rejects_malformed_known_values_without_exposing_parser_details() {
    for raw in [
        "null",
        "[]",
        "{",
        r#"{"theme":true}"#,
        r#"{"theme":"automatic"}"#,
        r#"{"windowMaterial":7}"#,
        r#"{"windowMaterial":"blur"}"#,
        r#"{"opacity":"0.8"}"#,
        r#"{"opacity":0.29}"#,
        r#"{"opacity":1.01}"#,
        r#"{"opacity":1e999}"#,
        r#"{"acrylicLightOpacity":-1}"#,
        r#"{"acrylicDarkOpacity":101}"#,
        r#"{"acrylicLightOpacity":50.5}"#,
    ] {
        let error = parse_general(Some(raw)).unwrap_err();
        assert_eq!(error.code, "appearance_invalid");
        assert_eq!(error.message, "更新器外观信息无效");
    }
}

#[test]
fn projection_preserves_native_facts_and_serializes_the_closed_shape() {
    let config = parse_general(Some(
        r#"{"theme":"system","windowMaterial":"mica","opacity":0.9,"acrylicLightOpacity":78,"acrylicDarkOpacity":50}"#,
    ))
    .unwrap();
    let actual_facts = NativeFacts {
        platform: Platform::Win32,
        material: Material::Acrylic,
        native_material: NativeMaterial::None,
        material_applied: false,
        effective_theme: EffectiveTheme::Dark,
        opacity: Some(0.0),
        opacity_applied: false,
        error: Some(UpdateCommandError::new(
            "unsupported_material",
            "当前材质暂不可用",
        )),
    };
    let appearance = project("0123456789abcdef0123456789abcdef", 7, &config, actual_facts).unwrap();
    let value = serde_json::to_value(appearance).unwrap();

    assert_eq!(
        value,
        json!({
            "windowId":"0123456789abcdef0123456789abcdef",
            "sequence":7,
            "platform":"win32",
            "material":"acrylic",
            "nativeMaterial":"none",
            "materialApplied":false,
            "theme":"system",
            "effectiveTheme":"dark",
            "opacity":0.0,
            "opacityApplied":false,
            "acrylicOpacity":{"light":78.0,"dark":50.0},
            "error":{"code":"unsupported_material","message":"当前材质暂不可用"}
        })
    );
    let keys: BTreeSet<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "windowId",
            "sequence",
            "platform",
            "material",
            "nativeMaterial",
            "materialApplied",
            "theme",
            "effectiveTheme",
            "opacity",
            "opacityApplied",
            "acrylicOpacity",
            "error",
        ]
        .into_iter()
        .collect()
    );
}

#[test]
fn projection_rejects_invalid_identity_sequence_and_native_opacity() {
    let config = expected_config();
    let mut native = facts();
    for id in [
        "",
        "0123456789abcdef0123456789abcdeF",
        "0123456789abcdef0123456789abcdef0",
        "0123456789abcdef0123456789abcdeg",
    ] {
        assert_eq!(
            project(id, 1, &config, native.clone()).unwrap_err().code,
            "appearance_invalid"
        );
    }
    for sequence in [0, 9_007_199_254_740_992] {
        assert_eq!(
            project(
                "0123456789abcdef0123456789abcdef",
                sequence,
                &config,
                native.clone()
            )
            .unwrap_err()
            .code,
            "appearance_invalid"
        );
    }

    for opacity in [f64::NAN, f64::INFINITY, -0.01, 1.01] {
        native.opacity = Some(opacity);
        assert_eq!(
            project(
                "0123456789abcdef0123456789abcdef",
                1,
                &config,
                native.clone()
            )
            .unwrap_err()
            .code,
            "appearance_invalid"
        );
    }
    native.opacity = Some(0.0);
    let valid = project(
        "0123456789abcdef0123456789abcdef",
        9_007_199_254_740_991,
        &config,
        native,
    )
    .unwrap();
    assert_eq!(valid.opacity, Some(0.0));
}

#[test]
fn projected_error_is_null_when_native_reports_no_error() {
    let appearance = project(
        "0123456789abcdef0123456789abcdef",
        1,
        &expected_config(),
        facts(),
    )
    .unwrap();
    let value: Value = serde_json::to_value(appearance).unwrap();
    assert_eq!(value["error"], Value::Null);
}

#[test]
fn wire_enum_values_match_the_native_contract() {
    assert_eq!(
        serde_json::to_value([Platform::Darwin, Platform::Win32, Platform::Linux]).unwrap(),
        json!(["darwin", "win32", "linux"])
    );
    assert_eq!(
        serde_json::to_value([
            Material::None,
            Material::Acrylic,
            Material::Mica,
            Material::Tabbed
        ])
        .unwrap(),
        json!(["none", "acrylic", "mica", "tabbed"])
    );
    assert_eq!(
        serde_json::to_value([NativeMaterial::None, NativeMaterial::FullScreenUi]).unwrap(),
        json!(["none", "fullscreen-ui"])
    );
    assert_eq!(
        serde_json::to_value([
            ThemePreference::System,
            ThemePreference::Light,
            ThemePreference::Dark
        ])
        .unwrap(),
        json!(["system", "light", "dark"])
    );
    assert_eq!(
        serde_json::to_value([EffectiveTheme::Light, EffectiveTheme::Dark]).unwrap(),
        json!(["light", "dark"])
    );
}

#[test]
fn unavailable_native_opacity_remains_null_without_losing_other_facts() {
    let config = expected_config();
    let native = NativeFacts {
        platform: Platform::Linux,
        material: Material::Mica,
        native_material: NativeMaterial::None,
        material_applied: false,
        effective_theme: EffectiveTheme::Dark,
        opacity: None,
        opacity_applied: false,
        error: Some(UpdateCommandError::new(
            "opacity_unavailable",
            "当前平台无法读取窗口透明度",
        )),
    };
    let value = serde_json::to_value(
        project("0123456789abcdef0123456789abcdef", 2, &config, native).unwrap(),
    )
    .unwrap();

    assert_eq!(value.as_object().unwrap().len(), 12);
    assert_eq!(value["opacity"], Value::Null);
    assert_eq!(value["opacityApplied"], false);
    assert_eq!(value["platform"], "linux");
    assert_eq!(value["material"], "mica");
    assert_eq!(value["materialApplied"], false);
    assert_eq!(value["effectiveTheme"], "dark");
    assert_eq!(value["error"]["code"], "opacity_unavailable");
}

#[test]
fn unavailable_opacity_cannot_be_reported_as_applied() {
    let mut native = facts();
    native.opacity = None;
    native.opacity_applied = true;
    assert_eq!(
        project(
            "0123456789abcdef0123456789abcdef",
            1,
            &expected_config(),
            native,
        )
        .unwrap_err()
        .code,
        "appearance_invalid"
    );
}
