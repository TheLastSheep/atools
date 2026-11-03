import importlib.util
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

SCRIPT = Path(__file__).with_name("inventory-ztools-ecosystem.py")
spec = importlib.util.spec_from_file_location("inventory_v3", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InventorySafetyTests(unittest.TestCase):
    def test_only_regular_files_inside_plugin_root_are_present(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "plugins"
            plugin = root / "sample"
            (plugin / "dist").mkdir(parents=True)
            entry = plugin / "dist" / "main.js"
            entry.write_text("ok")
            self.assertEqual(module.classify_main_entry_inside(plugin, root, "dist/main.js"), "present_regular_file")

    def test_absolute_traversal_drive_and_backslash_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "plugins"
            plugin = root / "sample"
            plugin.mkdir(parents=True)
            for value in ("/etc/passwd", "../outside", "dist/../../outside", "C:/outside.js", "\\\\server\\share", "dist\\main.js"):
                with self.subTest(value=value):
                    self.assertEqual(module.classify_main_entry_inside(plugin, root, value), "unsafe_path")

    def test_symlink_is_not_followed(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "plugins"
            plugin = root / "sample"
            plugin.mkdir(parents=True)
            outside = base / "outside"
            outside.mkdir()
            (outside / "main.js").write_text("external")
            (plugin / "linked").symlink_to(outside, target_is_directory=True)
            seen = []
            original_lstat = Path.lstat
            def recording_lstat(path, *args, **kwargs):
                seen.append(path)
                return original_lstat(path, *args, **kwargs)
            with patch.object(Path, "lstat", recording_lstat):
                self.assertEqual(module.classify_main_entry_inside(plugin, root, "linked/main.js"), "symlink_or_nonregular")
            self.assertNotIn(outside / "main.js", seen)


class SnapshotAndOutputTests(unittest.TestCase):
    def test_schema_names_structural_candidates_without_claiming_completeness(self):
        self.assertEqual(module.SCHEMA_VERSION, 3)
        self.assertEqual(module.UNTRACKED_LOCAL_ROWS_KEY, "untrackedLocalStructuralCandidates")
        self.assertNotIn("complete", module.UNTRACKED_LOCAL_ROWS_KEY.lower())

    def test_output_equal_or_inside_source_root_is_rejected_without_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "source"
            source.mkdir()
            marker = source / "tracked-like.txt"
            marker.write_text("unchanged")
            before = marker.read_bytes()
            inside = source / "inventory" / "run"
            for output in (source, inside):
                with self.subTest(output=output):
                    with self.assertRaises(ValueError):
                        module.prepare_fresh_output(output, source)
                    self.assertFalse(inside.exists())
                    self.assertFalse(inside.parent.exists())
                    self.assertEqual(marker.read_bytes(), before)

    def test_symlinked_output_parent_resolving_into_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "source"
            source.mkdir()
            alias = base / "outside-alias"
            alias.symlink_to(source, target_is_directory=True)
            output = alias / "new-inventory"
            with self.assertRaises(ValueError):
                module.prepare_fresh_output(output, source)
            self.assertFalse((source / "new-inventory").exists())
            self.assertFalse(output.exists())

    def test_external_fresh_output_is_created_and_existing_path_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "source"
            source.mkdir()
            output = base / "fresh-run"
            created = module.prepare_fresh_output(output, source)
            self.assertEqual(created, output.resolve())
            with self.assertRaises(FileExistsError):
                module.prepare_fresh_output(output, source)
            self.assertTrue(output.is_dir())

    def test_snapshot_requires_same_head_and_both_manifest_trees(self):
        same = ("head", "head", "tracked", "tracked", "local", "local")
        self.assertTrue(module.scan_snapshot_matches(*same))
        self.assertFalse(module.scan_snapshot_matches("head", "next", "tracked", "tracked", "local", "local"))
        self.assertFalse(module.scan_snapshot_matches("head", "head", "tracked", "changed", "local", "local"))
        self.assertFalse(module.scan_snapshot_matches("head", "head", "tracked", "tracked", "local", "changed"))

    def test_broken_output_symlink_is_also_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            output = parent / "reserved"
            source = parent / "source"
            source.mkdir()
            output.symlink_to(parent / "missing-target")
            with self.assertRaises(FileExistsError):
                module.prepare_fresh_output(output, source)


if __name__ == "__main__":
    unittest.main()
