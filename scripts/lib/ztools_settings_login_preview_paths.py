"""Fixed repository output-path validation for the synthetic login preview."""

from __future__ import annotations

import re
import stat
from pathlib import Path


OUTPUT_ROOT_NAME = "renderer-legacy-login-integration-2026-10-29"
RUN_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def _real_directory(path: Path) -> None:
    entry = path.lstat()
    if stat.S_ISLNK(entry.st_mode) or not stat.S_ISDIR(entry.st_mode) or path.resolve(strict=True) != path:
        raise RuntimeError("Preview output directory is not a real directory in the repository")


def validate_owned_preview_output(
    repository_root: Path,
    run_id: str,
    output_dir_value: object,
    bootstrap_path_value: object,
) -> Path:
    if not isinstance(run_id, str) or not RUN_ID_RE.fullmatch(run_id):
        raise RuntimeError("Preview run identifier is invalid")
    root = repository_root
    _real_directory(root)
    package_marker = root / "package.json"
    marker = package_marker.lstat()
    if stat.S_ISLNK(marker.st_mode) or not stat.S_ISREG(marker.st_mode) or package_marker.resolve(strict=True) != package_marker:
        raise RuntimeError("Preview repository marker is not a regular file")

    relative_dir = Path("output") / OUTPUT_ROOT_NAME / f"browser-{run_id}"
    relative_bootstrap = relative_dir / "bootstrap.js"
    if output_dir_value != relative_dir.as_posix() or bootstrap_path_value != relative_bootstrap.as_posix():
        raise RuntimeError("Node helper output paths differ from the fixed repository namespace")
    _real_directory(root / "output")
    _real_directory(root / "output" / OUTPUT_ROOT_NAME)
    _real_directory(root / relative_dir)

    bootstrap = root / relative_bootstrap
    entry = bootstrap.lstat()
    if stat.S_ISLNK(entry.st_mode) or not stat.S_ISREG(entry.st_mode) or bootstrap.resolve(strict=True) != bootstrap:
        raise RuntimeError("Node helper bootstrap is not a regular file in its owned run directory")
    return bootstrap


def validate_owned_preview_run_directory(
    repository_root: Path,
    run_id: str,
    output_dir_value: object,
    bootstrap_path_value: object,
) -> Path:
    return validate_owned_preview_output(
        repository_root, run_id, output_dir_value, bootstrap_path_value
    ).parent


def owned_bootstrap(repository_root: Path, ready: dict[str, object]) -> Path:
    return validate_owned_preview_output(
        repository_root,
        ready["runId"],
        ready.get("outputDir"),
        ready.get("bootstrapPath"),
    )


def owned_output_dir(repository_root: Path, ready: dict[str, object]) -> Path:
    return validate_owned_preview_run_directory(
        repository_root,
        ready["runId"],
        ready.get("outputDir"),
        ready.get("bootstrapPath"),
    )


def capture_owned_screenshot(page, repository_root: Path, ready: dict[str, object], filename: str) -> None:
    path = owned_output_dir(repository_root, ready) / filename
    page.screenshot(path=str(path), full_page=True, animations="disabled")
