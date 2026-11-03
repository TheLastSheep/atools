//! Fixture-only workaround experiment for AppKit's crash-restoration alert.
//!
//! `ApplePersistenceIgnoreState` is not a documented AppKit contract. This
//! module is an opt-in experiment for the two native editor acceptance cases,
//! not a supported product fix. It runs before Tauri/AppKit window setup and
//! changes only this process's volatile NSArgumentDomain.

#[cfg(target_os = "macos")]
mod macos {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSArgumentDomain, NSDictionary, NSNumber, NSString, NSUserDefaults};
    use objc2_foundation::{NSBundle, NSMutableDictionary};
    use std::collections::HashSet;

    const NATIVE_INPUT_FLAG: &str = "--native-ui-input";
    const CASE_FLAG: &str = "--published-case";
    const RUN_ID_FLAG: &str = "--run-id";
    const RESTORATION_KEY: &str = "ApplePersistenceIgnoreState";
    const BUNDLE_PREFIX: &str = "dev.atools.fixture.dialog.";

    #[derive(Debug, PartialEq, Eq)]
    struct ActiveFixture {
        run_id: String,
        case_id: String,
    }

    fn option<'a>(args: &'a [String], flag: &str) -> Result<&'a str, String> {
        let positions: Vec<_> = args
            .iter()
            .enumerate()
            .filter_map(|(index, value)| (value == flag).then_some(index))
            .collect();
        if positions.len() != 1 {
            return Err(format!("Expected exactly one {flag}"));
        }
        let value = args
            .get(positions[0] + 1)
            .filter(|value| !value.starts_with("--") && !value.is_empty())
            .ok_or_else(|| format!("Missing value for {flag}"))?;
        Ok(value)
    }

    fn canonical_run_id(value: &str) -> Result<String, String> {
        let parsed =
            uuid::Uuid::parse_str(value).map_err(|_| "Invalid fixture run-id".to_string())?;
        let canonical = parsed.hyphenated().to_string();
        if value != canonical {
            return Err("Fixture run-id must be one canonical lowercase UUID".into());
        }
        Ok(canonical)
    }

    fn validate_active_args(args: &[String]) -> Result<Option<ActiveFixture>, String> {
        let flag_count = args
            .iter()
            .filter(|value| value.as_str() == NATIVE_INPUT_FLAG)
            .count();
        if flag_count == 0 {
            return Ok(None);
        }
        if flag_count != 1 {
            return Err("Duplicate native UI input flag".into());
        }

        let case_id = option(args, CASE_FLAG)?.to_string();
        if !matches!(case_id.as_str(), "local-plain-text" | "local-json-editor") {
            return Err("Native UI input case is not registered for restoration experiment".into());
        }
        let run_id = canonical_run_id(option(args, RUN_ID_FLAG)?)?;
        Ok(Some(ActiveFixture { run_id, case_id }))
    }

    fn expected_bundle_id(run_id: &str) -> String {
        format!("{BUNDLE_PREFIX}{}", run_id.replace('-', ""))
    }

    fn validate_bundle_gate(
        bundle_id: Option<&str>,
        fixture: &ActiveFixture,
    ) -> Result<(), String> {
        if bundle_id == Some(expected_bundle_id(&fixture.run_id).as_str()) {
            Ok(())
        } else {
            Err("Active native input fixture bundle id does not match its run-id".into())
        }
    }

    fn merged_argument_domain(
        existing: &NSDictionary<NSString, AnyObject>,
        key: &NSString,
        value: &NSNumber,
    ) -> objc2::rc::Retained<NSMutableDictionary<NSString, AnyObject>> {
        let merged = NSMutableDictionary::dictionaryWithDictionary(existing);
        merged.insert(key, value);
        merged
    }

    fn preserve_other_keys(existing_keys: &[String], resulting_keys: &[String]) -> bool {
        let result: HashSet<_> = resulting_keys.iter().map(String::as_str).collect();
        existing_keys
            .iter()
            .filter(|key| key.as_str() != RESTORATION_KEY)
            .all(|key| result.contains(key.as_str()))
    }

    fn argument_domain_snapshot(
        domain: &NSDictionary<NSString, AnyObject>,
    ) -> (Vec<String>, HashSet<String>) {
        let mut keys = Vec::with_capacity(domain.count());
        let mut other_keys = HashSet::with_capacity(domain.count());
        for key in domain.allKeys().iter() {
            let name = key.to_string();
            if name != RESTORATION_KEY {
                other_keys.insert(name.clone());
            }
            keys.push(name);
        }
        (keys, other_keys)
    }

    /// Applies the unsupported preference only to a strictly identified local
    /// editor fixture. Ordinary launches return before touching NSUserDefaults.
    pub fn apply_if_requested() -> Result<(), String> {
        let args: Vec<String> = std::env::args().collect();
        let Some(fixture) = validate_active_args(&args)? else {
            return Ok(());
        };

        let bundle_id = NSBundle::mainBundle()
            .bundleIdentifier()
            .map(|value| value.to_string())
            .ok_or_else(|| {
                "Active native input fixture has no main bundle identifier".to_string()
            })?;
        validate_bundle_gate(Some(&bundle_id), &fixture)?;

        let defaults = NSUserDefaults::standardUserDefaults();
        // SAFETY: `NSArgumentDomain` is Foundation's exported immutable name.
        let argument_domain = unsafe { NSArgumentDomain };
        let existing = defaults.volatileDomainForName(argument_domain);
        let (before_keys, expected_other_keys) = argument_domain_snapshot(&existing);
        let key = NSString::from_str(RESTORATION_KEY);
        let enabled = NSNumber::numberWithBool(true);
        let merged = merged_argument_domain(&existing, &key, &enabled);
        // This is volatile and process-local. No persistent defaults API is used.
        unsafe { defaults.setVolatileDomain_forName(&merged, argument_domain) };

        let observed = defaults.volatileDomainForName(argument_domain);
        let (after_keys, after_other_keys) = argument_domain_snapshot(&observed);
        let readback = observed
            .objectForKey(&key)
            .and_then(|value| {
                value
                    .downcast_ref::<NSNumber>()
                    .map(|number| number.boolValue())
            })
            .unwrap_or(false);
        let effective_readback = defaults.boolForKey(&key);
        let preserved_other_keys = preserve_other_keys(&before_keys, &after_keys)
            && expected_other_keys == after_other_keys;
        let preserved_other_values = merged.isEqualToDictionary(&observed);
        println!(
            "AToolsNativeFixtureRestorationExperiment {{\"experimental\":true,\"supportedFix\":false,\"guardMatched\":true,\"case\":\"{}\",\"volatileReadback\":{},\"effectiveReadback\":{},\"preservedOtherKeys\":{},\"preservedOtherValues\":{},\"otherKeyCount\":{},\"persistentDefaultsWriteCalled\":false}}",
            fixture.case_id,
            readback,
            effective_readback,
            preserved_other_keys,
            preserved_other_values,
            after_other_keys.len()
        );
        if !readback || !effective_readback || !preserved_other_keys || !preserved_other_values {
            return Err("Volatile restoration experiment could not verify effective enablement and is not enabled".into());
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::{
            expected_bundle_id, merged_argument_domain, preserve_other_keys, validate_active_args,
            validate_bundle_gate, ActiveFixture, RESTORATION_KEY,
        };
        use objc2::runtime::AnyObject;
        use objc2_foundation::{NSMutableDictionary, NSNumber, NSString};

        fn args(extra: &[&str]) -> Vec<String> {
            let mut result = vec![
                "legacy_node_desktop_smoke".to_string(),
                "--native-ui-input".to_string(),
                "--published-case".to_string(),
                "local-json-editor".to_string(),
                "--run-id".to_string(),
                "7d610ca1-2c85-4b80-9f30-6a0c279b391a".to_string(),
            ];
            result.extend(extra.iter().map(|value| (*value).to_string()));
            result
        }

        #[test]
        fn ordinary_launch_skips_even_malformed_fixture_arguments() {
            let args = vec!["legacy_node_desktop_smoke".into(), "--run-id".into()];
            assert_eq!(validate_active_args(&args), Ok(None));
        }

        #[test]
        fn registered_case_requires_a_canonical_unique_run_id() {
            let parsed = validate_active_args(&args(&[])).unwrap();
            assert_eq!(
                parsed,
                Some(ActiveFixture {
                    run_id: "7d610ca1-2c85-4b80-9f30-6a0c279b391a".into(),
                    case_id: "local-json-editor".into(),
                })
            );
            assert!(validate_active_args(&args(&[
                "--run-id",
                "7d610ca1-2c85-4b80-9f30-6a0c279b391a"
            ]))
            .is_err());
            let mut uppercase = args(&[]);
            let run_index = uppercase
                .iter()
                .position(|value| value == "--run-id")
                .unwrap()
                + 1;
            uppercase[run_index] = "7D610CA1-2C85-4B80-9F30-6A0C279B391A".into();
            assert!(validate_active_args(&uppercase).is_err());
            let plaintext = args(&[])
                .into_iter()
                .map(|value| {
                    if value == "local-json-editor" {
                        "local-plain-text".into()
                    } else {
                        value
                    }
                })
                .collect::<Vec<_>>();
            assert_eq!(
                validate_active_args(&plaintext).unwrap().unwrap().case_id,
                "local-plain-text"
            );
        }

        #[test]
        fn duplicate_activation_flag_and_missing_active_values_are_rejected() {
            assert!(validate_active_args(&args(&["--native-ui-input"])).is_err());
            let missing_case = vec![
                "legacy_node_desktop_smoke".into(),
                "--native-ui-input".into(),
                "--published-case".into(),
            ];
            assert!(validate_active_args(&missing_case).is_err());
        }

        #[test]
        fn active_unknown_case_is_rejected_before_defaults_access() {
            let args = args(&[])
                .into_iter()
                .map(|value| {
                    if value == "local-json-editor" {
                        "other-case".into()
                    } else {
                        value
                    }
                })
                .collect::<Vec<_>>();
            assert!(validate_active_args(&args).is_err());
        }

        #[test]
        fn bundle_identity_derives_from_the_same_run_id() {
            assert_eq!(
                expected_bundle_id("7d610ca1-2c85-4b80-9f30-6a0c279b391a"),
                "dev.atools.fixture.dialog.7d610ca12c854b809f306a0c279b391a"
            );
        }

        #[test]
        fn bundle_gate_rejects_missing_permanent_and_foreign_run_id_bundles() {
            let fixture = validate_active_args(&args(&[])).unwrap().unwrap();
            let exact = expected_bundle_id(&fixture.run_id);
            assert!(validate_bundle_gate(Some(&exact), &fixture).is_ok());
            assert!(validate_bundle_gate(None, &fixture).is_err());
            assert!(validate_bundle_gate(Some("dev.atools.app"), &fixture).is_err());
            assert!(validate_bundle_gate(
                Some("dev.atools.fixture.dialog.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                &fixture
            )
            .is_err());
        }

        #[test]
        fn merge_observation_requires_every_non_experimental_key_to_survive() {
            let before = vec![
                "existing-a".into(),
                RESTORATION_KEY.into(),
                "existing-b".into(),
            ];
            let after = vec![
                "existing-a".into(),
                RESTORATION_KEY.into(),
                "existing-b".into(),
            ];
            assert!(preserve_other_keys(&before, &after));
            assert!(!preserve_other_keys(
                &before,
                &["existing-a".into(), RESTORATION_KEY.into()]
            ));
        }

        #[test]
        fn foundation_merge_preserves_existing_values_and_overwrites_only_experiment_key() {
            let existing = NSMutableDictionary::<NSString, AnyObject>::dictionary();
            let retained_key = NSString::from_str("existing-string");
            let retained_value = NSString::from_str("keep-this-value");
            existing.insert(&*retained_key, &*retained_value);
            let number_key = NSString::from_str("existing-number");
            let number_value = NSNumber::numberWithInt(37);
            existing.insert(&*number_key, &*number_value);
            let target_key = NSString::from_str(RESTORATION_KEY);
            let previous_target = NSString::from_str("old-value");
            existing.insert(&*target_key, &*previous_target);

            let enabled = NSNumber::numberWithBool(true);
            let merged = merged_argument_domain(&existing, &target_key, &enabled);

            assert_eq!(
                merged
                    .objectForKey(&retained_key)
                    .unwrap()
                    .downcast_ref::<NSString>()
                    .unwrap()
                    .to_string(),
                "keep-this-value"
            );
            assert_eq!(
                merged
                    .objectForKey(&number_key)
                    .unwrap()
                    .downcast_ref::<NSNumber>()
                    .unwrap()
                    .intValue(),
                37
            );
            assert!(merged
                .objectForKey(&target_key)
                .unwrap()
                .downcast_ref::<NSNumber>()
                .unwrap()
                .boolValue());
            assert_eq!(merged.count(), 3);
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::apply_if_requested;

#[cfg(not(target_os = "macos"))]
pub fn apply_if_requested() -> Result<(), String> {
    Ok(())
}
