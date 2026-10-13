import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Controller } from './controller.js';

export async function startBridge(controller: Controller) {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    const auth = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { response.writeHead(401).end(); return; }
    if (request.method !== 'POST' || request.url !== '/tool') { response.writeHead(404).end(); return; }
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 128_000) throw new Error('Request too large');
      }
      const { name, input } = JSON.parse(body);
      // Routing is System 1 deciding which executive model thinks next, not an executive tool.
      const output = name === 'route' ? await controller.route(input ?? {}) : await controller.tool(name, input ?? {});
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(output));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Bridge did not start');
  return { url: `http://127.0.0.1:${address.port}`, token, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
