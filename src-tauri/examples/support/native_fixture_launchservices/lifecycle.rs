use super::process::{read_identity, same_identity};
use super::protocol::{LaunchConfig, ObserverReport, ProcessIdentity};
use super::stdio;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_foundation::{NSArray, NSDate, NSError, NSRunLoop, NSString, NSURL};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const LATE_CALLBACK_GRACE: Duration = Duration::from_secs(20);

enum OpenResult { Opened(Retained<NSRunningApplication>), Failed(String) }

struct DrainLease {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<Result<stdio::Drain, String>>>,
}

impl DrainLease {
    fn finish(mut self) -> Result<stdio::Drain, String> {
        self.stop.store(true, Ordering::Release);
        self.thread.take().ok_or("bounded log reader handle missing")?.join()
            .map_err(|_| "bounded log reader panicked")?
    }
}

impl Drop for DrainLease {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

struct TargetLease {
    app: Retained<NSRunningApplication>,
    identity: ProcessIdentity,
    executable: std::path::PathBuf,
}

impl TargetLease {
    fn verify_same(&self) -> Result<bool, String> {
        match read_identity(self.identity.pid, &self.executable)? {
            Some(current) if same_identity(&self.identity, &current) => Ok(true),
            Some(_) => Err("target PID was reused or its command identity changed".into()),
            None => Ok(false),
        }
    }

    fn terminate(&self) -> Result<bool, String> {
        if self.app.isTerminated() { return Ok(!self.verify_same()?); }
        if !self.verify_same()? { return Err("target PID disappeared before termination request".into()); }
        self.app.terminate();
        let soft_deadline = Instant::now() + Duration::from_secs(4);
        while !self.app.isTerminated() && Instant::now() < soft_deadline { pump(&NSRunLoop::currentRunLoop()); }
        if !self.app.isTerminated() {
            if !self.verify_same()? { return Err("target PID disappeared before force termination".into()); }
            self.app.forceTerminate();
            let hard_deadline = Instant::now() + Duration::from_secs(4);
            while !self.app.isTerminated() && Instant::now() < hard_deadline { pump(&NSRunLoop::currentRunLoop()); }
        }
        if !self.app.isTerminated() { return Ok(false); }
        Ok(!self.verify_same()?)
    }
}

impl Drop for TargetLease {
    fn drop(&mut self) { if !self.app.isTerminated() { let _ = self.terminate(); } }
}

pub fn launch_and_observe(config: &LaunchConfig, fifo: &std::path::Path) -> Result<ObserverReport, String> {
    let draining = Arc::new(AtomicBool::new(false));
    let drain_stop = draining.clone();
    let drain_path = fifo.to_path_buf();
    let drain_run_id = config.run_id.clone();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let drain_thread = std::thread::Builder::new().name("atools-fixture-stdio".into())
        .spawn(move || stdio::drain_logs(
            &drain_path, &drain_run_id, stdio::RAW_LOG_BYTES, stdio::ENCODED_LOG_BYTES,
            &drain_stop, ready_tx,
        ))
        .map_err(|error| format!("start bounded log route: {error}"))?;
    let drain = DrainLease { stop: draining.clone(), thread: Some(drain_thread) };
    match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(error),
        Err(mpsc::RecvTimeoutError::Timeout) => return Err("stdio reader-ready handshake timed out before LaunchServices".into()),
        Err(mpsc::RecvTimeoutError::Disconnected) => return Err("stdio reader exited before its ready handshake".into()),
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_thread = cancelled.clone();
    std::thread::Builder::new().name("atools-fixture-control".into()).spawn(move || {
        use std::io::BufRead;
        let stdin = std::io::stdin();
        let mut lines = stdin.lock().lines().take(8);
        loop {
            match lines.next() {
                Some(Ok(value)) if value == "CANCEL" => { cancel_thread.store(true, Ordering::Release); break; }
                Some(Ok(_)) => continue,
                Some(Err(_)) | None => { cancel_thread.store(true, Ordering::Release); break; }
            }
        }
    }).map_err(|error| format!("start observer control reader: {error}"))?;

    let call_started = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64();
    let (sender, receiver) = mpsc::channel();
    let callback = RcBlock::new(move |app: *mut NSRunningApplication, error: *mut NSError| {
        let result = if let Some(pointer) = NonNull::new(app) {
            // SAFETY: AppKit passes a valid object retained for the callback duration.
            unsafe { Retained::retain(pointer.as_ptr()) }.map(OpenResult::Opened)
                .unwrap_or_else(|| OpenResult::Failed("LaunchServices returned an invalid application object".into()))
        } else if let Some(pointer) = NonNull::new(error) {
            // SAFETY: AppKit passes a valid NSError for the callback duration.
            let error: Option<Retained<NSError>> = unsafe { Retained::retain(pointer.as_ptr()) };
            OpenResult::Failed(error.map(|value| value.localizedDescription().to_string())
                .unwrap_or_else(|| "LaunchServices failed without an error description".into()))
        } else { OpenResult::Failed("LaunchServices returned neither app nor error".into()) };
        let _ = sender.send(result);
    });

    let bundle_url = NSURL::fileURLWithPath(&NSString::from_str(&config.bundle_path.to_string_lossy()));
    let open_config = NSWorkspaceOpenConfiguration::configuration();
    open_config.setCreatesNewApplicationInstance(true);
    open_config.setAllowsRunningApplicationSubstitution(false);
    open_config.setActivates(true);
    open_config.setAddsToRecentItems(false);
    open_config.setPromptsUserIfNeeded(false);
    let args: Vec<_> = config.target_args.iter().map(|value| NSString::from_str(value)).collect();
    let args = NSArray::from_retained_slice(&args);
    open_config.setArguments(&args);
    let mut env = config.target_env.clone();
    env.insert("ATOOLS_NATIVE_STDIO_FIFO".into(), fifo.to_string_lossy().into_owned());
    env.insert("ATOOLS_NATIVE_SMOKE_PROCESS_TAG".into(), config.process_tag.clone());
    let mut requested_keys: Vec<_> = env.keys().cloned().collect();
    requested_keys.push("ATOOLS_NATIVE_REQUESTED_ENV_KEYS".into());
    requested_keys.sort();
    env.insert("ATOOLS_NATIVE_REQUESTED_ENV_KEYS".into(), serde_json::to_string(&requested_keys)
        .map_err(|error| format!("serialize requested environment key names: {error}"))?);
    let keys: Vec<_> = env.keys().map(|value| NSString::from_str(value)).collect();
    let values: Vec<_> = env.values().map(|value| NSString::from_str(value)).collect();
    let key_refs: Vec<_> = keys.iter().map(|value| &**value).collect();
    let dictionary = objc2_foundation::NSDictionary::from_retained_objects(&key_refs, &values);
    open_config.setEnvironment(&dictionary);
    NSWorkspace::sharedWorkspace().openApplicationAtURL_configuration_completionHandler(&bundle_url, &open_config, Some(&callback));

    let run_loop = NSRunLoop::currentRunLoop();
    let callback_deadline = Instant::now() + Duration::from_millis(config.launch_timeout_ms) + LATE_CALLBACK_GRACE;
    let app = loop {
        if let Ok(result) = receiver.try_recv() { break result; }
        if Instant::now() >= callback_deadline {
            return Err("LaunchServices callback unresolved after bounded late-launch cleanup window".into());
        }
        pump(&run_loop);
    };
    let app = match app { OpenResult::Opened(app) => app, OpenResult::Failed(error) => return Err(error) };
    let target_pid = app.processIdentifier();
    let observer_pid = std::process::id();
    if target_pid <= 0 || target_pid as u32 == observer_pid {
        return Err("LaunchServices target PID is absent or aliases the observer".into());
    }
    let target_bundle_id = app.bundleIdentifier().map(|value| value.to_string());
    let target_bundle_url = app.bundleURL().and_then(|value| value.path()).map(|value| value.to_string());
    let target_executable = app.executableURL().and_then(|value| value.path()).map(|value| value.to_string());
    let launch_date = app.launchDate().map(|date| date.timeIntervalSince1970());
    let expected_bundle = std::fs::canonicalize(&config.bundle_path).map_err(|_| "bundle path cannot be canonicalized")?;
    let expected_executable = std::fs::canonicalize(&config.executable_path).map_err(|_| "executable path cannot be canonicalized")?;
    if target_bundle_id.as_deref() != Some(config.bundle_id.as_str())
        || target_bundle_url.as_deref().and_then(|path| std::fs::canonicalize(path).ok()).as_deref() != Some(expected_bundle.as_path())
        || target_executable.as_deref().and_then(|path| std::fs::canonicalize(path).ok()).as_deref() != Some(expected_executable.as_path()) {
        return Ok(failed_after_callback(config, app, target_pid, target_bundle_url, target_bundle_id, None,
            target_executable, false, false, false, drain,
            "LaunchServices callback identity does not match this run; no termination request was sent".into()));
    }
    let launch_date_present = launch_date.is_some();
    let launch_date_in_window = launch_date.is_some_and(|value| value >= call_started - 2.0 && value <= SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64() + 2.0);
    if !launch_date_in_window {
        return Ok(failed_after_callback(config, app, target_pid, target_bundle_url, target_bundle_id, None,
            target_executable, launch_date_present, launch_date_in_window, false, drain,
            "LaunchServices callback is not fresh for this run; no termination request was sent".into()));
    }
    let first_identity = match read_identity(target_pid, &expected_executable) {
        Ok(Some(identity)) => identity,
        Ok(None) => return Ok(failed_after_callback(config, app, target_pid, target_bundle_url, target_bundle_id, None,
            target_executable, launch_date_present, launch_date_in_window, true, drain,
            "process table confirmed target absence before its identity could be captured".into())),
        Err(error) => return Ok(failed_after_callback(config, app, target_pid, target_bundle_url, target_bundle_id, None,
            target_executable, launch_date_present, launch_date_in_window, true, drain,
            format!("process identity capture failed: {error}"))),
    };
    let lease = TargetLease { app: app.clone(), identity: first_identity.clone(), executable: expected_executable.clone() };
    emit_event(config, target_pid, &first_identity, &target_bundle_url, &target_bundle_id, &target_executable, launch_date_present);

    let mut identity_rechecked = false;
    let mut terminate_requested = false;
    let target_deadline = Instant::now() + Duration::from_millis(config.launch_timeout_ms);
    loop {
        if app.isTerminated() { break; }
        if cancelled.load(Ordering::Acquire) || Instant::now() >= target_deadline {
            terminate_requested = true;
            match lease.terminate() {
                Ok(true) => {}
                Ok(false) => return Ok(failed_after_callback(config, app, target_pid, target_bundle_url,
                    target_bundle_id, Some(first_identity.clone()), target_executable, launch_date_present,
                    launch_date_in_window, false, drain, "target did not terminate after bounded requests".into())),
                Err(error) => return Ok(failed_after_callback(config, app, target_pid, target_bundle_url,
                    target_bundle_id, Some(first_identity.clone()), target_executable, launch_date_present,
                    launch_date_in_window, false, drain, format!("target termination identity check failed: {error}"))),
            }
            identity_rechecked = true;
            break;
        }
        if let Ok(result) = receiver.try_recv() {
            if let OpenResult::Failed(error) = result { return Err(format!("late LaunchServices error after target callback: {error}")); }
            return Err("LaunchServices returned more than one target callback".into());
        }
        pump(&run_loop);
    }
    let target_terminated = app.isTerminated();
    if target_terminated {
        match lease.verify_same() {
            Ok(true) => return Ok(failed_after_callback(config, app, target_pid, target_bundle_url,
                target_bundle_id, Some(first_identity.clone()), target_executable, launch_date_present,
                launch_date_in_window, false, drain,
                "NSRunningApplication reports termination while the same PID identity remains live".into())),
            Ok(false) => {}
            Err(error) => return Ok(failed_after_callback(config, app, target_pid, target_bundle_url,
                target_bundle_id, Some(first_identity.clone()), target_executable, launch_date_present,
                launch_date_in_window, false, drain, format!("target termination identity recheck failed: {error}"))),
        }
        identity_rechecked = true;
    }
    let drain = drain.finish()?;
    Ok(ObserverReport {
        schema_version: 1, mode: "launchservices-private-fixture", run_id: config.run_id.clone(),
        case_id: config.case_id.clone(), observer_pid, target_pid: Some(target_pid), target_bundle_url,
        target_bundle_id, target_executable_url: target_executable, target_process_identity: Some(first_identity), launch_date_present,
        launch_date_in_window, launch_callback_received: true, target_terminated,
        target_os_exit_code: None, target_os_exit_code_source: "NSRunningApplication does not expose process exit status",
        termination_identity_rechecked: identity_rechecked, log_bytes: drain.bytes,
        log_encoded_bytes: drain.encoded_bytes, log_frame_count: drain.frame_count,
        log_overflow: drain.overflow,
        log_route_complete: drain.complete && !drain.overflow && drain.error.is_none() && target_terminated,
        error: if !target_terminated {
            Some(if terminate_requested { "target survived bounded terminate/forceTerminate" } else { "target did not terminate" }.into())
        } else if let Some(error) = drain.error {
            Some(format!("target log route failed: {error}"))
        } else if !drain.complete || drain.overflow {
            Some("bounded target log drain was incomplete".into())
        } else { None },
    })
}

fn failed_after_callback(
    config: &LaunchConfig,
    app: Retained<NSRunningApplication>,
    target_pid: i32,
    target_bundle_url: Option<String>,
    target_bundle_id: Option<String>,
    target_process_identity: Option<ProcessIdentity>,
    target_executable_url: Option<String>,
    launch_date_present: bool,
    launch_date_in_window: bool,
    request_termination: bool,
    drain: DrainLease,
    reason: String,
) -> ObserverReport {
    let termination = request_termination.then(|| terminate_callback_application(&app));
    let target_terminated = app.isTerminated();
    let drain = drain.finish();
    let (log_bytes, log_encoded_bytes, log_frame_count, log_overflow, log_route_complete, drain_error) = match drain {
        Ok(value) => (value.bytes, value.encoded_bytes, value.frame_count, value.overflow,
            value.complete && !value.overflow && value.error.is_none() && target_terminated, value.error),
        Err(error) => (0, 0, 0, false, false, Some(error)),
    };
    let mut errors = vec![reason,
        format!("callback PID={target_pid}; terminal={target_terminated}; process identity captured={}", target_process_identity.is_some())];
    if let Some(Err(error)) = termination { errors.push(error); }
    if !request_termination && target_process_identity.is_none() {
        errors.push("no termination request was sent because callback identity was not freshly proven".into());
    }
    if let Some(error) = drain_error { errors.push(error); }
    ObserverReport {
        schema_version: 1, mode: "launchservices-private-fixture", run_id: config.run_id.clone(),
        case_id: config.case_id.clone(), observer_pid: std::process::id(), target_pid: Some(target_pid),
        target_bundle_url, target_bundle_id, target_executable_url, target_process_identity,
        launch_date_present, launch_date_in_window, launch_callback_received: true, target_terminated,
        target_os_exit_code: None, target_os_exit_code_source: "NSRunningApplication does not expose process exit status",
        termination_identity_rechecked: false, log_bytes, log_encoded_bytes, log_frame_count,
        log_overflow, log_route_complete,
        error: Some(errors.join("; ")),
    }
}

fn terminate_callback_application(app: &NSRunningApplication) -> Result<(), String> {
    if app.isTerminated() { return Ok(()); }
    app.terminate();
    let soft_deadline = Instant::now() + Duration::from_secs(4);
    while !app.isTerminated() && Instant::now() < soft_deadline { pump(&NSRunLoop::currentRunLoop()); }
    if !app.isTerminated() {
        app.forceTerminate();
        let hard_deadline = Instant::now() + Duration::from_secs(4);
        while !app.isTerminated() && Instant::now() < hard_deadline { pump(&NSRunLoop::currentRunLoop()); }
    }
    if app.isTerminated() { Ok(()) } else { Err("callback-bound terminate and forceTerminate did not converge".into()) }
}

fn pump(loop_: &NSRunLoop) { loop_.runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.05)); }

fn emit_event(config: &LaunchConfig, pid: i32, identity: &ProcessIdentity, bundle_url: &Option<String>, bundle_id: &Option<String>, executable: &Option<String>, launch_date: bool) {
    let event = serde_json::json!({ "runId": config.run_id, "caseId": config.case_id,
        "observerPid": std::process::id(), "targetPid": pid, "bundleURL": bundle_url,
        "bundleId": bundle_id, "executableURL": executable, "launchDatePresent": launch_date,
        "processStartToken": identity.start_token, "commandSha256": identity.command_sha256,
        "executablePath": identity.executable_path });
    println!("AToolsNativeLaunchServicesEvent {event}");
}
