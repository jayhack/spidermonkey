import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const demoTask = 'Fix the cart total so each item price is multiplied by its quantity. Run the tests to verify the fix.';
export const buggyCart = `export function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n`;

export async function createDemo() {
  const root = await mkdtemp(join(tmpdir(), 'ros-harness-demo-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2));
  await writeFile(join(root, 'src/cart.js'), buggyCart);
  await writeFile(join(root, 'cart.test.js'), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from './src/cart.js';\n\ntest('cart total includes quantities', () => {\n  assert.equal(total([{ price: 10, quantity: 3 }, { price: 5, quantity: 2 }]), 40);\n});\n\ntest('empty cart is zero', () => {\n  assert.equal(total([]), 0);\n});\n`);
  return root;
}
