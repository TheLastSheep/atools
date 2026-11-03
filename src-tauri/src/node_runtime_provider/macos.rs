use super::{APPROVED_ENTITLEMENTS_SHA256, APP_IDENTIFIER};
use atools_plugin::sidecar::node_runtime_cache::{NodeTarget, RuntimeSignatureVerifier};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read};
use std::os::fd::AsRawFd;
use std::os::unix::fs::FileExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const CODESIGN: &str = "/usr/bin/codesign";
const COMMAND_LIMIT: Duration = Duration::from_secs(15);
const OUTPUT_LIMIT: usize = 256 * 1024;
const ENTITLEMENTS_LIMIT: usize = 64 * 1024;
const INFO_PLIST_LIMIT: u64 = 1024 * 1024;
const XML_DECLARATION: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>";
const XML_DTD: &str = "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">";
const APPROVED_KEYS: [&str; 3] = [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
];

pub(super) struct CodesignVerifier;

impl RuntimeSignatureVerifier for CodesignVerifier {
    fn verify_signed_binary(
        &self,
        absolute_path: &Path,
        opened_binary: &File,
        target: NodeTarget,
        expected_team_id: &str,
        approved_entitlements_sha256: &str,
        cancelled: &AtomicBool,
    ) -> Result<(), ()> {
        if cancelled.load(Ordering::Acquire)
            || approved_entitlements_sha256 != APPROVED_ENTITLEMENTS_SHA256
        {
            return Err(());
        }
        let inherited = InheritedFd::new(opened_binary.as_raw_fd())?;
        let descriptor_path = PathBuf::from(format!("/dev/fd/{}", inherited.fd));
        if !absolute_path.is_absolute() || !descriptor_path.exists() {
            return Err(());
        }
        verify_macho_target(opened_binary, target)?;

        run_bounded(
            CODESIGN,
            &[
                "--verify".into(),
                "--strict".into(),
                descriptor_path.as_os_str().to_owned(),
            ],
            cancelled,
            None,
        )?;
        let details = run_bounded(
            CODESIGN,
            &[
                "--display".into(),
                "--verbose=4".into(),
                descriptor_path.as_os_str().to_owned(),
            ],
            cancelled,
            None,
        )?;
        validate_signature_summary(&combined_text(&details)?, expected_team_id)?;
        let entitlements = run_bounded(
            CODESIGN,
            &[
                "--display".into(),
                "--entitlements".into(),
                "-".into(),
                "--xml".into(),
                descriptor_path.as_os_str().to_owned(),
            ],
            cancelled,
            Some(ENTITLEMENTS_LIMIT),
        )?;
        validate_approved_entitlements(&entitlements.stdout, approved_entitlements_sha256)
    }
}

pub(super) fn verify_app_bundle(
    app_bundle: &Path,
    resource_directory: &Path,
    configured_identifier: &str,
    expected_team_id: &str,
    cancelled: &AtomicBool,
) -> Result<(), ()> {
    if cancelled.load(Ordering::Acquire)
        || configured_identifier != APP_IDENTIFIER
        || !valid_team_id(expected_team_id)
        || app_bundle.extension().and_then(|value| value.to_str()) != Some("app")
    {
        return Err(());
    }
    let expected_resources = app_bundle.join("Contents/Resources/node-runtime/compressed");
    if resource_directory != expected_resources {
        return Err(());
    }
    let before = checked_directory_identity(app_bundle)?;
    checked_directory_identity(&app_bundle.join("Contents"))?;
    checked_directory_identity(resource_directory)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(());
    }
    let info = read_info_plist(&app_bundle.join("Contents/Info.plist"))?;
    let identifier = info
        .as_dictionary()
        .and_then(|values| values.get("CFBundleIdentifier"))
        .and_then(plist::Value::as_string)
        .ok_or(())?;
    if identifier != APP_IDENTIFIER {
        return Err(());
    }
    run_bounded(
        CODESIGN,
        &[
            "--verify".into(),
            "--deep".into(),
            "--strict".into(),
            app_bundle.as_os_str().to_owned(),
        ],
        cancelled,
        None,
    )?;
    let details = run_bounded(
        CODESIGN,
        &[
            "--display".into(),
            "--verbose=4".into(),
            app_bundle.as_os_str().to_owned(),
        ],
        cancelled,
        None,
    )?;
    validate_signature_summary(&combined_text(&details)?, expected_team_id)?;
    let after = checked_directory_identity(app_bundle)?;
    if cancelled.load(Ordering::Acquire) || before != after {
        return Err(());
    }
    checked_directory_identity(&app_bundle.join("Contents"))?;
    checked_directory_identity(resource_directory)?;
    Ok(())
}

fn read_info_plist(path: &Path) -> Result<plist::Value, ()> {
    let before = fs::symlink_metadata(path).map_err(|_| ())?;
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.len() == 0
        || before.len() > INFO_PLIST_LIMIT
    {
        return Err(());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| ())?;
    let opened = file.metadata().map_err(|_| ())?;
    if !same_metadata(&before, &opened) {
        return Err(());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(INFO_PLIST_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    let after = file.metadata().map_err(|_| ())?;
    if bytes.len() as u64 != before.len() || !same_metadata(&before, &after) {
        return Err(());
    }
    plist::Value::from_reader(Cursor::new(bytes)).map_err(|_| ())
}

fn checked_directory_identity(path: &Path) -> Result<FileIdentity, ()> {
    if !path.is_absolute() {
        return Err(());
    }
    let mut cursor = PathBuf::from("/");
    let mut final_meta = None;
    for (index, component) in path.components().enumerate() {
        match component {
            Component::RootDir => continue,
            Component::Normal(part) => cursor.push(part),
            _ => return Err(()),
        }
        let meta = fs::symlink_metadata(&cursor).map_err(|_| ())?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(());
        }
        if index + 1 < path.components().count() && !meta.is_dir() {
            return Err(());
        }
        final_meta = Some(FileIdentity::from(&meta));
    }
    final_meta.ok_or(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileIdentity {
    dev: u64,
    ino: u64,
    uid: u32,
    mode: u32,
    size: u64,
    mtime: i64,
    ctime: i64,
    mtime_nsec: i64,
    ctime_nsec: i64,
}
impl From<&fs::Metadata> for FileIdentity {
    fn from(meta: &fs::Metadata) -> Self {
        Self {
            dev: meta.dev(),
            ino: meta.ino(),
            uid: meta.uid(),
            mode: meta.mode(),
            size: meta.size(),
            mtime: meta.mtime(),
            ctime: meta.ctime(),
            mtime_nsec: meta.mtime_nsec(),
            ctime_nsec: meta.ctime_nsec(),
        }
    }
}
fn same_metadata(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    FileIdentity::from(left) == FileIdentity::from(right)
}

fn validate_signature_summary(text: &str, expected_team_id: &str) -> Result<(), ()> {
    if !valid_team_id(expected_team_id) {
        return Err(());
    }
    let teams = text
        .lines()
        .filter_map(|line| line.strip_prefix("TeamIdentifier="))
        .collect::<Vec<_>>();
    let authorities = text
        .lines()
        .filter_map(|line| line.strip_prefix("Authority="))
        .filter(|line| line.starts_with("Developer ID Application:"))
        .collect::<Vec<_>>();
    let runtime = text
        .lines()
        .any(|line| line.starts_with("CodeDirectory ") && line.contains("(runtime)"));
    let timestamps = text
        .lines()
        .filter_map(|line| line.strip_prefix("Timestamp="))
        .collect::<Vec<_>>();
    let authority_matches = authorities
        .first()
        .is_some_and(|line| line.ends_with(&format!(" ({expected_team_id})")));
    if teams.as_slice() != [expected_team_id]
        || authorities.len() != 1
        || !authority_matches
        || !runtime
        || timestamps.len() != 1
        || timestamps[0].trim().is_empty()
        || timestamps[0].trim().eq_ignore_ascii_case("none")
    {
        return Err(());
    }
    Ok(())
}

fn validate_approved_entitlements(xml: &[u8], expected_sha256: &str) -> Result<(), ()> {
    if xml.is_empty()
        || xml.len() > ENTITLEMENTS_LIMIT
        || expected_sha256 != APPROVED_ENTITLEMENTS_SHA256
    {
        return Err(());
    }
    let source = std::str::from_utf8(xml).map_err(|_| ())?;
    let mut body = source.trim();
    if let Some(rest) = body.strip_prefix(XML_DECLARATION) {
        body = rest.trim_start();
    }
    if let Some(rest) = body.strip_prefix(XML_DTD) {
        body = rest.trim_start();
    }
    body = body.strip_prefix("<plist version=\"1.0\">").ok_or(())?;
    body = body.strip_suffix("</plist>").ok_or(())?.trim();
    body = body.strip_prefix("<dict>").ok_or(())?;
    body = body.strip_suffix("</dict>").ok_or(())?.trim();
    let mut keys = Vec::new();
    while !body.trim().is_empty() {
        body = body.trim_start();
        body = body.strip_prefix("<key>").ok_or(())?;
        let (key, rest) = body.split_once("</key>").ok_or(())?;
        if key
            .chars()
            .any(|character| matches!(character, '<' | '>' | '&'))
            || !APPROVED_KEYS.contains(&key)
            || keys.contains(&key)
        {
            return Err(());
        }
        body = rest.trim_start();
        body = if let Some(rest) = body.strip_prefix("<true/>") {
            rest
        } else if let Some(rest) = body.strip_prefix("<true />") {
            rest
        } else {
            return Err(());
        };
        keys.push(key);
    }
    keys.sort_unstable();
    let mut expected = APPROVED_KEYS.to_vec();
    expected.sort_unstable();
    if keys == expected {
        Ok(())
    } else {
        Err(())
    }
}

fn verify_macho_target(binary: &File, target: NodeTarget) -> Result<(), ()> {
    let mut header = [0u8; 8];
    if binary.read_at(&mut header, 0).map_err(|_| ())? != header.len() {
        return Err(());
    }
    let cputype = match header[..4] {
        [0xcf, 0xfa, 0xed, 0xfe] => u32::from_le_bytes(header[4..8].try_into().map_err(|_| ())?),
        [0xfe, 0xed, 0xfa, 0xcf] => u32::from_be_bytes(header[4..8].try_into().map_err(|_| ())?),
        _ => return Err(()),
    };
    let expected = match target {
        NodeTarget::Aarch64AppleDarwin => 0x0100_000cu32,
        NodeTarget::X86_64AppleDarwin => 0x0100_0007u32,
    };
    if cputype == expected {
        Ok(())
    } else {
        Err(())
    }
}

fn valid_team_id(team: &str) -> bool {
    team.len() == 10
        && team
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}
fn output_text(bytes: &[u8]) -> Result<String, ()> {
    String::from_utf8(bytes.to_vec()).map_err(|_| ())
}
fn combined_text(output: &ToolOutput) -> Result<String, ()> {
    let mut text = output_text(&output.stdout)?;
    text.push('\n');
    text.push_str(&output_text(&output.stderr)?);
    Ok(text)
}

struct ToolOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}
static NEXT_READER: AtomicU64 = AtomicU64::new(0);
fn run_bounded(
    program: &str,
    args: &[std::ffi::OsString],
    cancelled: &AtomicBool,
    output_limit: Option<usize>,
) -> Result<ToolOutput, ()> {
    run_bounded_with_spawn_hook(program, args, cancelled, output_limit, || {})
}

fn run_bounded_with_spawn_hook(
    program: &str,
    args: &[std::ffi::OsString],
    cancelled: &AtomicBool,
    output_limit: Option<usize>,
    after_spawn: impl FnOnce(),
) -> Result<ToolOutput, ()> {
    if cancelled.load(Ordering::Acquire) {
        return Err(());
    }
    let output_limit = output_limit.unwrap_or(OUTPUT_LIMIT);
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| ())?;
    after_spawn();
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(());
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(());
    };
    let overflow = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stdout_thread = match spawn_reader(stdout, Arc::clone(&overflow), output_limit) {
        Ok(reader) => reader,
        Err(()) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(());
        }
    };
    let stderr_thread = match spawn_reader(stderr, Arc::clone(&overflow), output_limit) {
        Ok(reader) => reader,
        Err(()) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_thread.join();
            return Err(());
        }
    };
    let started = Instant::now();
    let status = loop {
        if cancelled.load(Ordering::Acquire)
            || started.elapsed() >= COMMAND_LIMIT
            || overflow.load(Ordering::Acquire)
        {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err(());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(());
            }
        }
    };
    let stdout = stdout_thread.join().map_err(|_| ())??;
    let stderr = stderr_thread.join().map_err(|_| ())??;
    if !status.success() || overflow.load(Ordering::Acquire) {
        return Err(());
    }
    Ok(ToolOutput { stdout, stderr })
}
fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    overflow: Arc<std::sync::atomic::AtomicBool>,
    output_limit: usize,
) -> Result<thread::JoinHandle<Result<Vec<u8>, ()>>, ()> {
    let id = NEXT_READER.fetch_add(1, Ordering::Relaxed);
    thread::Builder::new()
        .name(format!("codesign-output-{id}"))
        .spawn(move || {
            let mut captured = Vec::new();
            let mut buffer = [0u8; 8192];
            loop {
                let read = reader.read(&mut buffer).map_err(|_| ())?;
                if read == 0 {
                    return Ok(captured);
                }
                let retained = output_limit.saturating_sub(captured.len());
                captured.extend_from_slice(&buffer[..read.min(retained)]);
                if read > retained {
                    overflow.store(true, Ordering::Release);
                }
            }
        })
        .map_err(|_| ())
}

struct InheritedFd {
    fd: libc::c_int,
    original_flags: libc::c_int,
}
impl InheritedFd {
    fn new(fd: libc::c_int) -> Result<Self, ()> {
        // The child only receives this already-open, validated descriptor via /dev/fd.
        let original_flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if original_flags < 0
            || unsafe { libc::fcntl(fd, libc::F_SETFD, original_flags & !libc::FD_CLOEXEC) } < 0
        {
            return Err(());
        }
        Ok(Self { fd, original_flags })
    }
}
impl Drop for InheritedFd {
    fn drop(&mut self) {
        unsafe {
            libc::fcntl(self.fd, libc::F_SETFD, self.original_flags);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    const GOOD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>";
    #[test]
    fn accepts_only_the_fixed_developer_id_runtime_and_entitlement_contract() {
        let summary = "Authority=Developer ID Application: ATools (HX7739G8FX)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=HX7739G8FX\nCodeDirectory v=20400 size=123 flags=0x10000(runtime)\nTimestamp=2026-10-21 12:00:00 +0000";
        assert!(validate_signature_summary(summary, "HX7739G8FX").is_ok());
        assert!(
            validate_approved_entitlements(GOOD.as_bytes(), APPROVED_ENTITLEMENTS_SHA256).is_ok()
        );
    }
    #[test]
    fn rejects_signature_team_authority_runtime_timestamp_and_entitlement_drift() {
        let base = "Authority=Developer ID Application: ATools (HX7739G8FX)\nTeamIdentifier=HX7739G8FX\nCodeDirectory v=20400 flags=0x10000(runtime)\nTimestamp=2026-10-21";
        for altered in [
            base.replace("HX7739G8FX", "AAAAAAAAAA"),
            base.replace("(HX7739G8FX)", "(AAAAAAAAAA)"),
            base.replace("(runtime)", ""),
            base.replace("Timestamp=2026-10-21", "Timestamp=none"),
        ] {
            assert!(validate_signature_summary(&altered, "HX7739G8FX").is_err());
        }
        let extra = GOOD.replace("</dict>", "<key>get-task-allow</key><true/></dict>");
        let duplicate = GOOD.replace(
            "</dict>",
            "<key>com.apple.security.cs.allow-jit</key><true/></dict>",
        );
        let false_value = GOOD.replace("<true/>", "<false/>");
        for invalid in [
            extra,
            duplicate,
            false_value,
            GOOD.replace("<!DOCTYPE", "<!ENTITY"),
        ] {
            assert!(validate_approved_entitlements(
                invalid.as_bytes(),
                APPROVED_ENTITLEMENTS_SHA256
            )
            .is_err());
        }
    }

    #[test]
    fn cancellation_kills_reaps_and_joins_owned_codesign_child() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let (spawned_tx, spawned_rx) = mpsc::channel();
        let signal = Arc::clone(&cancelled);
        let signal_thread = thread::spawn(move || {
            spawned_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            signal.store(true, Ordering::Release);
        });
        let result = run_bounded_with_spawn_hook(
            "/bin/sleep",
            &["10".into()],
            cancelled.as_ref(),
            None,
            || spawned_tx.send(()).unwrap(),
        );
        signal_thread.join().unwrap();
        assert!(result.is_err());
        assert!(cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn macho_header_must_match_selected_runtime_architecture() {
        let arm = tempfile::tempfile().unwrap();
        std::os::unix::fs::FileExt::write_at(
            &arm,
            &[0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01],
            0,
        )
        .unwrap();
        assert!(verify_macho_target(&arm, NodeTarget::Aarch64AppleDarwin).is_ok());
        assert!(verify_macho_target(&arm, NodeTarget::X86_64AppleDarwin).is_err());
        let x64 = tempfile::tempfile().unwrap();
        std::os::unix::fs::FileExt::write_at(
            &x64,
            &[0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01],
            0,
        )
        .unwrap();
        assert!(verify_macho_target(&x64, NodeTarget::X86_64AppleDarwin).is_ok());
        assert!(verify_macho_target(&x64, NodeTarget::Aarch64AppleDarwin).is_err());
    }
}
