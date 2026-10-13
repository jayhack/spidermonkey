"""Materialize SWE-bench Lite repositories for the offline System 1 localization benchmark.

Only the localization scorer reads gold hunks. The localizer receives the issue and the
checked-out repository, exactly like the coding harness, and never sees patches or tests.
Development and held-out end-to-end tasks are excluded so they stay unseen by this loop.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess

from swebench.harness.utils import load_swebench_dataset

ROOT = Path(__file__).resolve().parents[1]
QUOTAS = {"pytest-dev/pytest": 15, "psf/requests": 6, "pylint-dev/pylint": 6, "mwaskom/seaborn": 4,
          "pydata/xarray": 5, "astropy/astropy": 6, "sphinx-doc/sphinx": 5, "django/django": 8,
          "sympy/sympy": 6, "scikit-learn/scikit-learn": 5, "matplotlib/matplotlib": 5}


def hunks(patch: str):
    """Original-file line ranges touched by a unified diff."""
    result, path, current, number = [], None, None, 0
    for line in patch.splitlines():
        if line.startswith("--- "):
            path = line[6:] if line.startswith("--- a/") else None
            continue
        if line.startswith("+++ "):
            continue
        match = re.match(r"@@ -(\d+)(?:,(\d+))? \+", line)
        if match:
            if current:
                result.append(current)
            current, number = None, int(match[1])
            continue
        if not path:
            continue
        # Score only changed lines; an insertion is located at the next original line.
        if line.startswith("-") or line.startswith("+"):
            current = current or {"path": path, "start": number, "end": number}
            current["end"] = max(current["end"], number)
        if not line.startswith("+"):
            number += 1
    if current:
        result.append(current)
    return result


def checkout(row, directory: Path):
    target = directory / row["instance_id"]
    if (target / ".git").exists():
        return target
    target.mkdir(parents=True, exist_ok=True)
    run = lambda *args: subprocess.run(["git", *args], cwd=target, check=True, capture_output=True)
    run("init", "-q")
    run("fetch", "-q", "--depth", "1", f"https://github.com/{row['repo']}", row["base_commit"])
    run("checkout", "-q", "FETCH_HEAD")
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repos", type=Path, required=True, help="Directory for shallow checkouts (outside Git)")
    parser.add_argument("--output", type=Path, default=ROOT / ".ros/localization/instances.json")
    args = parser.parse_args()
    suite = json.loads((ROOT / "evals/suite.json").read_text())
    excluded = set(suite["train"]) | set(suite["holdout"])
    rows = load_swebench_dataset(suite["dataset"], suite["split"])
    chosen = []
    for repo, quota in QUOTAS.items():
        candidates = sorted((row for row in rows if row["repo"] == repo and row["instance_id"] not in excluded),
                            key=lambda row: hashlib.sha256(row["instance_id"].encode()).hexdigest())
        chosen += candidates[:quota]
    with ThreadPoolExecutor(max_workers=8) as pool:
        paths = list(pool.map(lambda row: checkout(row, args.repos), chosen))
    instances = []
    for row, path in zip(chosen, paths):
        # Stable split: tune the localizer on "tune", report it on "test".
        split = "tune" if int(hashlib.sha256(row["instance_id"].encode()).hexdigest(), 16) % 2 == 0 else "test"
        instances.append({"instance_id": row["instance_id"], "repo": row["repo"], "split": split,
                          "workspace": str(path), "task": row["problem_statement"],
                          "gold": hunks(row["patch"]), "tests": hunks(row["test_patch"])})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(instances, indent=2) + "\n")
    print(f"{len(instances)} instances -> {args.output}")


if __name__ == "__main__":
    main()
