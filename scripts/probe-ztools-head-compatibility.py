#!/usr/bin/env python3
"""Run the existing static ZTools classifier over one pinned Git HEAD tree."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import selectors
import shutil
import stat
import subprocess
import sys
import tempfile
import time

EXPECTED_HEAD = "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d"
EXPECTED_INVENTORY_SHA256 = "d5998275b67736d1581fb3cddea2b340c13d8173c9c65f681cb3b21323c0abeb"

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "lib"))
from ztools_head_snapshot import (  # noqa: E402
    AuditError, MAX_FILE_BYTES, MAX_TREE_LIST_BYTES, head_archive_member_budget,
    materialize_archive, parse_ls_tree, parse_ls_tree_directories, safe_member_path, sha256,
)
from ztools_head_classifier_contract import validate_classifier_output  # noqa: E402
EXPECTED_COUNT = 153
EXPECTED_COUNTS = {
    "main_manifest": 72,
    "source_public_only": 75,
    "incomplete_top_level_manifest": 6,
    "both": 5,
}
MAX_INVENTORY_BYTES = 8 * 1024 * 1024
MAX_CLASSIFIER_BYTES = 256 * 1024 * 1024
CHUNK = 1024 * 1024

def checked_inventory(raw: bytes) -> dict:
    if len(raw) > MAX_INVENTORY_BYTES:
        raise AuditError("inventory_too_large")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise AuditError("inventory_invalid_json") from None
    if not isinstance(value, dict) or value.get("schemaVersion") != 3:
        raise AuditError("inventory_schema_mismatch")
    repository = value.get("repository")
    if not isinstance(repository, dict) or repository.get("head") != EXPECTED_HEAD:
        raise AuditError("inventory_head_mismatch")
    if repository.get("objectFormat") != "sha1":
        raise AuditError("unsupported_object_format")
    if repository.get("headStableThroughScan") is not True:
        raise AuditError("inventory_head_not_stable")
    if repository.get("headRecheckedAtEnd") != EXPECTED_HEAD:
        raise AuditError("inventory_final_head_mismatch")
    rows = value.get("upstreamDirectories")
    if not isinstance(rows, list) or len(rows) != EXPECTED_COUNT:
        raise AuditError("inventory_denominator_mismatch")
    names: set[str] = set()
    classes = {"main_manifest": 0, "source_public_only": 0, "incomplete_top_level_manifest": 0}
    both_count = 0
    for row in rows:
        if not isinstance(row, dict):
            raise AuditError("inventory_row_invalid")
        name = row.get("pluginDirectory")
        if not isinstance(name, str) or not name or name in (".", ".."):
            raise AuditError("inventory_name_invalid")
        if "/" in name or "\\" in name or "\x00" in name or name in names:
            raise AuditError("inventory_name_invalid")
        names.add(name)
        root = row.get("headRootManifest")
        public = row.get("headPublicManifest")
        if root is not None and root != f"plugins/{name}/plugin.json":
            raise AuditError("inventory_manifest_path_invalid")
        if public is not None and public != f"plugins/{name}/public/plugin.json":
            raise AuditError("inventory_manifest_path_invalid")
        if (root is None) != (public is None):
            expected = "main_manifest" if root else "source_public_only"
            if row.get("headClassification") != expected:
                raise AuditError("inventory_manifest_class_mismatch")
        elif root is not None and row.get("headClassification") != "main_manifest":
            raise AuditError("inventory_manifest_class_mismatch")
        elif root is None and row.get("headClassification") != "incomplete_top_level_manifest":
            raise AuditError("inventory_missing_manifest_class_mismatch")
        classification = row.get("headClassification")
        if not isinstance(classification, str) or classification not in classes:
            raise AuditError("inventory_manifest_class_invalid")
        classes[classification] += 1
        both = root is not None and public is not None
        if row.get("hasBothRootAndPublic") is not both:
            raise AuditError("inventory_both_manifest_mismatch")
        both_count += int(both)
    counts = value.get("counts")
    if not isinstance(counts, dict) or counts.get("upstreamTopLevelPluginDirectoriesAtHead") != EXPECTED_COUNT:
        raise AuditError("inventory_count_mismatch")
    expected_inventory_counts = {
        "main_manifest": counts.get("mainManifestRootPluginJson"),
        "source_public_only": counts.get("sourcePublicManifestOnly"),
        "incomplete_top_level_manifest": counts.get("noTopLevelMainOrPublicManifest"),
        "both": counts.get("rootAndPublicBoth"),
    }
    actual_inventory_counts = {**classes, "both": both_count}
    if actual_inventory_counts != EXPECTED_COUNTS or expected_inventory_counts != EXPECTED_COUNTS:
        raise AuditError("inventory_class_counts_mismatch")
    direct_entries = value.get("directManifestEntries")
    if not isinstance(direct_entries, list) or len(direct_entries) != 152:
        raise AuditError("inventory_direct_manifest_count_mismatch")
    direct_keys: set[tuple[str, str]] = set()
    for entry in direct_entries:
        if not isinstance(entry, dict):
            raise AuditError("inventory_direct_manifest_invalid")
        path, manifest_class, head = entry.get("path"), entry.get("class"), entry.get("head")
        if not isinstance(path, str) or manifest_class not in ("root", "public") or not isinstance(head, dict):
            raise AuditError("inventory_direct_manifest_invalid")
        key = (path, manifest_class)
        if key in direct_keys:
            raise AuditError("inventory_direct_manifest_duplicate")
        direct_keys.add(key)
        if not isinstance(head.get("bytes"), int) or isinstance(head.get("bytes"), bool) or not 0 <= head["bytes"] <= MAX_FILE_BYTES:
            raise AuditError("inventory_manifest_pin_invalid")
        digest = head.get("sha256")
        if not isinstance(digest, str) or len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
            raise AuditError("inventory_manifest_pin_invalid")
    return value


def git_bytes(repo: pathlib.Path, *args: str) -> bytes:
    result = capped_command(["git", "-C", str(repo), *args], MAX_TREE_LIST_BYTES, 30)
    if result.returncode != 0:
        raise AuditError("git_read_failed")
    return result.stdout


def capped_command(argv: list[str], limit: int, timeout_seconds: int) -> subprocess.CompletedProcess:
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    assert process.stdout is not None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    output = bytearray()
    deadline = time.monotonic() + timeout_seconds
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AuditError("subprocess_timeout")
            for key, _ in selector.select(min(0.1, remaining)):
                chunk = os.read(key.fd, min(CHUNK, limit - len(output) + 1))
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                output.extend(chunk)
                if len(output) > limit:
                    raise AuditError("subprocess_output_over_budget")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AuditError("subprocess_timeout")
        returncode = process.wait(timeout=remaining)
        return subprocess.CompletedProcess(argv, returncode, bytes(output), b"")
    except (subprocess.TimeoutExpired, AuditError):
        if process.poll() is None:
            process.kill()
        process.wait()
        raise
    finally:
        selector.close()
        process.stdout.close()


def sha256_file(path: pathlib.Path, max_bytes: int) -> tuple[str, int]:
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode) or metadata.st_size > max_bytes:
        raise AuditError("classifier_binary_invalid")
    digest = hashlib.sha256()
    count = 0
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(CHUNK)
            if not chunk:
                break
            count += len(chunk)
            if count > max_bytes:
                raise AuditError("classifier_binary_over_budget")
            digest.update(chunk)
    return digest.hexdigest(), count


def resolved_output(requested: str, repo: pathlib.Path) -> pathlib.Path:
    raw = pathlib.Path(requested).expanduser()
    if not raw.is_absolute():
        raw = pathlib.Path.cwd() / raw
    parent = raw.parent.resolve(strict=True)
    out = parent / raw.name
    root = repo.resolve(strict=True)
    if out == root or root in out.parents or out.exists() or out.is_symlink():
        raise AuditError("output_must_be_fresh_outside_repo")
    return out


def run(args: argparse.Namespace) -> dict:
    repo = pathlib.Path(args.repo).resolve(strict=True)
    plugins = repo / "plugins"
    if not plugins.is_dir() or plugins.is_symlink():
        raise AuditError("plugins_root_invalid")
    output = resolved_output(args.out, repo)
    inventory_argument = pathlib.Path(args.inventory).expanduser()
    try:
        inventory_argument_info = inventory_argument.lstat()
    except OSError:
        raise AuditError("inventory_file_invalid") from None
    if stat.S_ISLNK(inventory_argument_info.st_mode):
        raise AuditError("inventory_file_invalid")
    inventory_path = inventory_argument.resolve(strict=True)
    inventory_info = inventory_path.lstat()
    if stat.S_ISLNK(inventory_info.st_mode) or not stat.S_ISREG(inventory_info.st_mode) or inventory_info.st_size > MAX_INVENTORY_BYTES:
        raise AuditError("inventory_file_invalid")
    raw_inventory = inventory_path.read_bytes()
    if len(raw_inventory) > MAX_INVENTORY_BYTES:
        raise AuditError("inventory_too_large")
    if sha256(raw_inventory) != EXPECTED_INVENTORY_SHA256:
        raise AuditError("inventory_sha256_mismatch")
    inventory = checked_inventory(raw_inventory)
    head = git_bytes(repo, "rev-parse", "HEAD").decode("ascii").strip()
    if head != EXPECTED_HEAD:
        raise AuditError("live_head_mismatch")
    plugins_tree_oid = git_bytes(repo, "rev-parse", f"{head}:plugins").decode("ascii").strip()
    raw_dirs = git_bytes(repo, "ls-tree", "-d", "-z", f"{head}:plugins")
    dirs = parse_ls_tree_directories(raw_dirs)
    rows = inventory["upstreamDirectories"]
    if set(dirs) != {row["pluginDirectory"] for row in rows}:
        raise AuditError("head_directory_inventory_mismatch")
    raw_tree = git_bytes(repo, "ls-tree", "-r", "-t", "-l", "-z", head, "--", "plugins")
    dirs_all, blobs, archive_directories = parse_ls_tree(raw_tree)
    if archive_directories["plugins"]["oid"] != plugins_tree_oid:
        raise AuditError("head_recursive_tree_root_mismatch")
    if archive_directories["plugins"]["oid"] != plugins_tree_oid:
        raise AuditError("head_recursive_tree_root_mismatch")
    recursive_gitlinks = {name: row for name, row in dirs_all.items() if row["kind"] == "commit"}
    direct_gitlinks = {name: row for name, row in dirs.items() if row["kind"] == "commit"}
    if recursive_gitlinks != direct_gitlinks:
        raise AuditError("head_gitlink_object_mismatch")
    if len(dirs) != EXPECTED_COUNT:
        raise AuditError("head_directory_count_mismatch")
    for name, row in dirs.items():
        if row["kind"] not in ("tree", "commit"):
            raise AuditError("head_directory_type_invalid")
        if row["kind"] == "tree" and row["mode"] != "040000":
            raise AuditError("head_directory_mode_invalid")
    direct_entries = {(entry["path"], entry["class"]): entry for entry in inventory["directManifestEntries"]}
    pins_by_plugin: dict[str, dict] = {}
    all_manifest_pins: dict[str, dict] = {}
    for row in rows:
        name = row["pluginDirectory"]
        pins_by_plugin[name] = {}
        for manifest_class, path in (("root", row["headRootManifest"]), ("public", row["headPublicManifest"])):
            if path is None:
                continue
            entry = direct_entries.get((path, manifest_class))
            if not isinstance(entry, dict) or not isinstance(entry.get("head"), dict):
                raise AuditError("inventory_manifest_pin_missing")
            pin = entry["head"]
            materialized_pin = {"path": path, "bytes": pin["bytes"], "sha256": pin["sha256"], "owner": name}
            pins_by_plugin[name][manifest_class] = materialized_pin
            all_manifest_pins[path] = materialized_pin

    output_parent = output.parent
    stage = pathlib.Path(tempfile.mkdtemp(prefix=".ztools-head-classifier-", dir=output_parent))
    report = None
    try:
        snapshot = stage / "plugins"
        snapshot.mkdir()
        archive_argv = ["git", "-C", str(repo), "archive", "--format=tar", head, "--", "plugins"]
        process = subprocess.Popen(archive_argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            assert process.stdout is not None
            archive_stats = materialize_archive(
                process.stdout,
                snapshot,
                dirs,
                blobs,
                all_manifest_pins,
                archive_directories,
            )
            process.stdout.close()
            code = process.wait(timeout=30)
        except Exception:
            if process.poll() is None:
                process.kill()
            process.wait()
            raise
        finally:
            if process.stdout is not None and not process.stdout.closed:
                process.stdout.close()
        if code != 0:
            raise AuditError("git_archive_failed")

        # B91 rows are the denominator; combine them with only HEAD object IDs.
        input_rows = []
        for row in rows:
            name = row["pluginDirectory"]
            root_path, public_path = row["headRootManifest"], row["headPublicManifest"]
            manifest_pins = {
                manifest_class: {key: value for key, value in pin.items() if key != "owner"}
                for manifest_class, pin in pins_by_plugin[name].items()
            }
            reasons = archive_stats["incompatible"].get(name, [])
            if dirs[name]["kind"] == "commit":
                reasons = sorted(set(reasons) | {"gitlink_not_archived"})
            state = "materialized" if not reasons else "incompatible_snapshot_entry"
            input_rows.append({
                "pluginDirectory": name,
                "treeOid": dirs[name]["oid"],
                "headClassification": row["headClassification"],
                "headRootManifest": root_path,
                "headPublicManifest": public_path,
                "manifestPins": manifest_pins,
                "snapshotState": state,
                "snapshotIssues": reasons,
            })
        classifier_input = {
            "schemaVersion": 1,
            "head": head,
            "pluginsTreeOid": plugins_tree_oid,
            "plugins": input_rows,
        }
        input_file = stage / "classifier-input.json"
        input_file.write_text(json.dumps(classifier_input, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        classifier_argument = pathlib.Path(args.classifier).expanduser()
        try:
            classifier_argument_info = classifier_argument.lstat()
        except OSError:
            raise AuditError("classifier_binary_invalid") from None
        if stat.S_ISLNK(classifier_argument_info.st_mode):
            raise AuditError("classifier_binary_invalid")
        classifier = classifier_argument.resolve(strict=True)
        classifier_info = classifier.lstat()
        if stat.S_ISLNK(classifier_info.st_mode) or not stat.S_ISREG(classifier_info.st_mode) or not os.access(classifier, os.X_OK):
            raise AuditError("classifier_binary_invalid")
        classifier_sha256, classifier_bytes = sha256_file(classifier, MAX_CLASSIFIER_BYTES)
        result = capped_command(
            [str(classifier), "--snapshot-root", str(snapshot), "--input", str(input_file)],
            MAX_INVENTORY_BYTES,
            300,
        )
        if result.returncode != 0:
            raise AuditError("classifier_failed")
        try:
            classified = json.loads(result.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise AuditError("classifier_output_invalid") from None
        validate_classifier_output(classified, input_rows, head, plugins_tree_oid)
        final_head = git_bytes(repo, "rev-parse", "HEAD").decode("ascii").strip()
        final_tree = git_bytes(repo, "rev-parse", f"{final_head}:plugins").decode("ascii").strip()
        if final_head != head or final_tree != plugins_tree_oid:
            raise AuditError("head_changed_during_audit")
        report = {
            "schemaVersion": 2,
            "status": "static_head_classification_only",
            "head": head,
            "pluginsTreeOid": plugins_tree_oid,
            "inventorySha256": sha256(raw_inventory),
            "classifier": {"sha256": classifier_sha256, "bytes": classifier_bytes},
            "denominator": EXPECTED_COUNT,
            "inventoryCounts": {
                key: inventory["counts"][key]
                for key in (
                    "mainManifestRootPluginJson", "sourcePublicManifestOnly",
                    "noTopLevelMainOrPublicManifest", "rootAndPublicBoth",
                )
            },
            "classifierCounts": classified["counts"],
            "archive": archive_stats,
            "records": classified["records"],
            "claimBoundary": "Static package/readiness and source-pattern classification using the production resolver/classifier. No plugin was executed, built, installed, network-fetched, granted permissions, or tested for business usability. Not a direct-usability percentage.",
        }
    finally:
        try:
            shutil.rmtree(stage)
        except FileNotFoundError:
            pass
        except OSError:
            raise AuditError("staging_cleanup_failed") from None
        if stage.exists() or stage.is_symlink():
            raise AuditError("staging_cleanup_failed")
    if report is None:
        raise AuditError("report_missing")
    output.mkdir(mode=0o700)
    target = output / "compatibility-head-v2.json"
    with target.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return {"output": target.name, "head": head, "records": len(report["records"]), "archive": archive_stats}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="Read-only ZTools-plugins worktree path")
    parser.add_argument("--inventory", required=True, help="B91 schema-v3 inventory JSON pinned to the requested HEAD")
    parser.add_argument("--classifier", required=True, help="Built atools-plugin classify_ztools_head example binary")
    parser.add_argument("--out", required=True, help="Fresh output directory outside the submodule")
    args = parser.parse_args()
    try:
        result = run(args)
    except AuditError as error:
        print(json.dumps({"status": "failed_closed", "code": error.code}, separators=(",", ":")), file=sys.stderr)
        return 2
    except (OSError, subprocess.TimeoutExpired):
        print(json.dumps({"status": "failed_closed", "code": "io_or_timeout"}, separators=(",", ":")), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
