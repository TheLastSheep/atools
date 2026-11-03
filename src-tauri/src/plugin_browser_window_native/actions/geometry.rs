use serde_json::{json, Value};

use crate::plugin_browser_window_native::snapshot::NativeSnapshot;

const MAX_COORDINATE: f64 = 1_000_000.0;
const MAX_DIMENSION: f64 = 16_384.0;

#[derive(Clone, Debug)]
pub(super) enum GeometryAction {
    GetBounds,
    SetBounds {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    GetSize,
    SetSize {
        width: f64,
        height: f64,
    },
    GetContentSize,
    SetContentSize {
        width: f64,
        height: f64,
    },
    GetMinimumSize,
    SetMinimumSize {
        width: Option<f64>,
        height: Option<f64>,
    },
    GetMaximumSize,
    SetMaximumSize {
        width: Option<f64>,
        height: Option<f64>,
    },
    GetPosition,
    SetPosition {
        x: f64,
        y: f64,
    },
    Center,
}

pub(super) fn parse(action: &str, args: &[Value]) -> Result<Option<GeometryAction>, String> {
    let parsed = match action {
        "getBounds" => no_args(args).map(|_| GeometryAction::GetBounds),
        "setBounds" => parse_bounds(args),
        "getSize" => no_args(args).map(|_| GeometryAction::GetSize),
        "setSize" => {
            parse_size(args).map(|(width, height)| GeometryAction::SetSize { width, height })
        }
        "getContentSize" => no_args(args).map(|_| GeometryAction::GetContentSize),
        "setContentSize" => parse_content_size(args),
        "getMinimumSize" => no_args(args).map(|_| GeometryAction::GetMinimumSize),
        "setMinimumSize" => parse_constraint(args, true),
        "getMaximumSize" => no_args(args).map(|_| GeometryAction::GetMaximumSize),
        "setMaximumSize" => parse_constraint(args, false),
        "getPosition" => no_args(args).map(|_| GeometryAction::GetPosition),
        "setPosition" => parse_position(args),
        "center" => no_args(args).map(|_| GeometryAction::Center),
        _ => return Ok(None),
    };
    parsed.map(Some)
}

pub(super) fn read(snapshot: &NativeSnapshot, action: &GeometryAction) -> Option<Value> {
    match action {
        GeometryAction::GetBounds => serde_json::to_value(&snapshot.bounds).ok(),
        GeometryAction::GetSize => Some(json!([snapshot.bounds.width, snapshot.bounds.height])),
        GeometryAction::GetContentSize => Some(json!([
            snapshot.content_bounds.width,
            snapshot.content_bounds.height
        ])),
        GeometryAction::GetMinimumSize => Some(json!(snapshot.minimum_size)),
        GeometryAction::GetMaximumSize => Some(json!(snapshot.maximum_size)),
        GeometryAction::GetPosition => Some(json!([snapshot.bounds.x, snapshot.bounds.y])),
        _ => None,
    }
}

pub(super) fn centered_value(snapshot: &NativeSnapshot, action: &GeometryAction) -> Option<Value> {
    if !matches!(action, GeometryAction::Center) {
        return None;
    }
    let mut bounds = serde_json::to_value(&snapshot.bounds).ok()?;
    if let Value::Object(object) = &mut bounds {
        object.insert("centered".to_string(), Value::Bool(true));
    }
    Some(bounds)
}

fn parse_bounds(args: &[Value]) -> Result<GeometryAction, String> {
    exact_args(args, 1, "setBounds")?;
    let object = args[0]
        .as_object()
        .ok_or_else(|| invalid("setBounds expects a bounds object"))?;
    const KEYS: &[&str] = &["x", "y", "width", "height"];
    if object.keys().any(|key| !KEYS.contains(&key.as_str())) {
        return Err(invalid("setBounds accepts only x, y, width, and height"));
    }
    let x = position(object.get("x"), "x")?;
    let y = position(object.get("y"), "y")?;
    let width = dimension(object.get("width"), "width")?;
    let height = dimension(object.get("height"), "height")?;
    Ok(GeometryAction::SetBounds {
        x,
        y,
        width,
        height,
    })
}

fn parse_content_size(args: &[Value]) -> Result<GeometryAction, String> {
    if (2..=3).contains(&args.len()) {
        let animate = args.last().and_then(Value::as_bool);
        if animate.is_some() {
            if animate == Some(true) {
                return Err(unsupported(
                    "animated setContentSize is not available from the native host",
                ));
            }
            let (width, height) = parse_size(&args[..args.len() - 1])?;
            return Ok(GeometryAction::SetContentSize { width, height });
        }
    }
    let (width, height) = parse_size(args)?;
    Ok(GeometryAction::SetContentSize { width, height })
}

fn parse_size(args: &[Value]) -> Result<(f64, f64), String> {
    if args.len() == 1 {
        if let Some(array) = args[0].as_array() {
            if array.len() != 2 {
                return Err(invalid("size array must contain exactly [width, height]"));
            }
            return Ok((
                dimension(array.first(), "width")?,
                dimension(array.get(1), "height")?,
            ));
        }
        if let Some(object) = args[0].as_object() {
            return Ok((
                dimension(object.get("width"), "width")?,
                dimension(object.get("height"), "height")?,
            ));
        }
    }
    if args.len() == 2 {
        return Ok((
            dimension(args.first(), "width")?,
            dimension(args.get(1), "height")?,
        ));
    }
    Err(invalid("expected size as [width, height] or width, height"))
}

fn parse_constraint(args: &[Value], minimum: bool) -> Result<GeometryAction, String> {
    let name = if minimum {
        "setMinimumSize"
    } else {
        "setMaximumSize"
    };
    let (width, height) = parse_constraint_size(args, name)?;
    if minimum {
        Ok(GeometryAction::SetMinimumSize { width, height })
    } else {
        Ok(GeometryAction::SetMaximumSize { width, height })
    }
}

fn parse_constraint_size(args: &[Value], name: &str) -> Result<(Option<f64>, Option<f64>), String> {
    let pair = if args.len() == 1 {
        if let Some(array) = args[0].as_array() {
            if array.len() != 2 {
                return Err(invalid(format!("{name} expects [width, height]")));
            }
            (array.first(), array.get(1))
        } else if let Some(object) = args[0].as_object() {
            (object.get("width"), object.get("height"))
        } else {
            return Err(invalid(format!("{name} expects [width, height]")));
        }
    } else if args.len() == 2 {
        (args.first(), args.get(1))
    } else {
        return Err(invalid(format!(
            "{name} expects [width, height] or width, height"
        )));
    };
    Ok((constraint(pair.0, "width")?, constraint(pair.1, "height")?))
}

fn parse_position(args: &[Value]) -> Result<GeometryAction, String> {
    let (x, y) = if args.len() == 1 {
        if let Some(array) = args[0].as_array() {
            if array.len() != 2 {
                return Err(invalid("setPosition expects [x, y]"));
            }
            (array.first(), array.get(1))
        } else if let Some(object) = args[0].as_object() {
            (object.get("x"), object.get("y"))
        } else {
            return Err(invalid("setPosition expects [x, y]"));
        }
    } else if args.len() == 2 {
        (args.first(), args.get(1))
    } else {
        return Err(invalid("setPosition expects [x, y] or x, y"));
    };
    Ok(GeometryAction::SetPosition {
        x: position(x, "x")?,
        y: position(y, "y")?,
    })
}

fn no_args(args: &[Value]) -> Result<(), String> {
    exact_args(args, 0, "action")
}

fn exact_args(args: &[Value], count: usize, name: &str) -> Result<(), String> {
    if args.len() == count {
        Ok(())
    } else {
        Err(invalid(format!("{name} expects {count} argument(s)")))
    }
}

fn position(value: Option<&Value>, name: &str) -> Result<f64, String> {
    let number = finite_number(value, name)?;
    if number.abs() > MAX_COORDINATE {
        return Err(invalid(format!("{name} must be within ±{MAX_COORDINATE}")));
    }
    Ok(number)
}

fn dimension(value: Option<&Value>, name: &str) -> Result<f64, String> {
    let number = finite_number(value, name)?;
    if number <= 0.0 || number > MAX_DIMENSION {
        return Err(invalid(format!(
            "{name} must be greater than 0 and at most {MAX_DIMENSION}"
        )));
    }
    Ok(number)
}

fn constraint(value: Option<&Value>, name: &str) -> Result<Option<f64>, String> {
    let number = finite_number(value, name)?;
    if number < 0.0 || number > MAX_DIMENSION {
        return Err(invalid(format!(
            "{name} must be 0/unbounded or at most {MAX_DIMENSION}"
        )));
    }
    Ok((number > 0.0).then_some(number))
}

fn finite_number(value: Option<&Value>, name: &str) -> Result<f64, String> {
    let number = value
        .and_then(Value::as_f64)
        .ok_or_else(|| invalid(format!("{name} must be a finite number")))?;
    if number.is_finite() {
        Ok(number)
    } else {
        Err(invalid(format!("{name} must be a finite number")))
    }
}

fn invalid(message: impl AsRef<str>) -> String {
    format!(
        "ERR_ATOOLS_NATIVE_WINDOW_INVALID_OPTIONS: {}",
        message.as_ref()
    )
}

fn unsupported(message: impl AsRef<str>) -> String {
    format!("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED: {}", message.as_ref())
}
