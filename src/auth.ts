import { constants, existsSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { evaluate } from 'eve/ai';
import { generateText } from 'ai';
import { defaultExecutiveModel, defaultSystem1Model } from './models.js';
import { credentialsPath } from './paths.js';

export const gatewayKeyUrl = 'https://vercel.com/d?title=AI+Gateway+API+Keys&to=%2F%5Bteam%5D%2F~%2Fai-gateway%2Fapi-keys';
const gatewayBillingUrl = 'https://vercel.com/d?title=AI+Gateway&to=%2F%5Bteam%5D%2F~%2Fai-gateway';

export function loadModelEnvironment() {
  // Shell exports win; local settings take precedence over shared defaults, then `spidermonkey auth`.
  for (const path of ['.env.local', '.env', credentialsPath]) {
    if (existsSync(path)) process.loadEnvFile(path);
  }
  if (!process.env.AI_GATEWAY_API_KEY?.trim() && !process.env.VERCEL_OIDC_TOKEN && !process.env.EVE_MODEL_CONNECTION) {
    // Eve's local transport reuses the selected Vercel CLI account and team.
    process.env.EVE_DEV = '1';
    process.env.EVE_MODEL_CONNECTION = 'vercel-cli';
  }
}

export async function verifyModelConnection() {
  const [result] = await Promise.all([
    evaluate({
      model: process.env.ROS_SYSTEM1_MODEL || defaultSystem1Model,
      state: 'A coding workspace has a failing test. It needs executive attention.',
      questions: { needsAttention: { type: 'boolean', instructions: 'Does the workspace need executive attention?' } },
      abortSignal: AbortSignal.timeout(15_000), maxRetries: 0,
    }),
    // Eve owns Vercel CLI credentials. Probe the language model directly when
    // Gateway credentials are provisioned in the environment (including Modal).
    process.env.AI_GATEWAY_API_KEY?.trim() || process.env.VERCEL_OIDC_TOKEN?.trim() ? generateText({
      model: process.env.ROS_EXECUTIVE_MODEL || defaultExecutiveModel,
      prompt: 'Reply with OK.', reasoning: 'none', maxOutputTokens: 32,
      abortSignal: AbortSignal.timeout(15_000), maxRetries: 0,
    }) : Promise.resolve(),
  ]);
  return result.answers.needsAttention.probability;
}

function isAuthenticationError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const value = error as { name?: string; type?: string; statusCode?: number; message?: string; cause?: unknown };
    if (value.statusCode === 401 || value.name === 'GatewayAuthenticationError' || value.type === 'authentication_error' ||
      /Vercel CLI (credentials are unavailable|access expired)|selected saved API key is unavailable|Set AI_GATEWAY_API_KEY|AI Gateway authentication failed|x-vercel-oidc-token.*missing/i.test(value.message ?? '')) return true;
    error = value.cause;
  }
  return false;
}

function billingSetupUrl(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const value = error as { statusCode?: number; type?: string; message?: string; cause?: unknown };
    const message = value.message ?? '';
    if (value.statusCode === 402 || value.type === 'insufficient_funds' ||
      /AI Gateway requires a valid credit card on file|A positive credit balance is required|Free tier users do not have access to this model/i.test(message)) {
      for (const match of message.matchAll(/https:\/\/[^\s<>"']+/g)) {
        try {
          const url = new URL(match[0]);
          if (url.hostname === 'vercel.com' && !url.username && !url.password) return url.href;
        } catch { /* Use the dashboard fallback if the service returns an invalid URL. */ }
      }
      return gatewayBillingUrl;
    }
    error = value.cause;
  }
}

async function openSetupPage(url: string) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] :
    process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] :
    ['xdg-open', [url]];
  await promisify(execFile)(command, args, { timeout: 5_000, windowsHide: true });
}

async function promptInput(message: string, hidden = false): Promise<string> {
  process.stdout.write(message);
  const muted = hidden ? new Writable({ write(_chunk, _encoding, callback) { callback(); } }) : undefined;
  const prompt = createInterface({ input: process.stdin, output: muted ?? process.stdout, terminal: true });
  try {
    return await new Promise<string>((resolve, reject) => {
      prompt.once('SIGINT', () => reject(new Error('Authentication cancelled.')));
      prompt.once('close', () => reject(new Error('Authentication cancelled.')));
      prompt.question('', resolve);
    });
  } finally {
    prompt.close();
    muted?.end();
    if (hidden) process.stdout.write('\n');
  }
}

async function promptGatewayKey() {
  return promptInput('Create a Gateway API key, then paste it here (input hidden; Ctrl+C to cancel): ', true);
}

async function promptBillingSetup() {
  await promptInput('Finish billing setup in your browser, then press Enter to retry (Ctrl+C to cancel): ');
}

export async function saveGatewayKey(key: string, path = '.env.local') {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!key || /[\s"\\]/.test(key)) throw new Error('Paste the API key itself, without quotes or whitespace.');
  const file = await open(path, constants.O_CREAT | constants.O_RDWR, 0o600);
  try {
    const content = await file.readFile('utf8');
    const assignment = `AI_GATEWAY_API_KEY="${key}"`;
    const pattern = /^[\t ]*(?:export[\t ]+)?AI_GATEWAY_API_KEY[\t ]*=[^\r\n]*/gm;
    const updated = pattern.test(content) ? content.replace(pattern, () => assignment) :
      `${content}${content && !content.endsWith('\n') ? '\n' : ''}${assignment}\n`;
    await file.chmod(0o600);
    await file.write(updated, 0, 'utf8');
    await file.truncate(Buffer.byteLength(updated));
  } finally {
    await file.close();
  }
}

export async function authenticate(options: {
  verify?: () => Promise<number>;
  openBrowser?: (url: string) => Promise<void>;
  promptKey?: () => Promise<string>;
  promptContinue?: () => Promise<void>;
  saveKey?: (key: string) => Promise<void>;
  /** Where the default saveKey writes, and what the messages name. */
  keyPath?: string;
  /** The command to suggest when authentication cannot finish here. */
  command?: string;
  interactive?: boolean;
  log?: (message: string) => void;
} = {}) {
  const {
    verify = verifyModelConnection, openBrowser = openSetupPage, promptKey = promptGatewayKey, promptContinue = promptBillingSetup,
    keyPath = '.env.local', command = 'pnpm auth', saveKey = (key: string) => saveGatewayKey(key, keyPath), interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY), log = console.log,
  } = options;
  async function launchBrowser(url: string, purpose: string) {
    log(`Opening your browser to ${purpose}…`);
    try { await openBrowser(url); } catch { log('Could not open your browser. Open the URL above to continue.'); }
  }
  async function verifyWithBillingSetup() {
    try {
      return await verify();
    } catch (error) {
      const url = billingSetupUrl(error);
      if (!url) throw error;
      log(`AI Gateway billing setup required: ${url}`);
      if (!interactive) throw error;
      await launchBrowser(url, 'finish AI Gateway billing setup');
      await promptContinue();
      return verify();
    }
  }
  try {
    return await verifyWithBillingSetup();
  } catch (error) {
    if (!isAuthenticationError(error)) throw error;
  }
  log(`Connect AI Gateway: ${gatewayKeyUrl}`);
  if (!interactive) throw new Error(`Add AI_GATEWAY_API_KEY to ${keyPath}, then run ${command} in an interactive terminal.`);
  await launchBrowser(gatewayKeyUrl, 'create an AI Gateway API key');
  const key = (await promptKey()).trim();
  if (!key || /[\s"\\]/.test(key)) throw new Error('Paste the API key itself, without quotes or whitespace.');
  const previous = {
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
    EVE_MODEL_CONNECTION: process.env.EVE_MODEL_CONNECTION,
    EVE_MODEL_KEY_SOURCE: process.env.EVE_MODEL_KEY_SOURCE,
  };
  process.env.AI_GATEWAY_API_KEY = key;
  // Switch away from the Vercel CLI fallback for this verification request.
  delete process.env.EVE_MODEL_CONNECTION;
  delete process.env.EVE_MODEL_KEY_SOURCE;
  try {
    const probability = await verifyWithBillingSetup();
    await saveKey(key);
    log(`API key verified and saved to ${keyPath}.`);
    return probability;
  } catch (error) {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    throw error;
  }
}

if (process.argv[1]?.endsWith('/auth.ts')) {
  loadModelEnvironment();
  try {
    const probability = await authenticate();
    console.log(`Gateway connected. Executive: ${process.env.ROS_EXECUTIVE_MODEL || defaultExecutiveModel}. System 1: ${process.env.ROS_SYSTEM1_MODEL || defaultSystem1Model} P(attention) = ${probability.toFixed(3)}.`);
  } catch (error) {
    console.error(`Gateway connection failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Use a funded Vercel team or put AI_GATEWAY_API_KEY in .env.local, then run pnpm auth again.');
    process.exitCode = 1;
  }
}
