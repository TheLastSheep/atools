#!/usr/bin/env python3
"""Read-only local ZTools plugin denominator inventory; writes only --out."""
import argparse
import datetime as dt
import hashlib
import json
import pathlib
import re
import stat
import subprocess
from pathlib import PurePosixPath, PureWindowsPath

import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "lib"))
from ztools_plugin_cohort import head_plugin_tree

SCHEMA_VERSION = 3
UNTRACKED_LOCAL_ROWS_KEY = "untrackedLocalStructuralCandidates"

AUDITS = [
    "audit_builtin_summary.json",
    "output_ztools_audit.json",
    "unsupported_plugins_detailed.json",
    "ztools_plugin_verification_report.json",
    "ztools_plugin_full_detailed_audit.json",
]


def git(repo, *args, check=True):
    return subprocess.run(["git", "-C", str(repo), *args], check=check,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()



def scan_snapshot_matches(expected_head, actual_head, expected_tracked_tree, actual_tracked_tree,
                          expected_local_tree, actual_local_tree):
    """Fail-closed predicate for the commit and both manifest-tree snapshots."""
    return (expected_head == actual_head
            and expected_tracked_tree == actual_tracked_tree
            and expected_local_tree == actual_local_tree)


def prepare_fresh_output(requested, git_root):
    """Reject output in the scanned source tree before creating any directory."""
    raw = pathlib.Path(requested).expanduser()
    if not raw.is_absolute():
        raw = pathlib.Path.cwd() / raw
    root = pathlib.Path(git_root).resolve(strict=True)
    out = raw.resolve(strict=False)
    if out == root or root in out.parents:
        raise ValueError("--out must be outside the scanned Git source root")
    try:
        raw.lstat()
    except FileNotFoundError:
        pass
    else:
        raise FileExistsError("refusing to reuse an existing --out path")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.mkdir()
    return out


def file_record(path):
    try:
        st = path.lstat()
    except FileNotFoundError:
        return {"state": "missing"}
    if path.is_symlink():
        return {"state": "symlink", "targetType": "not-read"}
    if not path.is_file():
        return {"state": "not_regular_file"}
    data = path.read_bytes()
    return {"state": "present", "bytes": len(data), "sha256": sha(data)}


def tree_hash(records):
    digest = hashlib.sha256()
    for row in sorted(records, key=lambda item: item["path"]):
        digest.update(row["path"].encode())
        digest.update(b"\0")
        digest.update(str(row.get("state", "present")).encode())
        digest.update(b"\0")
        digest.update(str(row.get("bytes", "-")).encode())
        digest.update(b"\0")
        digest.update(str(row.get("sha256", "-")).encode())
        digest.update(b"\n")
    return digest.hexdigest()


def get_head_file(repo, head, path):
    return git(repo, "show", f"{head}:{path}")


def classify_main_entry_inside(plugin_dir, plugin_root, declared):
    """Check only lexical descendants; never follow a symlink or probe outside plugins/."""
    if not isinstance(declared, str) or not declared or "\0" in declared or "\\" in declared:
        return "unsafe_path"
    posix = PurePosixPath(declared)
    windows = PureWindowsPath(declared)
    if posix.is_absolute() or windows.is_absolute() or windows.drive:
        return "unsafe_path"
    parts = declared.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return "unsafe_path"
    try:
        root_info = plugin_root.lstat()
        child_info = plugin_dir.lstat()
        if stat.S_ISLNK(root_info.st_mode) or stat.S_ISLNK(child_info.st_mode):
            return "symlink_or_nonregular"
        if not stat.S_ISDIR(root_info.st_mode) or not stat.S_ISDIR(child_info.st_mode):
            return "symlink_or_nonregular"
        root = plugin_root.resolve(strict=True)
        base = plugin_dir.resolve(strict=True)
        if base.parent != root:
            return "unsafe_path"
        current = plugin_dir
        for index, part in enumerate(parts):
            current = current / part
            entry = current.lstat()
            if stat.S_ISLNK(entry.st_mode):
                return "symlink_or_nonregular"
            if index < len(parts) - 1:
                if not stat.S_ISDIR(entry.st_mode):
                    return "symlink_or_nonregular"
            elif not stat.S_ISREG(entry.st_mode):
                return "symlink_or_nonregular"
        return "present_regular_file"
    except FileNotFoundError:
        return "missing"
    except (NotADirectoryError, OSError):
        return "unavailable"


def local_manifest_tree_rows(repo, plugin_root, tracked_dirs):
    rows = []
    try:
        root_info = plugin_root.lstat()
        if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
            return rows
        children = list(plugin_root.iterdir())
    except OSError:
        return rows
    for child in sorted(children, key=lambda p: p.name.casefold()):
        try:
            child_info = child.lstat()
        except OSError:
            continue
        if child.name in tracked_dirs or stat.S_ISLNK(child_info.st_mode) or not stat.S_ISDIR(child_info.st_mode):
            continue
        manifest = child / "plugin.json"
        if manifest.is_symlink() or not manifest.is_file():
            continue
        record = file_record(manifest)
        if record.get("state") == "present":
            rows.append({"path": f"plugins/{child.name}/plugin.json", **record})
    return rows


def audit_pins(path):
    data = json.loads(path.read_text())
    keys = set()
    def visit(value):
        if isinstance(value, dict):
            for key, item in value.items():
                keys.add(str(key))
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    visit(data)
    candidate_keys = sorted(key for key in keys if re.search(r"sha|hash|head|commit|revision|source.?pin|fingerprint", key, re.I))
    return data, candidate_keys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    repo = pathlib.Path(args.repo).resolve()
    if not (repo / ".git").exists() and not (repo / ".git").is_file():
        raise SystemExit("repo is not a git worktree")
    git_root = pathlib.Path(git(repo, "rev-parse", "--show-toplevel").decode().strip()).resolve(strict=True)
    head = git(repo, "rev-parse", "HEAD").decode().strip()
    object_format = git(repo, "rev-parse", "--show-object-format").decode().strip()
    try:
        out = prepare_fresh_output(args.out, git_root)
    except ValueError as error:
        raise SystemExit(str(error))
    except FileExistsError:
        raise SystemExit("Refusing to reuse an existing --out path; choose a fresh directory")
    pinned_tree = head_plugin_tree(repo, head)
    tree_dirs = list(pinned_tree.directories)
    tracked_files = list(pinned_tree.entries)
    manifest_paths = [p for p in tracked_files if p.endswith("/plugin.json")]
    direct_root = {}
    direct_public = {}
    nested = []
    for path in manifest_paths:
        parts = path.split("/")
        if len(parts) == 3:
            direct_root[parts[1]] = path
        elif len(parts) == 4 and parts[2] == "public":
            direct_public[parts[1]] = path
        else:
            nested.append(path)

    directories = []
    head_manifest_rows = []
    current_manifest_rows = []
    direct_manifest_entries = []
    for name in sorted(tree_dirs, key=str.casefold):
        root_path = direct_root.get(name)
        public_path = direct_public.get(name)
        if root_path:
            category = "main_manifest"
        elif public_path:
            category = "source_public_only"
        else:
            category = "incomplete_top_level_manifest"
        row = {"pluginDirectory": name, "headClassification": category,
               "headRootManifest": root_path, "headPublicManifest": public_path,
               "hasBothRootAndPublic": bool(root_path and public_path)}
        directories.append(row)
        for manifest_class, relpath in (("root", root_path), ("public", public_path)):
            if not relpath:
                continue
            raw = get_head_file(repo, head, relpath)
            hrow = {"path": relpath, "class": manifest_class, "bytes": len(raw), "sha256": sha(raw)}
            head_manifest_rows.append(hrow)
            live = file_record(repo / relpath)
            crow = {"path": relpath, "class": manifest_class, **live}
            current_manifest_rows.append(crow)
            direct_manifest_entries.append({"path": relpath, "class": manifest_class,
                                            "head": {"bytes": len(raw), "sha256": sha(raw)},
                                            "workingTree": live,
                                            "workingTreeMatchesHead": live.get("state") == "present" and live.get("sha256") == sha(raw)})

    tracked_diff = git(repo, "diff", "--name-status", head, "--", "plugins").decode().splitlines()
    diff_counts = {}
    changed_plugin_examples = []
    changed_manifest_rows = []
    for line in tracked_diff:
        status, _, path = line.partition("\t")
        key = status[0]
        diff_counts[key] = diff_counts.get(key, 0) + 1
        if len(changed_plugin_examples) < 24:
            changed_plugin_examples.append({"status": status, "path": path})
        if path.endswith("plugin.json"):
            changed_manifest_rows.append({"status": status, "path": path})

    untracked_paths = git(repo, "ls-files", "--others", "--exclude-standard", "--", "plugins").decode().splitlines()
    tracked_dir_set = set(tree_dirs)
    fs_plugin_root = repo / "plugins"
    plugin_root_info = fs_plugin_root.lstat()
    if stat.S_ISLNK(plugin_root_info.st_mode) or not stat.S_ISDIR(plugin_root_info.st_mode):
        raise SystemExit("plugins root is not a real directory; refusing local path scan")
    local_rows = []
    initial_local_tree_rows = local_manifest_tree_rows(repo, fs_plugin_root, tracked_dir_set)
    for child in sorted(fs_plugin_root.iterdir(), key=lambda p: p.name.casefold()):
        try:
            child_info = child.lstat()
        except OSError:
            continue
        if stat.S_ISLNK(child_info.st_mode) or not stat.S_ISDIR(child_info.st_mode):
            continue
        if child.name in tracked_dir_set:
            continue
        manifest = child / "plugin.json"
        if file_record(manifest).get("state") != "present":
            continue
        rec = file_record(manifest)
        try:
            parsed = json.loads(manifest.read_text())
            main_value = parsed.get("main")
            main_status = classify_main_entry_inside(child, fs_plugin_root, main_value)
            main_exists = main_status == "present_regular_file"
            manifest_valid = isinstance(parsed, dict)
        except Exception:
            parsed, main_value, main_status, main_exists, manifest_valid = {}, None, "invalid_manifest", False, False
        local_rows.append({"pluginDirectory": child.name, "classification": "untracked_local_not_upstream",
                           "manifestValidJsonObject": manifest_valid, "manifest": rec,
                           "mainEntryStatus": main_status,
                           "mainEntryExistsInsidePluginRoot": bool(main_exists),
                           "packageJsonPresent": file_record(child / "package.json").get("state") == "present"})

    nested_rows = []
    nested_manifest_entries = []
    head_nested_manifest_rows = []
    current_nested_manifest_rows = []
    for path in nested:
        parts = path.split("/")
        nested_rows.append({"path": path, "topLevelOwner": parts[1] if len(parts) > 1 else None})
        raw = get_head_file(repo, head, path)
        hrow = {"path": path, "class": "nested", "bytes": len(raw), "sha256": sha(raw)}
        live = file_record(repo / path)
        crow = {"path": path, "class": "nested", **live}
        head_nested_manifest_rows.append(hrow)
        current_nested_manifest_rows.append(crow)
        nested_manifest_entries.append({"path": path, "class": "nested",
                                        "head": {"bytes": len(raw), "sha256": sha(raw)},
                                        "workingTree": live,
                                        "workingTreeMatchesHead": live.get("state") == "present" and live.get("sha256") == sha(raw)})

    audits = []
    audit_root = pathlib.Path(git_root).parent
    for rel in AUDITS:
        p = audit_root / rel
        if not p.is_file():
            continue
        try:
            parsed, keys = audit_pins(p)
            count = len(parsed) if isinstance(parsed, list) else parsed.get("total", parsed.get("summary", {}).get("total")) if isinstance(parsed, dict) else None
            audits.append({"path": rel, "bytes": p.stat().st_size, "sha256": sha(p.read_bytes()),
                           "topLevelRecordCount": count, "candidateFingerprintKeys": keys,
                           "sourceBinding": "unbound_no_plugin_source_fingerprint_found" if not keys else "candidate_keys_exist_but_not_verified_against_current_checkout"})
        except Exception as error:
            audits.append({"path": rel, "sourceBinding": "unreadable_or_unparseable", "errorType": type(error).__name__})

    classification_counts = {
        "mainManifestRootPluginJson": sum(row["headClassification"] == "main_manifest" for row in directories),
        "sourcePublicManifestOnly": sum(row["headClassification"] == "source_public_only" for row in directories),
        "noTopLevelMainOrPublicManifest": sum(row["headClassification"] == "incomplete_top_level_manifest" for row in directories),
        "rootAndPublicBoth": sum(row["hasBothRootAndPublic"] for row in directories),
    }
    working_direct = {"unchanged": 0, "modified": 0, "missing": 0, "symlink_or_nonregular": 0}
    for row in direct_manifest_entries:
        state = row["workingTree"].get("state")
        if state == "missing": working_direct["missing"] += 1
        elif state != "present": working_direct["symlink_or_nonregular"] += 1
        elif row["workingTreeMatchesHead"]: working_direct["unchanged"] += 1
        else: working_direct["modified"] += 1

    tree_pins = {"algorithm": "SHA-256 over sorted UTF-8 path\\0state\\0bytes\\0fileSHA256\\n records",
                 "headDirectRootAndPublicManifestTreeSha256": tree_hash(head_manifest_rows),
                 "workingDirectTrackedRootAndPublicManifestTreeSha256": tree_hash(current_manifest_rows),
                 "headAllTrackedPluginJsonTreeSha256": tree_hash(head_manifest_rows + head_nested_manifest_rows),
                 "workingAllTrackedPluginJsonTreeSha256": tree_hash(current_manifest_rows + current_nested_manifest_rows),
                 "workingUntrackedLocalRootManifestTreeSha256": tree_hash([
                     {"path": f"plugins/{r['pluginDirectory']}/plugin.json", **r["manifest"]} for r in local_rows
                 ])}
    output = {
        "schemaVersion": SCHEMA_VERSION,
        "schemaCompatibility": "Version 3 renames the prior B90 v2 untrackedLocalCompleteStructuralCandidates field to untrackedLocalStructuralCandidates; main-file presence is structural only and does not imply a complete or usable plugin.",
        "capturedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "repository": {"path": str(repo), "gitRoot": str(git_root), "head": head, "objectFormat": object_format,
                       "workingTreeDirtyExcludingIgnoredUntracked": bool(tracked_diff or untracked_paths)},
        "denominatorDefinition": {
            "upstreamPopulation": "Top-level plugin directories present in plugins/ at the recorded Git HEAD; each directory classified by its direct plugin.json and public/plugin.json paths only.",
            "mainManifestRootPluginJson": "A top-level plugins/<name>/plugin.json exists at HEAD; included regardless of a public manifest also existing.",
            "sourcePublicManifestOnly": "No root plugin.json, but plugins/<name>/public/plugin.json exists at HEAD; source/public marker, not usability or build result.",
            "incompleteTopLevelManifest": "Neither direct manifest exists at HEAD; nested manifests are listed separately and do not silently create extra upstream top-level plugins.",
            "untrackedLocalPopulation": "Filesystem top-level plugin dirs absent at HEAD with a parseable direct plugin.json are listed separately and excluded from upstream denominator; main path existence is only a no-follow structural check confined to that plugin root.",
        },
        "counts": {"upstreamTopLevelPluginDirectoriesAtHead": len(tree_dirs), **classification_counts,
                   "trackedManifestFilesAtHeadAllDepths": len(manifest_paths),
                   "trackedNestedPluginJsonBeyondDirectRootOrPublic": len(nested_rows),
                   "untrackedLocalDirectManifestDirectories": len(local_rows),
                   "untrackedLocalManifestWithMainEntryPresentInsidePluginRoot": sum(r["mainEntryExistsInsidePluginRoot"] for r in local_rows),
                   "untrackedLocalManifestWithPackageJson": sum(r["packageJsonPresent"] for r in local_rows),
                   "untrackedNonIgnoredFilesUnderPlugins": len(untracked_paths),
                   "trackedPluginSubtreeChangesByStatusInitial": diff_counts,
                   "trackedPluginJsonChanges": len(changed_manifest_rows),
                   "directTrackedManifestWorkingTreeStates": working_direct},
        "treePins": tree_pins,
        "upstreamDirectories": directories,
        "directManifestEntries": direct_manifest_entries,
        "nestedManifestPaths": nested_rows,
        "nestedManifestEntries": nested_manifest_entries,
        "allTrackedManifestEntries": direct_manifest_entries + nested_manifest_entries,
        "trackedManifestChangeExamples": changed_manifest_rows[:40],
        "trackedPluginSubtreeChangeExamples": changed_plugin_examples,
        UNTRACKED_LOCAL_ROWS_KEY: local_rows,
        "historicalAuditArtifacts": audits,
        "currentCommonRuntimeBlockers": {"status": "not_claimed", "reason": "Existing audit artifacts contain no verified per-source fingerprint binding to this live dirty checkout; no compatibility tests or runtime probes were rerun for B90. Do not reuse their classifications as current behavior."},
        "limits": [
            "Git HEAD is only the upstream revision anchor; tracked working-tree changes are separately represented by the direct manifest tree hash and path/status samples.",
            "This is a manifest/path inventory, not source-build readiness, plugin loading, API compatibility, UI behavior, or business usability evidence.",
            "untrackedNonIgnoredFilesUnderPlugins uses git ls-files --others --exclude-standard; ignored untracked files are excluded and are not counted.",
            "All HEAD-derived data is read from the captured immutable commit. The scan fails closed if HEAD or tracked/untracked manifest-tree pins change before output.",
            "Local main declarations are classified without following symlinks; absolute, drive-qualified, backslash, dot, and traversal paths are rejected before target traversal. The check is structural and does not invoke the entry.",
            "Nested plugin.json files are reported but not silently counted as top-level plugins.",
            "Local untracked structural candidates are not part of the upstream denominator.",
        ],
    }
    final_head = git(repo, "rev-parse", "HEAD").decode().strip()
    final_tracked = [file_record(repo / row["path"]) | {"path": row["path"]} for row in head_manifest_rows + head_nested_manifest_rows]
    final_local = local_manifest_tree_rows(repo, fs_plugin_root, tracked_dir_set)
    initial_tracked_hash = tree_hash(current_manifest_rows + current_nested_manifest_rows)
    final_tracked_hash = tree_hash(final_tracked)
    initial_local_hash = tree_hash(initial_local_tree_rows)
    final_local_hash = tree_hash(final_local)
    if not scan_snapshot_matches(head, final_head, initial_tracked_hash, final_tracked_hash,
                                 initial_local_hash, final_local_hash):
        raise SystemExit("Repository HEAD or manifest tree changed during scan; no canonical inventory written")
    output["repository"]["headRecheckedAtEnd"] = final_head
    output["repository"]["headStableThroughScan"] = True
    output["repository"]["workingTrackedManifestTreeStableThroughScan"] = final_tracked_hash == initial_tracked_hash
    output["repository"]["workingUntrackedLocalManifestTreeStableThroughScan"] = final_local_hash == initial_local_hash
    output["treePins"]["workingTrackedManifestTreeSha256AtFinalRecheck"] = final_tracked_hash
    output["treePins"]["workingUntrackedLocalManifestTreeSha256AtFinalRecheck"] = final_local_hash
    out_file = out / "inventory-v3.json"
    with out_file.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(out_file), "head": head, "counts": output["counts"], "treePins": output["treePins"]}, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
