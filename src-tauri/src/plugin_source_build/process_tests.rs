use super::*;
use atools_plugin::source_build::{ManifestIdentity, ManifestSelection};
use sha2::{Digest, Sha256};

#[tokio::test]
async fn already_cancelled_job_finishes_without_spawning() {
    let cancelled = Arc::new(AtomicBool::new(true));
    let finished = Arc::new(AtomicBool::new(false));
    let plan = SourceBuildPlan {
        source_root: PathBuf::new(),
        manifest_relative: "plugin.json".into(),
        manifest_selection: ManifestSelection::Root,
        manifest_sha256: String::new(),
        manifest_identity: ManifestIdentity {
            id: "unused".into(),
            version: "1".into(),
            main: "index.html".into(),
            preload: None,
            runtime: "web".into(),
            feature_codes: vec![],
        },
        plugin_id: "unused".into(),
        version: "1".into(),
        dependency_root: PathBuf::new(),
        vite_cli: PathBuf::new(),
        vite_backend: atools_plugin::source_build::ViteBuildBackend::Esbuild {
            binary: PathBuf::new(),
        },
        test_esbuild_binary: None,
        manifest_output_rewrite: None,
        build_steps: vec![],
    };
    let result = build(
        plan,
        PathBuf::new(),
        cancelled,
        finished.clone(),
        Arc::new(AtomicBool::new(false)),
        String::new(),
    )
    .await;
    #[cfg(target_os = "macos")]
    assert!(matches!(result, Err(error) if error == "SOURCE_BUILD_CANCELLED"));
    #[cfg(not(target_os = "macos"))]
    assert!(matches!(result, Err(error) if error == "SourceBuildSandboxUnsupported"));
    assert!(finished.load(Ordering::Acquire));
}

#[test]
fn future_cancel_guard_only_cancels_dropped_waiter() {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut guard = CancelOnDrop(Some(cancel.clone()));
    guard.0 = None;
    drop(guard);
    assert!(!cancel.load(Ordering::Acquire));
    drop(CancelOnDrop(Some(cancel.clone())));
    assert!(cancel.load(Ordering::Acquire));
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::fs;
    use std::time::{Duration, Instant};

    #[path = "process_cleanup_tests.rs"]
    mod cleanup;
    #[path = "process_resource_tests.rs"]
    mod resources;
    #[path = "process_toolchain_tests.rs"]
    mod toolchain;

    struct Tools {
        node: PathBuf,
        dependencies: PathBuf,
        vite: PathBuf,
        esbuild: PathBuf,
    }
    fn tools() -> Tools {
        let node = staging::canonical_file(&PathBuf::from(
            std::env::var_os("ATOOLS_SOURCE_BUILD_TEST_NODE")
                .expect("set exact local Node executable"),
        ))
        .unwrap();
        let dependencies = staging::canonical_directory(&PathBuf::from(
            std::env::var_os("ATOOLS_SOURCE_BUILD_TEST_DEPS")
                .expect("set existing local dependency root"),
        ))
        .unwrap();
        let vite = dependencies
            .join("vite/bin/vite.js")
            .canonicalize()
            .unwrap();
        let esbuild = std::env::var_os("ATOOLS_SOURCE_BUILD_TEST_ESBUILD")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let source_root = dependencies
                    .parent()
                    .expect("node_modules has a project root");
                atools_plugin::source_build::resolve_build_esbuild_binary(
                    source_root,
                    &dependencies,
                    &vite,
                )
                .expect("resolve Vite's locked esbuild installation")
            })
            .canonicalize()
            .unwrap();
        Tools {
            node,
            dependencies,
            vite,
            esbuild,
        }
    }
    fn temp() -> tempfile::TempDir {
        tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
    }

    fn fixture(tool: &Tools, configuration: &str) -> (tempfile::TempDir, SourceBuildPlan) {
        let source = temp();
        fs::create_dir(source.path().join("public")).unwrap();
        fs::write(source.path().join("public/plugin.json"), br#"{"name":"fixture-build","version":"1.0.0","main":"index.html","features":[{"code":"open","explain":"Fixture","cmds":["fixture"]}]}"#).unwrap();
        fs::write(
            source.path().join("index.html"),
            b"<main>fixture</main><script type=\"module\" src=\"/source.js\"></script>",
        )
        .unwrap();
        fs::write(
            source.path().join("source.js"),
            b"document.querySelector('main').textContent='built fixture';",
        )
        .unwrap();
        fs::write(
            source.path().join("package.json"),
            br#"{"name":"fixture-source","version":"1.0.0","type":"module"}"#,
        )
        .unwrap();
        fs::write(source.path().join("vite.config.mjs"), configuration).unwrap();
        let manifest_bytes = fs::read(source.path().join("public/plugin.json")).unwrap();
        let manifest: atools_core::PluginManifest =
            serde_json::from_slice(&manifest_bytes).unwrap();
        let plan = SourceBuildPlan {
            source_root: source.path().to_path_buf(),
            manifest_relative: "public/plugin.json".into(),
            manifest_selection: ManifestSelection::Public,
            manifest_sha256: format!("{:x}", Sha256::digest(&manifest_bytes)),
            manifest_identity: ManifestIdentity::from_plugin_manifest(&manifest).unwrap(),
            plugin_id: "fixture-build".into(),
            version: "1.0.0".into(),
            dependency_root: tool.dependencies.clone(),
            vite_cli: tool.vite.clone(),
            vite_backend: atools_plugin::source_build::ViteBuildBackend::Esbuild {
                binary: tool.esbuild.clone(),
            },
            test_esbuild_binary: None,
            manifest_output_rewrite: None,
            build_steps: vec![atools_plugin::source_build::BuildStep::ViteBuild {
                cli: "node_modules/vite/bin/vite.js".into(),
            }],
        };
        (source, plan)
    }
    fn run_script(
        tool: &Tools,
        source: &str,
        cancel: &AtomicBool,
        limits: supervisor::Limits,
    ) -> (staging::Workspace, supervisor::Outcome) {
        let mut workspace = staging::Workspace::create().unwrap();
        let work = workspace.root.join("work");
        fs::create_dir(&work).unwrap();
        let script = work.join("fixture.mjs");
        fs::write(&script, source).unwrap();
        let sandbox = profile::render(
            &workspace.root,
            &tool.dependencies,
            &tool.node,
            &tool.esbuild,
        )
        .unwrap();
        let profile = workspace.root.join("build.sb");
        fs::write(&profile, sandbox).unwrap();
        workspace.mark_running();
        let result = supervisor::run(
            supervisor::CommandSpec {
                stage: &workspace.root,
                work: &work,
                profile: &profile,
                node: &tool.node,
                entry: &script,
                args: vec![],
                vite_backend_path: &tool.esbuild,
                rolldown_backend: false,
                test_esbuild: None,
                dependencies: &tool.dependencies,
            },
            cancel,
            limits,
        );
        if result.cleanup_confirmed {
            workspace.mark_quiescent();
        }
        if result.result.is_err() {
            eprintln!(
                "private known-fixture outcome={:?}, exit={:?}, boundedLogBytes={}",
                result.result.as_ref().err(),
                result.exit,
                result.diagnostic_log.len()
            );
        }
        (workspace, result)
    }

    #[tokio::test]
    #[ignore = "explicit private macOS Node/Vite sandbox gate; no network installation"]
    async fn real_vite_build_produces_verified_same_identity_and_preserves_source() {
        let tools = tools();
        let (source, plan) = fixture(&tools, "export default {};");
        let (revision, _) = staging::source_digest(source.path(), &AtomicBool::new(false)).unwrap();
        let finished = Arc::new(AtomicBool::new(false));
        let cancel = Arc::new(AtomicBool::new(false));
        let prepared = build(
            plan,
            tools.node,
            cancel.clone(),
            finished.clone(),
            Arc::new(AtomicBool::new(false)),
            revision.clone(),
        )
        .await
        .unwrap();
        assert!(prepared.output_dir.join("plugin.json").is_file());
        assert_eq!(prepared.diagnostics.source_revision, revision);
        assert!(
            prepared.diagnostics.root_reaped
                && prepared.diagnostics.original_group_closed
                && prepared.diagnostics.streams_closed
        );
        assert!(
            !prepared.diagnostics.full_tree_containment
                && !prepared.diagnostics.aggregate_resource_caps
        );
        eprintln!(
            "known-fixture-build-diagnostics={}",
            serde_json::to_string(&prepared.diagnostics).unwrap()
        );
        assert!(finished.load(Ordering::Acquire));
        assert!(!cancel.load(Ordering::Acquire));
        let output = prepared.output_dir.clone();
        drop(prepared);
        assert!(!output.exists());
        assert_eq!(
            staging::source_digest(source.path(), &AtomicBool::new(false))
                .unwrap()
                .0,
            revision
        );
        assert!(!source.path().join("dist").exists());
    }

    #[test]
    #[ignore = "explicit private macOS filesystem/network sandbox canary"]
    fn stage_write_allowed_outside_read_write_and_loopback_network_denied() {
        let tools = tools();
        let outside = temp();
        fs::write(outside.path().join("read-canary"), b"secret canary").unwrap();
        let outside_json = serde_json::to_string(outside.path()).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let script = format!(
            r#"import fs from 'node:fs'; import net from 'node:net';
            fs.writeFileSync('allowed','stage');
            for(const [op,name] of [['read','read-canary'],['write','write-canary']]) {{
                try {{ if(op==='read')fs.readFileSync({outside_json}+'/'+name);else fs.writeFileSync({outside_json}+'/'+name,'bad'); process.exit(11); }} catch(e) {{ if(!['EPERM','EACCES'].includes(e.code))throw e; }}
            }}
            const socket=net.connect({{host:'127.0.0.1',port:{port}}});
            socket.on('connect',()=>process.exit(12));
            socket.on('error',e=>{{if(!['EPERM','EACCES'].includes(e.code))process.exit(13);else process.exit(0)}});
            setTimeout(()=>process.exit(14),1500);
        "#
        );
        let (workspace, result) = run_script(
            &tools,
            &script,
            &AtomicBool::new(false),
            supervisor::Limits::default(),
        );
        assert!(result.cleanup_confirmed);
        assert!(result.result.is_ok());
        assert_eq!(
            fs::read(workspace.root.join("work/allowed")).unwrap(),
            b"stage"
        );
        assert_eq!(
            fs::read(outside.path().join("read-canary")).unwrap(),
            b"secret canary"
        );
        assert!(!outside.path().join("write-canary").exists());
        assert!(listener.accept().is_err());
    }

    #[test]
    #[ignore = "explicit private macOS root/group cancellation gate"]
    fn cancellation_and_wall_timeout_reap_root_and_original_child_group() {
        let tools = tools();
        let cancel = Arc::new(AtomicBool::new(false));
        let trigger = cancel.clone();
        let timer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(700));
            trigger.store(true, Ordering::Release);
        });
        let start = Instant::now();
        let script = "import {spawn} from 'node:child_process'; const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); console.log(c.pid); setInterval(()=>{},1000);";
        let (_, result) = run_script(&tools, script, &cancel, supervisor::Limits::default());
        timer.join().unwrap();
        assert!(result.cleanup_confirmed);
        assert!(matches!(result.result, Err(error) if error == "SOURCE_BUILD_CANCELLED"));
        assert!(start.elapsed() < Duration::from_secs(6));
        let (_, result) = run_script(
            &tools,
            script,
            &AtomicBool::new(false),
            supervisor::Limits {
                wall: Duration::from_millis(700),
                ..Default::default()
            },
        );
        assert!(result.cleanup_confirmed);
        assert!(matches!(result.result, Err(error) if error == "SourceBuildTimeout"));
    }

    #[test]
    #[ignore = "explicit private macOS log flood gate"]
    fn combined_stdout_stderr_overflow_terminates_and_reaps() {
        let tools = tools();
        let (_, result) = run_script(&tools, "for(;;){process.stdout.write('x'.repeat(8192));process.stderr.write('y'.repeat(8192));}", &AtomicBool::new(false), supervisor::Limits::default());
        assert!(result.cleanup_confirmed);
        assert!(matches!(result.result, Err(error) if error == "SourceBuildLogLimitExceeded"));
    }

    #[test]
    #[ignore = "explicit private macOS inherited writable descriptor gate"]
    fn inherited_high_writable_descriptor_is_closed_before_untrusted_node() {
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        let tools = tools();
        let outside = temp();
        let path = outside.path().join("descriptor-canary");
        let file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .unwrap();
        let duplicated = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, 768) };
        assert!(duplicated >= 768);
        let descriptor = unsafe { OwnedFd::from_raw_fd(duplicated) };
        let script = format!("import fs from 'node:fs'; try{{fs.writeSync({duplicated},'bad');process.exit(21)}}catch(e){{if(e.code!=='EBADF')throw e;}}");
        let (_, result) = run_script(
            &tools,
            &script,
            &AtomicBool::new(false),
            supervisor::Limits::default(),
        );
        assert!(result.cleanup_confirmed && result.result.is_ok());
        drop(descriptor);
        assert!(fs::read(path).unwrap().is_empty());
    }

    #[test]
    #[ignore = "explicit private macOS malformed-profile and missing-executable gate"]
    fn malformed_profile_and_missing_exec_do_not_count_as_successful_spawn() {
        let tools = tools();
        for state in 0..3 {
            let malformed = state == 0;
            let mut workspace = staging::Workspace::create().unwrap();
            let work = workspace.root.join("work");
            fs::create_dir(&work).unwrap();
            let script = work.join("fixture.mjs");
            fs::write(
                &script,
                b"import fs from 'node:fs';fs.writeFileSync('unexpected-execution','bad');",
            )
            .unwrap();
            let profile_path = workspace.root.join("build.sb");
            let node = if state == 1 {
                workspace.root.join("missing-node")
            } else {
                tools.node.clone()
            };
            let profile = if malformed {
                "(".into()
            } else {
                profile::render(&workspace.root, &tools.dependencies, &node, &tools.esbuild)
                    .unwrap()
            };
            fs::write(&profile_path, profile).unwrap();
            workspace.mark_running();
            let result = supervisor::run(
                supervisor::CommandSpec {
                    stage: &workspace.root,
                    work: &work,
                    profile: &profile_path,
                    node: &node,
                    entry: &script,
                    args: if state == 2 {
                        vec!["unexpected".into()]
                    } else {
                        vec![]
                    },
                    vite_backend_path: &tools.esbuild,
                    rolldown_backend: false,
                    test_esbuild: None,
                    dependencies: &tools.dependencies,
                },
                &AtomicBool::new(false),
                supervisor::Limits::default(),
            );
            if result.cleanup_confirmed {
                workspace.mark_quiescent();
            }
            assert!(result.cleanup_confirmed);
            assert!(result.result.is_err());
            assert_eq!(result.exit.and_then(|status| status.code()), Some(70));
            assert!(!work.join("unexpected-execution").exists());
        }
    }

    #[tokio::test]
    #[ignore = "explicit private macOS invalid-output and changed-source build gate"]
    async fn invalid_output_and_unapproved_copied_source_never_return_prepared_package() {
        let tools = tools();
        let (source, plan) = fixture(&tools, "export default {publicDir:false};");
        let (revision, _) = staging::source_digest(source.path(), &AtomicBool::new(false)).unwrap();
        let result = build(
            plan.clone(),
            tools.node.clone(),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            revision.clone(),
        )
        .await;
        assert!(matches!(result, Err(error) if error == "SourceBuildInvalidOutput"));
        fs::write(
            source.path().join("source.js"),
            b"throw new Error('changed');",
        )
        .unwrap();
        let result = build(
            plan,
            tools.node,
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            revision,
        )
        .await;
        assert!(matches!(result, Err(error) if error == "SourceBuildSourceRevisionChanged"));
    }

    #[tokio::test]
    #[ignore = "explicit private macOS async-waiter abort cleanup gate"]
    async fn aborting_async_waiter_keeps_supervisor_until_controlled_job_finishes() {
        let tools = tools();
        // Keep the source owner alive while the separately owned snapshot starts.
        let (source, plan) = fixture(&tools, "setInterval(()=>{},1000); export default {plugins:[{name:'wait',buildStart(){return new Promise(()=>{});}}]};");
        let revision = staging::source_digest(source.path(), &AtomicBool::new(false))
            .unwrap()
            .0;
        let cancel = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let cleanup_unconfirmed = Arc::new(AtomicBool::new(false));
        let waiter = tokio::spawn(build(
            plan,
            tools.node,
            cancel.clone(),
            finished.clone(),
            cleanup_unconfirmed.clone(),
            revision,
        ));
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(!finished.load(Ordering::Acquire));
        waiter.abort();
        let _ = waiter.await;
        assert!(cancel.load(Ordering::Acquire));
        let until = Instant::now() + Duration::from_secs(6);
        while !finished.load(Ordering::Acquire) && Instant::now() < until {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(finished.load(Ordering::Acquire));
        assert!(!cleanup_unconfirmed.load(Ordering::Acquire));
        assert!(source.path().join("source.js").exists());
    }
}
