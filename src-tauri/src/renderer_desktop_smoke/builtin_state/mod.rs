mod cold_main;
mod report;
mod seed;
mod storage;

use super::profile::Profile;

pub(super) fn prepare(profile: &Profile) -> Result<bool, String> {
    if let Err(error) = profile.prepare() {
        if profile.builtin_state_journey {
            let _ = report::write_resume_rejection(profile);
        }
        return Err(error);
    }
    if profile.builtin_state_seed {
        tauri::async_runtime::block_on(seed::run(profile))?;
        return Ok(true);
    }
    Ok(false)
}

pub(super) fn start_main(app: tauri::AppHandle<tauri::Wry>) {
    cold_main::start(app);
}
