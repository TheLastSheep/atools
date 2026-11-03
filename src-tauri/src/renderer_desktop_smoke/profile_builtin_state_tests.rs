use std::{env, path::PathBuf};

use super::{args, Profile};

fn builtin_args(journey: &str, output_name: &str) -> Vec<String> {
    let temporary = env::temp_dir();
    let run_id = "8f14e45fea3e4d3a9b7d1c4e5f607182";
    let root =
        PathBuf::from("/private/tmp").join(format!("atools-renderer-settings-input-{run_id}"));
    let output_name = format!("{output_name}-{}.json", uuid::Uuid::new_v4().simple());
    let mut values = args(
        &root,
        &temporary.join("renderer-dist"),
        &temporary.join(output_name),
    );
    values.extend(["--run-id".into(), run_id.into()]);
    values.extend(["--journey".into(), journey.into()]);
    values
}

fn replace_flag_value(values: &mut [String], flag: &str, value: &str) {
    let index = values.iter().position(|item| item == flag).unwrap();
    values[index + 1] = value.to_owned();
}

#[test]
fn builtin_state_seed_and_cold_main_have_fixed_identity_and_explicit_resume_pid() {
    let seed_args = builtin_args(
        "builtin-state-seed",
        "native-builtin-state-seed-report.json",
    );
    let main_args = builtin_args("builtin-state", "native-builtin-state-report.json");
    if !cfg!(all(
        feature = "legacy-node-smoke",
        feature = "ztools-multiwebview"
    )) {
        assert!(Profile::from_args(&seed_args)
            .unwrap_err()
            .contains("builtin-state-seed requires --features"));
        let mut feature_check_args = main_args.clone();
        feature_check_args.extend([
            "--resume-seed-pid".into(),
            (std::process::id() + 10).to_string(),
        ]);
        assert!(Profile::from_args(&feature_check_args)
            .unwrap_err()
            .contains("settings-input requires --features"));
        return;
    }

    let seed = Profile::from_args(&seed_args).unwrap();
    assert!(seed.builtin_state_seed);
    assert!(!seed.builtin_state_journey && !seed.settings_input_journey);
    assert!(seed.resume_seed_pid.is_none());
    assert_eq!(
        seed.identifier,
        format!("dev.atools.renderer-settings-input.{}", seed.run_id)
    );

    let seed_pid = std::process::id() + 10;
    let mut main_args = main_args;
    main_args.extend(["--resume-seed-pid".into(), seed_pid.to_string()]);
    let main = Profile::from_args(&main_args).unwrap();
    assert!(main.builtin_state_journey && main.settings_input_journey);
    assert!(!main.builtin_state_seed);
    assert_eq!(main.resume_seed_pid, Some(seed_pid));
    assert_eq!(main.identifier, seed.identifier);
}

#[test]
fn cold_main_rejects_missing_or_noncanonical_resume_pid_and_presentation_mode() {
    let missing = builtin_args("builtin-state", "missing-resume.json");
    assert!(Profile::from_args(&missing)
        .unwrap_err()
        .contains("resume-seed-pid is required"));

    let current_pid = std::process::id().to_string();
    for invalid in ["0", "00042", current_pid.as_str(), "not-a-pid"] {
        let mut values = builtin_args("builtin-state", "invalid-resume.json");
        values.extend(["--resume-seed-pid".into(), invalid.into()]);
        assert!(Profile::from_args(&values)
            .unwrap_err()
            .contains("canonical positive PID"));
    }

    let mut seed_with_resume = builtin_args("builtin-state-seed", "seed-with-resume.json");
    seed_with_resume.extend(["--resume-seed-pid".into(), "123".into()]);
    assert!(Profile::from_args(&seed_with_resume)
        .unwrap_err()
        .contains("resume-seed-pid is required only"));

    let mut visible = builtin_args("builtin-state", "visible-cold.json");
    visible.extend([
        "--resume-seed-pid".into(),
        (std::process::id() + 10).to_string(),
        "--paint-presentation".into(),
        "visible-unfocused".into(),
    ]);
    assert!(Profile::from_args(&visible)
        .unwrap_err()
        .contains("paint-presentation requires --journey settings-input"));
}

#[test]
fn builtin_state_journeys_keep_auto_clear_and_private_root_constraints() {
    let mut seed = builtin_args("builtin-state-seed", "seed-constraints.json");
    let mut main = builtin_args("builtin-state", "main-constraints.json");
    main.extend([
        "--resume-seed-pid".into(),
        (std::process::id() + 10).to_string(),
    ]);

    for args in [&mut seed, &mut main] {
        replace_flag_value(args, "--auto-clear", "immediately");
        assert!(Profile::from_args(args)
            .unwrap_err()
            .contains("settings-input requires --auto-clear never"));
    }

    if !cfg!(all(
        feature = "legacy-node-smoke",
        feature = "ztools-multiwebview"
    )) {
        return;
    }
    for (journey, output) in [
        ("builtin-state-seed", "seed-root-constraints.json"),
        ("builtin-state", "main-root-constraints.json"),
    ] {
        let mut args = builtin_args(journey, output);
        if journey == "builtin-state" {
            args.extend([
                "--resume-seed-pid".into(),
                (std::process::id() + 10).to_string(),
            ]);
        }
        replace_flag_value(
            &mut args,
            "--fixture-root",
            "/private/tmp/atools-invalid-root",
        );
        assert!(Profile::from_args(&args)
            .unwrap_err()
            .contains("fixture-root must match the fixed private run path"));
    }
}
