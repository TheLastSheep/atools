use atools_core::agent::{PermissionScope, ToolDefinition};
use serde_json::json;

pub(crate) const TOOL: &str = "convert_ztools_plugin";
pub(crate) const INSPECT_TOOL: &str = "inspect_ztools_source_build";

fn build_steps_schema() -> serde_json::Value {
    json!({"type":"array","minItems":1,"maxItems":12,"items":{"oneOf":[
        {"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"const":"typecheck"}}},
        {"type":"object","additionalProperties":false,"required":["kind","files"],"properties":{"kind":{"const":"nodeTests"},"files":{"type":"integer","minimum":1,"maximum":128}}},
        {"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"const":"viteBuild"}}},
        {"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"const":"packageScript"}}}
    ]}})
}

fn manifest_identity_schema() -> serde_json::Value {
    json!({"type":"object","additionalProperties":false,"x-maxCanonicalJsonUtf8Bytes":270336,"required":["id","version","main","preload","runtime","featureCodes"],"properties":{
        "id":{"type":"string","maxLength":256,"x-maxUtf8Bytes":256},"version":{"type":"string","maxLength":256,"x-maxUtf8Bytes":256},
        "main":{"type":"string","maxLength":4096,"x-maxUtf8Bytes":4096},"preload":{"type":["string","null"],"maxLength":4096,"x-maxUtf8Bytes":4096},
        "runtime":{"enum":["web","node"]},"featureCodes":{"type":"array","maxItems":1000,"items":{"type":"string","maxLength":256,"x-maxUtf8Bytes":256}}
    }})
}

fn manifest_selection_schema() -> serde_json::Value {
    json!({"type":["string","null"],"enum":["root","public",null]})
}

fn manifest_selection_input_schema() -> serde_json::Value {
    json!({"type":"string","enum":["root","public"]})
}

fn manifest_sha_schema() -> serde_json::Value {
    json!({"type":["string","null"],"pattern":"^[a-f0-9]{64}$"})
}

fn manifest_sha_input_schema() -> serde_json::Value {
    json!({"type":"string","pattern":"^[a-f0-9]{64}$"})
}

fn manifest_metadata_schema() -> serde_json::Value {
    json!({
        "x-maxCanonicalJsonUtf8Bytes":1048576,
        "required":["manifestSelection","manifestSha256","manifestIdentity","manifestCandidates","manifestDifferences"],
        "properties":{
            "manifestSelection":manifest_selection_schema(),
            "manifestSha256":manifest_sha_schema(),
            "manifestIdentity":{"oneOf":[manifest_identity_schema(),{"type":"null"}]},
            "manifestCandidates":{"type":"array","minItems":2,"maxItems":2,"items":{"oneOf":[
                {"type":"object","additionalProperties":false,"required":["selection","status","code"],"properties":{"selection":{"enum":["root","public"]},"status":{"enum":["missing","invalid"]},"code":{"enum":["manifest_missing","manifest_invalid"]}}},
                {"type":"object","additionalProperties":false,"required":["selection","status","manifestSha256","identity"],"properties":{"selection":{"enum":["root","public"]},"status":{"const":"valid"},"manifestSha256":{"type":"string","pattern":"^[a-f0-9]{64}$"},"identity":manifest_identity_schema()}}
            ]}},
            "manifestDifferences":{"type":"array","maxItems":6,"uniqueItems":true,"items":{"enum":["id","version","main","preload","runtime","featureCodes"]}}
        }
    })
}

pub(crate) fn inspection_tool_definition() -> ToolDefinition {
    let mut output_schema = json!({"type":"object","required":["status","blockers"],"properties":{
        "status":{"enum":["eligible","already_ready","blocked"]},
        "blockers":{"type":"array","maxItems":64},
        "buildSteps":build_steps_schema()
    }});
    let metadata = manifest_metadata_schema();
    for field in metadata["required"].as_array().into_iter().flatten() {
        output_schema["required"]
            .as_array_mut()
            .unwrap()
            .push(field.clone());
    }
    if let Some(properties) = metadata["properties"].as_object() {
        for (name, schema) in properties {
            output_schema["properties"][name.as_str()] = schema.clone();
        }
    }
    ToolDefinition {
        name: INSPECT_TOOL.into(),
        description: "Inspect a selected local ZTools source project without executing it. Returns precise build blockers, an ordered bounded buildSteps summary when eligible, and a sourceRevision for convert_ztools_plugin. A plan is not runtime usability or a complete dependency closure proof.".into(),
        input_schema: json!({"type":"object","additionalProperties":false,"required":["sourcePath"],"properties":{
            "sourcePath":{"type":"string","minLength":1,"maxLength":4096},
            "manifestSelection":manifest_selection_input_schema()
        }}),
        output_schema: Some(output_schema),
        scopes: vec![PermissionScope::FileRead], enabled_by_default: true, enabled: true,
        source: "builtin".into(), plugin_id: None,
    }
}

pub(crate) fn tool_definition() -> ToolDefinition {
    ToolDefinition {
        name: TOOL.into(),
        description: "Build a selected local ZTools source package by running its inspected type-check, tests, Vite build, and bounded package-local build steps; validate the distribution and install it transactionally. No dependency installation or network access is requested. Requires inspect_ztools_source_build sourceRevision and runs the ordered steps shown by inspection. This executes package build code in a restricted macOS worker; aggregate process-tree CPU/RSS containment is not established.".into(),
        input_schema: json!({ "type":"object", "additionalProperties":false, "required":["sourcePath","expectedRevision"], "properties": {
            "sourcePath":{"type":"string","minLength":1,"maxLength":4096},
            "expectedRevision":{"type":"string","pattern":"^[a-f0-9]{64}$"},
            "overwrite":{"type":"boolean","default":false},
            "manifestSelection":manifest_selection_input_schema(),
            "expectedManifestSha256":manifest_sha_input_schema()
        },"oneOf":[
            {"not":{"anyOf":[{"required":["manifestSelection"]},{"required":["expectedManifestSha256"]}]}},
            {"required":["manifestSelection","expectedManifestSha256"]}
        ]}),
        output_schema: Some(json!({"type":"object","required":["installed","pluginId","sourceRevision","buildSteps","manifestSelection","manifestSha256"],"properties":{
            "buildSteps":build_steps_schema(),"manifestSelection":{"enum":["root","public"]},
            "manifestSha256":{"type":"string","pattern":"^[a-f0-9]{64}$"}
        }})),
        scopes: vec![PermissionScope::FileRead, PermissionScope::FileWrite, PermissionScope::Shell],
        enabled_by_default: true, enabled: true, source: "builtin".into(), plugin_id: None,
    }
}
