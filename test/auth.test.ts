import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import test, { type TestContext } from 'node:test';
import { authenticate, gatewayKeyUrl, loadModelEnvironment, saveGatewayKey } from '../src/auth.js';

function preserveEnvironment(t: TestContext) {
  const names = ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'EVE_MODEL_CONNECTION', 'EVE_MODEL_KEY_SOURCE', 'EVE_DEV', 'ROS_AUTH_TEST'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ros-auth-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('working authentication skips browser, prompt, and credential writes', async () => {
  const unexpected = async () => { assert.fail('Existing authentication must be reused'); };
  assert.equal(await authenticate({
    verify: async () => 0.9, openBrowser: unexpected, promptKey: unexpected, saveKey: unexpected,
    interactive: true, log: () => {},
  }), 0.9);
});

test('missing CLI auth opens the browser, switches to the pasted key, verifies, then saves', async t => {
  preserveEnvironment(t);
  process.env.EVE_MODEL_CONNECTION = 'vercel-cli';
  process.env.EVE_MODEL_KEY_SOURCE = 'secret';
  const actions: string[] = [];
  const messages: string[] = [];
  const probability = await authenticate({
    verify: async () => {
      actions.push('verify');
      if (actions.length === 1) throw new Error('Vercel CLI credentials are unavailable. Run /login.');
      assert.equal(process.env.AI_GATEWAY_API_KEY, 'test-gateway-key');
      assert.equal(process.env.EVE_MODEL_CONNECTION, undefined);
      assert.equal(process.env.EVE_MODEL_KEY_SOURCE, undefined);
      return 0.95;
    },
    openBrowser: async () => { actions.push('open'); },
    promptKey: async () => { actions.push('prompt'); return ' test-gateway-key '; },
    saveKey: async key => { actions.push('save'); assert.equal(key, 'test-gateway-key'); },
    interactive: true, log: message => messages.push(message),
  });
  assert.equal(probability, 0.95);
  assert.deepEqual(actions, ['verify', 'open', 'prompt', 'verify', 'save']);
  assert.ok(messages.some(message => message.includes(gatewayKeyUrl)));
  assert.ok(messages.every(message => !message.includes('test-gateway-key')));
});

test('wrapped expired authentication still offers setup if the browser cannot open', async t => {
  preserveEnvironment(t);
  let attempts = 0;
  const messages: string[] = [];
  assert.equal(await authenticate({
    verify: async () => {
      if (attempts++ === 0) throw new Error('Evaluation failed', { cause: Object.assign(new Error('Expired'), { statusCode: 401 }) });
      return 0.8;
    },
    openBrowser: async () => { throw new Error('Browser unavailable'); },
    promptKey: async () => 'replacement-key', saveKey: async () => {},
    interactive: true, log: message => messages.push(message),
  }), 0.8);
  assert.ok(messages.some(message => message.includes('Could not open')));
});

test('network and model errors do not trigger credential setup', async () => {
  for (const failure of [
    new Error('Request timed out'),
    Object.assign(new Error('Model not found'), { statusCode: 404 }),
  ]) {
    await assert.rejects(authenticate({
      verify: async () => { throw failure; },
      openBrowser: async () => { assert.fail('No authentication error'); },
      interactive: true, log: () => {},
    }), error => error === failure);
  }
});

test('the missing credit card error opens its billing URL and retries after setup', async () => {
  const url = 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card';
  const failure = new Error(`AI Gateway requires a valid credit card on file to service requests. Please visit ${url} to add a card and unlock your free credits.`);
  const actions: string[] = [];
  const unexpected = async () => { assert.fail('Billing setup must reuse the existing credentials'); };
  assert.equal(await authenticate({
    verify: async () => { actions.push('verify'); if (actions.length === 1) throw failure; return 0.9; },
    openBrowser: async openedUrl => { actions.push('open'); assert.equal(openedUrl, url); },
    promptContinue: async () => { actions.push('continue'); },
    promptKey: unexpected, saveKey: unexpected, interactive: true, log: () => {},
  }), 0.9);
  assert.deepEqual(actions, ['verify', 'open', 'continue', 'verify']);
});

test('free-tier model restrictions open the top-up page without replacing the API key', async () => {
  const url = 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dtop-up';
  const failure = new Error(`Free tier users do not have access to this model. Upgrade to paid credits at ${url} for unrestricted access.`);
  let attempts = 0;
  await authenticate({
    verify: async () => { if (attempts++ === 0) throw failure; return 0.9; },
    openBrowser: async openedUrl => { assert.equal(openedUrl, url); },
    promptContinue: async () => {},
    promptKey: async () => { assert.fail('Paid access should reuse the key'); },
    saveKey: async () => { assert.fail('Paid access should not replace the key'); },
    interactive: true, log: () => {},
  });
  assert.equal(attempts, 2);
});

test('billing setup uses the Vercel fallback, handles browser failures, and only retries once', async () => {
  const failure = new Error('Evaluation failed', { cause: Object.assign(new Error('A positive credit balance is required. Visit https://vercel.com.example.org/billing'), { statusCode: 402 }) });
  const messages: string[] = [];
  let attempts = 0;
  let opens = 0;
  await assert.rejects(authenticate({
    verify: async () => { attempts++; throw failure; },
    openBrowser: async url => {
      opens++;
      assert.equal(new URL(url).hostname, 'vercel.com');
      throw new Error('Browser unavailable');
    },
    promptContinue: async () => {},
    promptKey: async () => { assert.fail('Billing setup is not key setup'); },
    interactive: true, log: message => messages.push(message),
  }), error => error === failure);
  assert.equal(attempts, 2);
  assert.equal(opens, 1);
  assert.ok(messages.some(message => message.includes('Could not open')));
});

test('non-interactive billing errors print setup instructions without prompting', async () => {
  const failure = Object.assign(new Error('A positive credit balance is required'), { statusCode: 402 });
  const messages: string[] = [];
  const unexpected = async () => { assert.fail('Non-interactive billing setup'); };
  await assert.rejects(authenticate({
    verify: async () => { throw failure; }, openBrowser: unexpected, promptContinue: unexpected,
    interactive: false, log: message => messages.push(message),
  }), error => error === failure);
  assert.ok(messages.some(message => message.includes('billing setup required: https://vercel.com/')));
});

test('non-interactive auth prints a URL without opening or prompting', async () => {
  const messages: string[] = [];
  for (const message of [
    'Vercel CLI access expired. Run /login to reconnect.',
    "The 'x-vercel-oidc-token' header is missing from the request.",
  ]) {
    await assert.rejects(authenticate({
      verify: async () => { throw new Error(message); },
      openBrowser: async () => { assert.fail('Non-interactive browser launch'); },
      promptKey: async () => { assert.fail('Non-interactive prompt'); },
      interactive: false, log: message => messages.push(message),
    }), /interactive terminal/);
  }
  assert.ok(messages.some(message => message.includes(gatewayKeyUrl)));
});

test('rejected replacement keys are not saved and restore the previous credentials', async t => {
  preserveEnvironment(t);
  process.env.AI_GATEWAY_API_KEY = 'old-key';
  process.env.EVE_MODEL_CONNECTION = 'vercel-cli';
  process.env.EVE_MODEL_KEY_SOURCE = 'secret';
  const failure = Object.assign(new Error('Invalid API key'), { name: 'GatewayAuthenticationError' });
  await assert.rejects(authenticate({
    verify: async () => { throw failure; },
    openBrowser: async () => {}, promptKey: async () => 'invalid-key',
    saveKey: async () => { assert.fail('Rejected keys must not be saved'); },
    interactive: true, log: () => {},
  }), error => error === failure);
  assert.equal(process.env.AI_GATEWAY_API_KEY, 'old-key');
  assert.equal(process.env.EVE_MODEL_CONNECTION, 'vercel-cli');
  assert.equal(process.env.EVE_MODEL_KEY_SOURCE, 'secret');
});

test('saving keys preserves other settings, replaces old entries, and restricts permissions', async t => {
  const path = join(await fixture(t), '.env.local');
  await saveGatewayKey('initial-key', path);
  assert.deepEqual(parseEnv(await readFile(path, 'utf8')), { AI_GATEWAY_API_KEY: 'initial-key' });
  await writeFile(path, 'ROS_AUTH_TEST=keep');
  await saveGatewayKey('appended-key', path);
  assert.deepEqual(parseEnv(await readFile(path, 'utf8')), { ROS_AUTH_TEST: 'keep', AI_GATEWAY_API_KEY: 'appended-key' });
  await writeFile(path, '# Local settings\nROS_SYSTEM1_MODEL=typesafe-ai/jev\nexport AI_GATEWAY_API_KEY=old-long-key\nAI_GATEWAY_API_KEY=duplicate-key\nROS_AUTH_TEST=keep');
  await saveGatewayKey('new-key', path);
  const content = await readFile(path, 'utf8');
  assert.ok(content.startsWith('# Local settings\n'));
  assert.deepEqual(parseEnv(content), {
    ROS_SYSTEM1_MODEL: 'typesafe-ai/jev', AI_GATEWAY_API_KEY: 'new-key', ROS_AUTH_TEST: 'keep',
  });
  assert.ok(!content.includes('old-long-key') && !content.includes('duplicate-key'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(saveGatewayKey('bad\nkey', path), /without quotes or whitespace/);
  assert.equal(await readFile(path, 'utf8'), content);
});

test('local credentials override shared defaults while shell exports win', async t => {
  preserveEnvironment(t);
  const root = await fixture(t);
  await writeFile(join(root, '.env'), 'AI_GATEWAY_API_KEY=shared-key\nROS_AUTH_TEST=shared');
  await writeFile(join(root, '.env.local'), 'AI_GATEWAY_API_KEY=local-key\nROS_AUTH_TEST=local');
  const cwd = process.cwd();
  try {
    process.chdir(root);
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.ROS_AUTH_TEST;
    loadModelEnvironment();
    assert.equal(process.env.AI_GATEWAY_API_KEY, 'local-key');
    assert.equal(process.env.ROS_AUTH_TEST, 'local');
    process.env.AI_GATEWAY_API_KEY = 'shell-key';
    loadModelEnvironment();
    assert.equal(process.env.AI_GATEWAY_API_KEY, 'shell-key');
  } finally {
    process.chdir(cwd);
  }
});
