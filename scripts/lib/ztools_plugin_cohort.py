"""Bounded, read-only Git tree and manifest helpers shared by ZTools inventories."""
from __future__ import annotations

import hashlib
import json
import pathlib
from ztools_plugin_filesystem import local_outside_head_directories, working_matches_head, working_snapshot
from ztools_plugin_git_tree import (MAX_TREE_OUTPUT_BYTES, CohortError, HeadPluginTree,
                                    decode_component as _decode_component, git_bytes as _git,
                                    head_plugin_tree, parse_records as _records)

MAX_MANIFEST_FILES = 512
MAX_TOTAL_MANIFEST_BYTES = 16 * 1024 * 1024
from ztools_plugin_manifest import MAX_MANIFEST_BYTES, manifest_projection

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":")).encode("utf-8")
    return sha256(encoded)


def head_revision(repo: pathlib.Path) -> tuple[str, str]:
    try:
        head = _git(repo, ("rev-parse", "HEAD"), limit=256).decode("ascii").strip()
        object_format = _git(repo, ("rev-parse", "--show-object-format"), limit=64).decode("ascii").strip()
    except UnicodeDecodeError:
        raise CohortError("git_revision_invalid") from None
    if object_format not in ("sha1", "sha256") or len(head) not in (40, 64):
        raise CohortError("git_revision_invalid")
    return head, object_format


def head_blob_contents(repo: pathlib.Path, entries: dict[str, dict[str, str]]) -> dict[str, bytes]:
    """Fetch only the selected direct manifest blobs, in one bounded cat-file batch."""
    selected = {row["oid"] for row in entries.values() if row["kind"] == "blob" and row["mode"] in ("100644", "100755")}
    if len(selected) > MAX_MANIFEST_FILES:
        raise CohortError("manifest_file_count_over_limit")
    request = b"".join((oid + "\n").encode("ascii") for oid in sorted(selected))
    sizes: dict[str, int] = {}
    for row in entries.values():
        if row["kind"] != "blob" or row["mode"] not in ("100644", "100755"):
            continue
        if "size" not in row:
            raise CohortError("manifest_blob_size_missing")
        size = int(row["size"])
        oid = row["oid"]
        if oid in sizes and sizes[oid] != size:
            raise CohortError("manifest_blob_size_conflict")
        sizes[oid] = size
    if any(size > MAX_MANIFEST_BYTES for size in sizes.values()) or sum(sizes.values()) > MAX_TOTAL_MANIFEST_BYTES:
        raise CohortError("manifest_bytes_over_limit")
    output_limit = MAX_TOTAL_MANIFEST_BYTES + len(selected) * 128 + 1
    raw = _git(repo, ("cat-file", "--batch"), input_data=request, limit=output_limit)
    blobs: dict[str, bytes] = {}
    offset = 0
    for expected_oid in sorted(selected):
        end = raw.find(b"\n", offset)
        if end < 0:
            raise CohortError("cat_file_batch_malformed")
        header = raw[offset:end].decode("ascii", errors="strict").split()
        if len(header) != 3 or header[0] != expected_oid or header[1] != "blob" or not header[2].isdigit():
            raise CohortError("cat_file_batch_malformed")
        size = int(header[2])
        if size != sizes[expected_oid] or size > MAX_MANIFEST_BYTES:
            raise CohortError("cat_file_blob_size_mismatch")
        start = end + 1
        finish = start + size
        if finish >= len(raw) or raw[finish:finish + 1] != b"\n":
            raise CohortError("cat_file_batch_malformed")
        blobs[expected_oid] = raw[start:finish]
        offset = finish + 1
    if offset != len(raw):
        raise CohortError("cat_file_batch_trailing_data")
    return blobs



def _manifest_rows(tree: HeadPluginTree) -> tuple[dict[str, list[tuple[str, dict[str, str]]]], dict[str, dict[str, str]]]:
    rows: dict[str, list[tuple[str, dict[str, str]]]] = {name: [] for name in tree.directories}
    selected: dict[str, dict[str, str]] = {}
    for path, metadata in tree.entries.items():
        parts = path.split("/")
        if len(parts) not in (3, 4) or parts[-1] != "plugin.json":
            continue
        if len(parts) == 4 and parts[2] != "public":
            continue
        name = parts[1]
        if name not in rows:
            raise CohortError("manifest_owner_missing")
        manifest_class = "root" if len(parts) == 3 else "public"
        rows[name].append((manifest_class, metadata))
        if metadata["kind"] == "blob" and metadata["mode"] in ("100644", "100755"):
            selected[path] = metadata
    if len(selected) > MAX_MANIFEST_FILES:
        raise CohortError("manifest_file_count_over_limit")
    return rows, selected



def _tree_fingerprint(tree: HeadPluginTree, manifests: dict[str, list[tuple[str, dict[str, str]]]],
                      projections: dict[str, dict[str, dict[str, object]]]) -> str:
    rows = []
    for name, directory in sorted(tree.directories.items(), key=lambda pair: (pair[0].casefold(), pair[0])):
        records = []
        for manifest_class, metadata in sorted(manifests[name], key=lambda item: item[0]):
            path = f"plugins/{name}/plugin.json" if manifest_class == "root" else f"plugins/{name}/public/plugin.json"
            projection = projections.get(path, {})
            records.append({"class": manifest_class, "mode": metadata["mode"], "kind": metadata["kind"],
                            "oid": metadata["oid"], "bytes": projection.get("bytes"), "sha256": projection.get("sha256")})
        rows.append({"directory": name, "mode": directory["mode"], "kind": directory["kind"], "oid": directory["oid"],
                     "manifests": records})
    return canonical_sha256(rows)


def build_acceptance_ledger(repo: pathlib.Path) -> dict[str, object]:
    repo = repo.resolve(strict=True)
    head, object_format = head_revision(repo)
    tree = head_plugin_tree(repo, head)
    manifests, selected = _manifest_rows(tree)
    blobs = head_blob_contents(repo, selected)
    projections_by_path: dict[str, dict[str, object]] = {}
    for name, rows in manifests.items():
        for manifest_class, metadata in rows:
            path = f"plugins/{name}/plugin.json" if manifest_class == "root" else f"plugins/{name}/public/plugin.json"
            raw = blobs.get(metadata["oid"])
            if raw is None:
                projection = {"state": "unsupported_head_type", "bytes": None, "sha256": None}
            else:
                projection = manifest_projection(raw)
                projection["bytes"] = len(raw)
                projection["sha256"] = sha256(raw)
            projections_by_path[path] = projection

    head_names = set(tree.directories)
    first_working, local_dirs, local_others, fs_root_state = working_snapshot(
        repo, manifests, tree.entries, head_names)
    cohort_pin = _tree_fingerprint(tree, manifests, projections_by_path)
    # Re-read only the manifest paths and local directory names; plugin implementation files are never opened.
    second_working, second_local_dirs, second_local_others, second_fs_state = working_snapshot(
        repo, manifests, tree.entries, head_names)
    if canonical_sha256(first_working) != canonical_sha256(second_working):
        raise CohortError("working_manifest_tree_changed_during_scan")
    if canonical_sha256([local_dirs, local_others, fs_root_state]) != canonical_sha256(
            [second_local_dirs, second_local_others, second_fs_state]):
        raise CohortError("local_plugin_entries_changed_during_scan")
    final_head, final_format = head_revision(repo)
    if final_head != head or final_format != object_format:
        raise CohortError("repository_head_changed_during_scan")

    plugins = []
    counts = {"rootManifest": 0, "publicOnlyManifest": 0, "noDirectManifest": 0,
              "trackedManifestFiles": 0, "workingTreeModified": 0, "workingTreeMissing": 0,
              "workingTreeUnsupported": 0}
    for name, directory in sorted(tree.directories.items(), key=lambda pair: (pair[0].casefold(), pair[0])):
        rows = manifests[name]
        classes = {entry_class for entry_class, _ in rows}
        if "root" in classes:
            structure = "root_manifest"
            counts["rootManifest"] += 1
        elif "public" in classes:
            structure = "public_manifest_only"
            counts["publicOnlyManifest"] += 1
        else:
            structure = "no_direct_manifest"
            counts["noDirectManifest"] += 1
        manifest_records = []
        for manifest_class, metadata in sorted(rows, key=lambda item: item[0]):
            path = f"plugins/{name}/plugin.json" if manifest_class == "root" else f"plugins/{name}/public/plugin.json"
            projection = projections_by_path[path]
            working_row = next(row for row in first_working[name] if row["class"] == manifest_class)
            working = working_row.get("workingTree", {"state": "not_readable_type"})
            expected_sha = projection.get("sha256")
            state = working.get("state")
            match = working_matches_head(working, metadata, projection)
            if state == "present" and not match:
                counts["workingTreeModified"] += 1
            elif state == "missing":
                counts["workingTreeMissing"] += 1
            elif state != "present":
                counts["workingTreeUnsupported"] += 1
            counts["trackedManifestFiles"] += 1
            manifest_records.append({"class": manifest_class, "path": path,
                                     "head": {"mode": metadata["mode"], "kind": metadata["kind"],
                                              "gitBlobOid": metadata["oid"], "sha256": expected_sha,
                                              "bytes": projection.get("bytes"), "json": projection},
                                     "workingTree": working,
                                     "workingTreeMatchesHead": match})
        identity_record = next((row["head"]["json"] for row in manifest_records if row["class"] == "root"), None)
        if identity_record is None:
            identity_record = next((row["head"]["json"] for row in manifest_records if row["class"] == "public"), None)
        plugins.append({"directory": name, "directoryTree": directory,
                        "structure": structure, "manifests": manifest_records,
                        "identityProjection": identity_record or {"state": "no_manifest"},
                        "acceptance": {"sourceReview": "not_verified", "install": "not_verified",
                                       "runtime": "not_verified", "business": "not_verified",
                                       "interaction": "not_verified", "conversion": "not_verified"}})

    return {
        "schemaVersion": 1,
        "purpose": "Pinned structural cohort and manual acceptance ledger; generation never infers acceptance.",
        "repository": {"head": head, "objectFormat": object_format,
                       "pluginsTreeGitOid": tree.plugin_tree_oid,
                       "worktreePluginsRootState": fs_root_state},
        "cohort": {"definition": "Unique direct tree/gitlink entries in plugins/ at captured HEAD; structural root/public/no-manifest counts use plugin.json path presence regardless of Git mode or manifest validity.",
                   "sha256": cohort_pin,
                   "counts": {"fixedHeadPluginDirectories": len(plugins), **counts,
                              "localOutsideHeadDirectoriesExcluded": len(local_dirs),
                              "localOutsideHeadOtherEntriesExcluded": len(local_others)},
                   "localOutsideHeadDirectoriesExcluded": local_dirs,
                   "localOutsideHeadOtherEntriesExcluded": local_others,
                   "plugins": plugins},
        "verificationPolicy": {"sourceReview": "not_verified", "install": "not_verified",
                               "runtime": "not_verified", "business": "not_verified",
                               "interaction": "not_verified", "conversion": "not_verified",
                               "meaning": "Manifest presence, static readiness, import success, TaskRun success, or another case never changes these fields automatically."},
        "snapshot": {"headStableThroughScan": True,
                     "workingManifestStatesStableThroughScan": True,
                     "localOutsideHeadDirectoryListStableThroughScan": True,
                     "sourceClosure": False},
        "limits": ["The cohort is the selected local Git HEAD, not the latest network ecosystem.",
                   "Only Git tree metadata and direct root/public plugin.json blobs are read; implementation source is not inspected or executed.",
                   "A Git HEAD cohort and local outside-HEAD directories are reported separately; local additions are excluded from the denominator.",
                   "All acceptance categories start not_verified and require separate pinned evidence and human review.",
                   "Selected tree metadata is not a compiler dependency closure."],
    }


