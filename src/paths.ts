import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The installed package (or the repository checkout), independent of the working directory. */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Per-user state for the installed CLI: credentials, runs, staged agents. */
export const stateHome = process.env.SPIDERMONKEY_HOME || join(homedir(), '.spidermonkey');
export const credentialsPath = join(stateHome, 'credentials.env');

export const eveBin = () => join(dirname(fileURLToPath(import.meta.resolve('eve/package.json'))), 'bin', 'eve.js');

/** The nearest node_modules above the package that holds `eve` (its own, or a hoisted one). */
function dependencies() {
  for (let directory = packageRoot; ; directory = dirname(directory)) {
    const modules = directory.endsWith('/node_modules') ? directory : join(directory, 'node_modules');
    if (existsSync(join(modules, 'eve', 'package.json'))) return modules;
    if (dirname(directory) === directory) throw new Error('Could not find the installed eve package');
  }
}

/** Running from a repository checkout rather than an installed package. */
export const isCheckout = () => !packageRoot.split(/[\\/]/).includes('node_modules');

/** A short stable directory name for a workspace path. */
export const workspaceKey = (root: string) => createHash('sha256').update(root).digest('hex').slice(0, 12);

/**
 * `eve dev` writes `.eve/` into the agent project, and the install directory may be read-only.
 * Copy the authored agent into the state home once per version, and link it to the
 * dependencies that were installed alongside this package.
 */
export async function stageAgent(name: string): Promise<string> {
  const source = join(packageRoot, 'fixtures', name);
  if (isCheckout()) return source;
  const { version } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { version: string };
  const target = join(stateHome, 'agents', `${name}-${version}`);
  const marker = join(target, '.staged');
  if (existsSync(marker)) return target;
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(join(source, 'agent'), join(target, 'agent'), { recursive: true });
  await cp(join(source, 'package.json'), join(target, 'package.json'));
  await symlink(dependencies(), join(target, 'node_modules'), 'dir');
  await writeFile(marker, new Date().toISOString());
  return target;
}
