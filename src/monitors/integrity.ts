import type { MonitorContext } from '../monitor.js';
import type { Observation } from '../perception.js';

// Change-integrity sensors: proprioception for edits. After every edit they compute
// ordinary-code facts about the executive's cumulative change relative to the
// workspace's committed base (HEAD):
//
//   static  newly introduced compile errors, undefined names, and same-scope
//           redefinitions in edited Python files (stdlib only, differential);
//   diff    existing test code rewritten, extended, or removed, skip markers added, top-level
//           definitions removed while still referenced, build/config files touched.
//
// Sensors never decide whether a fact matters. Each emits an Observation only when it
// has at least one concern; the shared System 1 appraisal decides salience, kind, and
// urgency. Everything here is read-only: `git diff`, `git show`, `git grep`, and a
// Python process that parses files without importing or executing them.

export interface Concern {
  /** Stable identity without line numbers, for novelty. */
  key: string;
  file: string;
  /** Short observed fact, e.g. "assertion changed in TestRoutes.expect_order". */
  label: string;
  /** Observed lines, bounded. */
  detail: string[];
}

export interface DiffLine { type: ' ' | '-' | '+'; text: string; oldLine: number; newLine: number }
export interface Hunk { oldStart: number; newStart: number; context: string; lines: DiffLine[] }
export interface FileDiff { path: string; added: number; removed: number; hunks: Hunk[]; created: boolean; deleted: boolean; binary: boolean }

/** Parse `git diff` unified output. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let oldLine = 0, newLine = 0;
  for (const line of text.split('\n')) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      file = { path: header[2]!, added: 0, removed: 0, hunks: [], created: false, deleted: false, binary: false };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) file.created = true;
      else if (line.startsWith('deleted file mode')) file.deleted = true;
      else if (line.startsWith('Binary files')) file.binary = true;
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = line.slice(4).replace(/^b\//, '');
    }
    const range = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
    if (range) {
      oldLine = Number(range[1]); newLine = Number(range[2]);
      hunk = { oldStart: oldLine, newStart: newLine, context: range[3] ?? '', lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const type = line[0];
    if (type === ' ') { hunk.lines.push({ type, text: line.slice(1), oldLine: oldLine++, newLine: newLine++ }); }
    else if (type === '-') { hunk.lines.push({ type, text: line.slice(1), oldLine: oldLine++, newLine }); file.removed++; }
    else if (type === '+') { hunk.lines.push({ type, text: line.slice(1), oldLine, newLine: newLine++ }); file.added++; }
  }
  return files;
}

export interface Block { removed: DiffLine[]; added: DiffLine[]; oldStart: number; newStart: number; previous?: DiffLine; next?: DiffLine }

/** Consecutive removed/added runs inside a hunk, with the unchanged lines around them. */
export function changeBlocks(hunk: Hunk) {
  const blocks: Block[] = [];
  let current: Block | undefined;
  let previous: DiffLine | undefined;
  for (const line of hunk.lines) {
    if (line.type === ' ') { if (current) current.next = line; current = undefined; previous = line; continue; }
    if (!current) { current = { removed: [], added: [], oldStart: line.oldLine, newStart: line.newLine, previous }; blocks.push(current); }
    (line.type === '-' ? current.removed : current.added).push(line);
  }
  return blocks;
}

const indentation = (text: string) => text.length - text.trimStart().length;

/**
 * Pure insertions into an existing body change that code as much as rewrites do (e.g. a
 * line that normalizes input before an unchanged assertion). New definitions do not.
 */
function insertedIntoExisting(block: Block) {
  if (block.removed.length || !block.previous?.text.trim()) return false;
  const first = block.added.find(line => line.text.trim());
  if (!first || definition.test(first.text) || first.text.trimStart().startsWith('@')) return false;
  return indentation(first.text) > 0 && indentation(block.previous.text) > 0;
}

/**
 * A skip marker only weakens existing tests when it decorates, or is inserted into,
 * code that existed before. Markers inside newly added tests (e.g. tests of skipping
 * itself) are not concerns.
 */
function skipsExisting(block: Block, index: number) {
  const marker = block.added[index]!;
  const after = block.added.slice(index + 1).filter(line => line.text.trim());
  const next = block.next;
  if (!next?.text.trim()) return false;
  if (marker.text.trimStart().startsWith('@')) {
    return after.every(line => line.text.trimStart().startsWith('@')) && (definition.test(next.text) || next.text.trimStart().startsWith('@'));
  }
  return !after.length && indentation(next.text) >= indentation(marker.text) && indentation(marker.text) > 0;
}

export const isTestPath = (path: string) =>
  /(^|\/)(tests?|testing|__tests__|spec)\//.test(path) || /(^|\/)(test_[^/]*|[^/]*_tests?)\.py$/.test(path)
  || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /_test\.go$/.test(path) || /(^|\/)conftest\.py$/.test(path);

const configPath = /(^|\/)(setup\.py|setup\.cfg|pyproject\.toml|tox\.ini|pytest\.ini|noxfile\.py|conftest\.py|MANIFEST\.in|Makefile|Dockerfile|requirements[^/]*\.txt|Pipfile(\.lock)?|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|\.github\/.+|\.gitlab-ci\.yml)$/;

// Assertion vocabulary across common test frameworks (pytest, unittest, pytester, Jest, Chai, Go).
const assertion = /(^|[^\w])(assert\w*|expect|fnmatch_lines|re_match_lines|no_fnmatch_line|assertoutcome|assert_outcomes|raises|warns|should|toBe\w*|toEqual|toMatch\w*|toThrow\w*|t\.(Error|Fatal)f?)\b/;
const skipMarker = /@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.(skip|xfail|importorskip)\(|@unittest\.(skip|expectedFailure)|\b(it|describe|test)\.(skip|only)\(|\bx(it|describe)\(|\bt\.Skip\(/;
const definition = /^(\s*)(?:async\s+)?(?:def|function)\s+([A-Za-z_]\w*)|^(\s*)class\s+([A-Za-z_]\w*)/;

const clip = (text: string, width = 160) => text.length > width ? `${text.slice(0, width - 1)}…` : text;
const same = (a: string[], b: string[]) => a.join('\n').replace(/\s+/g, '') === b.join('\n').replace(/\s+/g, '');

/** Enclosing definitions (Class.function) of a base-file line: each less indented than the last. */
export function enclosing(baseLines: string[] | undefined, line: number, fallback: string) {
  if (!baseLines) {
    const match = fallback.match(definition);
    return match ? match[2] ?? match[4]! : fallback.trim() || 'module level';
  }
  const names: string[] = [];
  const start = baseLines[line - 1] ?? '';
  const own = start.match(definition);
  // A change that starts at a definition belongs to it; otherwise to the definitions around it.
  if (own) names.push(own[2] ?? own[4]!);
  let indent = start.trim() ? indentation(start) : Infinity;
  for (let index = Math.min(line, baseLines.length) - 2; index >= 0 && indent > 0; index--) {
    const match = baseLines[index]!.match(definition);
    const depth = match ? (match[1] ?? match[3] ?? '').length : Infinity;
    if (match && depth < indent) { names.unshift(match[2] ?? match[4]!); indent = depth; }
  }
  return names.join('.') || 'module level';
}

/**
 * Facts about existing test code. New tests are not concerns; removed, rewritten, or
 * inserted lines inside existing tests are, because they encode behavior other code relies on.
 */
export function testConcerns(file: FileDiff, baseLines?: string[]): Concern[] {
  const concerns: Concern[] = [];
  const addedDefs = new Set(file.hunks.flatMap(hunk => hunk.lines.filter(line => line.type === '+').map(line => line.text.match(definition)).filter(Boolean).map(match => match![2] ?? match![4]!)));
  for (const hunk of file.hunks) {
    for (const block of changeBlocks(hunk)) {
      for (const [index, line] of block.added.entries()) {
        if (!skipMarker.test(line.text) || !skipsExisting(block, index)) continue;
        concerns.push({ key: `skip:${file.path}:${line.text.trim()}`, file: file.path, label: `skip or xfail marker added at line ${line.newLine}`, detail: [`+ ${clip(line.text.trim())}`] });
      }
      if (insertedIntoExisting(block)) {
        const where = enclosing(baseLines, block.previous!.oldLine, hunk.context);
        if (where !== 'module level') {
          concerns.push({ key: `test-changed:${file.path}:${where}:${block.added.map(line => `+${line.text.trim()}`).join('\n')}`, file: file.path,
            label: `lines inserted into existing test code in ${where} (after base line ${block.previous!.oldLine})`,
            detail: [...block.added.slice(0, 6).map(line => `+ ${clip(line.text.trim())}`), ...(block.added.length > 6 ? [`+ … ${block.added.length - 6} more added lines`] : [])] });
        }
      }
      if (!block.removed.length || same(block.removed.map(line => line.text), block.added.map(line => line.text))) continue;
      const where = enclosing(baseLines, block.oldStart, hunk.context);
      const removedTests = block.removed.map(line => line.text.match(definition)).filter(Boolean)
        .map(match => match![2] ?? match![4]!).filter(name => /^(test|Test)/.test(name) && !addedDefs.has(name));
      for (const name of removedTests) {
        concerns.push({ key: `test-removed:${file.path}:${name}`, file: file.path, label: `existing test ${name} removed`, detail: [] });
      }
      const removedAssertions = block.removed.filter(line => assertion.test(line.text)).length;
      const addedAssertions = block.added.filter(line => assertion.test(line.text)).length;
      const label = removedAssertions && addedAssertions ? 'existing assertion changed' : removedAssertions ? 'existing assertion removed' : 'existing test code changed';
      const detail = [...block.removed.slice(0, 6).map(line => `- ${clip(line.text.trim())}`), ...(block.removed.length > 6 ? [`- … ${block.removed.length - 6} more removed lines`] : []),
        ...block.added.slice(0, 6).map(line => `+ ${clip(line.text.trim())}`), ...(block.added.length > 6 ? [`+ … ${block.added.length - 6} more added lines`] : [])];
      concerns.push({ key: `test-changed:${file.path}:${where}:${[...block.removed, ...block.added].map(line => line.type + line.text.trim()).join('\n')}`,
        file: file.path, label: `${label} in ${where} (base line ${block.oldStart})`, detail });
    }
  }
  return concerns;
}

/** Top-level definitions a change removes without re-adding them anywhere in the change set. */
export function removedDefinitions(files: FileDiff[]) {
  const added = new Set<string>();
  const removed: Array<{ file: string; name: string; line: number; text: string }> = [];
  for (const file of files) for (const hunk of file.hunks) for (const line of hunk.lines) {
    const match = line.text.match(definition);
    if (!match || (match[1] ?? match[3] ?? '').length) continue;
    const name = match[2] ?? match[4]!;
    if (line.type === '+') added.add(name);
    if (line.type === '-' && name.length >= 4) removed.push({ file: file.path, name, line: line.oldLine, text: line.text.trim() });
  }
  return removed.filter(item => !added.has(item.name));
}

export function formatConcerns(concerns: Concern[]) {
  return concerns.map(concern => [`${concern.file}: ${concern.label}`, ...concern.detail.map(line => `    ${line}`)].join('\n')).join('\n');
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Diff-integrity sensor: one observation over the executive's cumulative change, or none. */
export async function observeDiff(context: MonitorContext, edited: string[], signal?: AbortSignal): Promise<Observation | undefined> {
  if (!edited.length) return undefined;
  const editRevision = context.editRevision();
  const paths = edited.map(shellQuote).join(' ');
  const diff = await context.run(`git diff --no-color --no-ext-diff --relative -U3 HEAD -- ${paths}`, { timeoutMs: 20_000, maxOutput: 1_000_000, signal });
  if (diff.exitCode !== 0) return undefined;
  const files = parseUnifiedDiff(diff.output).filter(file => !file.binary);
  if (!files.length) return undefined;
  // Base test files locate each change's enclosing test; the hunk header is the fallback.
  const bases = new Map<string, string[]>();
  for (const file of files.filter(item => isTestPath(item.path) && !item.created)) {
    const base = await context.run(`git show ${shellQuote(`HEAD:./${file.path}`)}`, { timeoutMs: 10_000, maxOutput: 2_000_000, signal });
    if (base.exitCode === 0) bases.set(file.path, base.output.split('\n'));
  }
  const references: Concern[] = [];
  for (const item of removedDefinitions(files)) {
    const grep = await context.run(`git grep -n -w -I -F -e ${shellQuote(item.name)} -- . ${shellQuote(`:!${item.file}`)} | head -n 4`, { timeoutMs: 10_000, signal });
    const lines = grep.output.split('\n').filter(line => line.trim());
    if (lines.length) references.push({ key: `removed-def:${item.file}:${item.name}`, file: item.file,
      label: `top-level definition ${item.name} removed (base line ${item.line}) but still referenced elsewhere`, detail: [`- ${clip(item.text)}`, ...lines.slice(0, 3).map(line => `ref ${clip(line, 140)}`)] });
  }
  return diffObservation(files, editRevision, path => bases.get(path), references);
}

/**
 * The diff observation for a change set, from ordinary facts only. `references` carries
 * facts that need the workspace (definitions still referenced elsewhere). Shared by the
 * live sensor and the offline appraisal benchmark so both see identical text.
 */
export function diffObservation(files: FileDiff[], editRevision: number, baseLines: (path: string) => string[] | undefined = () => undefined, references: Concern[] = []): Observation | undefined {
  const concerns: Concern[] = [...files.filter(item => isTestPath(item.path)).flatMap(file => testConcerns(file, baseLines(file.path))), ...references];
  for (const file of files.filter(item => configPath.test(item.path))) {
    concerns.push({ key: `config:${file.path}`, file: file.path, label: `build/config file changed (+${file.added} -${file.removed})`, detail: [] });
  }
  if (!concerns.length) return undefined;
  const summary = files.map(file => `${file.path} +${file.added} -${file.removed}${isTestPath(file.path) ? ' (test)' : ''}`).join(', ');
  const count = (prefix: string) => concerns.filter(concern => concern.key.startsWith(prefix)).length;
  return {
    stream: 'diff', source: 'sensor:diff', editRevision, about: 'self',
    content: `Cumulative change vs HEAD: ${summary}\nExisting code this change rewrites, extends, or removes (new tests and definitions are not listed):\n${formatConcerns(concerns)}`,
    facts: Object.fromEntries(Object.entries({
      files: files.length, testCodeChanges: count('test-changed:'), testsRemoved: count('test-removed:'), skipsAdded: count('skip:'),
      removedDefinitionsStillReferenced: count('removed-def:'), configFiles: count('config:'),
    }).filter(([key, value]) => key === 'files' || value)),
    paths: [...new Set(concerns.map(concern => concern.file))],
    noveltyKey: concerns.map(concern => concern.key).sort().join('\n'),
  };
}

// Stdlib-only differential static check. For each file: compile it, then find module-
// scope names that are read but never bound (symtable) and same-scope redefinitions.
// The same analysis runs on `git show HEAD:<file>`; only diagnostics absent from the
// base are reported, so pre-existing warnings and interpreter-version quirks cancel.
export const staticCheckScript = String.raw`
import ast, builtins, json, subprocess, symtable, sys
EXTRA = set("__file__ __name__ __doc__ __builtins__ __spec__ __loader__ __package__ __path__ __annotations__ __dict__ __module__ __qualname__ __class__ __debug__ WindowsError unicode basestring long xrange unichr raw_input reload file buffer cmp execfile intern apply coerce reduce".split())
KNOWN = set(dir(builtins)) | EXTRA
MARKERS = {"setter", "getter", "deleter", "overload", "register", "dispatch", "cached_property"}

def base_source(path):
    try:
        out = subprocess.run(["git", "show", "HEAD:./" + path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
        return out.stdout.decode("utf-8", "replace") if out.returncode == 0 else None
    except Exception:
        return None

def undefined(tree, source, path):
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and any(alias.name == "*" for alias in node.names):
            return set()
    top = symtable.symtable(source, path, "exec")
    bound = set(s.get_name() for s in top.get_symbols() if s.is_assigned() or s.is_imported() or s.is_namespace())
    def declared(table):
        for s in table.get_symbols():
            if s.is_declared_global() and (s.is_assigned() or s.is_imported() or s.is_namespace()):
                bound.add(s.get_name())
        for child in table.get_children():
            declared(child)
    declared(top)
    missing = set()
    def visit(table):
        for s in table.get_symbols():
            name = s.get_name()
            if not s.is_referenced() or name in bound or name in KNOWN:
                continue
            if table.get_type() == "module" or (s.is_global() and not s.is_local()):
                missing.add(name)
        for child in table.get_children():
            visit(child)
    visit(top)
    return missing

def redefinitions(tree):
    found = []
    def scan(body, scope):
        seen = {}
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names = set()
                for decorator in node.decorator_list:
                    for part in ast.walk(decorator):
                        if isinstance(part, ast.Name): names.add(part.id)
                        if isinstance(part, ast.Attribute): names.add(part.attr)
                if not names & MARKERS:
                    if node.name in seen:
                        found.append({"key": "redefinition:%s.%s" % (scope, node.name), "line": node.lineno,
                                      "message": "%s is defined again in %s (first definition at line %d is shadowed)" % (node.name, scope, seen[node.name])})
                    else:
                        seen[node.name] = node.lineno
                if isinstance(node, ast.ClassDef):
                    scan(node.body, node.name)
    scan(tree.body, "module")
    return found

def diagnostics(source, path):
    try:
        compile(source, path, "exec", dont_inherit=True)
    except SyntaxError as error:
        return [{"key": "syntax", "line": error.lineno, "message": "%s: %s" % (type(error).__name__, error.msg), "text": (error.text or "").strip()[:200]}]
    except (ValueError, TypeError) as error:
        return [{"key": "syntax", "line": None, "message": str(error)}]
    tree = ast.parse(source, path)
    found = []
    for name in sorted(undefined(tree, source, path)):
        lines = sorted(set(node.lineno for node in ast.walk(tree) if isinstance(node, ast.Name) and node.id == name))
        found.append({"key": "undefined:" + name, "line": lines[0] if lines else None, "lines": lines[:5], "message": "undefined name " + name})
    return found + redefinitions(tree)

report = {}
for path in sys.argv[1:]:
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            current = handle.read()
    except OSError:
        continue
    base = base_source(path)
    after = diagnostics(current, path)
    if base is None:
        new = [item for item in after if item["key"] == "syntax"]
    else:
        before = set(item["key"] for item in diagnostics(base, path))
        new = [item for item in after if item["key"] not in before]
    lines = current.split("\n")
    for item in new:
        if item.get("line") and not item.get("text") and 0 < item["line"] <= len(lines):
            item["text"] = lines[item["line"] - 1].strip()[:200]
    report[path] = {"new": new, "base": base is not None}
print(json.dumps(report))
`;

/** Static sensor: compile/undefined-name/redefinition diagnostics introduced by the change. */
export async function observeStatic(context: MonitorContext, edited: string[], python: string[], signal?: AbortSignal): Promise<Observation | undefined> {
  const files = edited.filter(path => path.endsWith('.py'));
  if (!files.length) return undefined;
  const editRevision = context.editRevision();
  const interpreters = python.map(shellQuote).join(' ');
  // First available interpreter; the project's own interpreter matches its syntax version.
  const command = `for PY in ${interpreters}; do command -v "$PY" >/dev/null 2>&1 && break; done; "$PY" - ${files.map(shellQuote).join(' ')} <<'ROS_STATIC_CHECK'\n${staticCheckScript}\nROS_STATIC_CHECK`;
  const result = await context.run(command, { timeoutMs: 30_000, maxOutput: 200_000, signal });
  if (result.exitCode !== 0) {
    context.emit('sensor', `static: checker unavailable (exit ${result.exitCode})`, { sensor: 'static', output: result.output.slice(-400) });
    return undefined;
  }
  let report: Record<string, { new: Array<{ key: string; line?: number | null; lines?: number[]; message: string; text?: string }> }>;
  try { report = JSON.parse(result.output.trim().split('\n').at(-1)!); } catch { return undefined; }
  const concerns: Concern[] = Object.entries(report).flatMap(([file, entry]) => entry.new.map(item => ({
    key: `static:${file}:${item.key}`, file,
    label: `${item.message}${item.line ? ` at line ${item.line}${item.lines && item.lines.length > 1 ? ` (also ${item.lines.slice(1).join(', ')})` : ''}` : ''}`,
    detail: item.text ? [`> ${clip(item.text)}`] : [],
  })));
  if (!concerns.length) return undefined;
  const count = (fragment: string) => concerns.filter(concern => concern.key.includes(fragment)).length;
  return {
    stream: 'static', source: 'sensor:static', editRevision,
    content: `Static check of edited Python files, compared with HEAD (only newly introduced problems):\n${formatConcerns(concerns)}`,
    facts: Object.fromEntries(Object.entries({ syntaxErrors: count(':syntax'), undefinedNames: count(':undefined:'), redefinitions: count(':redefinition:') }).filter(([, value]) => value)),
    paths: [...new Set(concerns.map(concern => concern.file))],
    noveltyKey: concerns.map(concern => concern.key).sort().join('\n'),
  };
}
