use std::collections::BTreeMap;

use crate::hotkey::OwnedMainHotkeyStateSnapshot;
use atools_core::db::{
    renderer_general_settings_row_count, validate_renderer_general_settings_patch,
    DEFAULT_SHOW_TRAY_ICON,
};
use serde_json::{json, Map, Value};

const MAX_GENERAL_RAW_BYTES: usize = 64 * 1024;
const MAX_PROJECTED_BYTES: usize = 80 * 1024;
const MAX_READONLY_STRING_BYTES: usize = 64 * 1024;
const MAX_COLLECTION_ITEMS: usize = 16_384;
const DEFAULT_PLACEHOLDER: &str = "搜索应用和指令 / 粘贴文件或图片";

pub(super) fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

pub(crate) fn project_general_settings(
    raw: Option<&str>,
    active_hotkey: &str,
) -> Result<Value, String> {
    if raw.is_some_and(|raw| raw.len() > MAX_GENERAL_RAW_BYTES) {
        return Err("Stored General settings exceed the shared record budget".into());
    }
    let source: Map<String, Value> = match raw {
        None => Map::new(),
        Some(raw) => serde_json::from_str::<Value>(raw)
            .ok()
            .and_then(|value| value.as_object().cloned())
            .ok_or_else(|| "Stored General settings cannot be projected safely".to_owned())?,
    };
    let mut form: Map<String, Value> = serde_json::from_str::<Value>(r##"{
        "opacity":1.0,"windowDefaultHeight":541,"hotkey":"","placeholder":"搜索应用和指令 / 粘贴文件或图片","avatar":null,"autoPaste":"3s",
        "autoClear":"immediately","autoBackToSearch":"never","windowPositionStrategy":"remember","showRecentInSearch":true,"showMatchRecommendation":true,
        "localAppSearch":true,"recentRows":2,"pinnedRows":2,"searchMode":"aggregate","tabKeyFunction":"navigate","tabTargetCommand":"","spaceOpenCommand":false,
        "floatingBallDoubleClickCommand":"","floatingBallEnabled":false,"floatingBallLetter":"Z","superPanelEnabled":false,"superPanelMouseButton":"middle","superPanelLongPressMs":500,
        "superPanelBlockedApps":[],"wakeupBlacklist":[],"superPanelTranslateEnabled":false,"theme":"system","primaryColor":"green","customColor":"#db2777",
        "windowMaterial":"none","acrylicLightOpacity":78,"acrylicDarkOpacity":50,"devToolsMode":"detach","disableGpuAcceleration":false,
        "customInternalApiPluginNames":[],"proxyEnabled":false,"proxyUrl":"","autoCheckUpdate":true,"clipboardRetentionDays":180,"terminal":"default","terminalCustomCommand":""
    }"##)
    .ok()
    .and_then(|value| value.as_object().cloned())
    .ok_or_else(|| "General settings projection is unavailable".to_owned())?;
    form.insert("showTrayIcon".into(), Value::Bool(DEFAULT_SHOW_TRAY_ICON));
    form.insert(
        "builtinAppShortcutsEnabled".into(),
        crate::renderer_settings::project_builtin_shortcuts(
            source.get("builtinAppShortcutsEnabled"),
        ),
    );

    if !active_hotkey.is_empty() {
        validate_shortcut(active_hotkey)?;
    }
    form.insert("hotkey".into(), Value::String(active_hotkey.to_owned()));

    put_bounded_number(&source, &mut form, "opacity", 0.3, 1.0)?;
    if let Some(height) = source.get("windowDefaultHeight") {
        atools_core::db::renderer_general_settings_window_default_height(height)
            .ok_or("Stored default content height is invalid")?;
        form.insert("windowDefaultHeight".into(), height.clone());
    }
    put_safe_string(
        &source,
        &mut form,
        "placeholder",
        DEFAULT_PLACEHOLDER,
        MAX_READONLY_STRING_BYTES,
    )?;
    put_avatar(&source, &mut form)?;
    put_enum(
        &source,
        &mut form,
        "autoPaste",
        "3s",
        &["off", "1s", "3s", "5s", "10s"],
    )?;
    put_enum(
        &source,
        &mut form,
        "autoClear",
        "immediately",
        &["immediately", "1m", "2m", "3m", "5m", "10m", "never"],
    )?;
    put_enum(
        &source,
        &mut form,
        "autoBackToSearch",
        "never",
        &["immediately", "30s", "1m", "3m", "5m", "10m", "never"],
    )?;
    put_enum(
        &source,
        &mut form,
        "windowPositionStrategy",
        "remember",
        &["remember", "cursor", "primary", "lastActive"],
    )?;
    for key in [
        "showRecentInSearch",
        "showMatchRecommendation",
        "localAppSearch",
        "spaceOpenCommand",
        "floatingBallEnabled",
        "superPanelEnabled",
        "superPanelTranslateEnabled",
        "showTrayIcon",
        "disableGpuAcceleration",
        "proxyEnabled",
        "autoCheckUpdate",
    ] {
        put_bool(&source, &mut form, key)?;
    }
    put_renderer_row_count(&source, &mut form, "recentRows")?;
    put_renderer_row_count(&source, &mut form, "pinnedRows")?;
    put_enum(
        &source,
        &mut form,
        "searchMode",
        "aggregate",
        &["aggregate", "list"],
    )?;
    let tab_default = source
        .get("tabTargetCommand")
        .and_then(Value::as_str)
        .filter(|command| !command.is_empty())
        .map(|_| "target-command")
        .unwrap_or("navigate");
    put_enum(
        &source,
        &mut form,
        "tabKeyFunction",
        tab_default,
        &["navigate", "target-command"],
    )?;
    for key in ["tabTargetCommand", "floatingBallDoubleClickCommand"] {
        put_safe_string(&source, &mut form, key, "", MAX_READONLY_STRING_BYTES)?;
    }
    let letter = source_string(&source, "floatingBallLetter")?
        .filter(|letter| !letter.is_empty())
        .unwrap_or("Z");
    if letter.len() > 16 || letter.chars().any(char::is_control) {
        return Err("Stored General string exceeds its safe projection budget".into());
    }
    form.insert(
        "floatingBallLetter".into(),
        Value::String(letter.to_owned()),
    );
    put_enum(
        &source,
        &mut form,
        "superPanelMouseButton",
        "middle",
        &["middle", "right", "back", "forward"],
    )?;
    put_bounded_integer(&source, &mut form, "superPanelLongPressMs", 0, 10_000)?;
    put_app_list(&source, &mut form, "superPanelBlockedApps")?;
    put_app_list(&source, &mut form, "wakeupBlacklist")?;
    put_enum(
        &source,
        &mut form,
        "theme",
        "system",
        &["system", "light", "dark"],
    )?;
    put_enum(
        &source,
        &mut form,
        "primaryColor",
        "green",
        &["blue", "purple", "green", "orange", "red", "pink", "custom"],
    )?;
    put_color(&source, &mut form)?;
    put_enum(
        &source,
        &mut form,
        "windowMaterial",
        "none",
        &["mica", "acrylic", "none"],
    )?;
    put_bounded_integer(&source, &mut form, "acrylicLightOpacity", 0, 100)?;
    put_bounded_integer(&source, &mut form, "acrylicDarkOpacity", 0, 100)?;
    put_enum(
        &source,
        &mut form,
        "devToolsMode",
        "detach",
        &["right", "bottom", "undocked", "detach"],
    )?;
    put_plugin_name_list(&source, &mut form)?;
    put_bounded_integer(&source, &mut form, "clipboardRetentionDays", 1, 3650)?;
    put_safe_string(&source, &mut form, "terminal", "default", 256)?;
    validate_redacted_secret_type(&source, "proxyUrl")?;
    validate_redacted_secret_type(&source, "terminalCustomCommand")?;
    let projected = Value::Object(form);
    validate_projected_size(&projected)?;
    Ok(projected)
}

pub(super) fn displayed_hotkey(
    state: &OwnedMainHotkeyStateSnapshot,
    configured_fallback: &str,
) -> Result<String, String> {
    if let Some(label) = state.active_label() {
        validate_shortcut(label)?;
        return Ok(label.to_owned());
    }
    if state.label().is_some() || state.startup_attempted() {
        return Ok(String::new());
    }

    #[cfg(feature = "legacy-node-smoke")]
    {
        // This is a display-only configured hint for smoke fixtures that did
        // not run startup; it does not prove the shortcut is registered.
        if !configured_fallback.is_empty() && validate_shortcut(configured_fallback).is_ok() {
            Ok(configured_fallback.to_owned())
        } else {
            Ok(String::new())
        }
    }
    #[cfg(not(feature = "legacy-node-smoke"))]
    {
        let _ = configured_fallback;
        Err("Owned primary shortcut startup has not been attempted".into())
    }
}

pub(super) fn validate_projected_size(value: &Value) -> Result<(), String> {
    let size = serde_json::to_vec(value)
        .map_err(|_| "General settings projection cannot be serialized".to_owned())?
        .len();
    if size > MAX_PROJECTED_BYTES {
        return Err("General settings projection exceeds its shared size budget".into());
    }
    Ok(())
}

fn source_string<'a>(source: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, String> {
    match source.get(key) {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .map(Some)
            .ok_or_else(|| "Stored General setting has an invalid type".to_owned()),
    }
}

fn put_safe_string(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    key: &str,
    default: &str,
    max_bytes: usize,
) -> Result<(), String> {
    let value = source_string(source, key)?.unwrap_or(default);
    if value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err("Stored General string exceeds its safe projection budget".into());
    }
    target.insert(key.to_owned(), Value::String(value.to_owned()));
    Ok(())
}

fn put_enum(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    key: &str,
    default: &str,
    allowed: &[&str],
) -> Result<(), String> {
    let value = source_string(source, key)?.unwrap_or(default);
    if !allowed.contains(&value) {
        return Err("Stored General setting has an unsupported value".into());
    }
    target.insert(key.to_owned(), Value::String(value.to_owned()));
    Ok(())
}

fn put_bool(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    key: &str,
) -> Result<(), String> {
    if let Some(value) = source.get(key) {
        if !value.is_boolean() {
            return Err("Stored General setting has an invalid type".into());
        }
        target.insert(key.to_owned(), value.clone());
    }
    Ok(())
}

fn put_bounded_integer(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    key: &str,
    min: i64,
    max: i64,
) -> Result<(), String> {
    if let Some(value) = source.get(key) {
        let Some(number) = value.as_i64().filter(|number| (min..=max).contains(number)) else {
            return Err("Stored General number is outside its safe projection budget".into());
        };
        target.insert(key.to_owned(), json!(number));
    }
    Ok(())
}

fn put_renderer_row_count(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    key: &str,
) -> Result<(), String> {
    if let Some(value) = source.get(key) {
        let count = renderer_general_settings_row_count(value)
            .ok_or_else(|| "Stored General row count has an invalid value".to_owned())?;
        target.insert(key.to_owned(), json!(count));
    }
    Ok(())
}

fn put_bounded_number(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    key: &str,
    min: f64,
    max: f64,
) -> Result<(), String> {
    if let Some(value) = source.get(key) {
        let Some(number) = value
            .as_f64()
            .filter(|number| number.is_finite() && *number >= min && *number <= max)
        else {
            return Err("Stored General number is outside its safe projection budget".into());
        };
        target.insert(key.to_owned(), json!(number));
    }
    Ok(())
}

fn put_avatar(source: &Map<String, Value>, target: &mut Map<String, Value>) -> Result<(), String> {
    let avatar = match source.get("avatar") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(value))
            if value.len() <= 64 * 1024 && !value.chars().any(char::is_control) =>
        {
            Value::String(value.clone())
        }
        _ => return Err("Stored General avatar has an invalid type or size".into()),
    };
    target.insert("avatar".into(), avatar);
    Ok(())
}

fn put_color(source: &Map<String, Value>, target: &mut Map<String, Value>) -> Result<(), String> {
    let value = source_string(source, "customColor")?.unwrap_or("#db2777");
    if !is_hex_color(value) {
        return Err("Stored General color is invalid".into());
    }
    target.insert("customColor".into(), Value::String(value.to_owned()));
    Ok(())
}

fn put_plugin_name_list(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
) -> Result<(), String> {
    let Some(value) = source.get("customInternalApiPluginNames") else {
        return Ok(());
    };
    let Some(values) = value.as_array() else {
        return Err("Stored General plugin name list has an invalid type".into());
    };
    if values.len() > MAX_COLLECTION_ITEMS {
        return Err("Stored General plugin name list exceeds its item budget".into());
    }
    let mut names = Vec::with_capacity(values.len());
    for value in values {
        let Some(name) = value.as_str() else {
            return Err("Stored General plugin name has an invalid type".into());
        };
        if name.len() > 256 || name.chars().any(char::is_control) {
            return Err("Stored General plugin name exceeds its safe projection budget".into());
        }
        let name = name.trim();
        if !name.is_empty() && !names.iter().any(|existing: &String| existing == name) {
            names.push(name.to_owned());
        }
    }
    target.insert("customInternalApiPluginNames".into(), json!(names));
    Ok(())
}

fn put_app_list(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    key: &str,
) -> Result<(), String> {
    let Some(value) = source.get(key) else {
        return Ok(());
    };
    let Some(values) = value.as_array() else {
        return Err("Stored General app list has an invalid type".into());
    };
    if values.len() > MAX_COLLECTION_ITEMS {
        return Err("Stored General app list exceeds its item budget".into());
    }
    let mut apps = Vec::with_capacity(values.len());
    for value in values {
        let Some(object) = value.as_object() else {
            return Err("Stored General app entry has an invalid type".into());
        };
        let mut app = Map::new();
        for field in ["app", "bundleId", "label"] {
            if let Some(value) = object.get(field) {
                let Some(value) = value.as_str() else {
                    return Err("Stored General app entry has an invalid type".into());
                };
                if value.len() > 1024 || value.chars().any(char::is_control) {
                    return Err(
                        "Stored General app entry exceeds its safe projection budget".into(),
                    );
                }
                app.insert(field.into(), Value::String(value.to_owned()));
            }
        }
        if !app.contains_key("app")
            || object
                .keys()
                .any(|field| !["app", "bundleId", "label"].contains(&field.as_str()))
        {
            return Err("Stored General app entry has unsupported fields".into());
        }
        apps.push(Value::Object(app));
    }
    target.insert(key.to_owned(), Value::Array(apps));
    Ok(())
}

fn validate_redacted_secret_type(source: &Map<String, Value>, key: &str) -> Result<(), String> {
    if let Some(value) = source.get(key) {
        if !value.is_string() {
            return Err("Stored sensitive General setting has an invalid type".into());
        }
    }
    Ok(())
}

fn validate_shortcut(value: &str) -> Result<(), String> {
    validate_renderer_general_settings_patch(&BTreeMap::from([(
        "hotkey".to_owned(),
        Value::String(value.to_owned()),
    )]))
    .map_err(|_| "Configured shortcut cannot be projected safely".to_owned())
}

#[cfg(test)]
mod double_modifier_projection_tests {
    use super::*;
    #[test]
    fn inactive_owned_double_keeps_recovery_identity_but_never_projects_active_label() {
        let snapshot = OwnedMainHotkeyStateSnapshot::for_test_inactive("Command+Command");
        assert_eq!(snapshot.label(), Some("Command+Command"));
        assert_eq!(displayed_hotkey(&snapshot, "Option+Z").unwrap(), "");
        assert_eq!(
            displayed_hotkey(
                &OwnedMainHotkeyStateSnapshot::for_test_registered("Command+Command"),
                ""
            )
            .unwrap(),
            "Command+Command"
        );
    }
}
