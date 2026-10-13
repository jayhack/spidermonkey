"""Run the actual ROS controller + Eve executive in isolated SWE-bench images."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shlex
import statistics
import sys
import time
import uuid

import modal
from dotenv import dotenv_values
from swebench.harness.grading import get_eval_report
from swebench.harness.utils import load_swebench_dataset, make_test_spec

ROOT = Path(__file__).resolve().parents[1]
APP_NAME = "ros-harness-swebench"


def model_settings(suite):
    return {"executive": suite.get("executiveModel", "openai/gpt-6-luna"),
            "system1": suite.get("system1Model", "typesafe-ai/jev"),
            "reasoning": suite.get("reasoning", "provider-default")}


def comparable_suite(suite):
    models = model_settings(suite)
    return {**suite, "executiveModel": models["executive"], "system1Model": models["system1"]}


def trial_schedule(profiles, tasks, repeats, interleave=False):
    if interleave:
        for repeat in range(repeats):
            order = profiles if repeat % 2 == 0 else list(reversed(profiles))
            for task in tasks:
                for profile in order:
                    yield profile, repeat, task
    else:
        for profile in profiles:
            for repeat in range(repeats):
                for task in tasks:
                    yield profile, repeat, task


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def snapshot(destination: Path):
    """Explicit allowlist: no credentials, git data, results or runtime state."""
    paths = [ROOT / name for name in ["package.json", "pnpm-lock.yaml", "tsconfig.json"]]
    for directory in ["src", "agent"]:
        paths += sorted(path for path in (ROOT / directory).rglob("*") if path.is_file()
                        and path.suffix in {".ts", ".md"})
    paths += [ROOT / "evals/run-task.ts"]
    digest = hashlib.sha256()
    for path in paths:
        relative = path.relative_to(ROOT)
        data = path.read_bytes()
        digest.update(str(relative).encode() + b"\0" + data)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return digest.hexdigest()


def quick(sandbox, command, workdir=None):
    """A short exec; long-lived exec streams are unreliable, short ones are not."""
    process = sandbox.exec("bash", "-c", command, workdir=workdir, timeout=60)
    output = process.stdout.read()
    process.wait()
    return output


def execute(sandbox, args, *, timeout=300, workdir=None, env=None, stream=False):
    """Run a command detached inside the sandbox and poll it with short execs.

    Holding one exec stream open for a long command proved fragile (the client loses the
    container after ~10 s and can hang). The job writes its output and exit code to files;
    polling reads them, streams new output when asked, and enforces the timeout.
    """
    job = f"/tmp/ros-job-{uuid.uuid4().hex}"
    script = f"{' '.join(shlex.quote(arg) for arg in args)} > {job}.out 2> {job}.err < /dev/null; echo $? > {job}.rc"
    launcher = f"nohup setsid bash -c {shlex.quote(script)} > /dev/null 2>&1 < /dev/null & echo $!"
    process = sandbox.exec("bash", "-c", launcher, workdir=workdir, env=env, timeout=60)
    pid = process.stdout.read().strip()
    process.wait()
    deadline = time.monotonic() + timeout
    printed = 0
    code = None
    while code is None:
        rc = quick(sandbox, f"cat {job}.rc 2>/dev/null || true").strip()
        if stream:
            new = quick(sandbox, f"tail -c +{printed + 1} {job}.out 2>/dev/null || true")
            printed += len(new.encode())
            for line in new.splitlines():
                print(line.rstrip()[:240], flush=True)
        if rc:
            code = int(rc)
        elif time.monotonic() > deadline:
            quick(sandbox, f"kill -9 -{pid} 2>/dev/null; kill -9 {pid} 2>/dev/null; true")
            code = 124
        else:
            time.sleep(2)
    output = quick(sandbox, f"cat {job}.out 2>/dev/null; cat {job}.err 2>/dev/null")
    return code, output


def terminate(sandbox):
    # Teardown failures (e.g. transient Modal API errors) must not abort an experiment.
    try:
        sandbox.terminate()
    except Exception as error:
        print(f"Sandbox teardown failed ({type(error).__name__}): {error}", flush=True)


def put(sandbox, path, content):
    sandbox.filesystem.write_text(content, path)


def get(sandbox, path):
    return sandbox.filesystem.read_text(path)


def coding_image(row, source):
    # The benchmark image supplies the exact repository and Python dependencies.
    image = (modal.Image.from_registry(row["image"])
             .run_commands(
                 "curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz "
                 "| tar -xJ --strip-components=1 -C /usr/local",
                 "npm install -g pnpm@10.28.1")
             .add_local_file(source / "package.json", "/opt/ros/package.json", copy=True)
             .add_local_file(source / "pnpm-lock.yaml", "/opt/ros/pnpm-lock.yaml", copy=True)
             .run_commands("cd /opt/ros && pnpm install --frozen-lockfile")
             .add_local_dir(source, "/opt/ros", copy=True)
             .workdir("/opt/ros"))
    return image


def grade(app, row, patch, directory, timeout, model_name="gold-calibration"):
    """Fresh sandbox, no keys/harness; only submitted patch and official eval script."""
    directory.mkdir(parents=True, exist_ok=True)
    spec = make_test_spec(row)
    sandbox = modal.Sandbox.create(app=app, image=modal.Image.from_registry(row["image"]),
                                  cpu=2, memory=4096, timeout=timeout + 120)
    try:
        put(sandbox, "/tmp/model.patch", patch)
        code, output = execute(sandbox, ["git", "reset", "--hard", row["base_commit"]], workdir="/testbed")
        if code:
            raise RuntimeError(f"Could not reset grader to base commit: {output[:200]}")
        code, output = execute(sandbox, ["git", "apply", "--check", "/tmp/model.patch"], workdir="/testbed")
        if code:
            return {"resolved": False, "status": "patch_rejected", "output": output}
        code, output = execute(sandbox, ["git", "apply", "/tmp/model.patch"], workdir="/testbed")
        if code:
            return {"resolved": False, "status": "patch_rejected", "output": output}
        put(sandbox, "/tmp/grade.sh", spec.eval_script)
        code, output = execute(sandbox, ["bash", "/tmp/grade.sh"], timeout=timeout, workdir="/testbed")
        log = directory / "test_output.txt"
        log.write_text(output)
        if ">>>>> Start Test Output" not in output or ">>>>> End Test Output" not in output:
            raise RuntimeError(f"Official test suite did not complete (exit {code}); inspect test_output.txt")
        prediction = {"instance_id": row["instance_id"], "model_patch": patch, "model_name_or_path": model_name}
        report = get_eval_report(spec, prediction, str(log), include_tests_status=True)
        write_json(directory / "grade.json", report)
        detail = report[row["instance_id"]]
        if detail.get("infra_failure"):
            raise RuntimeError("Official grader reports an infrastructure failure; inspect grade.json")
        return {"resolved": bool(detail["resolved"]), "status": "graded", "exitCode": code, "report": detail}
    finally:
        terminate(sandbox)


def calibrate(app, rows, run, timeout):
    reports = {}
    for row in rows:
        task = row["instance_id"]
        cache = ROOT / ".ros/evals/calibration-cache" / (fingerprint(row) + ".json")
        if cache.exists() and time.time() - cache.stat().st_mtime < 24 * 3600:
            reports[task] = json.loads(cache.read_text())
        else:
            try:
                reports[task] = grade(app, row, row["patch"], run / "calibration" / task, timeout)
            except Exception as error:
                reports[task] = {"resolved": False, "status": "infrastructure_error", "error": str(error)}
            if reports[task]["resolved"]:
                write_json(cache, reports[task])
        print(f'Calibration {task}: resolved={reports[task]["resolved"]}', flush=True)
    write_json(run / "calibration.json", reports)
    return all(report["resolved"] for report in reports.values())


def trial(app, row, profile, tuning, suite, source, directory, secret):
    directory.mkdir(parents=True, exist_ok=True)
    result = {"instance_id": row["instance_id"], "profile": profile, "resolved": False,
              "status": "infrastructure_error", "metrics": None, "grade": None}
    sandbox = None
    start = time.monotonic()
    sandbox_started = None
    models = model_settings(suite)
    try:
        sandbox = modal.Sandbox.create(app=app, image=coding_image(row, source),
            cpu=2, memory=4096, timeout=suite["timeoutSeconds"] + 180,
            secrets=[secret], env={"ROS_EXECUTIVE_MODEL": models["executive"],
                                  "ROS_SYSTEM1_MODEL": models["system1"], "EVE_TELEMETRY_DISABLED": "1",
                                  "ROS_EXECUTIVE_REASONING": models["reasoning"]})
        result["sandboxId"] = sandbox.object_id
        print(f'Coding sandbox: {sandbox.object_id}', flush=True)
        sandbox_started = time.monotonic()
        result["provisioningSeconds"] = sandbox_started - start
        code, output = execute(sandbox, ["git", "reset", "--hard", row["base_commit"]], workdir="/testbed")
        if code:
            raise RuntimeError(f"Could not reset coder to base commit: {output[:200]}")
        # Check the public image really contains the expected initial source.
        code, output = execute(sandbox, ["git", "rev-parse", "HEAD"], workdir="/testbed")
        if code or output.strip() != row["base_commit"]:
            raise RuntimeError(f"Benchmark image HEAD differs from base_commit: {output[:200]}")
        request = {"task": row["problem_statement"], "workspace": "/testbed", "output": "/opt/ros/.ros/eval",
                   "check": "bash -lc " + shlex.quote(suite.get("instanceChecks", {}).get(row["instance_id"]) or suite["checks"][row["repo"]]),
                   "tuning": tuning, "timeoutSeconds": suite["timeoutSeconds"],
                   "maxSteps": suite["maxSteps"], "maxCostUsd": suite["maxCostUsd"]}
        put(sandbox, "/tmp/task.json", json.dumps(request))
        # Timer covers runtime boot separately; the metrics clock starts at the task.
        code, output = execute(sandbox, ["pnpm", "exec", "tsx", "evals/run-task.ts", "/tmp/task.json"],
                               timeout=suite["timeoutSeconds"] + 100, workdir="/opt/ros", stream=True)
        (directory / "harness.log").write_text(output)
        for name in ["metrics.json", "events.jsonl", "eve.log"]:
            content = get(sandbox, f"/opt/ros/.ros/eval/{name}")
            (directory / name).write_text(content)
        if tuning.get("enabled", True):
            try:
                (directory / "snapshots.jsonl").write_text(get(sandbox, "/opt/ros/.ros/eval/snapshots.jsonl"))
            except Exception:
                pass
        result["metrics"] = json.loads((directory / "metrics.json").read_text())
        result["status"] = result["metrics"]["status"]
        code, patch = execute(sandbox, ["git", "diff", "--binary", row["base_commit"]], workdir="/testbed")
        if code:
            raise RuntimeError("Could not collect model patch")
        (directory / "model.patch").write_text(patch)
    except Exception as error:
        result["error"] = str(error)
    finally:
        if sandbox is not None:
            terminate(sandbox)
        result["codingSandboxSeconds"] = time.monotonic() - sandbox_started if sandbox_started else 0
    if (directory / "model.patch").exists():
        patch = (directory / "model.patch").read_text()
        if patch.strip():
            start = time.monotonic()
            try:
                result["grade"] = grade(app, row, patch, directory, suite["gradeTimeoutSeconds"], models["executive"])
                result["resolved"] = result["grade"]["resolved"]
            except Exception as error:
                result["status"] = "infrastructure_error"
                result["gradingError"] = str(error)
            result["gradingSandboxSeconds"] = time.monotonic() - start
    rates = suite.get("sandboxPricing", {})
    if rates:
        # Requested resource wall time is an estimate, not Modal's metered bill.
        rate = 2 * rates["coreUsdPerSecond"] + 4 * rates["gibUsdPerSecond"]
        result["sandboxCostEstimateUsd"] = rate * (result["codingSandboxSeconds"] + result.get("gradingSandboxSeconds", 0))
    write_json(directory / "result.json", result)
    return result


def model_cost(result):
    metrics = result.get("metrics")
    if not metrics:
        return None
    costs = [metrics["executive"]["costUsd"], metrics["system1"]["costUsd"]]
    return sum(costs) if all(cost is not None for cost in costs) else None


def summarize(results, suite):
    solved = [result for result in results if result["resolved"]]
    costs = [model_cost(result) for result in results]
    total_cost = sum(costs) if all(cost is not None for cost in costs) else None
    sandbox_estimate = sum(result.get("sandboxCostEstimateUsd", 0) for result in results)
    score = sum((result["metrics"]["elapsedSeconds"] if result["resolved"] and result.get("metrics")
                 else suite["failurePenaltySeconds"]) for result in results) / max(1, len(results))
    if total_cost is not None:
        score += suite["costWeightSecondsPerDollar"] * total_cost / max(1, len(results))
    return {"attempts": len(results), "resolved": len(solved),
            "medianSolveSeconds": statistics.median([result["metrics"]["elapsedSeconds"] for result in solved]) if solved else None,
            "modelCostUsd": total_cost, "costPerSolveUsd": total_cost / len(solved) if solved and total_cost is not None else None,
            "sandboxCostEstimateUsd": sandbox_estimate,
            "score": score,
            "optimizationScore": score - suite["failurePenaltySeconds"] * (len(results) - len(solved)) / max(1, len(results)),
            "valid": all(result["status"] == "completed" and result.get("metrics")
                and not result["metrics"]["system1"]["errors"] for result in results)}


def choose(incumbent, candidate, suite, minimum_improvement=0.05):
    """Paired trials only. A candidate may not lose an incumbent's solved task."""
    keys = lambda rows: [(row["instance_id"], row.get("repeat", 0)) for row in rows]
    if keys(incumbent) != keys(candidate):
        return False, "unpaired task/repeat sets"
    old, new = summarize(incumbent, suite), summarize(candidate, suite)
    if not old["valid"] or not new["valid"]:
        return False, "incomplete trial or System 1 error; repair and rerun"
    if any(a["resolved"] and not b["resolved"] for a, b in zip(incumbent, candidate)):
        return False, "regresses a previously solved task"
    # Cost cannot silently disappear from the objective for a candidate.
    if old["modelCostUsd"] is None or new["modelCostUsd"] is None:
        return False, "incomplete cost coverage"
    # Equal failures contribute the same constant. Apply the percentage threshold
    # to the time/cost we can improve, so hard tasks don't hide real savings.
    improved = new["resolved"] > old["resolved"] or new["optimizationScore"] < old["optimizationScore"] * (1 - minimum_improvement)
    return improved, "more solves or lower penalized time + cost" if improved else "improvement below threshold"


def render_report(path, results, suite, decisions):
    lines = ["# ROS harness live SWE-bench experiment", "", "Lower score is better. Failures incur a fixed penalty; cost includes both model lanes.",
             "Sandbox time is reported separately. Unknown provider cost is shown as unknown.", "",
             f'Executive: {model_settings(suite)["executive"]}; System 1: {model_settings(suite)["system1"]}; reasoning: {model_settings(suite)["reasoning"]}.', "",
             "| Profile | Solves | Median solve sec | Model $ | $ / solve | Score | Valid |",
             "| --- | --- | --- | --- | --- | --- | --- |"]
    for profile in dict.fromkeys(result["profile"] for result in results):
        summary = summarize([result for result in results if result["profile"] == profile], suite)
        fmt = lambda value: "unknown" if value is None else f"{value:.6f}"
        lines.append(f'| {profile} | {summary["resolved"]}/{summary["attempts"]} | {fmt(summary["medianSolveSeconds"])} | '
                     f'{fmt(summary["modelCostUsd"])} | {fmt(summary["costPerSolveUsd"])} | {summary["score"]:.2f} | {summary["valid"]} |')
    lines += ["", "## Inference usage", "", "| Profile | Executive input tokens | S1 input tokens | Executive steps | S1 calls / reflexes | Sandbox estimated $ |",
              "| --- | --- | --- | --- | --- | --- |"]
    for profile in dict.fromkeys(result["profile"] for result in results):
        rows = [result for result in results if result["profile"] == profile]
        total = lambda lane, field: sum((row.get("metrics") or {}).get(lane, {}).get(field, 0) for row in rows)
        lines.append(f'| {profile} | {total("executive", "inputTokens")} | {total("system1", "inputTokens")} | '
                     f'{total("executive", "steps")} | {total("system1", "calls")} / {total("system1", "reflexes")} | '
                     f'{sum(row.get("sandboxCostEstimateUsd", 0) for row in rows):.6f} |')
    write_json(path.parent / "summary.json", {profile: summarize([row for row in results if row["profile"] == profile], suite)
                                            for profile in dict.fromkeys(row["profile"] for row in results)})
    lines += ["", "## Cost breakdown per attempt", "", "| Profile | Executive $ | System 1 $ | Total model $ | Cached executive input |",
              "| --- | --- | --- | --- | --- |"]
    for profile in dict.fromkeys(result["profile"] for result in results):
        rows = [result for result in results if result["profile"] == profile]
        def average_cost(lane):
            costs = [(row.get("metrics") or {}).get(lane, {}).get("costUsd") for row in rows]
            return sum(costs) / len(rows) if all(cost is not None for cost in costs) else None
        executive_cost, system1_cost = average_cost("executive"), average_cost("system1")
        total_cost = executive_cost + system1_cost if executive_cost is not None and system1_cost is not None else None
        inputs = sum((row.get("metrics") or {}).get("executive", {}).get("inputTokens", 0) for row in rows)
        cached = sum((row.get("metrics") or {}).get("executive", {}).get("cacheReadTokens", 0) for row in rows)
        fmt = lambda value: "unknown" if value is None else f"{value:.6f}"
        hit_rate = f"{100 * cached / inputs:.1f}%" if inputs else "unknown"
        lines.append(f'| {profile} | {fmt(executive_cost)} | {fmt(system1_cost)} | {fmt(total_cost)} | {hit_rate} |')
    lines += ["", "## Selection", ""] + [f'- {decision}' for decision in decisions]
    lines += ["", "## Individual trials", "", "| Task | Profile | Solved | Status | Executive steps | S1 calls / reflexes | Coding sandbox sec |",
              "| --- | --- | --- | --- | --- | --- | --- |"]
    for result in results:
        metrics = result.get("metrics") or {}
        executive = metrics.get("executive", {})
        system1 = metrics.get("system1", {})
        lines.append(f'| {result["instance_id"]} | {result["profile"]} | {result["resolved"]} | {result["status"]} | '
                     f'{executive.get("steps", "?")} | {system1.get("calls", "?")} / {system1.get("reflexes", "?")} | '
                     f'{result.get("codingSandboxSeconds", 0):.1f} |')
    path.write_text("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", type=Path, default=ROOT / "evals/suite.json")
    parser.add_argument("--profiles", nargs="+", default=["executive-only", "focused-budgeted", "relevance"])
    parser.add_argument("--instances", nargs="+")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--holdout", action="store_true", help="Evaluate final winner on held-out tasks; never tune on them")
    parser.add_argument("--prepare-only", action="store_true", help="Build and inspect one benchmark sandbox without model calls")
    parser.add_argument("--calibrate", action="store_true", help="Check gold patches in isolated graders before spending on models")
    parser.add_argument("--secret", help="Existing Modal secret containing AI_GATEWAY_API_KEY")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--compare", type=Path, help="Compare code changes to an earlier experiment with identical tasks, suite, and models")
    parser.add_argument("--validate", type=Path, help="Run only held-out validation for a repeated winner, using unchanged source")
    parser.add_argument("--executive-model", help="Gateway model ID for the executive, such as openai/gpt-6-astra")
    parser.add_argument("--system1-model", help="Gateway evaluation model ID for perception, default typesafe-ai/jev")
    parser.add_argument("--interleave", action="store_true", help="Alternate profile order across repeats to reduce cache warmup and timing bias")
    parser.add_argument("--parallel", type=int, default=1, help="Concurrent trials; results keep schedule order")
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    suite = json.loads(args.suite.read_text())
    tasks = args.instances or suite["train"]
    validation = None
    if args.validate:
        if args.instances or args.compare or args.prepare_only or args.calibrate:
            parser.error("--validate cannot be combined with --instances, --compare, --prepare-only, or --calibrate")
        validation = json.loads((args.validate / "winner.json").read_text())
        if not validation.get("profile") or validation.get("provisional", True):
            parser.error("--validate requires a valid winner with at least three repeats")
        original = json.loads((args.validate / "manifest.json").read_text())
        suite, tasks = original["suite"], original["tasks"]
        for argument, key in [(args.executive_model, "executive"), (args.system1_model, "system1")]:
            if argument and argument != original["models"][key]:
                parser.error("--validate must use the same models as the training winner")
        suite = {**suite, "executiveModel": original["models"]["executive"], "system1Model": original["models"]["system1"]}
        args.profiles, args.repeats, args.holdout = [validation["profile"]], original["repeats"], True
    if args.executive_model:
        suite["executiveModel"] = args.executive_model
    if args.system1_model:
        suite["system1Model"] = args.system1_model
    if set(tasks) & set(suite["holdout"]):
        parser.error("--instances includes held-out tasks; use --holdout for the final winner")
    for path in [ROOT / ".env.local", ROOT / ".env"]:
        for name, value in dotenv_values(path).items():
            if value is not None:
                os.environ.setdefault(name, value)
    secret = None
    if not args.prepare_only and not args.calibrate:
        if args.secret:
            secret = modal.Secret.from_name(args.secret, required_keys=["AI_GATEWAY_API_KEY"])
        elif os.environ.get("AI_GATEWAY_API_KEY"):
            secret = modal.Secret.from_dict({"AI_GATEWAY_API_KEY": os.environ["AI_GATEWAY_API_KEY"]})
        else:
            parser.error("Add a funded AI_GATEWAY_API_KEY to .env.local, or pass --secret NAME. CLI login tokens are not copied.")
    run = args.output or ROOT / ".ros/evals" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    if run.exists():
        parser.error("--output must be a new directory; results are immutable")
    run.mkdir(parents=True)
    source = run / "source"
    source_hash = snapshot(source)
    if validation and source_hash != validation["sourceSha256"]:
        parser.error("--validate requires the exact source snapshot of the training winner; rerun training after code changes")
    runner_bytes = Path(__file__).read_bytes()
    (run / "runner.py").write_bytes(runner_bytes)
    dataset = load_swebench_dataset(suite["dataset"], suite["split"], tasks + (suite["holdout"] if args.holdout else []))
    by_id = {row["instance_id"]: row for row in dataset}
    profiles = {name: json.loads((ROOT / "evals/profiles" / f"{name}.json").read_text()) for name in args.profiles}
    if validation:
        profiles = {validation["profile"]: validation["tuning"]}
    previous = None
    if args.compare:
        previous_manifest = json.loads((args.compare / "manifest.json").read_text())
        if previous_manifest["tasks"] != tasks or comparable_suite(previous_manifest["suite"]) != comparable_suite(suite) or previous_manifest["models"] != model_settings(suite) or previous_manifest["repeats"] != args.repeats or previous_manifest["datasetSha256"] != fingerprint(dataset):
            parser.error("--compare requires identical tasks, suite, models, repeats, and dataset fingerprint")
        previous = json.loads((args.compare / "results.json").read_text())
    write_json(run / "manifest.json", {"sourceSha256": source_hash, "runnerSha256": hashlib.sha256(runner_bytes).hexdigest(), "datasetSha256": fingerprint(dataset),
        "instances": {row["instance_id"]: {"rowSha256": fingerprint(row), "image": row["image"], "baseCommit": row["base_commit"]} for row in dataset},
        "suite": suite, "tasks": tasks, "profiles": profiles, "repeats": args.repeats,
        "trialOrder": list(trial_schedule(args.profiles, tasks, args.repeats, args.interleave)), "parallel": args.parallel,
        "models": model_settings(suite),
        "versions": {"modal": "1.6.0", "swebench": "5.0.2", "node": "24.21.0"},
        "comparedTo": str(args.compare) if args.compare else None,
        "validationOf": str(args.validate) if args.validate else None})
    results, decisions = [], []
    print(f"Experiment: {run}", flush=True)
    with modal.enable_output():
        app = modal.App.lookup(APP_NAME, create_if_missing=True)
        if validation:
            if not calibrate(app, [by_id[task] for task in suite["holdout"]], run / "holdout", suite["gradeTimeoutSeconds"]):
                raise RuntimeError("Held-out environment calibration failed.")
            holdout = [trial(app, by_id[task], validation["profile"], validation["tuning"], suite, source,
                             run / "holdout" / task, secret) for task in suite["holdout"]]
            write_json(run / "holdout.json", holdout)
            render_report(run / "report.md", holdout, suite, [f'Validation only for {args.validate}; never used for tuning or promotion'])
            print(f"Report: {run / 'report.md'}", flush=True)
            return
        if args.calibrate:
            if not calibrate(app, [by_id[task] for task in tasks], run, suite["gradeTimeoutSeconds"]):
                sys.exit(1)
            return
        if args.prepare_only:
            row = by_id[tasks[0]]
            sandbox = modal.Sandbox.create(app=app, image=coding_image(row, source), cpu=2, memory=4096, timeout=180)
            try:
                code, output = execute(sandbox, ["bash", "-lc", "node --version && cd /opt/ros && pnpm typecheck && cd /testbed && git rev-parse HEAD"], timeout=120)
                print(output, flush=True)
                write_json(run / "prepare.json", {"exitCode": code, "output": output, "sandboxId": sandbox.object_id})
                if code:
                    raise RuntimeError("Sandbox preparation failed")
            finally:
                terminate(sandbox)
            return
        if not calibrate(app, [by_id[task] for task in tasks], run, suite["gradeTimeoutSeconds"]):
            raise RuntimeError("Suite calibration failed. Repair the environment or select calibrated tasks before tuning.")
        incumbent = args.profiles[0]
        schedule = list(trial_schedule(args.profiles, tasks, args.repeats, args.interleave))
        def run_one(item):
            profile, repeat, task = item
            print(f"Running {profile} / {task} / repeat {repeat + 1}", flush=True)
            try:
                result = trial(app, by_id[task], profile, profiles[profile], suite, source,
                               run / profile / str(repeat) / task, secret)
            except Exception as error:
                # One broken trial is recorded as invalid; it does not end the experiment.
                result = {"instance_id": task, "profile": profile, "resolved": False, "status": "infrastructure_error",
                          "metrics": None, "grade": None, "error": f"{type(error).__name__}: {error}"}
            result["repeat"] = repeat
            print(f'{task}: resolved={result["resolved"]} status={result["status"]}', flush=True)
            return item, result
        # Parallel trials keep results in schedule order so pairing is unchanged.
        finished = {}
        with ThreadPoolExecutor(max_workers=args.parallel) as pool:
            for item, result in pool.map(run_one, schedule):
                finished[item] = result
                results[:] = [finished[key] for key in schedule if key in finished]
                write_json(run / "results.json", results)
                render_report(run / "report.md", results, suite, decisions)
        for profile in args.profiles:
            if profile != incumbent:
                accepted, reason = choose([r for r in results if r["profile"] == incumbent],
                                          [r for r in results if r["profile"] == profile], suite)
                decisions.append(f'{profile}: {"accept" if accepted else "reject"} — {reason}')
                if accepted:
                    incumbent = profile
            if previous:
                old = [r for r in previous if r["profile"] == profile]
                if old:
                    accepted, reason = choose(old, [r for r in results if r["profile"] == profile], suite)
                    decisions.append(f'Code change for {profile}: {"accept" if accepted else "reject"} — {reason}')
            render_report(run / "report.md", results, suite, decisions)
        selected = summarize([r for r in results if r["profile"] == incumbent], suite)
        valid = selected["valid"] and selected["modelCostUsd"] is not None and selected["resolved"] > 0
        code_change_accepted = None
        if previous:
            old_winner = json.loads((args.compare / "winner.json").read_text()).get("profile")
            if old_winner:
                code_change_accepted, reason = choose([r for r in previous if r["profile"] == old_winner],
                    [r for r in results if r["profile"] == incumbent], suite)
                decisions.append(f'Combined source/policy against previous winner {old_winner}: {"accept" if code_change_accepted else "reject"} — {reason}')
                valid = valid and code_change_accepted
            else:
                decisions.append('Previous experiment has no valid winner; comparison cannot promote a code change')
                valid = False
        render_report(run / "report.md", results, suite, decisions)
        write_json(run / "winner.json", {"profile": incumbent if valid else None, "tuning": profiles[incumbent] if valid else None,
                   "sourceSha256": source_hash, "provisional": args.repeats < 3, "codeChangeAccepted": code_change_accepted, "decisions": decisions})
        if args.holdout and valid:
            if not calibrate(app, [by_id[task] for task in suite["holdout"]], run / "holdout", suite["gradeTimeoutSeconds"]):
                raise RuntimeError("Held-out environment calibration failed; no validation claim can be made.")
            holdout = []
            for task in suite["holdout"]:
                holdout.append(trial(app, by_id[task], incumbent, profiles[incumbent], suite, source,
                                     run / "holdout" / task, secret))
            write_json(run / "holdout.json", holdout)
        print(f"Report: {run / 'report.md'}", flush=True)
        if not valid:
            sys.exit(1)


if __name__ == "__main__":
    main()
