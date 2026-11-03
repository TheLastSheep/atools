//! Finite, shell-free expansion of package build scripts into host-reviewed steps.
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::metadata::canonical_regular_file;
use super::policy::string;
#[path = "typecheck_config.rs"]
mod typecheck_config;

pub(super) const MAX_SCRIPT_DEPTH: usize = 4;
pub(super) const MAX_BUILD_STEPS: usize = 12;
pub(super) const MAX_TEST_FILES: usize = 128;
const MAX_GLOB_ENTRIES: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BuildStep {
    Typecheck { cli: String },
    NodeTest { files: Vec<String> },
    ViteBuild { cli: String },
    NodeScript { script: String },
}

#[derive(Debug)]
pub(super) struct CompiledScripts {
    pub steps: Vec<BuildStep>,
    pub vite_cli: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ScriptPlanError {
    InvalidScripts,
    UnsupportedCommand,
    RecursiveScript,
    ScriptLimit,
    UnsafeScriptPath,
    ToolchainInvalid,
    TypecheckConfigUnsupported,
    LockMismatch,
    ViteCount,
}
impl ScriptPlanError {
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidScripts => "The package build scripts are missing or invalid",
            Self::UnsupportedCommand => {
                "The package build contains commands outside the supported local plan"
            }
            Self::RecursiveScript => {
                "The package build scripts recurse or exceed the nesting limit"
            }
            Self::ScriptLimit => "The package build exceeds the bounded step or test-file limit",
            Self::UnsafeScriptPath => {
                "A package build script references an unsafe or missing local file"
            }
            Self::ToolchainInvalid => "A required local build tool is missing or invalid",
            Self::TypecheckConfigUnsupported => "Bare typecheck requires strict root tsconfig JSON with noEmit true and no unsupported output settings",
            Self::LockMismatch => "The installed build tool versions do not match the package lock",
            Self::ViteCount => "The package build must contain exactly one Vite build step",
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidScripts => "build_scripts_invalid",
            Self::UnsupportedCommand => "unsupported_build",
            Self::RecursiveScript => "build_script_recursive",
            Self::ScriptLimit => "build_script_limit",
            Self::UnsafeScriptPath => "build_script_path_invalid",
            Self::ToolchainInvalid => "build_toolchain_invalid",
            Self::TypecheckConfigUnsupported => "bare_typecheck_config_unsupported",
            Self::LockMismatch => "build_lock_mismatch",
            Self::ViteCount => "build_vite_count_invalid",
        }
    }
}

pub(super) fn compile_scripts(
    root: &Path,
    package: &Value,
    lock: &Value,
    dependency_root: &Path,
) -> Result<CompiledScripts, ScriptPlanError> {
    validate_lock_root(package, lock)?;
    let scripts = package
        .get("scripts")
        .and_then(Value::as_object)
        .ok_or(ScriptPlanError::InvalidScripts)?;
    let mut state = Expansion {
        root,
        scripts,
        stack: Vec::new(),
        tools: BTreeSet::new(),
        typecheck_tools: Vec::new(),
        test_files: HashSet::new(),
        steps: Vec::new(),
    };
    state.expand_named("build")?;
    if state.steps.is_empty() || state.steps.len() > MAX_BUILD_STEPS {
        return Err(ScriptPlanError::ScriptLimit);
    }
    if state
        .steps
        .iter()
        .filter(|step| matches!(step, BuildStep::ViteBuild { .. }))
        .count()
        != 1
    {
        return Err(ScriptPlanError::ViteCount);
    }
    let mut tool_bins = HashMap::new();
    for tool in state.tools {
        let bin_name = if tool == "typescript" {
            "tsc"
        } else {
            tool.as_str()
        };
        let cli =
            super::toolchain::validate_tool_bin(package, lock, dependency_root, &tool, bin_name)?;
        tool_bins.insert(tool, cli);
    }
    let vite_cli = tool_bins
        .get("vite")
        .and_then(|path| path.as_ref())
        .cloned()
        .ok_or(ScriptPlanError::ToolchainInvalid)?;
    let toolchain_home = dependency_root
        .parent()
        .ok_or(ScriptPlanError::ToolchainInvalid)?;
    let mut steps = state.steps;
    let mut typecheck_tools = state.typecheck_tools.into_iter();
    for step in &mut steps {
        match step {
            BuildStep::Typecheck { cli } => {
                let tool = typecheck_tools
                    .next()
                    .ok_or(ScriptPlanError::ToolchainInvalid)?;
                *cli = relative_tool_path(
                    toolchain_home,
                    tool_bins.get(&tool).and_then(Option::as_ref),
                )?;
            }
            BuildStep::ViteBuild { cli } => {
                *cli = relative_tool_path(
                    toolchain_home,
                    tool_bins.get("vite").and_then(Option::as_ref),
                )?;
            }
            BuildStep::NodeTest { .. } | BuildStep::NodeScript { .. } => {}
        }
    }
    if typecheck_tools.next().is_some() {
        return Err(ScriptPlanError::ToolchainInvalid);
    }
    Ok(CompiledScripts { steps, vite_cli })
}

struct Expansion<'a> {
    root: &'a Path,
    scripts: &'a serde_json::Map<String, Value>,
    stack: Vec<String>,
    tools: BTreeSet<String>,
    typecheck_tools: Vec<String>,
    test_files: HashSet<String>,
    steps: Vec<BuildStep>,
}
impl Expansion<'_> {
    fn expand_named(&mut self, name: &str) -> Result<(), ScriptPlanError> {
        if self.stack.len() >= MAX_SCRIPT_DEPTH || self.stack.iter().any(|item| item == name) {
            return Err(ScriptPlanError::RecursiveScript);
        }
        let body = self
            .scripts
            .get(name)
            .and_then(Value::as_str)
            .ok_or(ScriptPlanError::InvalidScripts)?
            .to_owned();
        let pre = self
            .scripts
            .get(&format!("pre{name}"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let post = self
            .scripts
            .get(&format!("post{name}"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.stack.push(name.to_owned());
        for script in [pre, Some(body), post].into_iter().flatten() {
            self.expand_text(&script)?;
        }
        self.stack.pop();
        Ok(())
    }

    fn expand_text(&mut self, script: &str) -> Result<(), ScriptPlanError> {
        if script.is_empty()
            || script.len() > 4096
            || script.chars().any(char::is_control)
            || script.chars().any(|ch| {
                matches!(
                    ch,
                    '|' | ';' | '<' | '>' | '$' | '`' | '\\' | '\'' | '"' | '(' | ')'
                )
            })
        {
            return Err(ScriptPlanError::UnsupportedCommand);
        }
        let commands = script.split("&&").collect::<Vec<_>>();
        if commands.is_empty() || commands.len() > MAX_BUILD_STEPS {
            return Err(ScriptPlanError::ScriptLimit);
        }
        for command in commands {
            if command.contains('&') {
                return Err(ScriptPlanError::UnsupportedCommand);
            }
            let tokens = command.split_whitespace().collect::<Vec<_>>();
            if tokens.is_empty() {
                return Err(ScriptPlanError::UnsupportedCommand);
            }
            self.expand_command(&tokens)?;
            if self.steps.len() > MAX_BUILD_STEPS {
                return Err(ScriptPlanError::ScriptLimit);
            }
        }
        Ok(())
    }

    fn expand_command(&mut self, tokens: &[&str]) -> Result<(), ScriptPlanError> {
        if let Some(tool) = typecheck_config::recognized_command(self.root, tokens)? {
            let package = tool.package_name();
            self.tools.insert(package.to_owned());
            self.typecheck_tools.push(package.to_owned());
            return self.push(BuildStep::Typecheck { cli: String::new() });
        }
        match tokens {
            ["npm", "run", script] if valid_script_name(script) => self.expand_named(script),
            ["npm", "test"] => self.expand_named("test"),
            ["node", "--import", "tsx", "--test", patterns @ ..] if !patterns.is_empty() => {
                self.tools.insert("tsx".into());
                let mut files = Vec::new();
                for pattern in patterns {
                    files.extend(self.expand_test_pattern(pattern)?);
                }
                if files.is_empty() || files.len() > MAX_TEST_FILES {
                    return Err(ScriptPlanError::ScriptLimit);
                }
                files.sort();
                for file in &files {
                    if !self.test_files.insert(file.clone()) {
                        return Err(ScriptPlanError::UnsupportedCommand);
                    }
                }
                if self.test_files.len() > MAX_TEST_FILES {
                    return Err(ScriptPlanError::ScriptLimit);
                }
                self.push(BuildStep::NodeTest { files })
            }
            ["vite", "build"] => {
                self.tools.insert("vite".into());
                self.push(BuildStep::ViteBuild {
                    cli: "node_modules/vite/bin/vite.js".into(),
                })
            }
            ["node", script] if safe_relative_script(script) => {
                self.check_script_file(script)?;
                self.push(BuildStep::NodeScript {
                    script: (*script).to_owned(),
                })
            }
            _ => Err(ScriptPlanError::UnsupportedCommand),
        }
    }

    fn push(&mut self, step: BuildStep) -> Result<(), ScriptPlanError> {
        if self.steps.len() >= MAX_BUILD_STEPS {
            return Err(ScriptPlanError::ScriptLimit);
        }
        self.steps.push(step);
        Ok(())
    }

    fn expand_test_pattern(&self, pattern: &str) -> Result<Vec<String>, ScriptPlanError> {
        if pattern
            .chars()
            .any(|ch| matches!(ch, '?' | '[' | ']' | '{' | '}' | '*'))
        {
            let path = Path::new(pattern);
            let Some(parent) = path.parent() else {
                return Err(ScriptPlanError::UnsafeScriptPath);
            };
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                return Err(ScriptPlanError::UnsafeScriptPath);
            };
            if name.matches('*').count() != 1
                || name
                    .chars()
                    .any(|ch| matches!(ch, '?' | '[' | ']' | '{' | '}'))
            {
                return Err(ScriptPlanError::UnsafeScriptPath);
            }
            let (prefix, suffix) = name
                .split_once('*')
                .ok_or(ScriptPlanError::UnsafeScriptPath)?;
            let directory = self.safe_package_path(parent, true)?;
            let mut output = Vec::new();
            let mut inspected = 0usize;
            for entry in fs::read_dir(directory).map_err(|_| ScriptPlanError::UnsafeScriptPath)? {
                inspected = inspected.saturating_add(1);
                if inspected > MAX_GLOB_ENTRIES {
                    return Err(ScriptPlanError::ScriptLimit);
                }
                let entry = entry.map_err(|_| ScriptPlanError::UnsafeScriptPath)?;
                let file_name = entry.file_name();
                let Some(file_name) = file_name.to_str() else {
                    continue;
                };
                if !file_name.starts_with(prefix) || !file_name.ends_with(suffix) {
                    continue;
                }
                let metadata = fs::symlink_metadata(entry.path())
                    .map_err(|_| ScriptPlanError::UnsafeScriptPath)?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(ScriptPlanError::UnsafeScriptPath);
                }
                let relative = parent.join(file_name);
                let relative_text =
                    safe_forward_slash(&relative, ScriptPlanError::UnsafeScriptPath)?;
                self.check_script_file(&relative_text)?;
                output.push(relative_text);
                if output.len() > MAX_TEST_FILES {
                    return Err(ScriptPlanError::ScriptLimit);
                }
            }
            if output.is_empty() {
                return Err(ScriptPlanError::UnsafeScriptPath);
            }
            Ok(output)
        } else {
            let normalized =
                safe_forward_slash(Path::new(pattern), ScriptPlanError::UnsafeScriptPath)?;
            self.check_script_file(&normalized)?;
            Ok(vec![normalized])
        }
    }

    fn check_script_file(&self, value: &str) -> Result<(), ScriptPlanError> {
        let path = self.safe_package_path(Path::new(value), false)?;
        let extension = path.extension().and_then(|value| value.to_str());
        if value.len() > 512
            || value.starts_with('-')
            || value.chars().any(char::is_control)
            || value
                .chars()
                .any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '{' | '}'))
            || !matches!(extension, Some("js" | "mjs" | "cjs" | "ts"))
        {
            return Err(ScriptPlanError::UnsafeScriptPath);
        }
        Ok(())
    }

    fn safe_package_path(
        &self,
        relative: &Path,
        directory: bool,
    ) -> Result<PathBuf, ScriptPlanError> {
        let relative_text = safe_forward_slash(relative, ScriptPlanError::UnsafeScriptPath)?;
        if relative.as_os_str().is_empty()
            || relative_text.chars().any(char::is_control)
            || relative.components().any(|part| matches!(part, Component::Normal(name)
                if ["node_modules", ".npm-cache", ".git", "dist", "__atools_dist"].contains(&name.to_string_lossy().as_ref())))
        {
            return Err(ScriptPlanError::UnsafeScriptPath);
        }
        if directory {
            let path = self.root.join(relative);
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| ScriptPlanError::UnsafeScriptPath)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(ScriptPlanError::UnsafeScriptPath);
            }
            let canonical = path
                .canonicalize()
                .map_err(|_| ScriptPlanError::UnsafeScriptPath)?;
            if !canonical.starts_with(self.root) {
                return Err(ScriptPlanError::UnsafeScriptPath);
            }
            Ok(canonical)
        } else {
            canonical_regular_file(self.root, relative)
                .map_err(|_| ScriptPlanError::UnsafeScriptPath)?
                .ok_or(ScriptPlanError::UnsafeScriptPath)
        }
    }
}

fn valid_script_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b':'))
}
fn safe_relative_script(value: &str) -> bool {
    let path = Path::new(value);
    if safe_forward_slash(path, ScriptPlanError::UnsafeScriptPath).is_err() {
        return false;
    }
    !value.is_empty()
        && value.len() <= 256
        && !value.starts_with('-')
        && !value.chars().any(char::is_control)
        && !path.is_absolute()
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        && matches!(
            path.extension().and_then(|ext| ext.to_str()),
            Some("js" | "mjs" | "cjs")
        )
}
fn relative_tool_path(root: &Path, path: Option<&PathBuf>) -> Result<String, ScriptPlanError> {
    let path = path.ok_or(ScriptPlanError::ToolchainInvalid)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| ScriptPlanError::ToolchainInvalid)?;
    let value = safe_forward_slash(relative, ScriptPlanError::ToolchainInvalid)?;
    if value.is_empty() || value.len() > 512 {
        return Err(ScriptPlanError::ToolchainInvalid);
    }
    Ok(value)
}

fn safe_forward_slash(relative: &Path, error: ScriptPlanError) -> Result<String, ScriptPlanError> {
    relative
        .components()
        .map(|component| match component {
            Component::Normal(name) => {
                let name = name.to_str().ok_or(error)?;
                if name.is_empty()
                    || name.starts_with('-')
                    || name.contains('\\')
                    || name.chars().any(char::is_control)
                {
                    return Err(error);
                }
                Ok(name.to_owned())
            }
            _ => Err(error),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join("/"))
}

fn validate_lock_root(package: &Value, lock: &Value) -> Result<(), ScriptPlanError> {
    if !matches!(
        lock.get("lockfileVersion").and_then(Value::as_u64),
        Some(2 | 3)
    ) {
        return Err(ScriptPlanError::LockMismatch);
    }
    let name = string(package, "name");
    let version = string(package, "version");
    let root = lock.get("packages").and_then(|value| value.get(""));
    if name.is_none()
        || version.is_none()
        || string(lock, "name") != name
        || string(lock, "version") != version
        || root
            .is_none_or(|root| string(root, "name") != name || string(root, "version") != version)
    {
        return Err(ScriptPlanError::LockMismatch);
    }
    Ok(())
}

#[cfg(test)]
#[path = "script_plan_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "typecheck_config_tests.rs"]
mod typecheck_config_tests;
