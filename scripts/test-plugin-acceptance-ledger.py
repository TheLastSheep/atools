"""Focused structural tests for the pinned ZTools cohort ledger."""
from __future__ import annotations

import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).parent / "lib" / "ztools_plugin_cohort.py"
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC = importlib.util.spec_from_file_location("ztools_plugin_cohort", MODULE_PATH)
COHORT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = COHORT
SPEC.loader.exec_module(COHORT)
import ztools_plugin_filesystem as FILESYSTEM
import ztools_plugin_git_tree as GIT_TREE
DESCRIPTOR_IO_AVAILABLE = (hasattr(os, "O_NOFOLLOW") and os.open in os.supports_dir_fd
                           and os.stat in os.supports_dir_fd and os.stat in os.supports_follow_symlinks
                           and os.listdir in os.supports_fd)


def git(root: pathlib.Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *args], check=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.stdout.decode("utf-8").strip()


def put(root: pathlib.Path, relative: str, value: str) -> None:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value, encoding="utf-8")


class AcceptanceLedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="ztools-ledger-")
        # Resolve macOS /var aliases once so descriptor tests begin at a canonical root.
        self.temp_root = pathlib.Path(self.temp.name).resolve(strict=True)
        self.root = self.temp_root / "reference"
        self.root.mkdir()
        git(self.root, "init", "-q")
        put(self.root, "plugins/alpha/plugin.json", '{"name":"Alpha","version":"1"}')
        put(self.root, "plugins/alpha/public/plugin.json", '{"name":"Alpha Public","version":"1"}')
        put(self.root, "plugins/beta/public/plugin.json", '{"name":"Beta","version":"2"}')
        put(self.root, "plugins/gamma/README.md", "no direct manifest")
        put(self.root, "plugins/delta/README.md", "symlink manifest fixture")
        (self.root / "plugins/delta/plugin.json").symlink_to("../alpha/plugin.json")
        git(self.root, "add", "plugins")
        git(self.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
            "commit", "-qm", "fixed cohort")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_fixed_head_structure_and_worktree_states_are_separate(self) -> None:
        put(self.root, "plugins/alpha/plugin.json", '{"name":"Dirty Alpha","version":"1"}')
        (self.root / "plugins/beta/public/plugin.json").unlink()
        put(self.root, "plugins/local-only/plugin.json", '{"name":"Outside HEAD"}')
        (self.root / "plugins/local-link").symlink_to(self.root / "plugins/local-only", target_is_directory=True)

        first = COHORT.build_acceptance_ledger(self.root)
        second = COHORT.build_acceptance_ledger(self.root)
        self.assertEqual(first, second)
        cohort = first["cohort"]
        self.assertEqual(cohort["counts"]["fixedHeadPluginDirectories"], 4)
        self.assertEqual(cohort["counts"]["rootManifest"], 2)
        self.assertEqual(cohort["counts"]["publicOnlyManifest"], 1)
        self.assertEqual(cohort["counts"]["noDirectManifest"], 1)
        self.assertEqual(sum(cohort["counts"][key] for key in
                             ("rootManifest", "publicOnlyManifest", "noDirectManifest")),
                         cohort["counts"]["fixedHeadPluginDirectories"])
        self.assertEqual(cohort["counts"]["localOutsideHeadDirectoriesExcluded"], 1)
        self.assertEqual(cohort["counts"]["localOutsideHeadOtherEntriesExcluded"], 1)
        self.assertNotIn("local-only", {row["directory"] for row in cohort["plugins"]})
        by_name = {row["directory"]: row for row in cohort["plugins"]}
        self.assertEqual(len(by_name["alpha"]["manifests"]), 2)
        alpha_root = next(row for row in by_name["alpha"]["manifests"] if row["class"] == "root")
        self.assertEqual(alpha_root["workingTree"]["state"], "present")
        self.assertFalse(alpha_root["workingTreeMatchesHead"])
        self.assertEqual(by_name["beta"]["manifests"][0]["workingTree"]["state"], "missing")
        delta = by_name["delta"]
        self.assertEqual(delta["structure"], "root_manifest")
        self.assertEqual(delta["directoryTree"]["mode"], "040000")
        self.assertEqual(delta["manifests"][0]["class"], "root")
        self.assertEqual(delta["manifests"][0]["head"]["mode"], "120000")
        self.assertEqual(delta["manifests"][0]["head"]["json"]["state"], "unsupported_head_type")
        self.assertEqual(delta["identityProjection"]["state"], "unsupported_head_type")
        self.assertEqual(delta["manifests"][0]["workingTree"]["state"], "symlink")
        self.assertEqual(cohort["localOutsideHeadOtherEntriesExcluded"][0]["state"], "symlink_excluded")
        self.assertTrue(all(value == "not_verified" for row in cohort["plugins"]
                            for value in row["acceptance"].values()))
        self.assertFalse(first["snapshot"]["sourceClosure"])

    def test_head_tree_path_rejects_ambiguous_components_and_extra_output(self) -> None:
        put(self.root, "plugins/bad\\component/plugin.json", '{"name":"bad"}')
        git(self.root, "add", "plugins/bad\\component/plugin.json")
        git(self.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
            "commit", "-qm", "invalid tree path")
        head, _ = COHORT.head_revision(self.root)
        with self.assertRaises(COHORT.CohortError):
            COHORT.head_plugin_tree(self.root, head)

    def test_git_tree_parser_accepts_long_blob_sizes_and_rejects_bad_size_headers(self) -> None:
        oid = "a" * 40
        basic = f"100644 blob {oid}\tplugins/alpha/plugin.json\0".encode("ascii")
        ordinary = COHORT._records(basic)
        self.assertNotIn("size", ordinary[0][0])
        long_blob = f"100644 blob {oid} 123\tplugins/alpha/plugin.json\0".encode("ascii")
        parsed = COHORT._records(long_blob, long_listing=True)
        self.assertEqual(parsed[0][0]["size"], "123")
        gitlink = f"160000 commit {oid} -\tplugins/submodule\0".encode("ascii")
        self.assertEqual(COHORT._records(gitlink, long_listing=True)[0][0]["kind"], "commit")

        malformed = (
            (f"100644 blob {oid}\tplugins/alpha/plugin.json\0".encode("ascii"), True),
            (f"160000 commit {oid}\tplugins/submodule\0".encode("ascii"), True),
            (f"040000 tree {oid} -\tplugins/nested\0".encode("ascii"), True),
            (f"100644 blob {oid} -1\tplugins/alpha/plugin.json\0".encode("ascii"), True),
            (f"100644 blob {oid} {1 << 63}\tplugins/alpha/plugin.json\0".encode("ascii"), True),
            (f"160000 commit {oid} 123\tplugins/submodule\0".encode("ascii"), True),
            (f"100644 blob {oid} 1\tplugins/alpha/plugin.json\0".encode("ascii"), False),
        )
        for record, long_listing in malformed:
            with self.subTest(record=record, long_listing=long_listing):
                with self.assertRaises(COHORT.CohortError):
                    COHORT._records(record, long_listing=long_listing)

    def test_git_subprocess_streams_close_on_success_and_bounded_failure(self) -> None:
        stdout = mock.Mock()
        stdout.read.side_effect = [b"{}", b""]
        stdin = mock.Mock()
        process = mock.Mock(stdin=stdin, stdout=stdout)
        process.poll.return_value = 0
        process.wait.return_value = 0
        with mock.patch.object(GIT_TREE.subprocess, "Popen", return_value=process):
            self.assertEqual(GIT_TREE.git_bytes(self.root, ("cat-file", "--batch"), input_data=b"abc"), b"{}")
        stdin.close.assert_called()
        stdout.close.assert_called_once()
        process.kill.assert_not_called()

        limited_stdout = mock.Mock()
        limited_stdout.read.return_value = b"too much"
        limited_process = mock.Mock(stdin=None, stdout=limited_stdout)
        limited_process.poll.return_value = None
        limited_process.wait.return_value = -9
        with mock.patch.object(GIT_TREE.subprocess, "Popen", return_value=limited_process):
            with self.assertRaises(COHORT.CohortError):
                GIT_TREE.git_bytes(self.root, ("ls-tree", "-z"), limit=1)
        limited_process.kill.assert_called_once()
        limited_process.wait.assert_called()
        limited_stdout.close.assert_called_once()

        rejected_stdin = mock.Mock()
        rejected_stdin.write.side_effect = BrokenPipeError
        rejected_stdout = mock.Mock()
        rejected_process = mock.Mock(stdin=rejected_stdin, stdout=rejected_stdout)
        rejected_process.poll.return_value = None
        with mock.patch.object(GIT_TREE.subprocess, "Popen", return_value=rejected_process):
            with self.assertRaises(COHORT.CohortError):
                GIT_TREE.git_bytes(self.root, ("cat-file", "--batch"), input_data=b"request")
        rejected_process.kill.assert_called_once()
        rejected_process.wait.assert_called()
        rejected_stdin.close.assert_called_once()
        rejected_stdout.close.assert_called_once()

    def test_output_is_fresh_and_outside_repository(self) -> None:
        with self.assertRaises(ValueError):
            FILESYSTEM.write_fresh_output(self.root / "generated", self.root, "ledger.json", b"{}\n")
        existing = self.temp_root / "already-there"
        existing.mkdir()
        with self.assertRaises(FILESYSTEM.FilesystemBoundaryError):
            FILESYSTEM.write_fresh_output(existing, self.root, "ledger.json", b"{}\n")
        if not DESCRIPTOR_IO_AVAILABLE:
            with self.assertRaises(FILESYSTEM.FilesystemBoundaryError) as failure:
                FILESYSTEM.write_fresh_output(self.temp_root / "fresh", self.root,
                                              "ledger.json", b"{}\n")
            self.assertEqual(str(failure.exception), "descriptor_io_unsupported")
            return
        new_output_directory = FILESYSTEM.write_fresh_output(
            self.temp_root / "fresh", self.root, "ledger.json", b"{}\n")
        self.assertEqual((new_output_directory / "ledger.json").read_bytes(), b"{}\n")
        self.assertEqual(new_output_directory.stat().st_mode & 0o777, 0o700)
        nested_output = self.temp_root / "new-parent" / "nested" / "fresh"
        nested_directory = FILESYSTEM.write_fresh_output(nested_output, self.root, "ledger.json", b"[]\n")
        self.assertEqual((nested_directory / "ledger.json").read_bytes(), b"[]\n")

    @unittest.skipUnless(DESCRIPTOR_IO_AVAILABLE, "descriptor-relative no-follow I/O unavailable")
    def test_manifest_swap_to_symlink_is_rejected_before_read(self) -> None:
        manifest = self.root / "plugins/alpha/plugin.json"
        outside = self.temp_root / "outside.json"
        outside.write_text('{"name":"LEAK!","version":"1"}', encoding="utf-8")
        self.assertEqual(outside.stat().st_size, manifest.stat().st_size)
        saved = manifest.with_name("plugin.json.saved")
        real_open = FILESYSTEM.os.open
        supported_dir_fd_ops = FILESYSTEM.os.supports_dir_fd
        reads: list[int] = []
        real_read = FILESYSTEM.os.read
        changed = False

        def replace_before_open(path: str, flags: int, *args: object, **kwargs: object) -> int:
            nonlocal changed
            if path == "plugin.json" and kwargs.get("dir_fd") is not None and not changed:
                os.replace(manifest, saved)
                manifest.symlink_to(outside)
                changed = True
            return real_open(path, flags, *args, **kwargs)

        def count_reads(fd: int, size: int) -> bytes:
            reads.append(fd)
            return real_read(fd, size)

        try:
            with mock.patch.object(FILESYSTEM.os, "open", side_effect=replace_before_open) as patched_open, \
                    mock.patch.object(FILESYSTEM.os, "supports_dir_fd",
                                      supported_dir_fd_ops | {patched_open}), \
                    mock.patch.object(FILESYSTEM.os, "read", side_effect=count_reads):
                result = FILESYSTEM.read_worktree_manifest(self.root, "plugins/alpha/plugin.json")
            self.assertTrue(changed)
            self.assertIn(result["state"], {"symlink", "changed_during_read"})
            self.assertEqual(reads, [])
            self.assertNotIn("LEAK!", repr(result))
        finally:
            if manifest.is_symlink():
                manifest.unlink()
            if saved.exists():
                os.replace(saved, manifest)

    @unittest.skipUnless(DESCRIPTOR_IO_AVAILABLE, "descriptor-relative no-follow I/O unavailable")
    def test_output_parent_swap_is_rejected_and_cleanup_stays_anchored(self) -> None:
        parent = self.temp_root / "output-parent"
        outside = self.temp_root / "outside-parent"
        moved = self.temp_root / "output-parent-moved"
        parent.mkdir()
        outside.mkdir()
        real_mkdir = FILESYSTEM.os.mkdir
        supported_dir_fd_ops = FILESYSTEM.os.supports_dir_fd
        replaced = False

        def replace_parent_at_create(name: str, mode: int = 0o777, *, dir_fd: int | None = None) -> None:
            nonlocal replaced
            if name == "fresh" and dir_fd is not None and not replaced:
                os.replace(parent, moved)
                parent.symlink_to(outside, target_is_directory=True)
                replaced = True
            real_mkdir(name, mode, dir_fd=dir_fd)

        try:
            with mock.patch.object(FILESYSTEM.os, "mkdir", side_effect=replace_parent_at_create) as patched_mkdir, \
                    mock.patch.object(FILESYSTEM.os, "supports_dir_fd",
                                      supported_dir_fd_ops | {patched_mkdir}):
                with self.assertRaises(FILESYSTEM.FilesystemBoundaryError):
                    FILESYSTEM.write_fresh_output(parent / "fresh", self.root, "ledger.json", b"{}\n")
            self.assertTrue(replaced)
            self.assertEqual(list(outside.iterdir()), [])
            self.assertEqual(list(moved.iterdir()), [])
        finally:
            if parent.is_symlink():
                parent.unlink()
            if moved.exists() and not parent.exists():
                os.replace(moved, parent)

    def test_executable_mode_drift_is_not_reported_as_head_match(self) -> None:
        target = self.root / "plugins/alpha/plugin.json"
        os.chmod(target, 0o755)
        ledger = COHORT.build_acceptance_ledger(self.root)
        alpha_root = next(row for row in ledger["cohort"]["plugins"] if row["directory"] == "alpha")
        root_manifest = next(row for row in alpha_root["manifests"] if row["class"] == "root")
        self.assertEqual(root_manifest["workingTree"]["sha256"], root_manifest["head"]["sha256"])
        self.assertFalse(root_manifest["workingTreeMatchesHead"])

    def test_identity_projection_rejects_unencodable_manifest_strings(self) -> None:
        projected = COHORT.manifest_projection(b'{"name":"\\ud800","version":"1"}')
        self.assertEqual(projected["state"], "valid_json_object")
        self.assertEqual(projected["declaredName"], {"state": "unsupported_or_over_limit"})


if __name__ == "__main__":
    unittest.main()
