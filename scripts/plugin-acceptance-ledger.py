#!/usr/bin/env python3
"""Generate a structural, all-unverified ledger for a fixed local ZTools Git HEAD."""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "lib"))
from ztools_plugin_cohort import CohortError, build_acceptance_ledger
from ztools_plugin_filesystem import write_fresh_output


def git_root(requested: pathlib.Path) -> pathlib.Path:
    root = requested.expanduser().resolve(strict=True)
    try:
        result = subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel"],
                                check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=10)
    except (OSError, subprocess.SubprocessError):
        raise CohortError("repository_root_unavailable") from None
    try:
        actual = pathlib.Path(result.stdout.decode("utf-8", errors="strict").strip()).resolve(strict=True)
    except (UnicodeDecodeError, OSError):
        raise CohortError("repository_root_invalid") from None
    if actual != root or not (root / ".git").exists():
        raise CohortError("repo_root_must_be_git_toplevel")
    return root


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True, type=pathlib.Path,
                        help="root of the local fixed-HEAD ZTools reference repository")
    parser.add_argument("--output", required=True, type=pathlib.Path,
                        help="new output directory outside the reference repository")
    args = parser.parse_args()
    try:
        root = git_root(args.repo_root)
        ledger = build_acceptance_ledger(root)
        payload = (json.dumps(ledger, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
        write_fresh_output(args.output, root, "plugin-acceptance-ledger-v1.json", payload)
    except (CohortError, OSError, ValueError, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, CohortError) else "output_or_repository_rejected"
        print(f"ledger generation failed: {code}", file=sys.stderr)
        return 2
    counts = ledger["cohort"]["counts"]
    print(f"Pinned {counts['fixedHeadPluginDirectories']} HEAD plugin directories; all acceptance states remain not_verified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
