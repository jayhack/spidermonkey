"""Per-task paired summary of an experiment directory: solves, steps, first-edit step, cost, time,
official PASS_TO_PASS regressions (graded patches that broke previously passing tests), and
System 1 final-gate follow-up turns.

    uv run --project evals python evals/pairs.py .ros/evals/RUN
"""
from __future__ import annotations

import json
from pathlib import Path
import statistics
import sys


def first_edit_step(events):
    step = 0
    for event in events:
        if event["lane"] == "executive" and event["kind"] == "step":
            step += 1
        if event["lane"] == "executive" and event["kind"] == "tool" and event.get("data", {}).get("toolName") in ("replace_text", "write_file"):
            return step
    return None


def mean(values, digits=2):
    values = [value for value in values if value is not None]
    return f"{statistics.mean(values):.{digits}f}" if values else "-"


def pass_to_pass_failures(directory):
    """Previously passing tests the submitted patch broke, per the official grade (None if ungraded)."""
    grade = directory / "grade.json"
    if not grade.exists():
        return None
    report = next(iter(json.loads(grade.read_text()).values()))
    return len(report.get("tests_status", {}).get("PASS_TO_PASS", {}).get("failure", []))


def main():
    run = Path(sys.argv[1])
    results = json.loads((run / "results.json").read_text())
    rows = {}
    for result in results:
        directory = run / result["profile"] / str(result.get("repeat", 0)) / result["instance_id"]
        events = [json.loads(line) for line in (directory / "events.jsonl").read_text().splitlines()] if (directory / "events.jsonl").exists() else []
        metrics = result.get("metrics") or {}
        executive, system1 = metrics.get("executive", {}), metrics.get("system1", {})
        cost = None if executive.get("costUsd") is None or system1.get("costUsd") is None else executive["costUsd"] + system1["costUsd"]
        tools = metrics.get("tools") or []
        rows.setdefault((result["instance_id"], result["profile"]), []).append({
            "solved": result["resolved"], "steps": executive.get("steps"), "edit": first_edit_step(events),
            "cost": cost, "executiveCost": executive.get("costUsd"), "system1Cost": system1.get("costUsd"),
            "system1Calls": system1.get("calls"), "system1Seconds": (system1.get("latencyMs") or 0) / 1000,
            "inputTokens": executive.get("inputTokens"), "reads": tools.count("read_file"), "searches": tools.count("search"),
            "seconds": metrics.get("elapsedSeconds"), "status": result["status"],
            "p2p": pass_to_pass_failures(directory),
            "followUps": sum(1 for event in events if event["lane"] == "executive" and event["kind"] == "prompt" and event.get("data", {}).get("source"))})
    profiles = list(dict.fromkeys(profile for _, profile in rows))
    tasks = list(dict.fromkeys(task for task, _ in rows))
    fmt = lambda values, digits=3: "/".join("?" if value is None else f"{value:.{digits}f}" if isinstance(value, float) else str(value) for value in values)
    print("| Task | Profile | Solved | P2P broken | Steps | First edit step | Model $ | Task sec |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for task in tasks:
        for profile in profiles:
            items = rows.get((task, profile), [])
            print(f"| {task} | {profile} | {sum(item['solved'] for item in items)}/{len(items)} | {sum(bool(item['p2p']) for item in items)}/{len(items)} | {fmt([item['steps'] for item in items])} | "
                  f"{fmt([item['edit'] for item in items])} | {fmt([item['cost'] for item in items])} | {fmt([item['seconds'] for item in items], 1)} |")
    print()
    print("| Profile | Solves | P2P broken | Follow-ups | Mean steps | Mean first edit step (no edit) | Mean model $ | Median task sec | Mean task sec |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for profile in profiles:
        items = [item for (task, name), values in rows.items() if name == profile for item in values]
        costs = [item["cost"] for item in items]
        seconds = [item["seconds"] for item in items if item["seconds"] is not None]
        print(f"| {profile} | {sum(item['solved'] for item in items)}/{len(items)} | {sum(bool(item['p2p']) for item in items)}/{len(items)} | "
              f"{sum(item['followUps'] for item in items)} | {statistics.mean(item['steps'] or 0 for item in items):.2f} | "
              f"{mean([item['edit'] for item in items])} ({sum(item['edit'] is None for item in items)}) | "
              f"{'unknown' if None in costs else f'{statistics.mean(costs):.4f}'} | {statistics.median(seconds):.1f} | {statistics.mean(seconds):.1f} |")
    print()
    print("| Profile | Executive $ | System 1 $ | System 1 calls | System 1 sec | Executive input tokens | read_file | search |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for profile in profiles:
        items = [item for (task, name), values in rows.items() if name == profile for item in values]
        print(f"| {profile} | {mean([item['executiveCost'] for item in items], 4)} | {mean([item['system1Cost'] for item in items], 4)} | "
              f"{mean([item['system1Calls'] for item in items], 1)} | {mean([item['system1Seconds'] for item in items], 1)} | "
              f"{mean([item['inputTokens'] for item in items], 0)} | {mean([item['reads'] for item in items])} | {mean([item['searches'] for item in items])} |")


if __name__ == "__main__":
    main()
