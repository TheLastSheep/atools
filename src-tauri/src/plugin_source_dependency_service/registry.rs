use atools_core::agent::{PermissionScope, ToolDefinition};
use serde_json::json;

pub(crate) const INSPECT: &str = "inspect_ztools_source_dependencies";
pub(crate) const FETCH: &str = "fetch_ztools_source_dependencies";
pub(crate) const PREPARE: &str = "prepare_ztools_source_dependencies";
pub(crate) const CACHE_LIMIT: u64 = 512 * 1024 * 1024;
const PLAN_PACKAGE_LIMIT: u64 = 4_096;
const PLAN_ARCHIVE_BYTES_LIMIT: u64 = 128 * 1024 * 1024;
const UNPACKED_BYTES_LIMIT: u64 = 512 * 1024 * 1024;
const TREE_BYTES_LIMIT: u64 = 512 * 1024 * 1024 + 1024 * 1024;
const FILE_COUNT_LIMIT: u64 = 65_536;
const TREE_FILES_LIMIT: u64 = 65_537;
const TREE_ENTRIES_LIMIT: u64 = 65_536 + 4_096 * 32 + 1;
const NODE_BINARY_BYTES_LIMIT: u64 = 256 * 1024 * 1024;
const OPERATION_MS_LIMIT: u64 = 120_000;

fn source_revision_input() -> serde_json::Value {
    json!({"type":"object","additionalProperties":false,"required":["sourcePath"],"properties":{
        "sourcePath":{"type":"string","minLength":1,"maxLength":4096}
    }})
}
fn operation_input() -> serde_json::Value {
    json!({"type":"object","additionalProperties":false,"required":["sourcePath","expectedRevision"],"properties":{
        "sourcePath":{"type":"string","minLength":1,"maxLength":4096},
        "expectedRevision":{"type":"string","pattern":"^[a-f0-9]{64}$"}
    }})
}
fn tool(
    name: &str,
    description: &str,
    input: serde_json::Value,
    scopes: Vec<PermissionScope>,
) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: description.into(),
        input_schema: input,
        output_schema: Some(output_schema(name)),
        scopes,
        enabled_by_default: true,
        enabled: true,
        source: "builtin".into(),
        plugin_id: None,
    }
}

fn output_schema(name: &str) -> serde_json::Value {
    let hash = json!({"type":"string","pattern":"^[a-f0-9]{64}$"});
    let bounded_count = |maximum: u64| json!({"type":"integer","minimum":0,"maximum":maximum});
    let package_count = bounded_count(PLAN_PACKAGE_LIMIT);
    let archive_bytes = bounded_count(PLAN_ARCHIVE_BYTES_LIMIT);
    let tree_bytes = bounded_count(TREE_BYTES_LIMIT);
    let unpacked_bytes = bounded_count(UNPACKED_BYTES_LIMIT);
    let file_count = bounded_count(FILE_COUNT_LIMIT);
    let tree_files = bounded_count(TREE_FILES_LIMIT);
    let tree_entries = json!({"type":"integer","minimum":1,"maximum":TREE_ENTRIES_LIMIT});
    let elapsed_ms = bounded_count(OPERATION_MS_LIMIT);
    let hash_elapsed_ms = json!({"type":"integer","minimum":0});
    let node_bytes = json!({"type":"integer","minimum":1,"maximum":NODE_BINARY_BYTES_LIMIT});
    let properties = match name {
        INSPECT => json!({
            "status":{"const":"eligible"},"sourceRevision":hash,"planSha256":hash,
            "dependencySetIdSha256":hash,
            "target":{"type":"object","additionalProperties":false,"required":["os","cpu"],"properties":{"os":{"type":"string"},"cpu":{"type":"string"}}},
            "packageCount":package_count,"skippedOptionalCount":package_count,"cachedBytes":archive_bytes,"missingCount":package_count,
            "archiveBytes":{"type":["integer","null"],"minimum":0,"maximum":PLAN_ARCHIVE_BYTES_LIMIT},
            "dependencySetPrepared":{"type":"boolean"},
            "dependencyTreeSha256":{"type":["string","null"],"pattern":"^[a-f0-9]{64}$"},
            "dependencyTreeBytes":{"type":["integer","null"],"minimum":0,"maximum":TREE_BYTES_LIMIT},
            "nodeBinaryBytes":node_bytes,"nodeBinarySha256":hash,
            "toolchainFingerprintSha256":hash,"toolchainHashElapsedMs":hash_elapsed_ms,
            "lifecyclesSkipped":{"type":"boolean"},"dependencyClosureVerified":{"const":false},
            "businessUsabilityVerified":{"const":false}
        }),
        FETCH => json!({
            "status":{"const":"cached"},"sourceRevision":hash,"dependencySetIdSha256":hash,
            "packageCount":package_count,"cachedArchiveCount":package_count,"fetchedArchiveCount":package_count,
            "verifiedArchiveBytes":archive_bytes,"elapsedMs":elapsed_ms,"lifecyclesSkipped":{"type":"boolean"},
            "dependencySetPrepared":{"const":false},"businessUsabilityVerified":{"const":false}
        }),
        PREPARE => json!({
            "status":{"const":"prepared"},"sourceRevision":hash,"dependencySetIdSha256":hash,
            "manifestSha256":hash,"packageCount":package_count,"archiveBytes":archive_bytes,"unpackedBytes":unpacked_bytes,
            "fileCount":file_count,"treeSha256":hash,"treeEntries":tree_entries,"treeFiles":tree_files,
            "treeBytes":tree_bytes,"nodeBinaryBytes":node_bytes,
            "nodeBinarySha256":hash,"toolchainFingerprintSha256":hash,"toolchainHashElapsedMs":hash_elapsed_ms,
            "workerElapsedMs":elapsed_ms,"dependencyClosureVerified":{"const":false},
            "businessUsabilityVerified":{"const":false}
        }),
        _ => return json!({"type":"object","additionalProperties":false}),
    };
    let required = properties
        .as_object()
        .map(|fields| fields.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    json!({"type":"object","additionalProperties":false,"required":required,"properties":properties})
}

pub(crate) fn definitions() -> [ToolDefinition; 3] {
    [
        tool(INSPECT,
            "Inspect a local package-lock dependency plan and app-owned cache status. Does not download or execute package code; URLs and cache paths are not returned.",
            source_revision_input(), vec![PermissionScope::FileRead]),
        tool(FETCH,
            "Fetch only locked npm registry archives for a selected local project into the app-owned cache. Verifies lock integrity and requires FileRead, FileWrite, and Network permission. Does not run lifecycle scripts.",
            operation_input(), vec![PermissionScope::FileRead, PermissionScope::FileWrite, PermissionScope::Network]),
        tool(PREPARE,
            "Materialize a previously fetched locked dependency set in an isolated worker without network access or lifecycle scripts. Requires FileRead and FileWrite permission.",
            operation_input(), vec![PermissionScope::FileRead, PermissionScope::FileWrite]),
    ]
}

pub(crate) fn is_tool(name: &str) -> bool {
    matches!(name, INSPECT | FETCH | PREPARE)
}
pub(crate) fn is_mutating_tool(name: &str) -> bool {
    matches!(name, FETCH | PREPARE)
}
pub(crate) fn is_dependency_tool(name: &str) -> bool {
    is_tool(name)
}

pub(crate) fn capability(name: &str) -> bool {
    is_tool(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn maximum(schema: &serde_json::Value, field: &str) -> u64 {
        schema["properties"][field]["maximum"]
            .as_u64()
            .expect("bounded output field")
    }

    #[test]
    fn dependency_tool_output_schema_matches_frozen_service_caps() {
        let inspect = output_schema(INSPECT);
        assert_eq!(maximum(&inspect, "packageCount"), 4_096);
        assert_eq!(maximum(&inspect, "skippedOptionalCount"), 4_096);
        assert_eq!(maximum(&inspect, "missingCount"), 4_096);
        assert_eq!(maximum(&inspect, "cachedBytes"), PLAN_ARCHIVE_BYTES_LIMIT);
        assert_eq!(
            inspect["properties"]["archiveBytes"]["maximum"],
            PLAN_ARCHIVE_BYTES_LIMIT
        );
        assert_eq!(
            inspect["properties"]["dependencyTreeBytes"]["maximum"],
            537_919_488
        );
        assert_eq!(
            maximum(&inspect, "nodeBinaryBytes"),
            NODE_BINARY_BYTES_LIMIT
        );
        assert_eq!(
            inspect["properties"]["toolchainHashElapsedMs"]["minimum"],
            0
        );
        assert!(inspect["properties"]["toolchainHashElapsedMs"]
            .get("maximum")
            .is_none());

        let fetch = output_schema(FETCH);
        assert_eq!(maximum(&fetch, "packageCount"), 4_096);
        assert_eq!(maximum(&fetch, "cachedArchiveCount"), 4_096);
        assert_eq!(maximum(&fetch, "fetchedArchiveCount"), 4_096);
        assert_eq!(
            maximum(&fetch, "verifiedArchiveBytes"),
            PLAN_ARCHIVE_BYTES_LIMIT
        );
        assert_eq!(maximum(&fetch, "elapsedMs"), OPERATION_MS_LIMIT);

        let prepare = output_schema(PREPARE);
        assert_eq!(maximum(&prepare, "packageCount"), 4_096);
        assert_eq!(maximum(&prepare, "archiveBytes"), PLAN_ARCHIVE_BYTES_LIMIT);
        assert_eq!(maximum(&prepare, "unpackedBytes"), UNPACKED_BYTES_LIMIT);
        assert_eq!(maximum(&prepare, "fileCount"), FILE_COUNT_LIMIT);
        assert_eq!(maximum(&prepare, "treeEntries"), TREE_ENTRIES_LIMIT);
        assert_eq!(prepare["properties"]["treeEntries"]["minimum"], 1);
        assert_eq!(maximum(&prepare, "treeFiles"), TREE_FILES_LIMIT);
        assert_eq!(maximum(&prepare, "treeBytes"), TREE_BYTES_LIMIT);
        assert_eq!(
            maximum(&prepare, "nodeBinaryBytes"),
            NODE_BINARY_BYTES_LIMIT
        );
        assert_eq!(
            prepare["properties"]["toolchainHashElapsedMs"]["minimum"],
            0
        );
        assert!(prepare["properties"]["toolchainHashElapsedMs"]
            .get("maximum")
            .is_none());
        assert_eq!(maximum(&prepare, "workerElapsedMs"), OPERATION_MS_LIMIT);
    }
}
