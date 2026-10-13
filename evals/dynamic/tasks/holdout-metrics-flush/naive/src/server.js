// A tiny HTTP service with request counting.
import { createServer } from 'node:http';

export function startServer({ port = 0, flushIntervalMs = 5000, onFlush = () => {} } = {}) {
  const metrics = { requests: 0 };
  const server = createServer((request, response) => {
    metrics.requests += 1;
    if (request.url === '/health') return response.end('ok');
    response.statusCode = 404;
    response.end('not found');
  });
  setInterval(() => onFlush({ ...metrics }), flushIntervalMs);
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({
    metrics,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(done => server.close(() => done())),
  })));
}
