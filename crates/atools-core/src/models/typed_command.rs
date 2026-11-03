//! Accept both legacy regex keys without rejecting a declaration that carries both.
use super::{deserialize_length_field, deserialize_match_field, CmdType, CmdTyped};
use serde::Deserialize;

#[derive(Deserialize)]
pub(super) struct Wire {
    #[serde(rename = "type")]
    type_: CmdType,
    label: Option<String>,
    #[serde(
        default,
        rename = "match",
        deserialize_with = "deserialize_match_field"
    )]
    match_: Option<String>,
    #[serde(default, deserialize_with = "deserialize_match_field")]
    regex: Option<String>,
    #[serde(default)]
    exclude: Option<String>,
    #[serde(
        default,
        alias = "minLength",
        deserialize_with = "deserialize_length_field"
    )]
    length: Option<u32>,
    #[serde(
        default,
        rename = "maxLength",
        deserialize_with = "deserialize_length_field"
    )]
    max_length: Option<u32>,
    #[serde(default, rename = "fileType")]
    file_type: Option<String>,
    #[serde(default)]
    extensions: Option<Vec<String>>,
}

impl From<Wire> for CmdTyped {
    fn from(wire: Wire) -> Self {
        Self {
            type_: wire.type_,
            label: wire.label,
            match_: wire.match_.or(wire.regex),
            exclude: wire.exclude,
            length: wire.length,
            max_length: wire.max_length,
            file_type: wire.file_type,
            extensions: wire.extensions,
        }
    }
}
