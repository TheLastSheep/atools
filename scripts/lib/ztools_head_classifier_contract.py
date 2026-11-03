"""Bounded schema and identity validation for fixed-head classifier output."""
from __future__ import annotations

from ztools_head_snapshot import AuditError, EXPECTED_COUNT

# Resolution may combine source and published candidates, each with at most 512
# HTML references plus a bounded set of manifest-level diagnostics.
MAX_DIAGNOSTIC_CODES_PER_PLUGIN = 2 * 528
READINESS_DIAGNOSTIC_CODES = frozenset({
    "empty_main", "external_html_asset", "missing_entry", "missing_logo", "missing_main",
    "missing_preload", "missing_runtime_entry", "missing_script", "missing_stylesheet",
    "remote_entry", "remote_html_base", "source_main_entry", "source_preload_entry",
    "source_script_entry",
})

def validate_classifier_output(value: object, rows: list[dict], head: str, plugins_tree_oid: str) -> None:
    if not isinstance(value, dict) or value.get("schemaVersion") != 2 or value.get("head") != head or value.get("pluginsTreeOid") != plugins_tree_oid:
        raise AuditError("classifier_output_identity_mismatch")
    records = value.get("records")
    if not isinstance(records, list) or len(records) != EXPECTED_COUNT:
        raise AuditError("classifier_output_count_mismatch")
    expected = {row["pluginDirectory"]: row for row in rows}
    actual = [record.get("pluginDirectory") if isinstance(record, dict) else None for record in records]
    if len(set(actual)) != EXPECTED_COUNT or set(actual) != set(expected):
        raise AuditError("classifier_output_membership_mismatch")
    counts = value.get("counts")
    if (
        not isinstance(counts, dict)
        or not isinstance(counts.get("analysisStates"), dict)
        or not isinstance(counts.get("tiers"), dict)
        or not isinstance(counts.get("readinessDiagnosticCodes"), dict)
    ):
        raise AuditError("classifier_output_counts_invalid")
    observed_states: dict[str, int] = {}
    observed_tiers: dict[str, int] = {}
    observed_diagnostic_codes: dict[str, int] = {}
    for record in records:
        if not isinstance(record, dict):
            raise AuditError("classifier_output_record_invalid")
        source = expected[record["pluginDirectory"]]
        for key in (
            "treeOid", "headClassification", "headRootManifest", "headPublicManifest",
            "snapshotState", "snapshotIssues", "manifestPins",
        ):
            if record.get(key) != source.get(key):
                raise AuditError("classifier_output_source_binding_mismatch")
        state = record.get("analysisState")
        if state not in ("classified", "classifier_error", "incompatible_snapshot_entry", "no_direct_manifest"):
            raise AuditError("classifier_output_state_invalid")
        observed_states[state] = observed_states.get(state, 0) + 1
        codes = record.get("readinessDiagnosticCodes")
        if (
            not isinstance(codes, list)
            or len(codes) > MAX_DIAGNOSTIC_CODES_PER_PLUGIN
            or any(not isinstance(code, str) or code not in READINESS_DIAGNOSTIC_CODES for code in codes)
            or codes != sorted(codes)
        ):
            raise AuditError("classifier_output_diagnostic_codes_invalid")
        if state in ("no_direct_manifest", "incompatible_snapshot_entry") and codes:
            raise AuditError("classifier_output_diagnostic_codes_invalid")
        for code in codes:
            observed_diagnostic_codes[code] = observed_diagnostic_codes.get(code, 0) + 1
        if source["headRootManifest"] is None and source["headPublicManifest"] is None:
            if state != "no_direct_manifest" or record.get("classifier") is not None:
                raise AuditError("classifier_output_missing_manifest_state_invalid")
        elif source["snapshotState"] != "materialized":
            if state != "incompatible_snapshot_entry" or record.get("classifier") is not None:
                raise AuditError("classifier_output_snapshot_state_invalid")
        elif state == "classified":
            classifier = record.get("classifier")
            if not isinstance(classifier, dict) or classifier.get("tier") not in (
                "tier1_direct_web_view", "tier2_quickjs_or_node_sidecar", "tier3_requires_build_or_native_addon"
            ):
                raise AuditError("classifier_output_tier_invalid")
            tier = classifier["tier"]
            observed_tiers[tier] = observed_tiers.get(tier, 0) + 1
        elif state == "incompatible_snapshot_entry":
            raise AuditError("classifier_output_materialized_state_invalid")
    expected_tier_keys = {
        "tier1_direct_web_view", "tier2_quickjs_or_node_sidecar", "tier3_requires_build_or_native_addon"
    }
    diagnostic_counts = counts["readinessDiagnosticCodes"]
    if any(type(count) is not int or count <= 0 for count in diagnostic_counts.values()):
        raise AuditError("classifier_output_count_values_mismatch")
    if (
        counts["analysisStates"] != observed_states
        or counts["tiers"] != {key: observed_tiers.get(key, 0) for key in sorted(expected_tier_keys)}
        or diagnostic_counts != {key: observed_diagnostic_codes[key] for key in sorted(observed_diagnostic_codes)}
    ):
        raise AuditError("classifier_output_count_values_mismatch")
