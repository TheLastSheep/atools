"""Descriptor-anchored worktree reads and fresh output writes for the ledger."""
from __future__ import annotations

import os
import pathlib
import stat
import errno
import hashlib

from ztools_plugin_manifest import MAX_MANIFEST_BYTES


class FilesystemBoundaryError(ValueError):
    """A fixed, path-free failure at a filesystem boundary."""


def _descriptor_flags() -> int:
    required = ("O_NOFOLLOW", "O_DIRECTORY")
    directory_fd_operations = (os.open, os.stat, os.mkdir, os.unlink, os.rmdir)
    supports_dir_fd = getattr(os, "supports_dir_fd", set())
    supports_follow_symlinks = getattr(os, "supports_follow_symlinks", set())
    supports_fd = getattr(os, "supports_fd", set())
    if (not all(hasattr(os, name) for name in required)
            or any(operation not in supports_dir_fd for operation in directory_fd_operations)
            or os.stat not in supports_follow_symlinks or os.listdir not in supports_fd):
        raise FilesystemBoundaryError("descriptor_io_unsupported")
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)


def _identity(info: os.stat_result) -> tuple[int, int]:
    return info.st_dev, info.st_ino


def _file_version(info: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            getattr(info, "st_mtime_ns", int(info.st_mtime * 1_000_000_000)),
            getattr(info, "st_ctime_ns", int(info.st_ctime * 1_000_000_000)))


def _path_state(error: OSError, parent_fd: int, name: str) -> str:
    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return "missing"
    except OSError:
        return "unreadable"
    if stat.S_ISLNK(current.st_mode):
        return "symlink"
    return "changed_during_read" if error.errno == errno.ELOOP else "unreadable"


def _open_child_directory(parent_fd: int, name: str) -> int:
    flags = _descriptor_flags()
    try:
        before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        raise FilesystemBoundaryError("missing") from None
    except OSError:
        raise FilesystemBoundaryError("unreadable") from None
    if stat.S_ISLNK(before.st_mode):
        raise FilesystemBoundaryError("symlink")
    if not stat.S_ISDIR(before.st_mode):
        raise FilesystemBoundaryError("parent_not_directory")
    try:
        child_fd = os.open(name, flags, dir_fd=parent_fd)
    except OSError as error:
        raise FilesystemBoundaryError(_path_state(error, parent_fd, name)) from None
    try:
        opened = os.fstat(child_fd)
        after = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (not stat.S_ISDIR(opened.st_mode) or stat.S_ISLNK(after.st_mode)
                or _identity(before) != _identity(opened) or _identity(opened) != _identity(after)):
            raise FilesystemBoundaryError("changed_during_read")
        return child_fd
    except (OSError, FilesystemBoundaryError):
        os.close(child_fd)
        raise


def _open_absolute_directory(path: pathlib.Path, *, create_missing: bool = False) -> int:
    flags = _descriptor_flags()
    absolute = pathlib.Path(os.path.abspath(path))
    if len(absolute.parts) > 256:
        raise FilesystemBoundaryError("directory_path_over_limit")
    try:
        root_fd = os.open(os.sep, flags)
        root_info = os.fstat(root_fd)
        if not stat.S_ISDIR(root_info.st_mode):
            os.close(root_fd)
            raise FilesystemBoundaryError("not_directory")
        current_fd = root_fd
        for component in absolute.parts[1:]:
            try:
                child_fd = _open_child_directory(current_fd, component)
            except FilesystemBoundaryError as error:
                if not create_missing or str(error) != "missing":
                    raise
                try:
                    os.mkdir(component, 0o777, dir_fd=current_fd)
                except FileExistsError:
                    pass
                except OSError:
                    raise FilesystemBoundaryError("parent_create_failed") from None
                child_fd = _open_child_directory(current_fd, component)
            if current_fd != root_fd:
                os.close(current_fd)
            current_fd = child_fd
        if current_fd == root_fd:
            return root_fd
        os.close(root_fd)
        return current_fd
    except (OSError, FilesystemBoundaryError):
        try:
            if "current_fd" in locals() and current_fd != root_fd:
                os.close(current_fd)
            if "root_fd" in locals():
                os.close(root_fd)
        except OSError:
            pass
        raise


def _same_named_directory(parent_fd: int, name: str, expected_fd: int) -> bool:
    try:
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        opened = os.fstat(expected_fd)
    except OSError:
        return False
    return (stat.S_ISDIR(named.st_mode) and _identity(named) == _identity(opened)
            and stat.S_ISDIR(opened.st_mode))


def _same_absolute_directory(path: pathlib.Path, expected_fd: int) -> bool:
    try:
        current_fd = _open_absolute_directory(path)
    except (FilesystemBoundaryError, OSError):
        return False
    try:
        return _identity(os.fstat(current_fd)) == _identity(os.fstat(expected_fd))
    except OSError:
        return False
    finally:
        os.close(current_fd)


def _safe_component(name: str) -> bool:
    try:
        name.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        return False
    return (bool(name) and name not in (".", "..") and "/" not in name
            and "\\" not in name and "\0" not in name
            and not any(ord(char) < 0x20 or ord(char) == 0x7F for char in name))


def read_worktree_manifest(repo: pathlib.Path, relative: str) -> dict[str, object]:
    parts = relative.split("/")
    if len(parts) < 2 or parts[0] != "plugins" or any(
            not part or part in (".", "..") or "\\" in part or "\0" in part for part in parts):
        return {"state": "unsafe_path"}
    directory_fds: list[int] = []
    directory_names: list[tuple[int, str, int]] = []
    file_fd: int | None = None
    try:
        current_fd = _open_absolute_directory(repo)
        directory_fds.append(current_fd)
        for component in parts[:-1]:
            parent_fd = current_fd
            current_fd = _open_child_directory(parent_fd, component)
            directory_fds.append(current_fd)
            directory_names.append((parent_fd, component, current_fd))
        parent_fd = current_fd
        filename = parts[-1]
        try:
            before = os.stat(filename, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return {"state": "missing"}
        except OSError:
            return {"state": "unreadable"}
        if stat.S_ISLNK(before.st_mode):
            return {"state": "symlink"}
        if not stat.S_ISREG(before.st_mode):
            return {"state": "not_regular_file"}
        if before.st_size > MAX_MANIFEST_BYTES:
            return {"state": "over_limit", "bytes": before.st_size}
        try:
            file_fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
                              dir_fd=parent_fd)
        except OSError as error:
            return {"state": _path_state(error, parent_fd, filename)}
        opened = os.fstat(file_fd)
        named = os.stat(filename, dir_fd=parent_fd, follow_symlinks=False)
        if (not stat.S_ISREG(opened.st_mode) or stat.S_ISLNK(named.st_mode)
                or opened.st_nlink != 1 or _file_version(before) != _file_version(opened)
                or _file_version(opened) != _file_version(named)):
            return {"state": "changed_during_read"}
        data = bytearray()
        while len(data) <= MAX_MANIFEST_BYTES:
            chunk = os.read(file_fd, min(64 * 1024, MAX_MANIFEST_BYTES + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(file_fd)
        named_after = os.stat(filename, dir_fd=parent_fd, follow_symlinks=False)
        if (len(data) > MAX_MANIFEST_BYTES or not stat.S_ISREG(after.st_mode)
                or stat.S_ISLNK(named_after.st_mode) or _file_version(opened) != _file_version(after)
                or _file_version(after) != _file_version(named_after) or after.st_size != len(data)):
            return {"state": "changed_during_read"}
        for owner_fd, component, child_fd in directory_names:
            if not _same_named_directory(owner_fd, component, child_fd):
                return {"state": "changed_during_read"}
        if not _same_absolute_directory(repo, directory_fds[0]):
            return {"state": "changed_during_read"}
        return {"state": "present", "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "mode": stat.S_IMODE(after.st_mode)}
    except FilesystemBoundaryError as error:
        return {"state": str(error)}
    except OSError:
        return {"state": "unreadable"}
    finally:
        if file_fd is not None:
            os.close(file_fd)
        for fd in reversed(directory_fds):
            os.close(fd)


def _manifest_presence(directory_fd: int) -> str:
    try:
        info = os.stat("plugin.json", dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return "missing"
    except OSError:
        return "unreadable"
    if stat.S_ISLNK(info.st_mode):
        return "symlink"
    return "present_uninspected" if stat.S_ISREG(info.st_mode) else "not_regular_file"


def local_outside_head_directories(repo: pathlib.Path, head_names: set[str]) -> tuple[list[dict[str, object]], list[dict[str, object]], str]:
    root_fd: int | None = None
    plugins_fd: int | None = None
    directories = []
    other_entries = []
    try:
        root_fd = _open_absolute_directory(repo)
        try:
            plugins_fd = _open_child_directory(root_fd, "plugins")
        except FilesystemBoundaryError as error:
            state = "not_directory" if str(error) == "parent_not_directory" else str(error)
            return [], [], state
        names = os.listdir(plugins_fd)
        if len(names) > 4_096:
            raise FilesystemBoundaryError("local_plugin_entry_count_over_limit")
        for name in sorted(names, key=lambda value: (value.casefold(), value)):
            if not _safe_component(name):
                other_entries.append({"entryNameState": "invalid_or_unreadable"})
                continue
            try:
                info = os.stat(name, dir_fd=plugins_fd, follow_symlinks=False)
            except OSError:
                other_entries.append({"entryNameState": "invalid_or_unreadable"})
                continue
            if name in head_names:
                continue
            if stat.S_ISLNK(info.st_mode):
                other_entries.append({"entryName": name, "state": "symlink_excluded"})
            elif stat.S_ISDIR(info.st_mode):
                try:
                    child_fd = _open_child_directory(plugins_fd, name)
                except FilesystemBoundaryError:
                    manifest_state = "changed_or_unsafe"
                else:
                    try:
                        manifest_state = _manifest_presence(child_fd)
                        if not _same_named_directory(plugins_fd, name, child_fd):
                            manifest_state = "changed_or_unsafe"
                    finally:
                        os.close(child_fd)
                directories.append({"directory": name, "state": "outside_captured_head_excluded",
                                    "rootManifestState": manifest_state})
            else:
                other_entries.append({"entryName": name, "state": "non_directory_excluded"})
        if not _same_named_directory(root_fd, "plugins", plugins_fd):
            return [], [], "changed_during_read"
        if not _same_absolute_directory(repo, root_fd):
            return [], [], "changed_during_read"
        return directories, other_entries, "present"
    except FilesystemBoundaryError as error:
        return [], [], str(error)
    except OSError:
        return [], [], "unreadable"
    finally:
        if plugins_fd is not None:
            os.close(plugins_fd)
        if root_fd is not None:
            os.close(root_fd)


def working_snapshot(repo: pathlib.Path, manifest_rows: dict[str, list[tuple[str, dict[str, str]]]],
                     tree_entries: dict[str, dict[str, str]], head_names: set[str]):
    result: dict[str, list[dict[str, object]]] = {}
    for name, manifests in manifest_rows.items():
        current = []
        for manifest_class, metadata in manifests:
            path = f"plugins/{name}/plugin.json" if manifest_class == "root" else f"plugins/{name}/public/plugin.json"
            record = {"path": path, "class": manifest_class, "headMode": metadata["mode"],
                      "headKind": metadata["kind"], "state": "unsupported_head_type",
                      "workingTree": read_worktree_manifest(repo, path)}
            if metadata["kind"] == "blob" and metadata["mode"] in ("100644", "100755"):
                record["headBlobOid"] = tree_entries[path]["oid"]
            current.append(record)
        result[name] = current
    extras, excluded, root_state = local_outside_head_directories(repo, head_names)
    return result, extras, excluded, root_state


def working_matches_head(working: dict[str, object], metadata: dict[str, str],
                         projection: dict[str, object]) -> bool:
    actual_mode = working.get("mode")
    actual_exec = isinstance(actual_mode, int) and bool(actual_mode & 0o111)
    return (working.get("state") == "present"
            and working.get("sha256") == projection.get("sha256")
            and actual_exec == (metadata["mode"] == "100755"))


def _open_verified_path(path: pathlib.Path, *, create_missing: bool = False) -> tuple[int, tuple[int, int]]:
    fd = _open_absolute_directory(path, create_missing=create_missing)
    try:
        opened = os.fstat(fd)
        if not stat.S_ISDIR(opened.st_mode):
            raise FilesystemBoundaryError("output_parent_unsafe")
        return fd, _identity(opened)
    except (OSError, FilesystemBoundaryError):
        os.close(fd)
        raise


def _cleanup_output(parent_fd: int, directory_name: str, output_fd: int | None,
                    output_identity: tuple[int, int] | None, filename: str,
                    file_identity: tuple[int, int] | None) -> None:
    if output_fd is not None and file_identity is not None:
        try:
            current = os.stat(filename, dir_fd=output_fd, follow_symlinks=False)
            if _identity(current) == file_identity:
                os.unlink(filename, dir_fd=output_fd)
        except OSError:
            pass
    if output_fd is not None:
        os.close(output_fd)
    if output_identity is not None:
        try:
            current = os.stat(directory_name, dir_fd=parent_fd, follow_symlinks=False)
            if _identity(current) == output_identity and stat.S_ISDIR(current.st_mode):
                os.rmdir(directory_name, dir_fd=parent_fd)
        except OSError:
            pass


def write_fresh_output(requested: pathlib.Path, git_root: pathlib.Path,
                       filename: str, payload: bytes) -> pathlib.Path:
    """Create the output directory, write filename inside it, and return that directory."""
    if (not filename or filename in (".", "..") or "/" in filename or "\\" in filename
            or "\0" in filename or len(filename.encode("utf-8")) > 128):
        raise FilesystemBoundaryError("output_filename_invalid")
    if len(payload) > 32 * 1024 * 1024:
        raise FilesystemBoundaryError("output_over_limit")
    raw = requested.expanduser()
    if not raw.is_absolute():
        raw = pathlib.Path.cwd() / raw
    absolute = pathlib.Path(os.path.abspath(raw))
    if not absolute.name or absolute.name in (".", ".."):
        raise FilesystemBoundaryError("output_directory_invalid")
    parent = absolute.parent
    target = parent / absolute.name
    root = git_root.resolve(strict=True)
    if target == root or root in target.parents:
        raise FilesystemBoundaryError("output_inside_source_repository")
    parent_fd = None
    output_fd = None
    file_fd = None
    output_identity = None
    file_identity = None
    success = False
    try:
        parent_fd, parent_identity = _open_verified_path(parent, create_missing=True)
        try:
            os.mkdir(target.name, 0o700, dir_fd=parent_fd)
        except FileExistsError:
            raise FilesystemBoundaryError("output_already_exists") from None
        except OSError:
            raise FilesystemBoundaryError("output_create_failed") from None
        info = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode):
            raise FilesystemBoundaryError("output_directory_unsafe")
        output_identity = _identity(info)
        output_fd = _open_child_directory(parent_fd, target.name)
        if not _same_named_directory(parent_fd, target.name, output_fd):
            raise FilesystemBoundaryError("output_directory_changed")
        check_fd, checked_parent_identity = _open_verified_path(parent)
        os.close(check_fd)
        if checked_parent_identity != parent_identity:
            raise FilesystemBoundaryError("output_parent_changed")
        try:
            file_fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW |
                              getattr(os, "O_CLOEXEC", 0), 0o600, dir_fd=output_fd)
        except OSError:
            raise FilesystemBoundaryError("output_file_create_failed") from None
        file_info = os.fstat(file_fd)
        if not stat.S_ISREG(file_info.st_mode) or file_info.st_nlink != 1:
            raise FilesystemBoundaryError("output_file_unsafe")
        file_identity = _identity(file_info)
        view = memoryview(payload)
        while view:
            written = os.write(file_fd, view)
            if written <= 0:
                raise FilesystemBoundaryError("output_write_failed")
            view = view[written:]
        final_file = os.fstat(file_fd)
        named_file = os.stat(filename, dir_fd=output_fd, follow_symlinks=False)
        if (not stat.S_ISREG(final_file.st_mode) or stat.S_ISLNK(named_file.st_mode)
                or _identity(final_file) != file_identity or _identity(named_file) != file_identity
                or final_file.st_size != len(payload) or named_file.st_size != len(payload)):
            raise FilesystemBoundaryError("output_file_changed")
        check_fd, checked_parent_identity = _open_verified_path(parent)
        try:
            named_output = os.stat(target.name, dir_fd=check_fd, follow_symlinks=False)
            if (checked_parent_identity != parent_identity or _identity(named_output) != output_identity
                    or not stat.S_ISDIR(named_output.st_mode)):
                raise FilesystemBoundaryError("output_parent_changed")
        finally:
            os.close(check_fd)
        if not _same_named_directory(parent_fd, target.name, output_fd):
            raise FilesystemBoundaryError("output_directory_changed")
        success = True
        return target
    except FilesystemBoundaryError:
        raise
    except OSError:
        raise FilesystemBoundaryError("output_filesystem_failed") from None
    finally:
        if file_fd is not None:
            os.close(file_fd)
        if not success and parent_fd is not None:
            _cleanup_output(parent_fd, target.name, output_fd, output_identity, filename, file_identity)
            output_fd = None
        elif output_fd is not None:
            os.close(output_fd)
        if parent_fd is not None:
            os.close(parent_fd)
