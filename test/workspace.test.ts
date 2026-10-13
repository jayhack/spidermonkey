import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { digest, Workspace } from '../src/workspace.js';

async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), 'ros-workspace-test-'));
  const root = join(parent, 'workspace');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/index.ts'), 'export const value = 1;\n');
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root, workspace: new Workspace(root) };
}

test('workspace rejects escapes and credential paths, including symlink aliases', async t => {
  const { parent, root, workspace } = await fixture(t);
  await writeFile(join(parent, 'outside.ts'), 'outside workspace');
  await writeFile(join(root, '.env.local'), 'secret environment');
  await mkdir(join(root, '.aws'));
  await writeFile(join(root, '.aws/config.json'), '{"secret":true}');
  await symlink(join(parent, 'outside.ts'), join(root, 'outside-link.ts'));
  await symlink(join(root, '.env.local'), join(root, 'environment-link.ts'));
  await symlink(join(root, '.aws/config.json'), join(root, 'credentials-link.json'));

  assert.deepEqual(await workspace.list(), ['src/index.ts']);
  for (const path of [
    '../outside.ts', join(root, 'src/index.ts'), 'outside-link.ts',
    '.env.local', '.aws/config.json', 'environment-link.ts', 'credentials-link.json',
  ]) {
    await assert.rejects(workspace.read(path), /workspace|outside|escape|readable/i, path);
  }
  assert.equal((await workspace.read('src/index.ts')).content, 'export const value = 1;\n');
});

test('edits require a read and reject a file changed since that read', async t => {
  const { root, workspace } = await fixture(t);
  const path = 'src/index.ts';
  const diskPath = join(root, path);

  await assert.rejects(workspace.write(path, 'unseen edit'), /read.*before/i);
  const original = await workspace.read(path);
  assert.equal(original.hash, digest(original.content));
  await writeFile(diskPath, 'concurrent edit');
  await assert.rejects(workspace.write(path, 'stale overwrite'), /changed.*read/i);
  assert.equal(await readFile(diskPath, 'utf8'), 'concurrent edit');

  await workspace.read(path);
  const result = await workspace.write(path, 'fresh edit');
  assert.equal(result.written, true);
  assert.equal(result.hash, digest('fresh edit'));
  assert.equal(await readFile(diskPath, 'utf8'), 'fresh edit');
});

test('workspace read and write limits count bytes', async t => {
  const { root, workspace } = await fixture(t);
  await writeFile(join(root, 'large.ts'), 'a'.repeat(512_001));
  await assert.rejects(workspace.read('large.ts'), /512KB.*read|512KB read/i);

  await workspace.read('src/index.ts');
  // Multibyte characters fit a character limit, but exceed the byte limit.
  await assert.rejects(workspace.write('src/index.ts', 'é'.repeat(256_001)), /512KB.*write|512KB write/i);
  assert.equal(await readFile(join(root, 'src/index.ts'), 'utf8'), 'export const value = 1;\n');
});

test('workspace checks receive ordinary environment values without model or bridge credentials', async t => {
  const { root } = await fixture(t);
  const values = { ROS_TEST_SAFE: 'kept', ROS_TEST_API_KEY: 'model-secret', ROS_BRIDGE_TOKEN: 'bridge-secret' };
  for (const [key, value] of Object.entries(values)) {
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }
  const workspace = new Workspace(root,
    'test "$ROS_TEST_SAFE" = "kept" && test -z "$ROS_TEST_API_KEY" && test -z "$ROS_BRIDGE_TOKEN"');
  assert.deepEqual(await workspace.check(), { exitCode: 0, output: '' });
});
