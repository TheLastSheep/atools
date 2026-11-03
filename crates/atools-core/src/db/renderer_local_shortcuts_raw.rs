//! Raw JSON token accounting and surgical edits that preserve unknown values.

use std::fmt;

use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};

use super::{
    invalid,
    records::{MAX_JSON_DEPTH, MAX_JSON_NODES},
};
use crate::error::Result;

pub(super) fn count_record_nodes(raw: &str) -> Result<usize> {
    count_json_nodes(raw, 2)
}

pub(super) fn replace_display_fields(
    raw: &str,
    alias: Option<&str>,
    pinyin: &str,
    pinyin_abbr: &str,
) -> Result<String> {
    const FIELDS: [&str; 3] = ["alias", "pinyin", "pinyinAbbr"];
    let encoded_values = [
        alias.map(encode_string).transpose()?,
        Some(encode_string(pinyin)?),
        Some(encode_string(pinyin_abbr)?),
    ];
    let encoded_keys = [
        serde_json::to_string(FIELDS[0])
            .map_err(|_| invalid("display key serialization failed"))?,
        serde_json::to_string(FIELDS[1])
            .map_err(|_| invalid("display key serialization failed"))?,
        serde_json::to_string(FIELDS[2])
            .map_err(|_| invalid("display key serialization failed"))?,
    ];
    let (open, close, members) = object_members(raw)?;
    let mut seen = [false; 3];
    let mut actions = Vec::with_capacity(members.len());
    let mut kept_members = 0usize;
    let mut body_bytes = 0usize;
    for member in &members {
        let update_index = FIELDS.iter().position(|name| *name == member.key.as_str());
        let action = match update_index {
            Some(index) => {
                seen[index] = true;
                if encoded_values[index].is_some() {
                    MemberAction::Replace(index)
                } else {
                    MemberAction::Remove
                }
            }
            None => MemberAction::Keep,
        };
        if !matches!(action, MemberAction::Remove) {
            kept_members += 1;
            let member_bytes = member.segment_end - member.segment_start;
            let output_bytes = match action {
                MemberAction::Replace(index) => member_bytes
                    .checked_sub(member.value_end - member.value_start)
                    .and_then(|size| size.checked_add(encoded_values[index].as_ref()?.len()))
                    .ok_or_else(|| invalid("display field size overflow"))?,
                MemberAction::Keep => member_bytes,
                MemberAction::Remove => 0,
            };
            body_bytes = body_bytes
                .checked_add(output_bytes)
                .ok_or_else(|| invalid("display field size overflow"))?;
        }
        actions.push(action);
    }
    body_bytes = body_bytes
        .checked_add(kept_members.saturating_sub(1))
        .ok_or_else(|| invalid("display field size overflow"))?;
    let additions = (0..FIELDS.len())
        .filter(|index| !seen[*index] && encoded_values[*index].is_some())
        .collect::<Vec<_>>();
    let mut addition_bytes = 0usize;
    for index in &additions {
        addition_bytes = addition_bytes
            .checked_add(encoded_keys[*index].len())
            .and_then(|size| size.checked_add(1))
            .and_then(|size| size.checked_add(encoded_values[*index].as_ref()?.len()))
            .ok_or_else(|| invalid("display field size overflow"))?;
    }
    body_bytes = body_bytes
        .checked_add(addition_bytes)
        .and_then(|size| size.checked_add(additions.len().saturating_sub(1)))
        .and_then(|size| {
            size.checked_add(if kept_members > 0 && !additions.is_empty() {
                1
            } else {
                0
            })
        })
        .ok_or_else(|| invalid("display field size overflow"))?;
    let output_bytes = (open + 1)
        .checked_add(body_bytes)
        .and_then(|size| size.checked_add(raw.len() - close))
        .ok_or_else(|| invalid("display field size overflow"))?;
    if output_bytes > super::records::MAX_STORED_BYTES {
        return Err(invalid("updated record exceeds 128 KiB"));
    }

    let mut pieces = Vec::with_capacity(kept_members);
    for (member, action) in members.iter().zip(actions) {
        match action {
            MemberAction::Keep => {
                pieces.push(raw[member.segment_start..member.segment_end].to_owned())
            }
            MemberAction::Replace(index) => {
                let encoded = encoded_values[index].as_ref().unwrap();
                let mut piece = String::with_capacity(member.segment_end - member.segment_start);
                piece.push_str(&raw[member.segment_start..member.value_start]);
                piece.push_str(encoded);
                piece.push_str(&raw[member.value_end..member.segment_end]);
                pieces.push(piece);
            }
            MemberAction::Remove => {}
        }
    }
    let additions = additions
        .into_iter()
        .map(|index| {
            format!(
                "{}:{}",
                encoded_keys[index],
                encoded_values[index].as_ref().unwrap()
            )
        })
        .collect::<Vec<_>>();

    let body = join_members(&pieces, &additions);
    let mut output = String::with_capacity(output_bytes);
    output.push_str(&raw[..open + 1]);
    output.push_str(&body);
    output.push_str(&raw[close..]);
    if output.len() != output_bytes {
        return Err(invalid("updated record size changed after validation"));
    }
    Ok(output)
}

fn encode_string(value: &str) -> Result<String> {
    let size = super::super::bounded_json::serialized_size(value, super::records::MAX_STORED_BYTES)
        .ok_or_else(|| invalid("display field exceeds 128 KiB"))?;
    let encoded =
        serde_json::to_string(value).map_err(|_| invalid("display field serialization failed"))?;
    if encoded.len() != size {
        return Err(invalid("display field size changed after validation"));
    }
    Ok(encoded)
}

#[derive(Clone, Copy)]
enum MemberAction {
    Keep,
    Replace(usize),
    Remove,
}

fn join_members(pieces: &[String], additions: &[String]) -> String {
    let mut joined = pieces.join(",");
    if !additions.is_empty() {
        if !joined.is_empty() {
            joined.push(',');
        }
        joined.push_str(&additions.join(","));
    }
    joined
}

#[derive(Debug)]
struct RawObjectMember {
    key: String,
    segment_start: usize,
    segment_end: usize,
    value_start: usize,
    value_end: usize,
}

fn object_members(raw: &str) -> Result<(usize, usize, Vec<RawObjectMember>)> {
    let bytes = raw.as_bytes();
    let open = skip_whitespace(bytes, 0);
    let trimmed_end = trim_end_whitespace(bytes);
    if bytes.get(open) != Some(&b'{')
        || trimmed_end <= open + 1
        || bytes.get(trimmed_end - 1) != Some(&b'}')
    {
        return Err(invalid("record is not a JSON object"));
    }
    let close = trimmed_end - 1;
    let mut members = Vec::new();
    let mut segment_start = open + 1;
    let mut cursor = skip_whitespace(bytes, segment_start);
    while cursor < close {
        let key_end = scan_string(bytes, cursor)?;
        let key: String = serde_json::from_str(&raw[cursor..key_end])
            .map_err(|_| invalid("record object key is invalid"))?;
        let colon = skip_whitespace(bytes, key_end);
        if bytes.get(colon) != Some(&b':') {
            return Err(invalid("record object is malformed"));
        }
        let value_start = skip_whitespace(bytes, colon + 1);
        let value_end = scan_value(bytes, value_start)?;
        let delimiter = skip_whitespace(bytes, value_end);
        members.push(RawObjectMember {
            key,
            segment_start,
            segment_end: delimiter,
            value_start,
            value_end,
        });
        match bytes.get(delimiter) {
            Some(b',') => {
                segment_start = delimiter + 1;
                cursor = skip_whitespace(bytes, segment_start);
            }
            Some(b'}') if delimiter == close => break,
            _ => return Err(invalid("record object is malformed")),
        }
    }
    Ok((open, close, members))
}

fn scan_value(bytes: &[u8], start: usize) -> Result<usize> {
    match bytes.get(start) {
        Some(b'"') => scan_string(bytes, start),
        Some(b'{') | Some(b'[') => {
            let mut stack = Vec::new();
            let mut in_string = false;
            let mut escaped = false;
            for (index, byte) in bytes.iter().enumerate().skip(start) {
                if in_string {
                    if escaped {
                        escaped = false;
                    } else if *byte == b'\\' {
                        escaped = true;
                    } else if *byte == b'"' {
                        in_string = false;
                    }
                    continue;
                }
                match byte {
                    b'"' => in_string = true,
                    b'{' => stack.push(b'}'),
                    b'[' => stack.push(b']'),
                    b'}' | b']' => {
                        if stack.pop() != Some(*byte) {
                            return Err(invalid("record JSON nesting is invalid"));
                        }
                        if stack.is_empty() {
                            return Ok(index + 1);
                        }
                    }
                    _ => {}
                }
            }
            Err(invalid("record JSON value is incomplete"))
        }
        Some(_) => {
            let mut end = start;
            while bytes
                .get(end)
                .is_some_and(|byte| !is_json_whitespace(*byte) && !matches!(byte, b',' | b'}'))
            {
                end += 1;
            }
            if end == start {
                Err(invalid("record JSON value is missing"))
            } else {
                Ok(end)
            }
        }
        None => Err(invalid("record JSON value is missing")),
    }
}

fn scan_string(bytes: &[u8], start: usize) -> Result<usize> {
    if bytes.get(start) != Some(&b'"') {
        return Err(invalid("record object key is not a string"));
    }
    let mut escaped = false;
    for (index, byte) in bytes.iter().enumerate().skip(start + 1) {
        if escaped {
            escaped = false;
        } else if *byte == b'\\' {
            escaped = true;
        } else if *byte == b'"' {
            return Ok(index + 1);
        }
    }
    Err(invalid("record string is incomplete"))
}

fn skip_whitespace(bytes: &[u8], mut index: usize) -> usize {
    while bytes
        .get(index)
        .is_some_and(|byte| is_json_whitespace(*byte))
    {
        index += 1;
    }
    index
}

fn trim_end_whitespace(bytes: &[u8]) -> usize {
    let mut index = bytes.len();
    while index > 0 && is_json_whitespace(bytes[index - 1]) {
        index -= 1;
    }
    index
}

fn is_json_whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\n' | b'\r' | b'\t')
}

struct NodeBudget {
    nodes: usize,
}

struct CountSeed<'a> {
    budget: &'a mut NodeBudget,
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for CountSeed<'_> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        if self.depth > MAX_JSON_DEPTH {
            return Err(serde::de::Error::custom("JSON depth limit exceeded"));
        }
        self.budget.nodes += 1;
        if self.budget.nodes > MAX_JSON_NODES {
            return Err(serde::de::Error::custom("JSON node limit exceeded"));
        }
        deserializer.deserialize_any(CountVisitor {
            budget: self.budget,
            depth: self.depth,
        })
    }
}

struct CountVisitor<'a> {
    budget: &'a mut NodeBudget,
    depth: usize,
}

impl<'de> Visitor<'de> for CountVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E>(self, _: bool) -> std::result::Result<(), E>
    where
        E: serde::de::Error,
    {
        Ok(())
    }

    fn visit_i64<E>(self, _: i64) -> std::result::Result<(), E>
    where
        E: serde::de::Error,
    {
        Ok(())
    }

    fn visit_u64<E>(self, _: u64) -> std::result::Result<(), E>
    where
        E: serde::de::Error,
    {
        Ok(())
    }

    fn visit_f64<E>(self, _: f64) -> std::result::Result<(), E>
    where
        E: serde::de::Error,
    {
        Ok(())
    }

    fn visit_str<E>(self, _: &str) -> std::result::Result<(), E>
    where
        E: serde::de::Error,
    {
        Ok(())
    }

    fn visit_string<E>(self, _: String) -> std::result::Result<(), E>
    where
        E: serde::de::Error,
    {
        Ok(())
    }

    fn visit_unit<E>(self) -> std::result::Result<(), E>
    where
        E: serde::de::Error,
    {
        Ok(())
    }

    fn visit_none<E>(self) -> std::result::Result<(), E>
    where
        E: serde::de::Error,
    {
        Ok(())
    }

    fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<(), A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence
            .next_element_seed(CountSeed {
                budget: &mut *self.budget,
                depth: self.depth + 1,
            })?
            .is_some()
        {}
        Ok(())
    }

    fn visit_map<A>(self, mut map: A) -> std::result::Result<(), A::Error>
    where
        A: MapAccess<'de>,
    {
        while map.next_key::<IgnoredAny>()?.is_some() {
            map.next_value_seed(CountSeed {
                budget: &mut *self.budget,
                depth: self.depth + 1,
            })?;
        }
        Ok(())
    }
}

pub(super) fn count_json_nodes(raw: &str, depth: usize) -> Result<usize> {
    let mut budget = NodeBudget { nodes: 0 };
    let mut deserializer = serde_json::Deserializer::from_str(raw);
    CountSeed {
        budget: &mut budget,
        depth,
    }
    .deserialize(&mut deserializer)
    .map_err(|_| invalid("JSON exceeds the depth or node budget"))?;
    deserializer
        .end()
        .map_err(|_| invalid("JSON has trailing data"))?;
    Ok(budget.nodes)
}
