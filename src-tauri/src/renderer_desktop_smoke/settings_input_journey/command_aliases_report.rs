use super::command_aliases_schema as schema;
use serde_json::{json, Value};

pub(super) fn build(
    profile: &super::super::profile::Profile,
    observations: Value,
    errors: &[&'static str],
) -> Value {
    json!({
        "schemaVersion": 1,
        "journey": "settings-command-aliases",
        "scope": schema::SCOPE,
        "identifier": profile.identifier,
        "root": profile.root.to_string_lossy(),
        "pid": std::process::id(),
        "runId": profile.run_id,
        "observations": observations,
        "errors": errors,
    })
}

pub(super) fn write(
    profile: &super::super::profile::Profile,
    value: &Value,
) -> Result<(), &'static str> {
    if !schema::valid_report(value) {
        return Err(schema::REPORT_WRITE_FAILED);
    }
    super::local_app_search_report::write_owned_artifact(profile, schema::REPORT_NAME, value)
        .map_err(|_| schema::REPORT_WRITE_FAILED)
}
