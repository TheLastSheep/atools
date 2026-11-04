use crate::updater::UpdateCommandError;
use serde_json::{Map, Value};

const MIN_WINDOW_OPACITY: f64 = 0.3;
const MAX_WINDOW_OPACITY: f64 = 1.0;
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Config {
    pub theme: ThemePreference,
    pub requested_material: Material,
    pub opacity: f64,
    pub acrylic_light_opacity: f64,
    pub acrylic_dark_opacity: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum ThemePreference {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Material {
    None,
    Acrylic,
    Mica,
    Tabbed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub(super) enum Platform {
    Darwin,
    Win32,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[allow(dead_code)]
pub(super) enum NativeMaterial {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "fullscreen-ui")]
    FullScreenUi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum EffectiveTheme {
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct NativeFacts {
    pub platform: Platform,
    pub material: Material,
    pub native_material: NativeMaterial,
    pub material_applied: bool,
    pub effective_theme: EffectiveTheme,
    pub opacity: Option<f64>,
    pub opacity_applied: bool,
    pub error: Option<UpdateCommandError>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Appearance {
    pub window_id: String,
    pub sequence: u64,
    pub platform: Platform,
    pub material: Material,
    pub native_material: NativeMaterial,
    pub material_applied: bool,
    pub theme: ThemePreference,
    pub effective_theme: EffectiveTheme,
    pub opacity: Option<f64>,
    pub opacity_applied: bool,
    pub acrylic_opacity: AcrylicOpacity,
    pub error: Option<UpdateCommandError>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AcrylicOpacity {
    pub light: f64,
    pub dark: f64,
}

pub(super) fn parse_general(raw: Option<&str>) -> Result<Config, UpdateCommandError> {
    let empty = Map::new();
    let parsed;
    let object = match raw {
        None => &empty,
        Some(raw) => {
            parsed = serde_json::from_str::<Value>(raw).map_err(|_| invalid())?;
            parsed.as_object().ok_or_else(invalid)?
        }
    };

    let theme = match string_field(object, "theme", "system")? {
        "system" => ThemePreference::System,
        "light" => ThemePreference::Light,
        "dark" => ThemePreference::Dark,
        _ => return Err(invalid()),
    };
    let requested_material = match string_field(object, "windowMaterial", "none")? {
        "none" => Material::None,
        "acrylic" => Material::Acrylic,
        "mica" => Material::Mica,
        "tabbed" => Material::Tabbed,
        _ => return Err(invalid()),
    };

    let config = Config {
        theme,
        requested_material,
        opacity: number_field(object, "opacity", 1.0)?,
        acrylic_light_opacity: percentage_field(object, "acrylicLightOpacity", 78.0)?,
        acrylic_dark_opacity: percentage_field(object, "acrylicDarkOpacity", 50.0)?,
    };
    if valid_config(&config) {
        Ok(config)
    } else {
        Err(invalid())
    }
}

pub(super) fn project(
    window_id: &str,
    sequence: u64,
    config: &Config,
    facts: NativeFacts,
) -> Result<Appearance, UpdateCommandError> {
    if !valid_id(window_id)
        || sequence == 0
        || sequence > MAX_SAFE_SEQUENCE
        || !valid_config(config)
        || facts.opacity.is_some_and(|opacity| {
            !opacity.is_finite() || !(0.0..=MAX_WINDOW_OPACITY).contains(&opacity)
        })
        || (facts.opacity_applied && facts.opacity.is_none())
    {
        return Err(invalid());
    }

    Ok(Appearance {
        window_id: window_id.to_owned(),
        sequence,
        platform: facts.platform,
        material: facts.material,
        native_material: facts.native_material,
        material_applied: facts.material_applied,
        theme: config.theme,
        effective_theme: facts.effective_theme,
        opacity: facts.opacity,
        opacity_applied: facts.opacity_applied,
        acrylic_opacity: AcrylicOpacity {
            light: config.acrylic_light_opacity,
            dark: config.acrylic_dark_opacity,
        },
        error: facts.error,
    })
}

fn string_field<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    default: &'a str,
) -> Result<&'a str, UpdateCommandError> {
    match object.get(key) {
        None => Ok(default),
        Some(value) => value.as_str().ok_or_else(invalid),
    }
}

fn number_field(
    object: &Map<String, Value>,
    key: &str,
    default: f64,
) -> Result<f64, UpdateCommandError> {
    match object.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_f64()
            .filter(|number| number.is_finite())
            .ok_or_else(invalid),
    }
}

fn percentage_field(
    object: &Map<String, Value>,
    key: &str,
    default: f64,
) -> Result<f64, UpdateCommandError> {
    let value = number_field(object, key, default)?;
    if !(0.0..=100.0).contains(&value) || value.fract() != 0.0 {
        return Err(invalid());
    }
    Ok(value)
}

fn valid_config(config: &Config) -> bool {
    config.opacity.is_finite()
        && (MIN_WINDOW_OPACITY..=MAX_WINDOW_OPACITY).contains(&config.opacity)
        && valid_percentage(config.acrylic_light_opacity)
        && valid_percentage(config.acrylic_dark_opacity)
}

fn valid_percentage(value: f64) -> bool {
    value.is_finite() && (0.0..=100.0).contains(&value) && value.fract() == 0.0
}

fn valid_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn invalid() -> UpdateCommandError {
    UpdateCommandError::new("appearance_invalid", "更新器外观信息无效")
}

#[cfg(test)]
#[path = "appearance_tests.rs"]
mod tests;
