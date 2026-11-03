use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MARKER_LIMIT: usize = 512;
const OBSERVE_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Clone, Copy, Debug)]
pub(in crate::renderer_desktop_smoke) struct ProbeObservation {
    pub(in crate::renderer_desktop_smoke) started: bool,
    pub(in crate::renderer_desktop_smoke) nonce_matched: bool,
    pub(in crate::renderer_desktop_smoke) exit_marker: bool,
    pub(in crate::renderer_desktop_smoke) terminal: bool,
    pub(in crate::renderer_desktop_smoke) run_id_matched: bool,
    pub(in crate::renderer_desktop_smoke) probe_id_matched: bool,
    pub(in crate::renderer_desktop_smoke) pid: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Marker {
    run_id: String,
    probe_id: String,
    pid: u32,
}

pub(in crate::renderer_desktop_smoke) fn markers_absent(profile_root: &Path) -> bool {
    ["first", "second"].into_iter().all(|probe_id| {
        let Some(resources) = resources_path(profile_root, probe_id) else {
            return false;
        };
        ["probe-started.json", "probe-exiting.json"]
            .into_iter()
            .all(|name| marker_absent(&resources.join(name)))
    })
}

pub(in crate::renderer_desktop_smoke) fn markers_absent_for(
    profile_root: &Path,
    probe_id: &str,
) -> bool {
    let Some(resources) = resources_path(profile_root, probe_id) else {
        return false;
    };
    ["probe-started.json", "probe-exiting.json"]
        .into_iter()
        .all(|name| marker_absent(&resources.join(name)))
}

pub(in crate::renderer_desktop_smoke) fn observe_probe(
    profile_root: &Path,
    run_id: &str,
    probe_id: &str,
) -> ProbeObservation {
    let Some(resources) = resources_path(profile_root, probe_id) else {
        return ProbeObservation::default();
    };
    let started = wait_for_marker(&resources.join("probe-started.json"));
    let Some(start_marker) = started else {
        return ProbeObservation::default();
    };
    let run_id_matched = start_marker.run_id == run_id;
    let probe_id_matched = start_marker.probe_id == probe_id;
    let nonce_matched = run_id_matched && probe_id_matched;
    let exit_marker = wait_for_marker(&resources.join("probe-exiting.json"));
    let matching_exit = exit_marker
        .as_ref()
        .is_some_and(|marker| marker == &start_marker);
    let terminal = if matching_exit && nonce_matched {
        wait_for_terminal(start_marker.pid)
    } else {
        false
    };
    ProbeObservation {
        started: true,
        nonce_matched,
        exit_marker: matching_exit,
        terminal,
        run_id_matched,
        probe_id_matched,
        pid: Some(start_marker.pid),
    }
}

impl Default for ProbeObservation {
    fn default() -> Self {
        Self {
            started: false,
            nonce_matched: false,
            exit_marker: false,
            terminal: false,
            run_id_matched: false,
            probe_id_matched: false,
            pid: None,
        }
    }
}

fn resources_path(profile_root: &Path, probe_id: &str) -> Option<PathBuf> {
    let bundle = match probe_id {
        "first" => "AToolsOwnedProbeFirst.app",
        "second" => "AToolsOwnedProbeSecond.app",
        _ => return None,
    };
    Some(
        profile_root
            .join("launcher-apps")
            .join(bundle)
            .join("Contents")
            .join("Resources"),
    )
}

fn marker_absent(path: &Path) -> bool {
    matches!(
        fs::symlink_metadata(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    )
}

fn wait_for_marker(path: &Path) -> Option<Marker> {
    let deadline = Instant::now() + OBSERVE_TIMEOUT;
    loop {
        if let Some(marker) = read_marker(path) {
            return Some(marker);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn read_marker(path: &Path) -> Option<Marker> {
    let before = fs::symlink_metadata(path).ok()?;
    if !before.file_type().is_file() || before.len() > MARKER_LIMIT as u64 {
        return None;
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    let opened = file.metadata().ok()?;
    if !opened.is_file() || opened.dev() != before.dev() || opened.ino() != before.ino() {
        return None;
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(MARKER_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > MARKER_LIMIT {
        return None;
    }
    parse_marker(&bytes)
}

fn parse_marker(bytes: &[u8]) -> Option<Marker> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let object = value.as_object()?;
    if object.len() != 4
        || !["schemaVersion", "runId", "probeId", "pid"]
            .iter()
            .all(|key| object.contains_key(*key))
        || value.get("schemaVersion")?.as_u64()? != 1
    {
        return None;
    }
    let run_id = value.get("runId")?.as_str()?;
    let probe_id = value.get("probeId")?.as_str()?;
    let pid = u32::try_from(value.get("pid")?.as_u64()?).ok()?;
    if run_id.len() != 32
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !matches!(probe_id, "first" | "second")
        || pid == 0
        || pid > i32::MAX as u32
    {
        return None;
    }
    Some(Marker {
        run_id: run_id.to_owned(),
        probe_id: probe_id.to_owned(),
        pid,
    })
}

fn wait_for_terminal(pid: u32) -> bool {
    let deadline = Instant::now() + OBSERVE_TIMEOUT;
    loop {
        match process_exists(pid) {
            Ok(false) => return true,
            Ok(true) => {}
            Err(()) => return false,
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn process_exists(pid: u32) -> Result<bool, ()> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(());
    }
    // Signal 0 only probes liveness; this code never sends a terminating signal.
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if result == 0 {
        return Ok(true);
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        _ => Err(()),
    }
}
