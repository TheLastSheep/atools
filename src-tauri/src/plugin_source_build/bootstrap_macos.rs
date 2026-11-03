//! Runs after exec in a normal process context, never in a post-fork closure.
use super::super::{profile, staging};
use atools_plugin::source_build::ViteBuildBackend;
use std::ffi::{CString, OsString};
use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
use std::path::PathBuf;

struct Configuration {
    stage: PathBuf,
    work: PathBuf,
    profile: PathBuf,
    node: PathBuf,
    entry: PathBuf,
    vite_backend: ViteBuildBackend,
    arguments: Vec<OsString>,
}
impl Configuration {
    fn parse(arguments: Vec<OsString>) -> Result<Self, String> {
        if arguments.len() < 8
            || arguments.len() > 16
            || arguments
                .iter()
                .map(|arg| arg.as_bytes().len())
                .sum::<usize>()
                > 64 * 1024
        {
            return Err("SourceBuildBootstrapArguments".into());
        }
        let (rolldown_backend, marker_index) = match arguments.get(7).map(|arg| arg.as_os_str()) {
            Some(value) if value == "--rolldown-binding" => (true, 8),
            _ => (false, 7),
        };
        let (extra_esbuild_index, separator_index) =
            match arguments.get(marker_index).map(|arg| arg.as_os_str()) {
                Some(value) if value == "--" => (None, marker_index),
                Some(value) if value == "--extra-esbuild" => {
                    let separator = marker_index + 2;
                    if arguments.len() <= separator || arguments[separator] != "--" {
                        return Err("SourceBuildBootstrapArguments".into());
                    }
                    (Some(marker_index + 1), separator)
                }
                _ => return Err("SourceBuildBootstrapArguments".into()),
            };
        let paths = arguments[..7].iter().map(PathBuf::from).collect::<Vec<_>>();
        let stage = staging::canonical_directory(&paths[0])?;
        let work = staging::canonical_directory(&paths[1])?;
        let profile = staging::canonical_file(&paths[2])?;
        let node = staging::canonical_file(&paths[3])?;
        let entry = staging::canonical_file(&paths[4])?;
        let backend_path = staging::canonical_file(&paths[5])?;
        let dependencies = staging::canonical_directory(&paths[6])?;
        let test_esbuild = extra_esbuild_index
            .map(|index| staging::canonical_file(PathBuf::from(&arguments[index]).as_path()))
            .transpose()?;
        let vite_backend = if rolldown_backend {
            ViteBuildBackend::Rolldown {
                binding: backend_path,
            }
        } else {
            ViteBuildBackend::Esbuild {
                binary: backend_path,
            }
        };
        let meta = std::fs::symlink_metadata(&stage).map_err(|_| "SourceBuildBootstrapStage")?;
        if meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o777 != 0o700
            || !stage
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("atools-source-build-"))
            || work != stage.join("work")
            || profile != stage.join("build.sb")
            || node.starts_with(&stage)
            || !vite_backend.path().starts_with(&dependencies)
            || test_esbuild.as_ref().is_some_and(|path| {
                !path.starts_with(&dependencies) || *path == vite_backend.path()
            })
            || rolldown_backend
                && !vite_backend
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "node")
            || (!entry.starts_with(&dependencies) && !entry.starts_with(&work))
            || dependencies.starts_with(&stage)
            || stage.starts_with(&dependencies)
        {
            return Err("SourceBuildBootstrapStage".into());
        }
        let expected = profile::render_with_vite_backend(
            &stage,
            &dependencies,
            &node,
            &vite_backend,
            test_esbuild.as_deref(),
        )?;
        if staging::read_regular(&profile, 256 * 1024)? != expected.as_bytes() {
            return Err("SourceBuildBootstrapProfileChanged".into());
        }
        let tail = arguments[separator_index + 1..].to_vec();
        if !tail.is_empty()
            && tail != ["build", "--outDir", "__atools_dist", "--emptyOutDir"].map(OsString::from)
        {
            return Err("SourceBuildBootstrapArguments".into());
        }
        Ok(Self {
            stage,
            work,
            profile,
            node,
            entry,
            vite_backend,
            arguments: tail,
        })
    }
}

extern "C" {
    fn posix_spawn_file_actions_addinherit_np(
        actions: *mut libc::posix_spawn_file_actions_t,
        descriptor: libc::c_int,
    ) -> libc::c_int;
}

struct Spawn {
    attributes: libc::posix_spawnattr_t,
    actions: libc::posix_spawn_file_actions_t,
    attributes_ready: bool,
    actions_ready: bool,
}
impl Spawn {
    fn new() -> Result<Self, String> {
        let mut spawn = Self {
            attributes: unsafe { std::mem::zeroed() },
            actions: unsafe { std::mem::zeroed() },
            attributes_ready: false,
            actions_ready: false,
        };
        check(unsafe { libc::posix_spawnattr_init(&mut spawn.attributes) })?;
        spawn.attributes_ready = true;
        check(unsafe { libc::posix_spawn_file_actions_init(&mut spawn.actions) })?;
        spawn.actions_ready = true;
        check(unsafe {
            libc::posix_spawnattr_setflags(
                &mut spawn.attributes,
                (libc::POSIX_SPAWN_SETEXEC | libc::POSIX_SPAWN_CLOEXEC_DEFAULT) as i16,
            )
        })?;
        for descriptor in [0, 1, 2] {
            check(unsafe {
                posix_spawn_file_actions_addinherit_np(&mut spawn.actions, descriptor)
            })?;
        }
        Ok(spawn)
    }
}
impl Drop for Spawn {
    fn drop(&mut self) {
        unsafe {
            if self.actions_ready {
                libc::posix_spawn_file_actions_destroy(&mut self.actions);
            }
            if self.attributes_ready {
                libc::posix_spawnattr_destroy(&mut self.attributes);
            }
        }
    }
}
fn check(code: i32) -> Result<(), String> {
    if code == 0 {
        Ok(())
    } else {
        Err("SourceBuildBootstrapSpawnFailed".into())
    }
}
fn path(value: &std::path::Path) -> Result<CString, String> {
    CString::new(value.as_os_str().as_bytes()).map_err(|_| "SourceBuildBootstrapArguments".into())
}

pub(super) fn replace(arguments: Vec<OsString>) -> Result<(), String> {
    let configuration = Configuration::parse(arguments)?;
    // These calls are made by a freshly exec'd trusted process. No forked Rust
    // application thread or inherited allocator lock is used to set limits.
    if unsafe { libc::setsid() } < 0 {
        return Err("SourceBuildBootstrapSession".into());
    }
    for (resource, value) in [
        (libc::RLIMIT_NOFILE, 2048),
        (libc::RLIMIT_CORE, 0),
        (libc::RLIMIT_FSIZE, staging::FILE_LIMIT),
    ] {
        let limit = libc::rlimit {
            rlim_cur: value,
            rlim_max: value,
        };
        if unsafe { libc::setrlimit(resource, &limit) } != 0 {
            return Err("SourceBuildBootstrapLimits".into());
        }
    }
    std::env::set_current_dir(&configuration.work).map_err(|_| "SourceBuildBootstrapWork")?;
    let executable = CString::new("/usr/bin/sandbox-exec").unwrap();
    let mut arguments = vec![
        executable.clone(),
        CString::new("-f").unwrap(),
        path(&configuration.profile)?,
        path(&configuration.node)?,
        CString::new("--max-old-space-size=256").unwrap(),
        path(&configuration.entry)?,
    ];
    for argument in configuration.arguments {
        arguments
            .push(CString::new(argument.as_bytes()).map_err(|_| "SourceBuildBootstrapArguments")?);
    }
    let mut environment = Vec::new();
    for (key, value) in [
        ("HOME", configuration.stage.join("home")),
        ("TMPDIR", configuration.stage.join("tmp")),
        ("XDG_CACHE_HOME", configuration.stage.join("cache")),
        ("XDG_CONFIG_HOME", configuration.stage.join("config")),
    ] {
        let mut bytes = key.as_bytes().to_vec();
        bytes.push(b'=');
        bytes.extend(value.as_os_str().as_bytes());
        environment.push(CString::new(bytes).map_err(|_| "SourceBuildBootstrapEnvironment")?);
    }
    if let ViteBuildBackend::Esbuild { binary } = &configuration.vite_backend {
        let mut bytes = b"ESBUILD_BINARY_PATH=".to_vec();
        bytes.extend(binary.as_os_str().as_bytes());
        environment.push(CString::new(bytes).map_err(|_| "SourceBuildBootstrapEnvironment")?);
    }
    for value in ["LANG=C", "LC_ALL=C", "PATH="] {
        environment.push(CString::new(value).unwrap());
    }
    let mut argv = arguments
        .iter()
        .map(|value| value.as_ptr() as *mut libc::c_char)
        .collect::<Vec<_>>();
    argv.push(std::ptr::null_mut());
    let mut envp = environment
        .iter()
        .map(|value| value.as_ptr() as *mut libc::c_char)
        .collect::<Vec<_>>();
    envp.push(std::ptr::null_mut());
    let spawn = Spawn::new()?;
    let mut pid = 0;
    // SETEXEC succeeds without returning and preserves this supervised PID.
    // CLOEXEC_DEFAULT closes every descriptor except explicit 0/1/2 actions.
    // posix_spawn returns an error number directly; errno is not its result.
    check(unsafe {
        libc::posix_spawn(
            &mut pid,
            executable.as_ptr(),
            &spawn.actions,
            &spawn.attributes,
            argv.as_ptr(),
            envp.as_ptr(),
        )
    })?;
    Err("SourceBuildBootstrapUnexpectedReturn".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    struct Fixture {
        _root: tempfile::TempDir,
        _stage: tempfile::TempDir,
        args: Vec<OsString>,
        dependencies: PathBuf,
        stage: PathBuf,
        vite: PathBuf,
        test: PathBuf,
    }

    fn fixture() -> Fixture {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let stage = tempfile::Builder::new()
            .prefix("atools-source-build-")
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir_in(root.path())
            .unwrap();
        let stage_path = stage.path().to_path_buf();
        let work = stage_path.join("work");
        fs::create_dir(&work).unwrap();
        let profile = stage_path.join("build.sb");
        let dependencies = root.path().join("dependencies");
        fs::create_dir(&dependencies).unwrap();
        let vite = dependencies.join("vite-esbuild");
        let test = dependencies.join("test-esbuild");
        let node_dir = root.path().join("tools");
        fs::create_dir(&node_dir).unwrap();
        let node = node_dir.join("node");
        let entry = work.join("runner.mjs");
        fs::write(&node, b"node").unwrap();
        fs::write(&entry, b"runner").unwrap();
        fs::write(&vite, b"vite esbuild").unwrap();
        fs::write(&test, b"test esbuild").unwrap();
        let dependencies = dependencies.canonicalize().unwrap();
        let node = node.canonicalize().unwrap();
        let entry = entry.canonicalize().unwrap();
        let vite = vite.canonicalize().unwrap();
        let test = test.canonicalize().unwrap();
        let stage_canonical = stage_path.canonicalize().unwrap();
        let work_canonical = work.canonicalize().unwrap();
        let profile_canonical = profile;
        fs::write(
            &profile_canonical,
            profile::render_with_test_esbuild(&stage_canonical, &dependencies, &node, &vite, None)
                .unwrap(),
        )
        .unwrap();
        let args = vec![
            stage_canonical.clone().into_os_string(),
            work_canonical.into_os_string(),
            profile_canonical.into_os_string(),
            node.into_os_string(),
            entry.into_os_string(),
            vite.clone().into_os_string(),
            dependencies.clone().into_os_string(),
            "--".into(),
        ];
        Fixture {
            _root: root,
            _stage: stage,
            args,
            dependencies,
            stage: stage_canonical,
            vite,
            test,
        }
    }

    #[test]
    fn legacy_seven_path_bootstrap_arguments_remain_accepted() {
        let fixture = fixture();
        let parsed = Configuration::parse(fixture.args.clone()).unwrap();
        assert_eq!(parsed.stage, fixture.stage);
        assert_eq!(
            parsed.vite_backend,
            ViteBuildBackend::Esbuild {
                binary: fixture.vite.clone()
            }
        );
        assert!(parsed.arguments.is_empty());
    }

    #[test]
    fn one_distinct_test_binary_is_accepted_only_inside_dependency_root() {
        let mut fixture = fixture();
        fixture.args.pop();
        fixture.args.push("--extra-esbuild".into());
        fixture.args.push(fixture.test.clone().into_os_string());
        fixture.args.push("--".into());
        let node = PathBuf::from(fixture.args[3].clone());
        fs::write(
            &fixture.stage.join("build.sb"),
            profile::render_with_test_esbuild(
                &fixture.stage,
                &fixture.dependencies,
                &node,
                &fixture.vite,
                Some(&fixture.test),
            )
            .unwrap(),
        )
        .unwrap();
        let parsed = Configuration::parse(fixture.args.clone()).unwrap();
        assert_eq!(
            parsed.vite_backend,
            ViteBuildBackend::Esbuild {
                binary: fixture.vite.clone()
            }
        );

        let outside = fixture._root.path().join("outside-esbuild");
        fs::write(&outside, b"not allowed").unwrap();
        let mut escaped = fixture.args;
        escaped[8] = outside.into_os_string();
        assert!(matches!(
            Configuration::parse(escaped),
            Err(error) if error == "SourceBuildBootstrapStage"
        ));
    }

    #[test]
    fn rolldown_binding_is_confined_and_never_selected_as_an_exec_binary() {
        let mut fixture = fixture();
        let binding_dir = fixture.dependencies.join("@rolldown");
        fs::create_dir(&binding_dir).unwrap();
        let binding = binding_dir.join("binding-darwin-arm64.node");
        fs::write(&binding, b"native binding fixture").unwrap();
        let binding = binding.canonicalize().unwrap();
        fixture.args[5] = binding.clone().into_os_string();
        fixture.args[7] = "--rolldown-binding".into();
        fixture.args.insert(8, "--".into());
        let node = PathBuf::from(fixture.args[3].clone());
        fs::write(
            &fixture.stage.join("build.sb"),
            profile::render_with_vite_backend(
                &fixture.stage,
                &fixture.dependencies,
                &node,
                &ViteBuildBackend::Rolldown {
                    binding: binding.clone(),
                },
                None,
            )
            .unwrap(),
        )
        .unwrap();
        let parsed = Configuration::parse(fixture.args.clone()).unwrap();
        assert_eq!(parsed.vite_backend, ViteBuildBackend::Rolldown { binding });

        let mut escaped = fixture.args;
        let outside = fixture._root.path().join("outside.node");
        fs::write(&outside, b"outside").unwrap();
        escaped[5] = outside.into_os_string();
        assert!(Configuration::parse(escaped).is_err());
    }

    #[test]
    fn malformed_duplicate_or_unneeded_extra_markers_are_rejected() {
        let fixture = fixture();
        let mut missing_path = fixture.args.clone();
        missing_path[7] = "--extra-esbuild".into();
        assert!(Configuration::parse(missing_path).is_err());

        let mut duplicate = fixture.args.clone();
        duplicate[7] = "--extra-esbuild".into();
        duplicate.insert(8, fixture.test.clone().into_os_string());
        duplicate.insert(9, "--extra-esbuild".into());
        duplicate.insert(10, fixture.test.clone().into_os_string());
        duplicate.insert(11, "--".into());
        assert!(Configuration::parse(duplicate).is_err());

        let mut unnecessary = fixture.args;
        unnecessary[7] = "--extra-esbuild".into();
        unnecessary.insert(8, fixture.vite.into_os_string());
        unnecessary.insert(9, "--".into());
        assert!(Configuration::parse(unnecessary).is_err());
    }
}
