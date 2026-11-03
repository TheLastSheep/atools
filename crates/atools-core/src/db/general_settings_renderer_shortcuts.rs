//! Lossless overlay for the two renderer-owned shortcut switches.
use std::{collections::BTreeMap, fmt};

use serde::{
    de::{Error, MapAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{value::RawValue, Value};

use crate::error::Result;

const FIELD: &str = "builtinAppShortcutsEnabled";

#[derive(Default, serde::Serialize)]
#[serde(transparent)]
struct RawObject(BTreeMap<String, Box<RawValue>>);

impl<'de> Deserialize<'de> for RawObject {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = RawObject;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON object without duplicate keys")
            }

            fn visit_map<M: MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let mut fields = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                    if fields.insert(key, value).is_some() {
                        return Err(M::Error::custom("duplicate settings key"));
                    }
                }
                Ok(RawObject(fields))
            }
        }
        deserializer.deserialize_map(ObjectVisitor)
    }
}

pub(super) fn merge(current: Option<&str>, changes: &BTreeMap<String, Value>) -> Result<String> {
    // Retain the shared 64 KiB, JSON-shape and depth checks before preserving opaque values.
    super::parse_settings(current)?;
    let mut settings = match current {
        Some(raw) => parse_object(raw)?,
        None => RawObject::default(),
    };
    for (key, value) in changes {
        if key == FIELD {
            let mut nested = match settings.0.remove(FIELD) {
                Some(raw) => parse_object(raw.get())?,
                None => RawObject::default(),
            };
            let patch = value.as_object().ok_or_else(invalid)?;
            for (name, value) in patch {
                nested.0.insert(name.clone(), raw_value(value)?);
            }
            settings.0.insert(key.clone(), raw_value(&nested)?);
        } else {
            settings.0.insert(key.clone(), raw_value(value)?);
        }
    }
    let raw = serde_json::to_string(&settings)?;
    super::ensure_stored_size(&raw)?;
    Ok(raw)
}

fn parse_object(raw: &str) -> Result<RawObject> {
    serde_json::from_str(raw).map_err(|_| invalid())
}

fn raw_value(value: &impl serde::Serialize) -> Result<Box<RawValue>> {
    let encoded = serde_json::to_string(value)?;
    RawValue::from_string(encoded).map_err(|_| invalid())
}

fn invalid() -> crate::error::AToolsError {
    super::invalid("Stored General shortcut settings cannot be safely merged")
}
