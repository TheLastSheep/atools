//! The actual report-emission boundary: owned-only and timed through serialization/fsync.
use crate::renderer_desktop_smoke::profile::Profile;
use serde_json::Value;
use std::time::Duration;

pub(super) fn write_owned(
    profile: &Profile,
    value: &Value,
    mut elapsed: impl FnMut() -> Duration,
    write: impl FnOnce(&Profile, &Value) -> Result<(), String>,
) -> Result<(), String> {
    profile.validate_settings_height_fixture()?;
    if !super::within_producer_limit(elapsed()) {
        return Err("height report started after native total limit".into());
    }
    write(profile, value)?;
    if !super::within_producer_limit(elapsed()) {
        return Err("height report serialization/fsync exceeded native total limit".into());
    }
    Ok(())
}
pub(super) fn exit_code(stage_passed: bool, emission: &Result<(), String>) -> i32 {
    i32::from(!stage_passed || emission.is_err())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{cell::Cell, fs};
    fn owned() -> Profile {
        let run = uuid::Uuid::new_v4().simple().to_string();
        let root = format!("/private/tmp/atools-renderer-smoke-{run}");
        let args = [
            "--fixture-root",
            &root,
            "--renderer-dist",
            "/private/tmp/dist",
            "--output",
            &format!("{root}/report.json"),
            "--run-id",
            &run,
            "--auto-clear",
            "never",
            "--journey",
            "settings-height",
            "--height-case",
            "a",
        ]
        .map(str::to_owned);
        let profile = Profile::from_args(&args).unwrap();
        profile.prepare().unwrap();
        profile
    }
    #[test]
    fn bad_marker_or_missing_owned_root_cannot_reach_actual_report_writer() {
        let profile = owned();
        let marker = profile.root.join(".atools-renderer-smoke-owner.json");
        fs::write(&marker, "{}").unwrap();
        let writes = Cell::new(0);
        let result = write_owned(
            &profile,
            &json!({}),
            || Duration::ZERO,
            |profile, value| {
                writes.set(writes.get() + 1);
                profile.write_report(value)
            },
        );
        assert!(result.is_err());
        assert_eq!(writes.get(), 0);
        assert!(!profile.output.exists());
        fs::remove_dir_all(&profile.root).unwrap();
        let profile = owned();
        let moved = profile.root.with_extension("moved");
        fs::rename(&profile.root, &moved).unwrap();
        let result = write_owned(
            &profile,
            &json!({}),
            || Duration::ZERO,
            |profile, value| {
                writes.set(writes.get() + 1);
                profile.write_report(value)
            },
        );
        assert!(result.is_err());
        assert_eq!(writes.get(), 0);
        assert!(!profile.output.exists());
        fs::remove_dir_all(moved).unwrap();
    }
    #[test]
    fn delayed_real_writer_crossing_175s_returns_exit_one_even_with_prewrite_passed() {
        let profile = owned();
        let clock = Cell::new(174_900);
        let result = write_owned(
            &profile,
            &json!({"status":"passed","elapsedSamplePhase":"before-report-serialization-and-fsync"}),
            || Duration::from_millis(clock.get()),
            |profile, value| {
                profile.write_report(value)?;
                clock.set(175_100);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(profile.output.is_file());
        assert_eq!(exit_code(true, &result), 1); // Must not be recomputed from the pre-write JSON status.
        assert_eq!(exit_code(true, &Ok(())), 0);
        assert_eq!(exit_code(false, &Ok(())), 1);
        fs::remove_dir_all(&profile.root).unwrap();
    }
}
