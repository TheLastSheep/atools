//! Strict complete argument contract for the opt-in converted native case.

#[derive(Debug, PartialEq, Eq)]
pub(super) struct ConvertedHandoffArgs {
    pub case_id: String,
    pub manifest_path: String,
    pub expected_sha256: String,
    pub deepread_text_encoding: super::deepread_fixture::TextEncoding,
}

const HANDOFF: &str = "--converted-source-handoff";
const EXPECTED: &str = "--expected-handoff-sha256";
const CASE: &str = "--published-case";
const EXECUTE: &str = "--execute-reviewed-package";
const DISPATCH: &str = "--published-plugin-panel-ui";
const REQUIRE_FOREGROUND: &str = "--require-foreground";
const TEXT_ENCODING: &str = "--deepread-text-encoding";
const REQUIRED_VALUE_FLAGS: [&str; 9] = [
    CASE,
    "--run-id",
    "--fixture-root",
    "--output",
    "--panel-ui",
    "--panel-css",
    "--panel-probe",
    HANDOFF,
    EXPECTED,
];
const VALUE_FLAGS: [&str; 10] = [
    CASE,
    "--run-id",
    "--fixture-root",
    "--output",
    "--panel-ui",
    "--panel-css",
    "--panel-probe",
    HANDOFF,
    EXPECTED,
    TEXT_ENCODING,
];

/// Returns `Some` only for an invocation attempting the converted case. Once that
/// mode is selected, every token after argv[0] must belong to its fixed contract.
pub(super) fn validate(args: &[String]) -> Result<Option<ConvertedHandoffArgs>, String> {
    let argv = args.get(1..).unwrap_or_default();
    let attempted = argv.iter().any(|arg| {
        matches_flag(arg, HANDOFF)
            || matches_flag(arg, EXPECTED)
            || matches_flag(arg, TEXT_ENCODING)
    }) || argv
        .windows(2)
        .any(|pair| pair[0] == CASE && is_converted_case(&pair[1]))
        || argv.iter().any(|arg| {
            arg.strip_prefix("--published-case=")
                .is_some_and(is_converted_case)
        });
    if !attempted {
        return Ok(None);
    }

    let mut standalone = [DISPATCH, EXECUTE]
        .into_iter()
        .map(|flag| (flag, 0usize))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut values = std::collections::BTreeMap::<&str, String>::new();
    let mut require_foreground = false;
    let mut index = 0;
    while index < argv.len() {
        let token = argv[index].as_str();
        if token == REQUIRE_FOREGROUND {
            if require_foreground {
                return Err("Foreground opt-in must occur at most once".into());
            }
            require_foreground = true;
            index += 1;
            continue;
        }
        if token.starts_with("--require-foreground=") {
            return Err("Foreground opt-in does not accept an inline value".into());
        }
        if let Some(count) = standalone.get_mut(token) {
            *count += 1;
            if *count != 1 {
                return Err(format!("{token} must occur exactly once"));
            }
            index += 1;
            continue;
        }
        if VALUE_FLAGS.contains(&token) {
            if values.contains_key(token) {
                return Err(format!("{token} must occur exactly once"));
            }
            let value = argv
                .get(index + 1)
                .ok_or_else(|| format!("Missing value for {token}"))?;
            if value.is_empty() || value.starts_with('-') {
                return Err(format!("Invalid value for {token}"));
            }
            values.insert(token, value.clone());
            index += 2;
            continue;
        }
        return Err(format!("Unexpected converted-case argument: {token}"));
    }
    if standalone.values().any(|count| *count != 1)
        || REQUIRED_VALUE_FLAGS
            .iter()
            .any(|flag| !values.contains_key(*flag))
    {
        return Err("Converted case requires its exact native argument set".into());
    }
    let case_id = values
        .get(CASE)
        .expect("required case value was checked")
        .clone();
    if !is_converted_case(&case_id) {
        return Err("Converted handoff inputs require a registered converted source case".into());
    }
    let deepread_text_encoding = match values.remove(TEXT_ENCODING).as_deref() {
        None => super::deepread_fixture::TextEncoding::Ascii,
        Some("utf8-bom") if case_id == "converted-deepread-source" => {
            super::deepread_fixture::TextEncoding::Utf8Bom
        }
        Some(_) => {
            return Err(
                "DeepRead text encoding opt-in is unsupported for this case or value".into(),
            )
        }
    };
    Ok(Some(ConvertedHandoffArgs {
        case_id,
        manifest_path: values
            .remove(HANDOFF)
            .expect("required handoff value was checked"),
        expected_sha256: values
            .remove(EXPECTED)
            .expect("required handoff SHA was checked"),
        deepread_text_encoding,
    }))
}

fn is_converted_case(case_id: &str) -> bool {
    crate::plugin_source_build::converted_source_registry::is_case(case_id)
}

fn matches_flag(argument: &str, flag: &str) -> bool {
    argument == flag || argument.starts_with(&format!("{flag}="))
}

#[cfg(test)]
mod tests {
    use super::super::parse_require_foreground;
    use super::*;

    fn valid() -> Vec<String> {
        vec![
            "host".into(),
            DISPATCH.into(),
            EXECUTE.into(),
            CASE.into(),
            "converted-my-calculator-source".into(),
            "--run-id".into(),
            "run-00000000-0000-4000-8000-000000000001".into(),
            "--fixture-root".into(),
            "/private/tmp/fixture".into(),
            "--output".into(),
            "/private/tmp/report.json".into(),
            "--panel-ui".into(),
            "/private/tmp/panel.js".into(),
            "--panel-css".into(),
            "/private/tmp/panel.css".into(),
            "--panel-probe".into(),
            "/private/tmp/probe.js".into(),
            HANDOFF.into(),
            "/private/tmp/handoff.json".into(),
            EXPECTED.into(),
            "a".repeat(64),
        ]
    }

    #[test]
    fn accepts_the_complete_fixed_native_argument_set() {
        let parsed = validate(&valid()).unwrap().unwrap();
        assert_eq!(parsed.case_id, "converted-my-calculator-source");
        assert_eq!(parsed.manifest_path, "/private/tmp/handoff.json");
        assert_eq!(parsed.expected_sha256.len(), 64);
        let mut tetris = valid();
        let case = tetris
            .iter()
            .position(|value| value == "converted-my-calculator-source")
            .unwrap();
        tetris[case] = "converted-tetris-source".into();
        assert_eq!(
            validate(&tetris).unwrap().unwrap().case_id,
            "converted-tetris-source"
        );
        assert_eq!(
            validate(&[
                "host".into(),
                "--published-case".into(),
                "local-plain-text".into()
            ])
            .unwrap(),
            None
        );
    }

    #[test]
    fn rejects_duplicate_missing_malformed_and_mutually_exclusive_arguments() {
        let mut duplicate_handoff = valid();
        duplicate_handoff.extend([HANDOFF.into(), "/private/tmp/other.json".into()]);
        assert!(validate(&duplicate_handoff).is_err());
        let mut duplicate_sha = valid();
        duplicate_sha.extend([EXPECTED.into(), "b".repeat(64)]);
        assert!(validate(&duplicate_sha).is_err());
        let mut duplicate_case = valid();
        duplicate_case.extend([CASE.into(), "converted-my-calculator-source".into()]);
        assert!(validate(&duplicate_case).is_err());
        let mut duplicate_execute = valid();
        duplicate_execute.push(EXECUTE.into());
        assert!(validate(&duplicate_execute).is_err());
        let mut duplicate_dispatch = valid();
        duplicate_dispatch.push(DISPATCH.into());
        assert!(validate(&duplicate_dispatch).is_err());
        let mut missing = valid();
        missing.truncate(missing.iter().position(|item| item == EXPECTED).unwrap() + 1);
        assert!(validate(&missing).is_err());
        let mut flag_value = valid();
        let index = flag_value.iter().position(|item| item == HANDOFF).unwrap();
        flag_value[index + 1] = EXECUTE.into();
        assert!(validate(&flag_value).is_err());
        let mut equals_form = valid();
        equals_form.push(format!("{HANDOFF}=/private/tmp/other.json"));
        assert!(validate(&equals_form).is_err());
        let mut mutually_exclusive = valid();
        mutually_exclusive.extend(["--plugin-root".into(), "/private/tmp/archive".into()]);
        assert!(validate(&mutually_exclusive).is_err());
        let mut false_execute = valid();
        false_execute.push("false".into());
        assert!(validate(&false_execute).is_err());
        let mut unknown = valid();
        unknown.extend(["--case".into(), "converted-my-calculator-source".into()]);
        assert!(validate(&unknown).is_err());
    }

    #[test]
    fn utf8_bom_encoding_requires_the_exact_reviewed_deepread_ui_case() {
        let mut deepread = valid();
        let case = deepread
            .iter()
            .position(|value| value == "converted-my-calculator-source")
            .unwrap();
        deepread[case] = "converted-deepread-source".into();
        assert_eq!(
            validate(&deepread).unwrap().unwrap().deepread_text_encoding,
            super::super::deepread_fixture::TextEncoding::Ascii
        );
        deepread.extend([TEXT_ENCODING.into(), "utf8-bom".into()]);
        assert_eq!(
            validate(&deepread).unwrap().unwrap().deepread_text_encoding,
            super::super::deepread_fixture::TextEncoding::Utf8Bom
        );
        for invalid_value in ["ascii", "utf8", "UTF8-BOM", "utf8-bom=1"] {
            let mut invalid = valid();
            let case = invalid
                .iter()
                .position(|value| value == "converted-my-calculator-source")
                .unwrap();
            invalid[case] = "converted-deepread-source".into();
            invalid.extend([TEXT_ENCODING.into(), invalid_value.into()]);
            assert!(validate(&invalid).is_err(), "{invalid_value}");
        }
        let mut duplicate = deepread.clone();
        duplicate.extend([TEXT_ENCODING.into(), "utf8-bom".into()]);
        assert!(validate(&duplicate).is_err());
        let mut missing = deepread.clone();
        missing.pop();
        assert!(validate(&missing).is_err());
        let mut wrong_case = valid();
        wrong_case.extend([TEXT_ENCODING.into(), "utf8-bom".into()]);
        assert!(validate(&wrong_case).is_err());
        let mut worker = deepread.clone();
        worker.extend(["--worker-contract-only".into()]);
        assert!(validate(&worker).is_err());
        let mut native_input = deepread.clone();
        native_input.extend(["--native-ui-input".into()]);
        assert!(validate(&native_input).is_err());
    }

    #[test]
    fn foreground_opt_in_is_optional_and_accepts_the_registered_deepread_case() {
        let mut deepread = valid();
        let case = deepread
            .iter()
            .position(|value| value == "converted-my-calculator-source")
            .unwrap();
        deepread[case] = "converted-deepread-source".into();
        let default = validate(&deepread).unwrap().unwrap();
        assert_eq!(default.case_id, "converted-deepread-source");
        assert!(!parse_require_foreground(&deepread, true, false, false).unwrap());

        deepread.push(REQUIRE_FOREGROUND.into());
        let parsed = validate(&deepread).unwrap().unwrap();
        assert_eq!(parsed.case_id, "converted-deepread-source");
        assert!(parse_require_foreground(&deepread, true, false, false).unwrap());
    }

    #[test]
    fn converted_foreground_flag_remains_strict_about_duplicates_values_and_mode_conflicts() {
        let mut duplicate = valid();
        duplicate.extend([REQUIRE_FOREGROUND.into(), REQUIRE_FOREGROUND.into()]);
        assert!(validate(&duplicate).is_err());

        let mut inline_value = valid();
        inline_value.push(format!("{REQUIRE_FOREGROUND}=true"));
        assert!(validate(&inline_value).is_err());

        let mut separate_value = valid();
        separate_value.extend([REQUIRE_FOREGROUND.into(), "true".into()]);
        assert!(validate(&separate_value).is_err());

        let mut worker = valid();
        worker.extend([REQUIRE_FOREGROUND.into(), "--worker-contract-only".into()]);
        assert!(validate(&worker).is_err());
        assert!(parse_require_foreground(&worker, true, true, false).is_err());

        let mut native_input = valid();
        native_input.extend([REQUIRE_FOREGROUND.into(), "--native-ui-input".into()]);
        assert!(validate(&native_input).is_err());
        assert!(parse_require_foreground(&native_input, true, false, true).is_err());
    }

    #[test]
    fn rejects_handoff_flags_on_other_cases_and_stray_nonconverted_tokens_stay_legacy() {
        let mut other = vec![
            "host".into(),
            CASE.into(),
            "local-plain-text".into(),
            HANDOFF.into(),
            "/tmp/handoff".into(),
        ];
        assert!(validate(&other).is_err());
        other = vec![
            "host".into(),
            CASE.into(),
            "local-plain-text".into(),
            "--legacy-extra".into(),
        ];
        assert_eq!(validate(&other).unwrap(), None);
    }
}
