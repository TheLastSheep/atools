use serde_json::Value;
use std::fs;
use tempfile::TempDir;

const RUN_ID: &str = "0123456789abcdef0123456789abcdef";

fn private_recovery_run(
    phase: &str,
    directory_name: &str,
    output_run_id: &str,
) -> (
    TempDir,
    super::super::super::profile::Profile,
    std::path::PathBuf,
) {
    let temporary = tempfile::tempdir().expect("private test parent");
    let base = fs::canonicalize(temporary.path()).expect("canonical temp parent");
    let run_directory = base.join(format!("run-{output_run_id}"));
    fs::create_dir(&run_directory).expect("create isolated run directory");
    let phase_directory = run_directory.join(directory_name);
    fs::create_dir(&phase_directory).expect("create isolated phase directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&run_directory, fs::Permissions::from_mode(0o700))
            .expect("secure run directory");
        fs::set_permissions(&phase_directory, fs::Permissions::from_mode(0o700))
            .expect("secure phase directory");
    }
    let output = phase_directory.join("native-report.json");
    let fixture_root = format!("/private/tmp/atools-renderer-settings-input-{RUN_ID}");
    let journey = match phase {
        "first" => "main-hotkey-recovery-first",
        "second" => "main-hotkey-recovery-second",
        _ => panic!("known recovery phase"),
    };
    let mut args = vec![
        "--fixture-root".into(),
        fixture_root,
        "--renderer-dist".into(),
        "/private/tmp/renderer-dist".into(),
        "--output".into(),
        output.to_string_lossy().into_owned(),
        "--auto-clear".into(),
        "never".into(),
        "--run-id".into(),
        RUN_ID.into(),
        "--journey".into(),
        journey.into(),
    ];
    if phase == "second" {
        args.extend(["--resume-hotkey-owner-pid".into(), u32::MAX.to_string()]);
    }
    let profile = super::super::super::profile::Profile::from_args(&args)
        .expect("valid private recovery profile");
    (temporary, profile, phase_directory)
}

#[test]
fn startup_recovery_reports_roundtrip_only_in_their_owned_phase_directory() {
    let (_first_temporary, first, first_directory) = private_recovery_run("first", "first", RUN_ID);
    let first_report = super::super::main_hotkey_startup_schema::first_report(
        &first,
        super::super::main_hotkey_startup_schema::empty_first(),
        &[],
    );
    assert!(super::super::main_hotkey_startup_schema::valid_first(
        &first,
        &first_report
    ));
    let first_name = super::super::main_hotkey_startup_schema::FIRST_REPORT;
    assert_eq!(
        super::write_owned_artifact(&first, first_name, &first_report),
        Ok(())
    );
    let first_written: Value = serde_json::from_slice(
        &fs::read(first_directory.join(first_name)).expect("read first recovery report"),
    )
    .expect("valid first report JSON");
    assert_eq!(first_written, first_report);

    let (_second_temporary, second, second_directory) =
        private_recovery_run("second", "second", RUN_ID);
    let second_report = super::super::main_hotkey_startup_schema::second_report(
        &second,
        u32::MAX,
        super::super::main_hotkey_startup_schema::empty_second(),
        &[],
    );
    assert!(super::super::main_hotkey_startup_schema::valid_second(
        &second,
        &second_report,
        u32::MAX
    ));
    let second_name = super::super::main_hotkey_startup_schema::SECOND_REPORT;
    assert_eq!(
        super::write_owned_artifact(&second, second_name, &second_report),
        Ok(())
    );
    let second_written: Value = serde_json::from_slice(
        &fs::read(second_directory.join(second_name)).expect("read second recovery report"),
    )
    .expect("valid second report JSON");
    assert_eq!(second_written, second_report);

    assert_eq!(
        super::write_owned_artifact(&first, second_name, &first_report),
        Err(super::schema::REPORT_WRITE_FAILED),
        "report name must match the profile phase"
    );
    let (_wrong_phase_temporary, wrong_phase, _) = private_recovery_run("first", "second", RUN_ID);
    assert_eq!(
        super::write_owned_artifact(&wrong_phase, first_name, &first_report),
        Err(super::schema::REPORT_WRITE_FAILED),
        "phase directory must match the profile phase"
    );
    let (_wrong_parent_temporary, wrong_parent, _) = private_recovery_run("first", "other", RUN_ID);
    assert_eq!(
        super::write_owned_artifact(&wrong_parent, first_name, &first_report),
        Err(super::schema::REPORT_WRITE_FAILED),
        "report requires the exact owned child directory"
    );
    let wrong_run_id = "112233445566778899aabbccddeeff00";
    let (_wrong_run_temporary, wrong_run, _) = private_recovery_run("first", "first", wrong_run_id);
    assert_eq!(
        super::write_owned_artifact(&wrong_run, first_name, &first_report),
        Err(super::schema::REPORT_WRITE_FAILED),
        "report requires the exact run-id grandparent"
    );
}
