use anyhow::{bail, Context, Result};
use atools_plugin::package_resolution::PackageDiagnostic;
use serde_json::Value;

// The resolver may combine diagnostics from the source and published candidates.
// Each candidate is bounded to 512 HTML references plus manifest-level checks.
const MAX_DIAGNOSTIC_CODES_PER_PLUGIN: usize = 2 * 528;
const READINESS_DIAGNOSTIC_CODES: &[&str] = &[
    "empty_main",
    "external_html_asset",
    "missing_entry",
    "missing_logo",
    "missing_main",
    "missing_preload",
    "missing_runtime_entry",
    "missing_script",
    "missing_stylesheet",
    "remote_entry",
    "remote_html_base",
    "source_main_entry",
    "source_preload_entry",
    "source_script_entry",
];
const PACKAGE_SELECTION_DIAGNOSTIC_CODES: &[&str] = &[
    "incomplete_published_package",
    "selected_published_package",
];

#[derive(Debug, PartialEq, Eq)]
pub(super) struct AggregateRecordCounts {
    pub(super) tier_counts: [usize; 3],
    pub(super) readiness_counts: std::collections::BTreeMap<String, usize>,
    pub(super) state_counts: std::collections::BTreeMap<String, usize>,
    pub(super) readiness_diagnostic_counts: std::collections::BTreeMap<String, usize>,
}

pub(super) fn aggregate_record_counts(records: &[Value]) -> Result<AggregateRecordCounts> {
    let mut counts = AggregateRecordCounts {
        tier_counts: [0; 3],
        readiness_counts: std::collections::BTreeMap::new(),
        state_counts: std::collections::BTreeMap::new(),
        readiness_diagnostic_counts: std::collections::BTreeMap::new(),
    };
    for record in records {
        match record.get("classifier") {
            None | Some(Value::Null) => {}
            Some(Value::Object(classifier)) => match classifier.get("tier").and_then(Value::as_str)
            {
                Some("tier1_direct_web_view") => counts.tier_counts[0] += 1,
                Some("tier2_quickjs_or_node_sidecar") => counts.tier_counts[1] += 1,
                Some("tier3_requires_build_or_native_addon") => counts.tier_counts[2] += 1,
                _ => bail!("classifier emitted an unknown tier"),
            },
            Some(_) => bail!("classifier emitted a malformed record"),
        }
        *counts
            .state_counts
            .entry(
                record["analysisState"]
                    .as_str()
                    .unwrap_or("invalid")
                    .to_owned(),
            )
            .or_default() += 1;
        if let Some(readiness) = record["packageReadiness"].as_str() {
            *counts
                .readiness_counts
                .entry(readiness.to_owned())
                .or_default() += 1;
        }
        let state = record["analysisState"].as_str().unwrap_or("invalid");
        let codes = record
            .get("readinessDiagnosticCodes")
            .and_then(Value::as_array)
            .context("readiness diagnostic codes are missing or malformed")?;
        if codes.len() > MAX_DIAGNOSTIC_CODES_PER_PLUGIN {
            bail!("readiness diagnostic code count exceeds its bound");
        }
        if matches!(state, "no_direct_manifest" | "incompatible_snapshot_entry") && !codes.is_empty() {
            bail!("unclassified record has readiness diagnostic codes");
        }
        let mut previous: Option<&str> = None;
        for code in codes {
            let code = code
                .as_str()
                .context("readiness diagnostic code is not a string")?;
            if !READINESS_DIAGNOSTIC_CODES.contains(&code) {
                bail!("readiness diagnostic code is unsupported");
            }
            if previous.is_some_and(|previous| previous > code) {
                bail!("readiness diagnostic codes are not sorted");
            }
            previous = Some(code);
            *counts
                .readiness_diagnostic_counts
                .entry(code.to_owned())
                .or_default() += 1;
        }
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::{aggregate_record_counts, readiness_diagnostic_codes, PackageDiagnostic, Value, MAX_DIAGNOSTIC_CODES_PER_PLUGIN};
    use serde_json::json;

    #[test]
    fn null_classifier_records_keep_state_and_readiness_counts_without_a_tier() {
        let records = vec![
            json!({"analysisState":"classified","packageReadiness":"ready","classifier":{"tier":"tier1_direct_web_view"},"readinessDiagnosticCodes":[]}),
            json!({"analysisState":"classified","packageReadiness":"requires_build","classifier":{"tier":"tier2_quickjs_or_node_sidecar"},"readinessDiagnosticCodes":["missing_main"]}),
            json!({"analysisState":"classified","packageReadiness":"requires_build","classifier":{"tier":"tier3_requires_build_or_native_addon"},"readinessDiagnosticCodes":["missing_main","missing_script"]}),
            json!({"analysisState":"no_direct_manifest","packageReadiness":null,"classifier":null,"readinessDiagnosticCodes":[]}),
            json!({"analysisState":"classifier_error","packageReadiness":"unknown","classifier":null,"readinessDiagnosticCodes":[]}),
            json!({"analysisState":"incompatible_snapshot_entry","packageReadiness":null,"classifier":null,"readinessDiagnosticCodes":[]}),
        ];

        let counts = aggregate_record_counts(&records).expect("null classifier is not a tier");

        assert_eq!(counts.tier_counts, [1, 1, 1]);
        assert_eq!(counts.state_counts.get("classified"), Some(&3));
        assert_eq!(counts.state_counts.get("no_direct_manifest"), Some(&1));
        assert_eq!(counts.state_counts.get("classifier_error"), Some(&1));
        assert_eq!(
            counts.state_counts.get("incompatible_snapshot_entry"),
            Some(&1)
        );
        assert_eq!(counts.readiness_counts.get("ready"), Some(&1));
        assert_eq!(counts.readiness_counts.get("requires_build"), Some(&2));
        assert_eq!(counts.readiness_counts.get("unknown"), Some(&1));
        assert_eq!(counts.readiness_diagnostic_counts.get("missing_main"), Some(&2));
        assert_eq!(counts.readiness_diagnostic_counts.get("missing_script"), Some(&1));
    }

    #[test]
    fn unsupported_diagnostic_codes_fail_without_echoing_their_value() {
        let records = vec![json!({
            "analysisState":"classified",
            "packageReadiness":"incomplete",
            "classifier":{"tier":"tier3_requires_build_or_native_addon"},
            "readinessDiagnosticCodes":["/private/plugin/path"]
        })];
        let error = aggregate_record_counts(&records).expect_err("arbitrary data is not a code");
        assert!(error.to_string().contains("readiness diagnostic code is unsupported"));
        assert!(!error.to_string().contains("/private/plugin/path"));
    }

    #[test]
    fn diagnostic_projection_is_bounded_and_never_returns_message_text() {
        let diagnostic = PackageDiagnostic { code: "missing_main".into(), message: "/private/plugin/path/index.html".into() };
        assert_eq!(readiness_diagnostic_codes(std::slice::from_ref(&diagnostic)).unwrap(), vec!["missing_main".to_owned()]);
        assert!(readiness_diagnostic_codes(&vec![diagnostic; MAX_DIAGNOSTIC_CODES_PER_PLUGIN + 1]).is_err());
    }

    #[test]
    fn classified_object_with_unknown_tier_still_fails_closed() {
        let records = vec![json!({
            "analysisState":"classified",
            "packageReadiness":"ready",
            "classifier":{"tier":"tier4_unknown"}
        })];

        let error = aggregate_record_counts(&records).expect_err("unknown tier must fail closed");
        assert!(error
            .to_string()
            .contains("classifier emitted an unknown tier"));
    }
}

pub(super) fn readiness_diagnostic_codes(diagnostics: &[PackageDiagnostic]) -> Result<Vec<String>> {
    let mut codes = Vec::new();
    for diagnostic in diagnostics {
        if PACKAGE_SELECTION_DIAGNOSTIC_CODES.contains(&diagnostic.code.as_str()) {
            continue;
        }
        if !READINESS_DIAGNOSTIC_CODES.contains(&diagnostic.code.as_str()) {
            bail!("readiness diagnostic code is unsupported");
        }
        if codes.len() == MAX_DIAGNOSTIC_CODES_PER_PLUGIN {
            bail!("readiness diagnostic code count exceeds its bound");
        }
        codes.push(diagnostic.code.clone());
    }
    codes.sort();
    Ok(codes)
}

