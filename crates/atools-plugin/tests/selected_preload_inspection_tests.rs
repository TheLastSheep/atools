use atools_plugin::package_resolution::page_requirements::{inspect_selected_preload, Usage};
use std::path::Path;

fn write(root: &Path, path: &str, source: &str) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, source).unwrap();
}

#[test]
fn selected_preload_follows_only_selected_graph_and_keeps_complete_source_bytes() {
    let temp = tempfile::tempdir().unwrap();
    write(temp.path(), "child.js", "require('fs'); require('./dep');");
    write(temp.path(), "dep.js", "module.exports=42;");
    write(temp.path(), "unrelated.js", "require('child_process')");
    let inspected =
        inspect_selected_preload(&temp.path().canonicalize().unwrap(), "child.js").unwrap();
    assert_eq!(inspected.requirements.node_usage, Usage::Detected);
    assert_eq!(inspected.sources.len(), 2);
    assert_eq!(inspected.sources[0].0, Path::new("child.js"));
    assert_eq!(inspected.sources[1].1, b"module.exports=42;");
    assert_eq!(
        inspect_selected_preload(&temp.path().canonicalize().unwrap(), "dep.js")
            .unwrap()
            .requirements
            .node_usage,
        Usage::Unknown
    );
}

#[test]
fn selected_preload_rejects_missing_unsafe_and_dynamic_graphs_after_node_is_detected() {
    let temp = tempfile::tempdir().unwrap();
    for source in [
        "require('fs');require('./missing')",
        "require('fs');require('../outside')",
        "require('fs');require(variable)",
        "require('fs');require.resolve('path')",
    ] {
        write(temp.path(), "child.js", source);
        assert!(
            inspect_selected_preload(&temp.path().canonicalize().unwrap(), "child.js").is_err(),
            "{source}"
        );
    }
    for path in ["../outside", "/child.js", "a\\child.js", "file:child.js"] {
        assert!(inspect_selected_preload(&temp.path().canonicalize().unwrap(), path).is_err());
    }
}

#[test]
fn selected_preload_limits_apply_to_whole_graph_even_if_first_source_requires_node() {
    let temp = tempfile::tempdir().unwrap();
    for index in 0..65 {
        write(temp.path(), &format!("f{index}.js"), "0;");
    }
    let source = (0..64)
        .map(|index| format!("require('./f{index}.js');"))
        .collect::<String>();
    write(temp.path(), "child.js", &format!("require('fs');{source}"));
    assert!(inspect_selected_preload(&temp.path().canonicalize().unwrap(), "child.js").is_err());
    // Exactly 64 source files are accepted.
    let source = (0..63)
        .map(|index| format!("require('./f{index}.js');"))
        .collect::<String>();
    write(temp.path(), "child.js", &format!("require('fs');{source}"));
    assert_eq!(
        inspect_selected_preload(&temp.path().canonicalize().unwrap(), "child.js")
            .unwrap()
            .sources
            .len(),
        64
    );
    // The Node edge may occur before the oversized local source.
    write(
        temp.path(),
        "child.js",
        "require('fs');require('./large.js');",
    );
    write(temp.path(), "large.js", &" ".repeat(4 * 1024 * 1024));
    assert!(inspect_selected_preload(&temp.path().canonicalize().unwrap(), "child.js").is_err());
    for index in 0..18 {
        write(
            temp.path(),
            &format!("d{index}.js"),
            &format!("require('./d{}.js');", index + 1),
        );
    }
    write(temp.path(), "d18.js", "require('fs')");
    assert!(inspect_selected_preload(&temp.path().canonicalize().unwrap(), "d0.js").is_err());
}

#[cfg(unix)]
#[test]
fn selected_preload_rejects_leaf_and_directory_symlinks_in_graph() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "outside.js", "require('fs')");
    symlink(
        outside.path().join("outside.js"),
        temp.path().join("leaf.js"),
    )
    .unwrap();
    symlink(outside.path(), temp.path().join("dir")).unwrap();
    assert!(inspect_selected_preload(&temp.path().canonicalize().unwrap(), "leaf.js").is_err());
    write(
        temp.path(),
        "child.js",
        "require('fs');require('./dir/outside.js')",
    );
    assert!(inspect_selected_preload(&temp.path().canonicalize().unwrap(), "child.js").is_err());
}

#[cfg(unix)]
#[test]
fn selected_preload_rejects_a_previously_selected_root_replaced_by_symlink() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("package");
    let outside = temp.path().canonicalize().unwrap().join("outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    write(&root, "child.js", "require('fs')");
    write(&outside, "child.js", "require('fs')");
    inspect_selected_preload(&root, "child.js").unwrap();
    std::fs::rename(&root, temp.path().join("retained")).unwrap();
    symlink(&outside, &root).unwrap();
    assert!(inspect_selected_preload(&root, "child.js").is_err());
}

#[test]
fn selected_preload_rejects_unbound_package_imports_aliases_and_builtin_lookalikes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    write(
        &root,
        "package.json",
        r##"{"imports":{"#review":"./alias.js"}}"##,
    );
    write(&root, "alias.js", "module.exports=41");
    write(
        &root,
        "node_modules/review-package/index.js",
        "module.exports=42",
    );
    write(&root, "node_modules/fs/review.js", "module.exports=43");
    for specifier in [
        "review-package",
        "@scope/review",
        "#review",
        "fs/review",
        "node:fs/review",
        "test",
        "sea",
        "sqlite",
        "node:unknown",
        "node:fs/promises/review",
    ] {
        write(
            &root,
            "child.js",
            &format!("require('fs');require('{specifier}')"),
        );
        assert!(
            inspect_selected_preload(&root, "child.js").is_err(),
            "{specifier}"
        );
    }
    // These are exact builtin specifiers and need no package resolution.
    for specifier in [
        "fs",
        "node:fs",
        "fs/promises",
        "node:fs/promises",
        "assert/strict",
        "dns/promises",
        "readline/promises",
        "stream/consumers",
        "stream/promises",
        "stream/web",
        "timers/promises",
        "util/types",
        "node:test",
        "node:test/reporters",
        "node:sea",
        "node:sqlite",
    ] {
        write(&root, "child.js", &format!("require('{specifier}')"));
        let result = inspect_selected_preload(&root, "child.js").unwrap();
        assert_eq!(
            result.requirements.node_usage,
            Usage::Detected,
            "{specifier}"
        );
    }
}

#[test]
fn selected_preload_rejects_unbound_reexports_in_root_or_selected_local_dependency() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    write(&root, "dep.js", "export const value=42");
    for reexport in [
        "export {value} from './dep.js'",
        "export * from './dep.js'",
        "export * as values from './dep.js'",
    ] {
        write(&root, "child.js", &format!("require('fs');{reexport}"));
        assert!(
            inspect_selected_preload(&root, "child.js").is_err(),
            "root: {reexport}"
        );
        write(&root, "child.js", "require('fs');import('./nested.js')");
        write(&root, "nested.js", reexport);
        assert!(
            inspect_selected_preload(&root, "child.js").is_err(),
            "nested: {reexport}"
        );
    }
    // Self-contained local ESM exports stay inside the captured static sources.
    write(
        &root,
        "nested.js",
        "const value=42; export {value}; export const other=43",
    );
    assert_eq!(
        inspect_selected_preload(&root, "child.js")
            .unwrap()
            .sources
            .len(),
        2
    );
}

#[test]
fn selected_preload_rejects_require_extracted_as_a_value_instead_of_direct_static_calls() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    for alias in [
        "const r=require;window.load=()=>r('#review')",
        "const r=window['require'];window.load=()=>r('#review')",
        "const r=window.require;window.load=()=>r('review-package')",
        "const r=globalThis.require;window.load=()=>r('review-package')",
        "const r=self['require'];window.load=()=>r('review-package')",
        "const r=require.bind(null);window.load=()=>r('review-package')",
    ] {
        write(&root, "child.js", &format!("require('fs');{alias}"));
        assert!(
            inspect_selected_preload(&root, "child.js").is_err(),
            "{alias}"
        );
    }
    for source in [
        "window.require('fs')",
        "globalThis['require']('fs')",
        "self.require('node:fs/promises')",
    ] {
        write(&root, "child.js", source);
        assert_eq!(
            inspect_selected_preload(&root, "child.js")
                .unwrap()
                .requirements
                .node_usage,
            Usage::Detected
        );
    }
}

#[test]
fn selected_preload_rejects_optional_or_unknown_receiver_require_access() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    for access in [
        "window?.require('#review')",
        "window?.['re'+'quire']('#review')",
        "window['re'+'quire']('#review')",
        "window?.[key]('#review')",
        "globalThis[key]('#review')",
        "self?.require('review-package')",
        "globalThis?.require('review-package')",
        "window?.['require']('#review')",
        "self?.['require']('review-package')",
        "globalThis?.['require']('review-package')",
        "const r=window?.require;window.load=()=>r('#review')",
        "const r=window?.['require'];window.load=()=>r('#review')",
        "const r=globalThis?.require;window.load=()=>r('#review')",
        "const r=globalThis?.['require'];window.load=()=>r('#review')",
        "unknown.require('#review')",
        "unknown['require']('#review')",
        "const r=unknown.require;window.load=()=>r('#review')",
        "const r=unknown['require'];window.load=()=>r('#review')",
    ] {
        write(&root, "child.js", &format!("require('fs');{access}"));
        assert!(
            inspect_selected_preload(&root, "child.js").is_err(),
            "{access}"
        );
    }
    // Supported direct calls include optional calls on a known global receiver.
    for source in [
        "require('fs');window['title']='fixture'",
        "require('fs');window?.['title']",
        "require('fs')",
        "window.require('fs')",
        "window['require']('fs')",
        "globalThis.require?.('fs')",
        "self['require']?.('node:fs/promises')",
    ] {
        write(&root, "child.js", source);
        assert_eq!(
            inspect_selected_preload(&root, "child.js")
                .unwrap()
                .requirements
                .node_usage,
            Usage::Detected
        );
    }
}
