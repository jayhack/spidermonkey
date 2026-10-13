"""Paired differences against a control profile across one or more runs with identical tasks.

Pairs are (run, task, repeat). Reports the mean difference with a bootstrap 95% interval and
wins/ties/losses, for executive steps, first-edit step, read_file calls, executive input tokens,
task seconds and solves.

    uv run --project evals python evals/paired_stats.py --control executive-only RUN [RUN ...]
"""
from __future__ import annotations

import argparse
import json
import random
import statistics
from pathlib import Path

from pairs import first_edit_step


def attempts(run: Path):
    for result in json.loads((run / "results.json").read_text()):
        directory = run / result["profile"] / str(result.get("repeat", 0)) / result["instance_id"]
        path = directory / "events.jsonl"
        events = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        metrics = result.get("metrics") or {}
        executive = metrics.get("executive", {})
        tools = metrics.get("tools") or []
        yield (str(run), result["instance_id"], result.get("repeat", 0)), result["profile"], {
            "steps": executive.get("steps"), "first edit step": first_edit_step(events), "read_file": tools.count("read_file"),
            "executive input tokens": executive.get("inputTokens"), "task sec": metrics.get("elapsedSeconds"), "solved": float(result["resolved"])}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--control", default="executive-only")
    parser.add_argument("runs", nargs="+", type=Path)
    args = parser.parse_args()
    table = {}
    for run in args.runs:
        for key, profile, values in attempts(run):
            table.setdefault(profile, {})[key] = values
    control = table[args.control]
    rng = random.Random(0)
    print(f"| Profile vs {args.control} | Metric | Pairs | Mean difference | Bootstrap 95% CI | Lower / equal / higher |")
    print("| --- | --- | --- | --- | --- | --- |")
    for profile, rows in table.items():
        if profile == args.control:
            continue
        for metric in ["steps", "first edit step", "read_file", "executive input tokens", "task sec", "solved"]:
            diffs = [rows[key][metric] - control[key][metric] for key in rows
                     if key in control and rows[key][metric] is not None and control[key][metric] is not None]
            if not diffs:
                continue
            means = sorted(statistics.mean(rng.choices(diffs, k=len(diffs))) for _ in range(4000))
            low, high = means[int(0.025 * len(means))], means[int(0.975 * len(means)) - 1]
            digits = 0 if metric == "executive input tokens" else 2
            print(f"| {profile} | {metric} | {len(diffs)} | {statistics.mean(diffs):+.{digits}f} | [{low:+.{digits}f}, {high:+.{digits}f}] | "
                  f"{sum(d < 0 for d in diffs)} / {sum(d == 0 for d in diffs)} / {sum(d > 0 for d in diffs)} |")


if __name__ == "__main__":
    main()
