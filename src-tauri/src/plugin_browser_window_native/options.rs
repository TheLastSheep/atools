use serde_json::{Map, Value};

use super::background_throttling;

const MAX_COORDINATE: f64 = 1_000_000.0;
const MAX_DIMENSION: f64 = 16_384.0;

/// Native window properties accepted from a BrowserWindow request.
///
/// Plugin URLs, preload scripts, renderer privileges, arbitrary WebView settings,
/// parent labels, and other execution inputs do not belong to this type. The
/// background-throttling flag is a narrow host-controlled policy exception.
#[derive(Clone, Debug, PartialEq)]
pub struct WindowSpec {
    pub label: String,
    pub title: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    pub min_width: Option<f64>,
    pub min_height: Option<f64>,
    pub max_width: Option<f64>,
    pub max_height: Option<f64>,
    pub center: bool,
    pub frame: bool,
    pub transparent: bool,
    pub background_color: Option<[u8; 4]>,
    pub use_content_size: bool,
    pub fullscreenable: bool,
    pub always_on_top: bool,
    pub show: bool,
    pub focusable: bool,
    pub resizable: bool,
    pub closable: bool,
    pub minimizable: bool,
    pub maximizable: bool,
    pub fullscreen: bool,
    pub skip_taskbar: bool,
    pub visible_on_all_workspaces: bool,
    pub has_shadow: bool,
    pub ignore_mouse_events: bool,
    pub background_throttling: bool,
}

impl WindowSpec {
    pub fn from_options(label: String, options: &Value) -> Result<Self, String> {
        validate_label(&label)?;
        let options = options.as_object().ok_or_else(|| {
            "ERR_ATOOLS_NATIVE_WINDOW_INVALID_OPTIONS: options must be an object".to_string()
        })?;
        reject_unsupported_options(options)?;
        reject_unsupported_platform_options(options)?;

        let title = string_option(options, &["title"], "ATools")?;
        let x = number_option(options, &["x"], "x", -MAX_COORDINATE, MAX_COORDINATE)?;
        let y = number_option(options, &["y"], "y", -MAX_COORDINATE, MAX_COORDINATE)?;
        if x.is_some() != y.is_some() {
            return Err(invalid("x and y must be provided together"));
        }

        let width = positive_dimension(options, &["width"], "width", 560.0)?;
        let height = positive_dimension(options, &["height"], "height", 220.0)?;
        let min_width = optional_constraint(
            options,
            &["minWidth", "minimumWidth", "minwidth", "minimumwidth"],
            "minWidth",
        )?;
        let min_height = optional_constraint(
            options,
            &["minHeight", "minimumHeight", "minheight", "minimumheight"],
            "minHeight",
        )?;
        let max_width = optional_constraint(
            options,
            &["maxWidth", "maximumWidth", "maxwidth", "maximumwidth"],
            "maxWidth",
        )?;
        let max_height = optional_constraint(
            options,
            &["maxHeight", "maximumHeight", "maxheight", "maximumheight"],
            "maxHeight",
        )?;
        if min_width.zip(max_width).is_some_and(|(min, max)| min > max)
            || min_height
                .zip(max_height)
                .is_some_and(|(min, max)| min > max)
        {
            return Err(invalid("minimum size cannot exceed maximum size"));
        }

        let center = bool_option(options, &["center"], false)?;
        if center && x.is_some() {
            return Err(invalid("center cannot be combined with x/y"));
        }

        let spec = Self {
            label,
            title,
            x,
            y,
            width,
            height,
            min_width,
            min_height,
            max_width,
            max_height,
            center,
            frame: bool_option(options, &["frame"], true)?,
            transparent: bool_option(options, &["transparent"], false)?,
            background_color: background_color_option(options)?,
            use_content_size: bool_option(options, &["useContentSize", "usecontentsize"], false)?,
            fullscreenable: bool_option(options, &["fullscreenable", "fullScreenable"], true)?,
            always_on_top: bool_option(options, &["alwaysOnTop", "alwaysontop"], false)?,
            show: bool_option(options, &["show"], true)?,
            focusable: bool_option(options, &["focusable"], true)?,
            resizable: bool_option(options, &["resizable"], true)?,
            closable: bool_option(options, &["closable"], true)?,
            minimizable: bool_option(options, &["minimizable"], true)?,
            maximizable: bool_option(options, &["maximizable"], true)?,
            fullscreen: bool_option(options, &["fullScreen", "fullscreen"], false)?,
            skip_taskbar: bool_option(options, &["skipTaskbar", "skiptaskbar"], false)?,
            visible_on_all_workspaces: bool_option(
                options,
                &["visibleOnAllWorkspaces", "visibleonallworkspaces"],
                false,
            )?,
            has_shadow: bool_option(options, &["hasShadow", "hasshadow"], true)?,
            ignore_mouse_events: bool_option(
                options,
                &["ignoreMouseEvents", "ignoremouseevents"],
                false,
            )?,
            background_throttling: bool_option(options, &["backgroundThrottling"], true)?,
        };
        spec.validate()?;
        Ok(spec)
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_label(&self.label)?;
        validate_title(&self.title)?;
        validate_position(self.x, "x")?;
        validate_position(self.y, "y")?;
        validate_dimension(self.width, "width")?;
        validate_dimension(self.height, "height")?;
        validate_constraint(self.min_width, "minWidth")?;
        validate_constraint(self.min_height, "minHeight")?;
        validate_constraint(self.max_width, "maxWidth")?;
        validate_constraint(self.max_height, "maxHeight")?;
        if self.x.is_some() != self.y.is_some() || (self.center && self.x.is_some()) {
            return Err(invalid("inconsistent initial position"));
        }
        if self
            .min_width
            .zip(self.max_width)
            .is_some_and(|(min, max)| min > max)
            || self
                .min_height
                .zip(self.max_height)
                .is_some_and(|(min, max)| min > max)
        {
            return Err(invalid("minimum size cannot exceed maximum size"));
        }
        if self.min_width.is_some_and(|minimum| self.width < minimum)
            || self.min_height.is_some_and(|minimum| self.height < minimum)
            || self.max_width.is_some_and(|maximum| self.width > maximum)
            || self.max_height.is_some_and(|maximum| self.height > maximum)
        {
            return Err(invalid(
                "initial size must satisfy the requested min/max constraints",
            ));
        }
        if self.fullscreen && !self.fullscreenable {
            return Err(invalid(
                "initial fullscreen cannot be combined with fullscreenable=false",
            ));
        }
        #[cfg(not(target_os = "macos"))]
        if !self.fullscreenable {
            return Err(unsupported(
                "fullscreenable=false is only supported by the macOS native adapter",
            ));
        }
        #[cfg(target_os = "linux")]
        if !self.minimizable || !self.maximizable {
            return Err(unsupported(
                "minimizable/maximizable are not supported on Linux",
            ));
        }
        #[cfg(target_os = "linux")]
        if !self.has_shadow {
            return Err(unsupported("setHasShadow is not supported on Linux"));
        }
        if !self.background_throttling && !background_throttling::current_platform_supports() {
            return Err(unsupported(
                "backgroundThrottling=false requires macOS 14 or later",
            ));
        }
        Ok(())
    }
}

fn reject_unsupported_options(options: &Map<String, Value>) -> Result<(), String> {
    const ALLOWED: &[&str] = &[
        "title",
        "x",
        "y",
        "width",
        "height",
        "minWidth",
        "minimumWidth",
        "minwidth",
        "minimumwidth",
        "minHeight",
        "minimumHeight",
        "minheight",
        "minimumheight",
        "maxWidth",
        "maximumWidth",
        "maxwidth",
        "maximumwidth",
        "maxHeight",
        "maximumHeight",
        "maxheight",
        "maximumheight",
        "center",
        "frame",
        "transparent",
        "backgroundColor",
        "backgroundcolor",
        "useContentSize",
        "usecontentsize",
        "fullscreenable",
        "fullScreenable",
        "alwaysOnTop",
        "alwaysontop",
        "show",
        "focusable",
        "resizable",
        "closable",
        "minimizable",
        "maximizable",
        "fullScreen",
        "fullscreen",
        "skipTaskbar",
        "skiptaskbar",
        "visibleOnAllWorkspaces",
        "visibleonallworkspaces",
        "hasShadow",
        "hasshadow",
        "ignoreMouseEvents",
        "ignoremouseevents",
        "backgroundThrottling",
    ];
    if let Some(key) = options.keys().find(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(unsupported(format!(
            "window option {key:?} is not accepted by the native host"
        )));
    }
    Ok(())
}

fn reject_unsupported_platform_options(options: &Map<String, Value>) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    if !bool_option(options, &["fullscreenable", "fullScreenable"], true)? {
        return Err(unsupported(
            "fullscreenable=false is only supported by the macOS native adapter",
        ));
    }
    #[cfg(target_os = "linux")]
    for key in ["minimizable", "maximizable", "hasShadow", "hasshadow"] {
        if options.contains_key(key) {
            return Err(unsupported(format!(
                "window option {key:?} is not supported by Tauri on Linux"
            )));
        }
    }
    let _ = options;
    Ok(())
}

fn string_option(
    options: &Map<String, Value>,
    keys: &[&str],
    default: &str,
) -> Result<String, String> {
    match aliased_value(options, keys)? {
        None => Ok(default.to_string()),
        Some(Value::String(value))
            if value.len() <= 512 && !value.chars().any(char::is_control) =>
        {
            Ok(value.clone())
        }
        Some(_) => Err(invalid(
            "title must be a control-free string up to 512 bytes",
        )),
    }
}

fn background_color_option(options: &Map<String, Value>) -> Result<Option<[u8; 4]>, String> {
    let Some(value) = aliased_value(options, &["backgroundColor", "backgroundcolor"])? else {
        return Ok(None);
    };
    let Some(value) = value.as_str() else {
        return Err(invalid(
            "backgroundColor must be a hexadecimal color string",
        ));
    };
    let bytes = value.as_bytes();
    if bytes.first() != Some(&b'#') || !matches!(bytes.len(), 7 | 9) {
        return Err(unsupported(
            "backgroundColor only accepts #RRGGBB or #RRGGBBAA hexadecimal colors",
        ));
    }
    if !bytes[1..].iter().all(u8::is_ascii_hexdigit) {
        return Err(unsupported(
            "backgroundColor only accepts #RRGGBB or #RRGGBBAA hexadecimal colors",
        ));
    }
    let parse = |start| {
        u8::from_str_radix(&value[start..start + 2], 16)
            .map_err(|_| unsupported("backgroundColor contains invalid hexadecimal digits"))
    };
    let alpha = if bytes.len() == 9 { parse(7)? } else { 255 };
    Ok(Some([parse(1)?, parse(3)?, parse(5)?, alpha]))
}

fn bool_option(options: &Map<String, Value>, keys: &[&str], default: bool) -> Result<bool, String> {
    match aliased_value(options, keys)? {
        None => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(invalid(format!("{} must be boolean", keys[0]))),
    }
}

fn number_option(
    options: &Map<String, Value>,
    keys: &[&str],
    name: &str,
    minimum: f64,
    maximum: f64,
) -> Result<Option<f64>, String> {
    let Some(value) = aliased_value(options, keys)? else {
        return Ok(None);
    };
    let number = value
        .as_f64()
        .ok_or_else(|| invalid(format!("{name} must be a finite number")))?;
    if !number.is_finite() || !(minimum..=maximum).contains(&number) {
        return Err(invalid(format!(
            "{name} must be between {minimum} and {maximum}"
        )));
    }
    Ok(Some(number))
}

fn positive_dimension(
    options: &Map<String, Value>,
    keys: &[&str],
    name: &str,
    default: f64,
) -> Result<f64, String> {
    match number_option(options, keys, name, f64::MIN_POSITIVE, MAX_DIMENSION)? {
        Some(value) => Ok(value),
        None => Ok(default),
    }
}

fn optional_constraint(
    options: &Map<String, Value>,
    keys: &[&str],
    name: &str,
) -> Result<Option<f64>, String> {
    let Some(value) = number_option(options, keys, name, 0.0, MAX_DIMENSION)? else {
        return Ok(None);
    };
    Ok((value > 0.0).then_some(value))
}

fn aliased_value<'a>(
    options: &'a Map<String, Value>,
    keys: &[&str],
) -> Result<Option<&'a Value>, String> {
    let mut selected = None;
    for key in keys {
        if let Some(value) = options.get(*key) {
            if selected.is_some_and(|previous| previous != value) {
                return Err(invalid(format!("conflicting aliases for {}", keys[0])));
            }
            selected = Some(value);
        }
    }
    Ok(selected)
}

pub(crate) fn validate_label(label: &str) -> Result<(), String> {
    if label.is_empty()
        || label.len() > 64
        || !label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || !label
            .strip_prefix("atools-native-browser-")
            .is_some_and(|suffix| {
                suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        || matches!(
            label,
            "main" | "settings" | "plugin-detach" | "pasteboard-shelf" | "pasteboard-dialog"
        )
    {
        return Err(invalid("label is not a valid managed native-window label"));
    }
    Ok(())
}

fn validate_title(title: &str) -> Result<(), String> {
    if title.len() > 512 || title.chars().any(char::is_control) {
        return Err(invalid(
            "title must be a control-free string up to 512 bytes",
        ));
    }
    Ok(())
}

fn validate_position(value: Option<f64>, name: &str) -> Result<(), String> {
    if value.is_some_and(|number| !number.is_finite() || number.abs() > MAX_COORDINATE) {
        return Err(invalid(format!("{name} must be within ±{MAX_COORDINATE}")));
    }
    Ok(())
}

fn validate_dimension(value: f64, name: &str) -> Result<(), String> {
    if !value.is_finite() || value <= 0.0 || value > MAX_DIMENSION {
        return Err(invalid(format!(
            "{name} must be greater than 0 and at most {MAX_DIMENSION}"
        )));
    }
    Ok(())
}

fn validate_constraint(value: Option<f64>, name: &str) -> Result<(), String> {
    if value.is_some_and(|number| !number.is_finite() || number <= 0.0 || number > MAX_DIMENSION) {
        return Err(invalid(format!(
            "{name} must be 0/unbounded or between 0 and {MAX_DIMENSION}"
        )));
    }
    Ok(())
}

pub(crate) fn invalid(message: impl AsRef<str>) -> String {
    format!(
        "ERR_ATOOLS_NATIVE_WINDOW_INVALID_OPTIONS: {}",
        message.as_ref()
    )
}

pub(crate) fn unsupported(message: impl AsRef<str>) -> String {
    format!("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED: {}", message.as_ref())
}

#[cfg(test)]
#[path = "options/tests.rs"]
mod tests;
