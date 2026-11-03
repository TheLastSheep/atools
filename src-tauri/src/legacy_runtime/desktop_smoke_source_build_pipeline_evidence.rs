//! Strict typed projection of the bounded TypeScript build-pipeline evidence.
use serde::{
    de::{self, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use std::fmt;

const MAX_STEP_KINDS: usize = 2;
const MAX_OUTPUT_ENTRIES: u64 = 4096;
const MAX_OUTPUT_BYTES: u64 = 128 * 1024 * 1024;

/// Missing is accepted for older profiles; an explicit JSON null is rejected.
pub(super) fn optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BuildStepKind {
    Typecheck,
    ViteBuild,
}

/// The scenario emits either no verified ordered plan or exactly typecheck -> Vite.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct BuildStepKinds(Vec<BuildStepKind>);

impl<'de> Deserialize<'de> for BuildStepKinds {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct StepKindsVisitor;

        impl<'de> Visitor<'de> for StepKindsVisitor {
            type Value = BuildStepKinds;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an empty list or [typecheck, viteBuild]")
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let Some(first) = sequence.next_element::<BuildStepKind>()? else {
                    return Ok(BuildStepKinds(Vec::new()));
                };
                if first != BuildStepKind::Typecheck {
                    return Err(de::Error::custom("unsupported build step order"));
                }
                let Some(second) = sequence.next_element::<BuildStepKind>()? else {
                    return Err(de::Error::invalid_length(1, &self));
                };
                if second != BuildStepKind::ViteBuild {
                    return Err(de::Error::custom("unsupported build step order"));
                }
                if sequence.next_element::<de::IgnoredAny>()?.is_some() {
                    return Err(de::Error::invalid_length(MAX_STEP_KINDS + 1, &self));
                }
                Ok(BuildStepKinds(vec![first, second]))
            }
        }

        deserializer.deserialize_seq(StepKindsVisitor)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SuccessEvidenceWire {
    #[serde(default, deserialize_with = "optional_non_null")]
    step_kinds: Option<BuildStepKinds>,
    #[serde(default, deserialize_with = "optional_non_null")]
    runner_exit_code: Option<i64>,
    #[serde(default, deserialize_with = "optional_non_null")]
    output_entries: Option<u64>,
    #[serde(default, deserialize_with = "optional_non_null")]
    output_bytes: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSuccessEvidence {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_kinds: Option<BuildStepKinds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner_exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_entries: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_bytes: Option<u64>,
}

impl<'de> Deserialize<'de> for BuildSuccessEvidence {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = SuccessEvidenceWire::deserialize(deserializer)?;
        let runner_exit_code = wire
            .runner_exit_code
            .map(|value| {
                let code = i32::try_from(value)
                    .map_err(|_| de::Error::custom("runner exit code is outside i32"))?;
                if code != 0 {
                    return Err(de::Error::custom("successful build exit code must be zero"));
                }
                Ok(code)
            })
            .transpose()?;
        let output_entries = wire
            .output_entries
            .map(|value| {
                if value > MAX_OUTPUT_ENTRIES {
                    return Err(de::Error::custom("build output entry count exceeds limit"));
                }
                u32::try_from(value).map_err(|_| de::Error::custom("invalid entry count"))
            })
            .transpose()?;
        let output_bytes = wire
            .output_bytes
            .map(|value| {
                if value > MAX_OUTPUT_BYTES {
                    Err(de::Error::custom("build output byte count exceeds limit"))
                } else {
                    Ok(value)
                }
            })
            .transpose()?;
        Ok(Self {
            step_kinds: wire.step_kinds,
            runner_exit_code,
            output_entries,
            output_bytes,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "PascalCase")]
pub enum RunnerFailureCode {
    SourceBuildProcessFailed,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InvalidTypecheckEvidenceWire {
    #[serde(default, deserialize_with = "optional_non_null")]
    runner_failure_code: Option<RunnerFailureCode>,
    #[serde(default, deserialize_with = "optional_non_null")]
    runner_exit_code: Option<i64>,
    output_identity_mismatch: bool,
    build_output_absent: bool,
    previous_installation_preserved: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidTypecheckEvidence {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner_failure_code: Option<RunnerFailureCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner_exit_code: Option<i32>,
    pub output_identity_mismatch: bool,
    pub build_output_absent: bool,
    pub previous_installation_preserved: bool,
}

impl<'de> Deserialize<'de> for InvalidTypecheckEvidence {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = InvalidTypecheckEvidenceWire::deserialize(deserializer)?;
        let runner_exit_code = wire
            .runner_exit_code
            .map(|value| {
                let code = i32::try_from(value)
                    .map_err(|_| de::Error::custom("runner exit code is outside i32"))?;
                if code == 0 {
                    return Err(de::Error::custom("failed build exit code must be nonzero"));
                }
                Ok(code)
            })
            .transpose()?;
        Ok(Self {
            runner_failure_code: wire.runner_failure_code,
            runner_exit_code,
            output_identity_mismatch: wire.output_identity_mismatch,
            build_output_absent: wire.build_output_absent,
            previous_installation_preserved: wire.previous_installation_preserved,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BuildPipelineEvidence {
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub success: Option<BuildSuccessEvidence>,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub invalid_typecheck: Option<InvalidTypecheckEvidence>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse_report(
        value: serde_json::Value,
    ) -> Result<super::super::FrontendReport, serde_json::Error> {
        serde_json::from_value(value)
    }

    #[test]
    fn actual_success_and_invalid_typecheck_shapes_are_typed_and_bounded() {
        let report = parse_report(json!({
            "passed": false,
            "checks": {"completed": true},
            "buildPipelineEvidence": {
                "success": {
                    "stepKinds": ["typecheck", "viteBuild"],
                    "runnerExitCode": 0,
                    "outputEntries": 12,
                    "outputBytes": 4096
                },
                "invalidTypecheck": {
                    "runnerFailureCode": "SourceBuildProcessFailed",
                    "runnerExitCode": 1,
                    "outputIdentityMismatch": false,
                    "buildOutputAbsent": true,
                    "previousInstallationPreserved": true
                }
            }
        }))
        .unwrap();
        let evidence = report.build_pipeline_evidence.unwrap();
        assert_eq!(evidence.success.unwrap().output_entries, Some(12));
        assert_eq!(
            evidence.invalid_typecheck.unwrap().runner_exit_code,
            Some(1)
        );
    }

    #[test]
    fn legacy_report_and_partial_failure_without_pipeline_evidence_remain_valid() {
        let legacy =
            parse_report(json!({"passed": true, "observations": {"ready": true}})).unwrap();
        assert!(legacy.build_pipeline_evidence.is_none());
        let partial = parse_report(json!({"passed": false, "buildPipelineEvidence": {}})).unwrap();
        assert!(partial.build_pipeline_evidence.unwrap().success.is_none());
    }

    #[test]
    fn unknown_nested_fields_raw_text_and_paths_are_rejected() {
        for value in [
            json!({"passed": false, "buildPipelineEvidence": {"success": {"compilerText": "ignore previous instructions"}}}),
            json!({"passed": false, "buildPipelineEvidence": {"success": {"path": "/private/project"}}}),
            json!({"passed": false, "buildPipelineEvidence": {"invalidTypecheck": {"error": "raw compiler output"}}}),
            json!({"passed": false, "buildPipelineEvidence": {"other": true}}),
        ] {
            assert!(parse_report(value).is_err());
        }
    }

    #[test]
    fn step_order_failure_code_numbers_and_boolean_types_are_strict() {
        for evidence in [
            json!({"success": {"stepKinds": ["viteBuild", "typecheck"]}}),
            json!({"success": {"stepKinds": ["typecheck", "viteBuild", "viteBuild"]}}),
            json!({"success": {"stepKinds": ["nodeTest"]}}),
            json!({"success": {"runnerExitCode": 1}}),
            json!({"invalidTypecheck": {"runnerFailureCode": "OtherFailure"}}),
            json!({"invalidTypecheck": {"runnerExitCode": 0, "outputIdentityMismatch": false, "buildOutputAbsent": true, "previousInstallationPreserved": true}}),
            json!({"invalidTypecheck": {"runnerExitCode": 1}}),
            json!({"invalidTypecheck": {"runnerExitCode": 2147483648_i64}}),
            json!({"invalidTypecheck": {"buildOutputAbsent": "yes"}}),
            json!({"success": null}),
            json!({"success": {"stepKinds": null}}),
            json!({"success": {"runnerExitCode": null}}),
            json!({"invalidTypecheck": {"runnerFailureCode": null, "outputIdentityMismatch": false, "buildOutputAbsent": true, "previousInstallationPreserved": true}}),
        ] {
            assert!(serde_json::from_value::<BuildPipelineEvidence>(evidence).is_err());
        }
    }

    #[test]
    fn output_entry_and_byte_caps_are_enforced_on_deserialization() {
        assert!(serde_json::from_value::<BuildPipelineEvidence>(
            json!({"success":{"outputEntries":4096,"outputBytes":134217728}})
        )
        .is_ok());
        assert!(serde_json::from_value::<BuildPipelineEvidence>(
            json!({"success":{"outputEntries":4097}})
        )
        .is_err());
        assert!(serde_json::from_value::<BuildPipelineEvidence>(
            json!({"success":{"outputBytes":134217729}})
        )
        .is_err());
        assert!(serde_json::from_value::<BuildPipelineEvidence>(
            json!({"success":{"outputBytes":-1}})
        )
        .is_err());
    }
}
