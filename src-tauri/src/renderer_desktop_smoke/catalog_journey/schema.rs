use super::report::{DomObservation, NativeObservation, Stage, StageObservation};
use serde_json::Value;

const MAX_DOM_BYTES: usize = 16 * 1024;
const MAX_INPUT_BYTES: usize = 64;
const MAX_TITLES: usize = 16;
const MAX_TITLE_BYTES: usize = 128;

pub(super) fn parse_dom(value: Value) -> Result<DomObservation, &'static str> {
    if serde_json::to_vec(&value).map_or(true, |bytes| bytes.len() > MAX_DOM_BYTES) {
        return Err("catalog-probe-protocol-rejected");
    }
    let dom: DomObservation =
        serde_json::from_value(value).map_err(|_| "catalog-probe-protocol-rejected")?;
    if dom.input_value.len() > MAX_INPUT_BYTES
        || dom.titles.len() > MAX_TITLES
        || dom.titles.iter().any(|title| title.len() > MAX_TITLE_BYTES)
        || !matches!(
            dom.document_visibility.as_str(),
            "hidden" | "visible" | "prerender" | "unloaded"
        )
    {
        return Err("catalog-probe-protocol-rejected");
    }
    Ok(dom)
}

pub(super) fn validate_stage(
    stage: Stage,
    index: usize,
    previous: &[StageObservation],
    dom: &DomObservation,
    native: &NativeObservation,
) -> Result<(), &'static str> {
    if !dom.valid_for(stage, index, previous) {
        return Err("catalog-dom-stage-evidence-incomplete");
    }
    if !native.valid_for(stage) {
        return Err("catalog-hidden-native-state-not-verified");
    }
    Ok(())
}

#[cfg(test)]
#[path = "schema_tests.rs"]
mod tests;
