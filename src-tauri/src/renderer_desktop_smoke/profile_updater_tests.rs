use super::*;
#[test]
fn selection_requires_exact_root_and_offline_profile() {
    let id = "12345678123412341234123456781234";
    let root = format!("/private/tmp/atools-renderer-updater-{id}");
    let expected = cfg!(all(
        target_os = "macos",
        feature = "legacy-node-smoke",
        feature = "ztools-multiwebview"
    ));
    assert_eq!(
        validate(true, Path::new(&root), id, "never").is_ok(),
        expected
    );
    assert!(validate(true, Path::new("/private/tmp/other"), id, "never").is_err());
    assert!(validate(true, Path::new(&root), id, "immediately").is_err());
    assert!(validate(false, Path::new("/private/tmp/other"), id, "immediately").is_ok());
}

#[test]
fn real_parser_selects_only_updater_and_retains_other_flag_rejections() {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let root = format!("/private/tmp/atools-renderer-updater-{id}");
    let output = format!("/private/tmp/atools-updater-report-{id}.json");
    let args = [
        "--fixture-root",
        &root,
        "--renderer-dist",
        "/private/tmp/dist",
        "--output",
        &output,
        "--run-id",
        &id,
        "--journey",
        "updater",
        "--auto-clear",
        "never",
    ]
    .map(str::to_owned);
    let parsed = super::super::Profile::from_args(&args);
    if cfg!(all(
        target_os = "macos",
        feature = "legacy-node-smoke",
        feature = "ztools-multiwebview"
    )) {
        let p = parsed.unwrap();
        assert!(p.updater_journey);
        assert!(
            !p.catalog_journey && !p.settings_journey && !p.manual_ui && !p.launch_return_journey
        );
        let mut extra = args.to_vec();
        extra.extend(["--window-drag".into(), "true".into()]);
        assert!(super::super::Profile::from_args(&extra).is_err());
    } else {
        assert!(parsed.is_err());
    }
}
