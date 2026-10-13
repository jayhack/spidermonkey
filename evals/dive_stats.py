"""Dive telemetry per profile: how often System 1 (or the lexical rule) followed, what it delivered,
and whether the executive later edited inside, or re-read, a delivered view.

    uv run --project evals python evals/dive_stats.py .ros/evals/RUN
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
import sys


def main():
    run = Path(sys.argv[1])
    results = json.loads((run / "results.json").read_text())
    stats = defaultdict(lambda: defaultdict(float))
    for result in results:
        directory = run / result["profile"] / str(result.get("repeat", 0)) / result["instance_id"]
        path = directory / "events.jsonl"
        if not path.exists():
            continue
        row = stats[result["profile"]]
        row["attempts"] += 1
        used = set()
        for line in path.read_text().splitlines():
            event = json.loads(line)
            data = event.get("data") or {}
            if event["lane"] != "system1":
                continue
            if event["kind"] == "dive" and data.get("mode") != "off":
                row["triggers"] += 1
                views = data.get("views") or []
                row["followed"] += bool(views)
                row["views"] += len(views)
                row["chars"] += data.get("chars") or 0
                row["hops"] += len(data.get("hops") or [])
                row["latency"] += (data.get("latencyMs") or 0) / 1000
                for view in views:
                    row[f"relation:{view['relation'].split(' ')[0]}"] += 1
            elif event["kind"] == "dive-used":
                used.add((data.get("path"), data.get("start")))
                row["edits inside a delivered view"] += 1
            elif event["kind"] == "dive-reread":
                row["re-reads of a delivered view"] += 1
        row["attempts with an edit inside a delivered view"] += bool(used)
    for profile, row in stats.items():
        attempts = row["attempts"] or 1
        print(f"## {profile} ({int(row['attempts'])} attempts)")
        print(f"- dive triggers per attempt: {row['triggers'] / attempts:.2f}; followed {row['followed'] / max(1, row['triggers']):.0%} of triggers")
        print(f"- views delivered per attempt: {row['views'] / attempts:.2f}; chars per attempt: {row['chars'] / attempts:.0f}; hops per attempt: {row['hops'] / attempts:.2f}")
        print(f"- dive latency per attempt: {row['latency'] / attempts:.2f} s")
        print(f"- attempts with an edit inside a delivered view: {int(row['attempts with an edit inside a delivered view'])}/{int(row['attempts'])}")
        print(f"- edits inside a delivered view: {int(row['edits inside a delivered view'])}; re-reads of a delivered view: {int(row['re-reads of a delivered view'])}")
        relations = {key.split(':', 1)[1]: int(value) for key, value in row.items() if key.startswith('relation:')}
        print(f"- delivered view relations (first word): {dict(sorted(relations.items(), key=lambda item: -item[1]))}")
        print()


if __name__ == "__main__":
    main()
