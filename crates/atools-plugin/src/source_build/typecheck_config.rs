//! Conservative support for bare local TypeScript compiler scripts.
//!
//! Explicit `tsc --noEmit` / `vue-tsc --noEmit` use fixed CLI forms that pass `--noEmit`.
//! Bare forms additionally require a strict root config proving no regular output
//! is emitted; incremental metadata output is excluded as well.
use std::fmt;
use std::path::Path;

use serde::de::{Error as DeError, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Number, Value};

use crate::package_resolution::read_package_asset_bytes;

use super::ScriptPlanError;

const TSCONFIG_LIMIT: usize = 1024 * 1024;

#[derive(Clone, Copy)]
pub(super) enum TypecheckTool {
    Tsc,
    VueTsc,
}

impl TypecheckTool {
    pub(super) fn package_name(self) -> &'static str {
        match self {
            Self::Tsc => "typescript",
            Self::VueTsc => "vue-tsc",
        }
    }
}

pub(super) fn recognized_command(
    root: &Path,
    tokens: &[&str],
) -> Result<Option<TypecheckTool>, ScriptPlanError> {
    let (tool, bare) = match tokens {
        ["tsc"] => (TypecheckTool::Tsc, true),
        ["tsc", "--noEmit"] => (TypecheckTool::Tsc, false),
        ["vue-tsc"] => (TypecheckTool::VueTsc, true),
        ["vue-tsc", "--noEmit"] => (TypecheckTool::VueTsc, false),
        _ => return Ok(None),
    };
    if bare {
        validate_bare_config(root)?;
    }
    Ok(Some(tool))
}

fn validate_bare_config(root: &Path) -> Result<(), ScriptPlanError> {
    let bytes = read_package_asset_bytes(root, Path::new("tsconfig.json"), TSCONFIG_LIMIT)
        .map_err(|_| ScriptPlanError::TypecheckConfigUnsupported)?
        .ok_or(ScriptPlanError::TypecheckConfigUnsupported)?;
    let mut deserializer = serde_json::Deserializer::from_slice(&bytes);
    let parsed = UniqueValue::deserialize(&mut deserializer)
        .map_err(|_| ScriptPlanError::TypecheckConfigUnsupported)?;
    deserializer
        .end()
        .map_err(|_| ScriptPlanError::TypecheckConfigUnsupported)?;
    let config = parsed
        .0
        .as_object()
        .ok_or(ScriptPlanError::TypecheckConfigUnsupported)?;
    if config.contains_key("extends") || config.contains_key("references") {
        return Err(ScriptPlanError::TypecheckConfigUnsupported);
    }
    let options = config
        .get("compilerOptions")
        .and_then(Value::as_object)
        .ok_or(ScriptPlanError::TypecheckConfigUnsupported)?;
    if options.get("noEmit") != Some(&Value::Bool(true))
        || enabled(options, "incremental")?
        || enabled(options, "composite")?
        || options.contains_key("tsBuildInfoFile")
    {
        return Err(ScriptPlanError::TypecheckConfigUnsupported);
    }
    Ok(())
}

fn enabled(options: &Map<String, Value>, key: &str) -> Result<bool, ScriptPlanError> {
    match options.get(key) {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(ScriptPlanError::TypecheckConfigUnsupported),
    }
}

/// serde_json normally accepts duplicate object keys by retaining one value.
/// A bare compiler config is security-relevant, so reject duplicates instead.
struct UniqueValue(Value);

impl<'de> Deserialize<'de> for UniqueValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(UniqueVisitor)
    }
}

struct UniqueVisitor;

impl<'de> Visitor<'de> for UniqueVisitor {
    type Value = UniqueValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value without duplicate object keys")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Number(value.into())))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Number(value.into())))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: DeError,
    {
        Number::from_f64(value)
            .map(Value::Number)
            .map(UniqueValue)
            .ok_or_else(|| E::custom("invalid JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::String(value.to_owned())))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::String(value)))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Null))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Null))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<UniqueValue>()? {
            values.push(value.0);
        }
        Ok(UniqueValue(Value::Array(values)))
    }

    fn visit_map<A>(self, mut entries: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = Map::new();
        while let Some(key) = entries.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(A::Error::custom("duplicate JSON object key"));
            }
            let value = entries.next_value::<UniqueValue>()?;
            values.insert(key, value.0);
        }
        Ok(UniqueValue(Value::Object(values)))
    }
}
