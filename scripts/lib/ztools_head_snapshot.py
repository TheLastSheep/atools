"""Bounded, no-follow materialization of a fixed Git archive snapshot."""
from __future__ import annotations

import hashlib
import pathlib
import stat
import tarfile
from typing import BinaryIO

EXPECTED_COUNT = 153
MAX_TREE_LIST_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BLOB_BYTES = 512 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_MEMBERS_HARD = 16_000
CHUNK = 1024 * 1024

class AuditError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _nul_ls_tree_records(raw: bytes, max_bytes: int) -> list[tuple[bytes, str]]:
    """Parse Git's -z records without treating quoted paths as literal names."""
    if len(raw) > max_bytes:
        raise AuditError("tree_listing_too_large")
    if not raw:
        return []
    if not raw.endswith(b"\0"):
        raise AuditError("tree_listing_malformed")
    records = raw[:-1].split(b"\0")
    if any(not record for record in records):
        raise AuditError("tree_listing_malformed")
    parsed: list[tuple[bytes, str]] = []
    for record in records:
        try:
            meta, path_bytes = record.split(b"\t", 1)
        except ValueError:
            raise AuditError("tree_listing_malformed") from None
        try:
            path = path_bytes.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            raise AuditError("tree_listing_invalid_utf8") from None
        if not path:
            raise AuditError("tree_listing_path_invalid")
        parsed.append((meta, path))
    return parsed


def parse_ls_tree_directories(raw: bytes, max_bytes: int = MAX_TREE_LIST_BYTES) -> dict[str, dict]:
    """Parse `git ls-tree -d -z <tree>` direct children, preserving literal names."""
    directories: dict[str, dict] = {}
    for meta, name in _nul_ls_tree_records(raw, max_bytes):
        try:
            mode, kind, oid = meta.decode("ascii").split()
        except (UnicodeDecodeError, ValueError):
            raise AuditError("tree_listing_malformed") from None
        if not name or "/" in name or "\\" in name or name in (".", "..") or "\0" in name:
            raise AuditError("tree_listing_path_invalid")
        if kind not in ("tree", "commit") or len(oid) != 40:
            raise AuditError("tree_directory_metadata_invalid")
        if name in directories:
            raise AuditError("tree_directory_duplicate")
        directories[name] = {"oid": oid, "kind": kind, "mode": mode}
    return directories


def parse_ls_tree(raw: bytes, max_bytes: int = MAX_TREE_LIST_BYTES) -> tuple[dict[str, dict], dict[str, dict], dict[str, dict]]:
    directories: dict[str, dict] = {}
    blobs: dict[str, dict] = {}
    archive_directories: dict[str, dict] = {}
    for meta, path in _nul_ls_tree_records(raw, max_bytes):
        try:
            fields = meta.decode("ascii").split()
        except UnicodeDecodeError:
            raise AuditError("tree_listing_malformed") from None
        if len(fields) not in (3, 4):
            raise AuditError("tree_listing_malformed")
        mode, kind, oid = fields[:3]
        size_parts = fields[3:]
        if path == "plugins":
            if kind != "tree" or mode != "040000" or len(oid) != 40 or path in archive_directories:
                raise AuditError("tree_root_metadata_invalid")
            archive_directories[path] = {"kind": kind, "mode": mode, "oid": oid}
            continue
        parts = path.split("/")
        if len(parts) < 2 or parts[0] != "plugins" or any(part in ("", ".", "..") for part in parts):
            raise AuditError("tree_listing_path_invalid")
        name = parts[1]
        if kind in ("tree", "commit"):
            if kind == "tree" and (mode != "040000" or len(oid) != 40):
                raise AuditError("tree_directory_metadata_invalid")
            if kind == "commit" and (mode != "160000" or len(oid) != 40):
                raise AuditError("tree_directory_metadata_invalid")
            if path in archive_directories:
                raise AuditError("tree_directory_duplicate")
            archive_directories[path] = {"kind": kind, "mode": mode, "oid": oid}
        if len(parts) == 2 and kind in ("tree", "commit"):
            if name in directories:
                raise AuditError("tree_directory_duplicate")
            directories[name] = {"oid": oid, "kind": kind, "mode": mode}
        if kind == "blob":
            if path in archive_directories:
                raise AuditError("tree_entry_path_duplicate")
            if path in blobs:
                raise AuditError("tree_blob_duplicate")
            size = int(size_parts[0]) if size_parts and size_parts[0].isdigit() else None
            if size is None or len(oid) != 40:
                raise AuditError("tree_blob_metadata_invalid")
            blobs[path] = {"oid": oid, "size": size, "mode": mode, "owner": name}
        elif kind not in ("tree", "commit"):
            raise AuditError("tree_entry_type_unsupported")
    if "plugins" not in archive_directories:
        raise AuditError("tree_root_missing")
    for path in (*archive_directories.keys(), *blobs.keys()):
        if path == "plugins":
            continue
        parent = path.rpartition("/")[0]
        if archive_directories.get(parent, {}).get("kind") != "tree":
            raise AuditError("tree_directory_parent_missing")
    allowed_member_count = len(archive_directories) + len(blobs)
    if allowed_member_count > MAX_ARCHIVE_MEMBERS_HARD:
        raise AuditError("tree_member_count_over_hard_limit")
    total = sum(row["size"] for row in blobs.values())
    if total > MAX_TOTAL_BLOB_BYTES:
        raise AuditError("tree_bytes_over_budget")
    return directories, blobs, archive_directories


def head_archive_member_budget(archive_directories: dict[str, dict], blobs: dict[str, dict]) -> int:
    """Bound tar members by this exact HEAD path set plus a separate hard ceiling."""
    allowed = len(archive_directories) + len(blobs)
    if allowed > MAX_ARCHIVE_MEMBERS_HARD:
        raise AuditError("archive_member_budget_over_hard_limit")
    return allowed


def safe_member_path(name: str) -> tuple[str, tuple[str, ...]]:
    if not name or "\x00" in name or "\\" in name or name.startswith("/"):
        raise AuditError("archive_path_invalid")
    normalized = name[:-1] if name.endswith("/") else name
    parts = tuple(normalized.split("/"))
    if not parts or parts[0] != "plugins" or any(part in ("", ".", "..") for part in parts):
        raise AuditError("archive_path_invalid")
    if len(parts) == 1:
        return "", ()
    return parts[1], parts[2:]


class CappedReader:
    """Count raw tar bytes while keeping archive data streaming and bounded."""
    def __init__(self, stream: BinaryIO, limit: int):
        self.stream = stream
        self.limit = limit
        self.count = 0

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            size = min(CHUNK, self.limit - self.count + 1)
        data = self.stream.read(size)
        self.count += len(data)
        if self.count > self.limit:
            raise AuditError("archive_bytes_over_budget")
        return data


def ensure_safe_parent(root: pathlib.Path, parts: tuple[str, ...]) -> pathlib.Path:
    current = root
    for part in parts:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            current.mkdir()
            info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise AuditError("snapshot_parent_not_directory")
    return current


def materialize_archive(
    stream: BinaryIO,
    snapshot: pathlib.Path,
    expected_dirs: dict,
    blobs: dict,
    manifest_pins: dict[str, dict] | None = None,
    expected_archive_directories: dict[str, dict] | None = None,
) -> dict:
    manifest_pins = manifest_pins or {}
    if expected_archive_directories is None:
        raise AuditError("archive_directory_inventory_missing")
    allowed_member_count = head_archive_member_budget(expected_archive_directories, blobs)
    incompatible: dict[str, set[str]] = {
        name: ({"gitlink_not_archived"} if row["kind"] == "commit" else set())
        for name, row in expected_dirs.items()
    }
    seen: set[str] = set()
    seen_blobs: set[str] = set()
    member_count = 0
    seen_gitlinks: set[str] = set()
    total_file_bytes = 0
    manifest_actual: dict[str, dict] = {}
    reader = CappedReader(stream, MAX_ARCHIVE_BYTES)
    try:
        archive = tarfile.open(fileobj=reader, mode="r|")
        with archive:
            for member in archive:
                owner, tail = safe_member_path(member.name)
                normalized = "plugins" if not owner else "plugins/" + owner + ("/" + "/".join(tail) if tail else "")
                if normalized in seen:
                    raise AuditError("archive_duplicate_path")
                if not owner and (not member.isdir() or expected_archive_directories.get(normalized, {}).get("kind") != "tree"):
                    raise AuditError("archive_directory_not_in_head_tree")
                if owner and member.isdir() and expected_archive_directories.get(normalized) is None:
                    raise AuditError("archive_directory_not_in_head_tree")
                member_count += 1
                if member_count > MAX_ARCHIVE_MEMBERS_HARD:
                    raise AuditError("archive_member_absolute_hard_limit")
                if member_count > allowed_member_count:
                    raise AuditError("archive_member_count_over_head_budget")
                seen.add(normalized)
                if not owner:
                    continue
                if owner not in expected_dirs:
                    raise AuditError("archive_unknown_top_level")
                dest_parts = (owner, *tail)
                if member.isdir():
                    expected_directory = expected_archive_directories.get(normalized)
                    if expected_directory is None:
                        raise AuditError("archive_directory_not_in_head_tree")
                    if expected_directory.get("kind") == "commit":
                        seen_gitlinks.add(normalized)
                        incompatible[owner].add("gitlink_not_archived")
                        continue
                    ensure_safe_parent(snapshot, dest_parts)
                    continue
                if expected_dirs[owner]["kind"] == "commit":
                    raise AuditError("archive_path_not_in_head_tree")
                if not tail:
                    raise AuditError("archive_top_level_file")
                if member.issym():
                    incompatible[owner].add("symlink_not_followed")
                    # Git stores the symlink target in the link header. Keep the
                    # tree row explicit and never create or follow the link.
                    blob_path = "plugins/" + "/".join(dest_parts)
                    expected = blobs.get(blob_path)
                    if expected is None or expected["mode"] != "120000":
                        raise AuditError("archive_symlink_tree_mismatch")
                    seen_blobs.add(blob_path)
                    try:
                        target = member.linkname.encode("utf-8", errors="strict")
                    except UnicodeEncodeError:
                        incompatible[owner].add("symlink_target_not_utf8")
                        continue
                    if len(target) != expected["size"] or hashlib.sha1(b"blob " + str(len(target)).encode() + b"\0" + target).hexdigest() != expected["oid"]:
                        incompatible[owner].add("archive_content_mismatch")
                    if blob_path in manifest_pins:
                        manifest_actual[blob_path] = {"bytes": len(target), "sha256": sha256(target)}
                    continue
                if member.islnk():
                    incompatible[owner].add("hardlink_not_followed")
                    blob_path = "plugins/" + "/".join(dest_parts)
                    expected = blobs.get(blob_path)
                    if expected is None:
                        raise AuditError("archive_path_not_in_head_tree")
                    seen_blobs.add(blob_path)
                    incompatible[owner].add("archive_representation_unsupported")
                    continue
                if not member.isfile():
                    incompatible[owner].add("special_file_not_materialized")
                    blob_path = "plugins/" + "/".join(dest_parts)
                    expected = blobs.get(blob_path)
                    if expected is None:
                        raise AuditError("archive_path_not_in_head_tree")
                    seen_blobs.add(blob_path)
                    incompatible[owner].add("archive_representation_unsupported")
                    continue
                blob_path = "plugins/" + "/".join(dest_parts)
                expected = blobs.get(blob_path)
                if expected is None or expected["mode"] == "120000":
                    raise AuditError("archive_path_not_in_head_tree")
                seen_blobs.add(blob_path)
                size = member.size
                if size < 0:
                    raise AuditError("archive_file_size_invalid")
                total_file_bytes += size
                if total_file_bytes > MAX_TOTAL_BLOB_BYTES:
                    raise AuditError("archive_file_bytes_over_budget")
                if size > MAX_FILE_BYTES:
                    incompatible[owner].add("file_size_limit")
                destination = None
                if size <= MAX_FILE_BYTES and "gitlink_not_archived" not in incompatible[owner]:
                    parent = ensure_safe_parent(snapshot, dest_parts[:-1])
                    destination = parent / dest_parts[-1]
                source = archive.extractfile(member)
                if source is None:
                    raise AuditError("archive_file_data_missing")
                digest = hashlib.sha1()
                manifest_digest = hashlib.sha256() if blob_path in manifest_pins else None
                digest.update(b"blob " + str(size).encode() + b"\0")
                copied = 0
                output = destination.open("xb") if destination is not None else None
                try:
                    while True:
                        chunk = source.read(CHUNK)
                        if not chunk:
                            break
                        copied += len(chunk)
                        if copied > size:
                            raise AuditError("archive_file_size_mismatch")
                        digest.update(chunk)
                        if manifest_digest is not None:
                            manifest_digest.update(chunk)
                        if output is not None:
                            output.write(chunk)
                    if copied != size:
                        raise AuditError("archive_file_size_mismatch")
                finally:
                    if output is not None:
                        output.close()
                    source.close()
                if size != expected["size"] or digest.hexdigest() != expected["oid"]:
                    incompatible[owner].add("archive_content_mismatch")
                if manifest_digest is not None:
                    manifest_actual[blob_path] = {"bytes": copied, "sha256": manifest_digest.hexdigest()}
        # A missing blob may be caused by export-ignore; preserve an explicit
        # incompatible row rather than silently classifying a partial tree.
        for path, expected in blobs.items():
            if path not in seen_blobs:
                incompatible[expected["owner"]].add("archive_entry_missing")
        for path, pin in manifest_pins.items():
            actual = manifest_actual.get(path)
            if actual is None:
                incompatible[pin["owner"]].add("archive_entry_missing")
            elif actual["bytes"] != pin["bytes"] or actual["sha256"] != pin["sha256"]:
                incompatible[pin["owner"]].add("archive_content_mismatch")
        # Drain tar trailers through the same total-byte guard.
        while reader.read(CHUNK):
            pass
    except AuditError:
        raise
    except (tarfile.TarError, OSError, UnicodeError):
        raise AuditError("archive_invalid_or_unreadable") from None
    return {
        "memberCount": member_count,
        "headAllowedMemberCount": allowed_member_count,
        "headAllowedDirectoryCount": len(expected_archive_directories),
        "headAllowedBlobCount": len(blobs),
        "absoluteMemberHardLimit": MAX_ARCHIVE_MEMBERS_HARD,
        "excludedGitlinks": sorted(
            path for path, row in expected_archive_directories.items()
            if row.get("kind") == "commit" and path not in seen_gitlinks
        ),
        "blobBytes": total_file_bytes,
        "archiveBytes": reader.count,
        "seenBlobCount": len(seen_blobs),
        "verifiedManifestCount": len(manifest_actual),
        "incompatible": {name: sorted(reasons) for name, reasons in incompatible.items() if reasons},
    }


