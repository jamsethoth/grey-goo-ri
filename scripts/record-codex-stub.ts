// The stand-in Responses API scripts/record-codex.ts points a call at (#479), for a failure no real API call can ask
// for: it answers every request 429 usage_limit_reached, as the ChatGPT backend does at a limit, and lists each
// request.
import { createServer } from 'node:http';

export async function start(requests: string[]) {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      if (!path.endsWith('/responses')) {
        requests.push(`${request.method} ${path} 404`);
        response.writeHead(404).end();
        return;
      }
      requests.push(`${request.method} ${path} 429`);
      const error = { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus' };
      response
        .writeHead(429, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { ...error, resets_in_seconds: 3600 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}
