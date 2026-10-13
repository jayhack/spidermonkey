#!/usr/bin/env node
// The package ships TypeScript source; tsx compiles it on load.
const [major] = process.versions.node.split('.').map(Number);
if (major < 24) {
  console.error(`spidermonkey needs Node 24 or newer (this is ${process.version}).`);
  process.exit(1);
}
const { register } = await import('tsx/esm/api');
register();
await import('../src/spidermonkey/bin.ts');
