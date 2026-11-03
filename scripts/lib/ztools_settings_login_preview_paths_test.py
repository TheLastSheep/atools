"""Regression tests for fixed, non-symlink preview output ownership."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from ztools_settings_login_preview_paths import (
    OUTPUT_ROOT_NAME,
    validate_owned_preview_output,
    validate_owned_preview_run_directory,
)


RUN_ID = "a" * 32


class PreviewPathsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="settings-preview-paths-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve() / "repo"
        self.root.mkdir()
        self.target, self.output_root, self.run_dir, self.bootstrap = self.make_fixture(self.root)

    @staticmethod
    def make_fixture(root: Path) -> tuple[Path, Path, Path, Path]:
        (root / "package.json").write_text("{}\n", encoding="utf-8")
        (root / "output").mkdir()
        target = root.parent / "outside"
        target.mkdir()
        output_root = root / "output" / OUTPUT_ROOT_NAME
        run_dir = output_root / f"browser-{RUN_ID}"
        run_dir.mkdir(parents=True)
        bootstrap = run_dir / "bootstrap.js"
        bootstrap.write_text("fixture", encoding="utf-8")
        return target, output_root, run_dir, bootstrap

    def arguments(self) -> tuple[Path, str, str, str]:
        return (
            self.root,
            RUN_ID,
            f"output/{OUTPUT_ROOT_NAME}/browser-{RUN_ID}",
            f"output/{OUTPUT_ROOT_NAME}/browser-{RUN_ID}/bootstrap.js",
        )

    def test_accepts_only_the_fixed_real_run_directory(self) -> None:
        root, run_id, output_dir, bootstrap_path = self.arguments()
        self.assertEqual(
            validate_owned_preview_output(root, run_id, output_dir, bootstrap_path),
            self.bootstrap,
        )
        self.assertEqual(
            validate_owned_preview_run_directory(root, run_id, output_dir, bootstrap_path),
            self.run_dir,
        )

    def test_rejects_each_symlinked_output_ancestor_without_target_writes(self) -> None:
        for location in ("output", "output-root", "run-directory"):
            with self.subTest(location=location):
                with tempfile.TemporaryDirectory(prefix="settings-preview-symlink-") as directory:
                    root = Path(directory).resolve() / "repo"
                    root.mkdir()
                    target, output_root, run_dir, _ = self.make_fixture(root)
                    output_dir = f"output/{OUTPUT_ROOT_NAME}/browser-{RUN_ID}"
                    bootstrap_path = f"{output_dir}/bootstrap.js"
                    if location == "output":
                        (root / "output").rename(root / "output-real")
                        (root / "output").symlink_to(root / "output-real", target_is_directory=True)
                    elif location == "output-root":
                        output_root.rename(root / "real-output-root")
                        output_root.symlink_to(root / "real-output-root", target_is_directory=True)
                    else:
                        run_dir.rename(root / "real-run-directory")
                        run_dir.symlink_to(root / "real-run-directory", target_is_directory=True)

                    with self.assertRaises(RuntimeError):
                        validate_owned_preview_output(root, RUN_ID, output_dir, bootstrap_path)
                    self.assertEqual(list(target.iterdir()), [])

    def test_rejects_resolved_aliases_and_unexpected_relative_paths(self) -> None:
        root, run_id, output_dir, bootstrap_path = self.arguments()
        with self.assertRaises(RuntimeError):
            validate_owned_preview_output(root, run_id, str(self.run_dir.resolve()), bootstrap_path)
        with self.assertRaises(RuntimeError):
            validate_owned_preview_output(root, run_id, output_dir, "output/other/bootstrap.js")


if __name__ == "__main__":
    unittest.main()
