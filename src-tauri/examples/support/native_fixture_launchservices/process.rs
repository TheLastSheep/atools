use super::protocol::ProcessIdentity;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::process::Command;

pub fn read_identity(
    pid: i32,
    expected_executable: &Path,
) -> Result<Option<ProcessIdentity>, String> {
    let output = Command::new("/bin/ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "lstart=,args="])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .output()
        .map_err(|error| format!("read process identity: {error}"))?;
    if !output.status.success() {
        if process_query_confirms_absence(pid, &output.stdout, &output.stderr)? {
            return Ok(None);
        }
        return Err("process table query failed while the PID still appears live".into());
    }
    let row = String::from_utf8(output.stdout).map_err(|_| "process table is not UTF-8")?;
    let (start, command) = split_lstart_and_command(row.trim())
        .ok_or("process identity row lacks lstart or command")?;
    let executable = std::fs::canonicalize(expected_executable)
        .map_err(|_| "expected executable cannot be canonicalized")?;
    let expected = executable.to_string_lossy();
    if command != expected
        && !command
            .strip_prefix(expected.as_ref())
            .is_some_and(|tail| tail.starts_with(' '))
    {
        return Err("PID command identity does not match the staged fixture executable".into());
    }
    let digest = Sha256::digest(command.as_bytes());
    Ok(Some(ProcessIdentity {
        pid,
        start_token: start,
        command_sha256: format!("{digest:x}"),
        executable_path: expected.into_owned(),
    }))
}

fn split_lstart_and_command(row: &str) -> Option<(String, &str)> {
    let mut cursor = 0;
    let mut fields = Vec::with_capacity(5);
    while fields.len() < 5 {
        while row[cursor..].chars().next()?.is_whitespace() {
            cursor += row[cursor..].chars().next()?.len_utf8();
        }
        let start = cursor;
        while let Some(character) = row[cursor..].chars().next() {
            if character.is_whitespace() {
                break;
            }
            cursor += character.len_utf8();
        }
        if cursor == start {
            return None;
        }
        fields.push(&row[start..cursor]);
    }
    let start = fields.join(" ");
    let command = row[cursor..].trim_start();
    (!command.is_empty()).then_some((start, command))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LivenessProbe {
    Missing,
    Present,
    Denied,
    Failed(i32),
}

fn classify_empty_process_query(
    stdout: &[u8],
    stderr: &[u8],
    probe: LivenessProbe,
) -> Result<bool, String> {
    if !stdout.is_empty() || !stderr.is_empty() {
        return Err(
            "process table query failed with output; PID absence is not inferred from ps text"
                .into(),
        );
    }
    match probe {
        LivenessProbe::Missing => Ok(true),
        LivenessProbe::Present => {
            Err("process table query failed while the PID still appears live".into())
        }
        LivenessProbe::Denied => {
            Err("cannot confirm PID absence because the liveness probe was denied".into())
        }
        LivenessProbe::Failed(errno) => Err(format!(
            "cannot confirm PID absence; liveness probe errno={errno}"
        )),
    }
}

fn process_query_confirms_absence(pid: i32, stdout: &[u8], stderr: &[u8]) -> Result<bool, String> {
    let result = unsafe { libc::kill(pid, 0) };
    let probe = if result == 0 {
        LivenessProbe::Present
    } else {
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => LivenessProbe::Missing,
            Some(libc::EPERM) => LivenessProbe::Denied,
            Some(errno) => LivenessProbe::Failed(errno),
            None => LivenessProbe::Failed(-1),
        }
    };
    classify_empty_process_query(stdout, stderr, probe)
}

pub fn same_identity(left: &ProcessIdentity, right: &ProcessIdentity) -> bool {
    left.pid == right.pid
        && left.start_token == right.start_token
        && left.command_sha256 == right.command_sha256
        && left.executable_path == right.executable_path
}

#[cfg(test)]
mod tests {
    use super::{
        classify_empty_process_query, process_query_confirms_absence, read_identity,
        split_lstart_and_command, LivenessProbe,
    };
    use std::process::Command;

    #[test]
    fn parses_single_and_double_spaced_days_and_commands_with_spaces() {
        for date in [
            "Mon Oct  1 12:34:56 2026",
            "Fri Oct  9 12:34:56 2026",
            "Mon Oct 19 12:34:56 2026",
        ] {
            let row = format!("{date} /private/tmp/ATools Fixture/app");
            let (start, command) = split_lstart_and_command(&row).unwrap();
            assert_eq!(start, date.split_whitespace().collect::<Vec<_>>().join(" "));
            assert_eq!(command, "/private/tmp/ATools Fixture/app");
        }
    }

    #[test]
    fn rejects_invalid_identity_rows_and_distinguishes_denial_from_absence() {
        assert!(split_lstart_and_command("invalid process row").is_none());
        assert_eq!(
            classify_empty_process_query(b"", b"", LivenessProbe::Missing),
            Ok(true)
        );
        assert!(classify_empty_process_query(b"", b"", LivenessProbe::Present).is_err());
        assert!(classify_empty_process_query(b"", b"", LivenessProbe::Denied).is_err());
        assert!(classify_empty_process_query(b"", b"", LivenessProbe::Failed(libc::EIO)).is_err());
        assert!(
            classify_empty_process_query(
                b"",
                b"ps: no matching processes found",
                LivenessProbe::Missing
            )
            .is_err(),
            "stderr text alone never proves absence"
        );
        assert!(
            classify_empty_process_query(b"stale output", b"", LivenessProbe::Missing).is_err()
        );
    }

    #[test]
    fn a_reaped_child_is_confirmed_absent_without_guessing_from_ps_text() {
        let own_pid = std::process::id().to_string();
        let process_table = Command::new("/bin/ps")
            .args(["-ww", "-p", &own_pid, "-o", "pid="])
            .output();
        match process_table {
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                eprintln!(
                    "reaped-child process probe skipped before spawning: /bin/ps execution denied"
                );
                return;
            }
            Ok(output) if output.status.success() && !output.stdout.is_empty() => {}
            Ok(_) => panic!("/bin/ps probe did not identify the current test process"),
            Err(error) => panic!("/bin/ps probe failed: {error}"),
        }
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let pid = child.id() as i32;
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(read_identity(pid, std::path::Path::new("/bin/sleep"))
            .unwrap()
            .is_none());
        assert_eq!(process_query_confirms_absence(pid, b"", b"").unwrap(), true);
    }
}
