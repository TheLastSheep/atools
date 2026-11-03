"""Bounded Git process and tree-record parsing for the plugin cohort."""
from __future__ import annotations

import pathlib
import subprocess
from dataclasses import dataclass

MAX_TREE_OUTPUT_BYTES = 32 * 1024 * 1024
MAX_TREE_ROWS = 250_000
MAX_TOP_LEVEL_PLUGINS = 2_048
MAX_OBJECT_SIZE = (1 << 63) - 1


class CohortError(ValueError):
    """A fixed, non-path-bearing failure while reading a repository snapshot."""


@dataclass(frozen=True)
class HeadPluginTree:
    plugin_tree_oid: str
    directories: dict[str, dict[str, str]]
    entries: dict[str, dict[str, str]]


def git_bytes(repo: pathlib.Path, args: tuple[str, ...], *, input_data: bytes | None = None,
              limit: int = MAX_TREE_OUTPUT_BYTES) -> bytes:
    command = ["git", "-C", str(repo), *args]
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError:
        raise CohortError("git_unavailable") from None
    try:
        if input_data is not None:
            try:
                if process.stdin is None:
                    raise CohortError("git_input_rejected")
                process.stdin.write(input_data)
                process.stdin.close()
            except (BrokenPipeError, OSError):
                raise CohortError("git_input_rejected") from None
        if process.stdout is None:
            raise CohortError("git_output_unavailable")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = process.stdout.read(min(64 * 1024, limit - total + 1))
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise CohortError("git_output_over_limit")
            chunks.append(chunk)
        if process.wait() != 0:
            raise CohortError("git_command_failed")
        return b"".join(chunks)
    except OSError:
        raise CohortError("git_output_read_failed") from None
    finally:
        if process.poll() is None:
            try:
                process.kill()
            except OSError:
                pass
        try:
            process.wait()
        except OSError:
            pass
        for stream in (process.stdin, process.stdout):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass


def decode_component(raw: bytes) -> str:
    try:
        value = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise CohortError("tree_path_invalid_utf8") from None
    if (not value or value in (".", "..") or "/" in value or "\\" in value
            or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)):
        raise CohortError("tree_path_component_invalid")
    return value


def parse_records(raw: bytes, *, long_listing: bool = False) -> list[tuple[dict[str, str], bytes]]:
    if len(raw) > MAX_TREE_OUTPUT_BYTES:
        raise CohortError("git_output_over_limit")
    if raw and not raw.endswith(b"\0"):
        raise CohortError("tree_listing_malformed")
    rows = []
    for record in raw[:-1].split(b"\0") if raw else ():
        try:
            raw_metadata, path = record.split(b"\t", 1)
            fields = raw_metadata.decode("ascii").split()
        except (ValueError, UnicodeDecodeError):
            raise CohortError("tree_listing_malformed") from None
        if len(fields) not in (3, 4):
            raise CohortError("tree_listing_malformed")
        mode, kind, oid = fields[:3]
        if kind not in ("blob", "tree", "commit") or not oid.isalnum():
            raise CohortError("tree_entry_metadata_invalid")
        size = fields[3] if len(fields) == 4 else None
        if long_listing:
            if kind == "blob":
                if size is None:
                    raise CohortError("tree_entry_size_missing")
                if (not size.isascii() or not size.isdigit() or len(size) > 19
                        or int(size) > MAX_OBJECT_SIZE):
                    raise CohortError("tree_entry_size_invalid")
            elif kind == "commit" and size == "-":
                # Git uses a dash for gitlinks in --long listings; they have no blob size.
                size = None
            elif kind == "commit" and size is None:
                raise CohortError("tree_entry_size_missing")
            else:
                raise CohortError("tree_entry_size_invalid" if size is not None
                                  else "tree_entry_size_missing")
        elif size is not None:
            raise CohortError("tree_entry_size_invalid")
        metadata = {"mode": mode, "kind": kind, "oid": oid}
        if size is not None:
            metadata["size"] = size
        rows.append((metadata, path))
        if len(rows) > MAX_TREE_ROWS:
            raise CohortError("tree_row_count_over_limit")
    return rows


def head_plugin_tree(repo: pathlib.Path, head: str) -> HeadPluginTree:
    """Read only tree metadata; never open plugin implementation files."""
    root_rows = parse_records(git_bytes(repo, ("ls-tree", "-z", head, "--", "plugins")))
    plugin_root = [row for row in root_rows if row[1] == b"plugins"]
    if len(plugin_root) != 1 or plugin_root[0][0]["kind"] != "tree":
        raise CohortError("plugins_tree_missing_or_ambiguous")
    plugin_tree_oid = plugin_root[0][0]["oid"]

    direct_rows = parse_records(git_bytes(repo, ("ls-tree", "-z", f"{head}:plugins")))
    directories: dict[str, dict[str, str]] = {}
    for metadata, raw_name in direct_rows:
        if metadata["kind"] not in ("tree", "commit"):
            continue
        name = decode_component(raw_name)
        if name in directories:
            raise CohortError("tree_directory_duplicate")
        directories[name] = metadata
        if len(directories) > MAX_TOP_LEVEL_PLUGINS:
            raise CohortError("plugin_directory_count_over_limit")

    leaf_rows = parse_records(git_bytes(repo, ("ls-tree", "-r", "-l", "-z", head, "--", "plugins")),
                              long_listing=True)
    entries: dict[str, dict[str, str]] = {}
    for metadata, raw_path in leaf_rows:
        try:
            path = raw_path.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            raise CohortError("tree_path_invalid_utf8") from None
        parts = path.split("/")
        if len(parts) < 2 or parts[0] != "plugins":
            raise CohortError("tree_path_outside_plugins")
        for component in parts[1:]:
            try:
                encoded_component = component.encode("utf-8", errors="strict")
            except UnicodeEncodeError:
                raise CohortError("tree_path_invalid_utf8") from None
            decode_component(encoded_component)
        if parts[1] not in directories:
            raise CohortError("tree_entry_owner_missing")
        if path in entries:
            raise CohortError("tree_entry_duplicate")
        entries[path] = metadata
    return HeadPluginTree(plugin_tree_oid, directories, entries)
