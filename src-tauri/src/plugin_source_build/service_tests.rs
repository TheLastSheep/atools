use super::api::{BuildArguments, InspectionArguments};
use serde_json::json;

#[test]
fn source_build_arguments_require_exact_snapshot_and_reject_unknown_execution_options() {
    let valid = json!({"sourcePath":"/tmp/project","expectedRevision":"a".repeat(64)});
    assert!(BuildArguments::parse(valid.clone()).is_ok());
    assert!(BuildArguments::parse(json!({
        "sourcePath":"/tmp/project","expectedRevision":"a".repeat(64),
        "manifestSelection":"public","expectedManifestSha256":"b".repeat(64)
    }))
    .is_ok());
    for input in [
        json!({"sourcePath":"project","expectedRevision":"a".repeat(64)}),
        json!({"sourcePath":"/tmp/project","expectedRevision":"A".repeat(64)}),
        json!({"sourcePath":"/tmp/project","expectedRevision":"short"}),
        json!({"sourcePath":"/tmp/project","expectedRevision":"a".repeat(64),"command":"npm install"}),
        json!({"sourcePath":"/tmp/project","expectedRevision":"a".repeat(64),"manifestSelection":"root"}),
        json!({"sourcePath":"/tmp/project","expectedRevision":"a".repeat(64),"expectedManifestSha256":"b".repeat(64)}),
        json!({"sourcePath":"/tmp/project","expectedRevision":"a".repeat(64),"manifestSelection":"root","expectedManifestSha256":"B".repeat(64)}),
        json!({"sourcePath":"/tmp/project","expectedRevision":"a".repeat(64),"manifestSelection":"unknown","expectedManifestSha256":"b".repeat(64)}),
    ] {
        assert!(BuildArguments::parse(input).is_err());
    }
}

#[test]
fn explicit_null_manifest_arguments_are_not_treated_as_omitted() {
    let revision = "a".repeat(64);
    for input in [
        json!({"sourcePath":"/tmp/project","expectedRevision":revision.clone(),"manifestSelection":null,"expectedManifestSha256":"b".repeat(64)}),
        json!({"sourcePath":"/tmp/project","expectedRevision":revision.clone(),"manifestSelection":"root","expectedManifestSha256":null}),
        json!({"sourcePath":"/tmp/project","expectedRevision":revision,"manifestSelection":null,"expectedManifestSha256":null}),
    ] {
        assert!(BuildArguments::parse(input).is_err());
    }
    assert!(InspectionArguments::parse(
        json!({"sourcePath":"/tmp/project","manifestSelection":null})
    )
    .is_err());
    assert!(InspectionArguments::parse(json!({"sourcePath":"/tmp/project"})).is_ok());
}

#[test]
fn source_build_registry_requests_write_and_shell_without_network() {
    use atools_core::agent::PermissionScope;
    let tool = super::registry::tool_definition();
    assert_eq!(tool.name, "convert_ztools_plugin");
    assert!(tool.scopes.contains(&PermissionScope::Shell));
    assert!(tool.scopes.contains(&PermissionScope::FileWrite));
    assert!(!tool.scopes.contains(&PermissionScope::Network));
    assert_eq!(tool.input_schema["additionalProperties"], false);
}

#[test]
fn source_build_registry_documents_the_ordered_step_summary_contract() {
    let inspect = super::registry::inspection_tool_definition();
    let inspect_schema = inspect.output_schema.unwrap();
    assert!(!inspect_schema["required"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "buildSteps"));
    let step_schema = &inspect_schema["properties"]["buildSteps"];
    assert_eq!(step_schema["minItems"], 1);
    assert_eq!(step_schema["maxItems"], 12);
    let variants = step_schema["items"]["oneOf"].as_array().unwrap();
    assert_eq!(variants.len(), 4);
    let tests = variants
        .iter()
        .find(|variant| variant["properties"]["kind"]["const"] == "nodeTests")
        .unwrap();
    assert_eq!(tests["properties"]["files"]["minimum"], 1);
    assert_eq!(tests["properties"]["files"]["maximum"], 128);
    assert_eq!(tests["required"], json!(["kind", "files"]));
    assert_eq!(
        variants
            .iter()
            .filter(|variant| variant["properties"]["files"].is_null())
            .count(),
        3
    );
    assert!(inspect_schema["required"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "manifestCandidates"));
    assert_eq!(
        inspect_schema["properties"]["manifestCandidates"]["minItems"],
        2
    );
    assert_eq!(
        inspect_schema["properties"]["manifestCandidates"]["maxItems"],
        2
    );
    let identity = &inspect_schema["properties"]["manifestIdentity"]["oneOf"][0];
    assert_eq!(identity["properties"]["featureCodes"]["maxItems"], 1000);
    assert_eq!(
        identity["properties"]["featureCodes"]["items"]["maxLength"],
        256
    );

    let convert = super::registry::tool_definition();
    let convert_schema = convert.output_schema.unwrap();
    assert!(convert_schema["required"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "buildSteps"));
    assert_eq!(convert_schema["properties"]["buildSteps"], *step_schema);
    let convert = super::registry::tool_definition();
    assert_eq!(convert.input_schema["oneOf"].as_array().unwrap().len(), 2);
    let inspect_input = super::registry::inspection_tool_definition().input_schema;
    assert_eq!(
        inspect_input["properties"]["manifestSelection"]["type"],
        "string"
    );
    let convert_input = convert.input_schema;
    assert_eq!(
        convert_input["properties"]["manifestSelection"]["type"],
        "string"
    );
    assert_eq!(
        convert_input["properties"]["expectedManifestSha256"]["type"],
        "string"
    );
}
