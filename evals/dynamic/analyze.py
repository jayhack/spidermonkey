"""Secondary analysis of dynamic-world runs (stdlib only).

    python3 evals/dynamic/analyze.py .ros/evals/dynamic-main-v1 [.ros/evals/dynamic-holdout-v1 ...]

Per arm and hazard family: solves, executive steps/tokens/cost, Jev calls/cost, wall time;
two-sided Fisher exact tests; arms compared on exactly the polling arm's tasks; every
final-gate follow-up classified as warranted (the hazard recurred after the executive's last
edit took effect) or spurious; and, for holdout-csv-locale, a clearly labeled post-hoc
re-grade that parses quoted CSV fields (RFC 4180) instead of splitting on commas.
"""
import csv, glob, io, json, os, re, sys
from datetime import datetime
from math import comb
from statistics import mean, median

TASKS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tasks')
ARMS = ['executive-only', 'polling', 'perception', 'deliver-all', 'deliver-none', 'rules']
FAMILY = {'escalate': 'escalate', 'interrupt': 'hang', 'no-interrupt': 'distractor', 'no-escalate': 'distractor'}
STAMP = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z')


def spec(task):
    return json.load(open(os.path.join(TASKS, task, 'task.json')))


def ts(text):
    return datetime.fromisoformat(text.replace('Z', '+00:00')).timestamp()


def fisher(a, n1, b, n2):
    k, n = a + b, n1 + n2
    p = lambda x: comb(n1, x) * comb(n2, k - x) / comb(n, k)
    observed = p(a)
    return min(1.0, sum(p(x) for x in range(max(0, k - n2), min(k, n1) + 1) if p(x) <= observed * (1 + 1e-9)))


def avg(values):
    values = [v for v in values if v is not None]
    return mean(values) if values else 0.0


def families(rows):
    print(f"{'arm':15} {'family':10} {'n':>3} {'solved':>7} {'steps':>6} {'in tok':>7} {'exec $':>9} {'jev $':>8} {'jev calls':>9} {'task s':>7}")
    for family in ['escalate', 'hang', 'distractor', 'all']:
        for arm in ARMS:
            rs = [r for r in rows if r['arm'] == arm and (family == 'all' or FAMILY[spec(r['task'])['hazard']] == family)]
            if rs:
                print(f"{arm:15} {family:10} {len(rs):3} {sum(r['success'] for r in rs):3}/{len(rs):<3} {avg(r['executiveSteps'] for r in rs):6.1f} "
                      f"{avg(r['executiveInputTokens'] for r in rs):7.0f} {avg(r['executiveCostUsd'] for r in rs):9.5f} {avg(r['jevCostUsd'] for r in rs):8.5f} "
                      f"{avg(r['jevCalls'] for r in rs):9.1f} {avg(r['elapsedSeconds'] for r in rs):7.1f}")
        print()
    unknown = [(r['task'], r['arm'], r['repeat']) for r in rows if r['executiveCostUsd'] is None or (r['arm'] == 'perception' and r['jevCostUsd'] is None)]
    if unknown:
        print('attempts with unknown cost (excluded from cost means):', unknown, '\n')


def tests(rows):
    solved = lambda arm, family: [r['success'] for r in rows if r['arm'] == arm and (family == 'all' or FAMILY[spec(r['task'])['hazard']] == family)]
    print('Fisher exact, two-sided:')
    for family in ['escalate', 'all']:
        for other in ['executive-only', 'polling', 'deliver-all', 'deliver-none', 'rules']:
            a, b = solved('perception', family), solved(other, family)
            if a and b:
                print(f'  {family:8} perception {sum(a)}/{len(a)} vs {other} {sum(b)}/{len(b)}: p={fisher(sum(a), len(a), sum(b), len(b)):.4f}')
    distract = lambda arm: [r['falseFollowUps'] + r['falseInterrupts'] > 0 for r in rows if r['arm'] == arm and FAMILY[spec(r['task'])['hazard']] == 'distractor']
    a, b = distract('perception'), distract('rules')
    if a and b:
        print(f'  distractor attempts with a false alarm: perception {sum(a)}/{len(a)} vs rules {sum(b)}/{len(b)}: p={fisher(sum(a), len(a), sum(b), len(b)):.4f}')
    print()


def paired(rows):
    tasks = {r['task'] for r in rows if r['arm'] == 'polling'}
    if not tasks:
        return
    print('On the polling arm\'s tasks only:', ', '.join(sorted(tasks)))
    for arm in ARMS:
        rs = [r for r in rows if r['arm'] == arm and r['task'] in tasks]
        total = avg(r['executiveCostUsd'] for r in rs) + avg(r['jevCostUsd'] for r in rs)
        print(f"  {arm:15} solved {sum(r['success'] for r in rs)}/{len(rs)}  steps {avg(r['executiveSteps'] for r in rs):.1f}  "
              f"in tok {avg(r['executiveInputTokens'] for r in rs):.0f}  total model $ {total:.5f}  task s {avg(r['elapsedSeconds'] for r in rs):.1f}")
    print()


def followups(run):
    counts = {}
    for path in sorted(glob.glob(os.path.join(run, '*', '*', 'r*', 'events.jsonl'))):
        task, arm, repeat = path.split(os.sep)[-4:-1]
        event = spec(task).get('event')
        events = [json.loads(line) for line in open(path)]
        edits = [ts(e['at']) for e in events if e['lane'] == 'environment' and e['kind'] == 'result'
                 and (e.get('data') or {}).get('toolName') in ('replace_text', 'write_file') and (e['data'].get('output') or {}).get('written')]
        for gate in [e for e in events if e['lane'] == 'executive' and e['kind'] == 'prompt' and (e.get('data') or {}).get('source') == 'system1-final-gate']:
            at = ts(gate['at'])
            since = max([t for t in edits if t < at], default=at - 8) + 2
            warranted = False
            world = os.path.join(os.path.dirname(path), 'world', event['file'].replace('/', '__')) if event else ''
            if event and os.path.exists(world):
                last = 0
                for line in open(world):
                    match = STAMP.search(line)
                    if match:
                        last = ts(match.group(0))
                    if since <= last <= at + 1 and re.search(event['pattern'], line) and not (event.get('exclude') and re.search(event['exclude'], line)):
                        warranted = True
            counts.setdefault(arm, [0, 0])[0 if warranted else 1] += 1
            if not warranted:
                print(f'  spurious follow-up: {task}/{arm}/{repeat}')
    for arm, (good, bad) in sorted(counts.items()):
        print(f'  {arm:15} follow-ups warranted {good}, spurious {bad}')
    print()


def csv_regrade(run):
    paths = sorted(glob.glob(os.path.join(run, 'holdout-csv-locale', '*', 'r*', 'grade.json')))
    if not paths:
        return
    expected = [1234.5, 7.25, 980, 15.75]
    def quantity(text):
        text = text.strip()
        if re.fullmatch(r'-?\d{1,3}(\.\d{3})*,\d+', text):
            return float(text.replace('.', '').replace(',', '.'))
        return float(text.replace(',', ''))
    table = {}
    for path in paths:
        arm = path.split(os.sep)[-3]
        grade = json.load(open(path))
        checks = {check['name']: check for check in grade['checks']}
        rows = json.loads(checks['CSV quantities are correct']['detail'])
        try:
            parsed = list(csv.reader(io.StringIO('\n'.join(','.join(row) for row in rows))))
            ok = len(parsed) == 4 and all(len(r) == 3 and abs(quantity(r[2]) - e) < 1e-6 for r, e in zip(parsed, expected))
        except ValueError:
            ok = False
        others = all(check['pass'] for name, check in checks.items() if name != 'CSV quantities are correct')
        entry = table.setdefault(arm, [0, 0, 0, 0])
        entry[0] += grade['pass']; entry[1] += checks['report exporter verifies its CSV']['pass']; entry[2] += bool(ok and others); entry[3] += 1
    print('holdout-csv-locale: pre-registered grade / exporter verifies its CSV (pre-registered check) / post-hoc RFC 4180 re-grade')
    for arm in ARMS:
        if arm in table:
            pre, verifies, post, n = table[arm]
            print(f'  {arm:15} {pre}/{n}  {verifies}/{n}  {post}/{n}')
    print()


for run in sys.argv[1:]:
    rows = [json.loads(line) for line in open(os.path.join(run, 'results.jsonl'))]
    print(f'=== {run} ({len(rows)} attempts)\n')
    families(rows)
    tests(rows)
    paired(rows)
    print('Final-gate follow-ups:')
    followups(run)
    csv_regrade(run)
