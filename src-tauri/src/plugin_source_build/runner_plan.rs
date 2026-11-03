//! Versioned runner wire format and dependency-view executable mapping.
use std::path::{Component, Path};

use atools_plugin::source_build::BuildStep;
use atools_plugin::source_build::ViteBuildBackend;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunnerPlan<'a> {
    schema_version: u8,
    steps: &'a [BuildStep],
    toolchain: RunnerToolchain,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerToolchain {
    vite_backend: RunnerViteBackend,
    #[serde(skip_serializing_if = "Option::is_none")]
    test_esbuild: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum RunnerViteBackend {
    Esbuild { binary: String },
    Rolldown { binding: String },
}

pub(super) fn serialize(
    steps: &[BuildStep],
    dependencies: &Path,
    vite_backend: &ViteBuildBackend,
    test_esbuild: Option<&Path>,
) -> Result<Vec<u8>, String> {
    validate_test_esbuild_presence(steps, test_esbuild.is_some())?;
    serde_json::to_vec(&RunnerPlan {
        schema_version: 3,
        steps,
        toolchain: RunnerToolchain {
            vite_backend: match vite_backend {
                ViteBuildBackend::Esbuild { binary } => RunnerViteBackend::Esbuild {
                    binary: dependency_view_path(dependencies, binary)?,
                },
                ViteBuildBackend::Rolldown { binding } => RunnerViteBackend::Rolldown {
                    binding: dependency_view_path(dependencies, binding)?,
                },
            },
            test_esbuild: test_esbuild
                .map(|path| dependency_view_path(dependencies, path))
                .transpose()?,
        },
    })
    .map_err(|_| String::from("SourceBuildPlanSerializeFailed"))
}

pub(super) fn validate_test_esbuild_presence(
    steps: &[BuildStep],
    has_test_esbuild: bool,
) -> Result<(), String> {
    let has_node_test = steps
        .iter()
        .any(|step| matches!(step, BuildStep::NodeTest { .. }));
    if has_node_test == has_test_esbuild {
        Ok(())
    } else {
        Err("SourceBuildToolchainInvalid".into())
    }
}

fn dependency_view_path(dependencies: &Path, binary: &Path) -> Result<String, String> {
    let relative = binary
        .strip_prefix(dependencies)
        .map_err(|_| "SourceBuildUnsafeToolchain")?;
    if relative.as_os_str().is_empty() {
        return Err("SourceBuildUnsafeToolchain".into());
    }
    let mut output = String::from("node_modules");
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err("SourceBuildUnsafeToolchain".into());
        };
        let segment = segment
            .to_str()
            .filter(|value| {
                !value.is_empty()
                    && *value != "."
                    && *value != ".."
                    && !value
                        .chars()
                        .any(|character| matches!(character, '\\' | ':'))
                    && !value.chars().any(char::is_control)
            })
            .ok_or("SourceBuildUnsafeToolchain")?;
        output.push('/');
        output.push_str(segment);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_esbuild_is_required_exactly_when_node_test_is_planned() {
        let vite = [BuildStep::ViteBuild {
            cli: "node_modules/vite/bin/vite.js".into(),
        }];
        let node_test = [BuildStep::NodeTest {
            files: vec!["tests/a.test.mjs".into()],
        }];
        assert!(validate_test_esbuild_presence(&vite, false).is_ok());
        assert!(validate_test_esbuild_presence(&vite, true).is_err());
        assert!(validate_test_esbuild_presence(&node_test, true).is_ok());
        assert!(validate_test_esbuild_presence(&node_test, false).is_err());
    }

    #[test]
    fn runner_plan_v3_serializes_exact_esbuild_and_test_view_paths() {
        let steps = [
            BuildStep::ViteBuild {
                cli: "node_modules/vite/bin/vite.js".into(),
            },
            BuildStep::NodeTest {
                files: vec!["tests/a.test.ts".into()],
            },
        ];
        let bytes = serialize(
            &steps,
            Path::new("/readonly/external/dependencies"),
            &ViteBuildBackend::Esbuild { binary: Path::new("/readonly/external/dependencies/vite/node_modules/@esbuild/darwin-arm64/bin/esbuild").into() },
            Some(Path::new("/readonly/external/dependencies/tsx/node_modules/@esbuild/darwin-arm64/bin/esbuild")),
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["schemaVersion"], 3);
        assert_eq!(value["toolchain"]["viteBackend"]["kind"], "esbuild");
        assert_eq!(
            value["toolchain"]["viteBackend"]["binary"],
            "node_modules/vite/node_modules/@esbuild/darwin-arm64/bin/esbuild"
        );
        assert_eq!(
            value["toolchain"]["testEsbuild"],
            "node_modules/tsx/node_modules/@esbuild/darwin-arm64/bin/esbuild"
        );
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert_eq!(value["steps"][0]["kind"], "viteBuild");
        assert_eq!(value["steps"][1]["kind"], "nodeTest");
    }

    #[test]
    fn vite_only_plan_omits_test_binary_and_node_test_rejects_omission() {
        let vite = [BuildStep::ViteBuild {
            cli: "node_modules/vite/bin/vite.js".into(),
        }];
        let bytes = serialize(
            &vite,
            Path::new("/plugin/node_modules"),
            &ViteBuildBackend::Esbuild {
                binary: Path::new("/plugin/node_modules/esbuild/bin/esbuild").into(),
            },
            None,
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(value["toolchain"].get("testEsbuild").is_none());

        let node_test = [BuildStep::NodeTest {
            files: vec!["tests/a.test.ts".into()],
        }];
        assert!(serialize(
            &node_test,
            Path::new("/plugin/node_modules"),
            &ViteBuildBackend::Esbuild {
                binary: Path::new("/plugin/node_modules/esbuild/bin/esbuild").into()
            },
            None,
        )
        .is_err());
    }

    #[test]
    fn rolldown_runner_plan_binds_only_the_native_file_in_dependency_view() {
        let steps = [BuildStep::ViteBuild {
            cli: "node_modules/vite/bin/vite.js".into(),
        }];
        let bytes = serialize(
            &steps,
            Path::new("/deps"),
            &ViteBuildBackend::Rolldown {
                binding: Path::new(
                    "/deps/@rolldown/binding-darwin-arm64/rolldown-binding.darwin-arm64.node",
                )
                .into(),
            },
            None,
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["schemaVersion"], 3);
        assert_eq!(value["toolchain"]["viteBackend"]["kind"], "rolldown");
        assert_eq!(
            value["toolchain"]["viteBackend"]["binding"],
            "node_modules/@rolldown/binding-darwin-arm64/rolldown-binding.darwin-arm64.node"
        );
        assert_eq!(
            value["toolchain"]["viteBackend"].as_object().unwrap().len(),
            2
        );
    }

    #[test]
    fn dependency_view_mapping_supports_external_and_source_owned_dependencies() {
        assert_eq!(
            dependency_view_path(
                Path::new("/readonly/external/dependencies"),
                Path::new("/readonly/external/dependencies/vite/node_modules/@esbuild/darwin-arm64/bin/esbuild"),
            )
            .unwrap(),
            "node_modules/vite/node_modules/@esbuild/darwin-arm64/bin/esbuild"
        );
        assert_eq!(
            dependency_view_path(
                Path::new("/plugin/node_modules"),
                Path::new("/plugin/node_modules/esbuild/bin/esbuild"),
            )
            .unwrap(),
            "node_modules/esbuild/bin/esbuild"
        );
        assert!(dependency_view_path(
            Path::new("/plugin/node_modules"),
            Path::new("/elsewhere/esbuild"),
        )
        .is_err());
        assert!(dependency_view_path(
            Path::new("/plugin/node_modules"),
            Path::new("/plugin/node_modules/../escape/esbuild"),
        )
        .is_err());
    }
}
