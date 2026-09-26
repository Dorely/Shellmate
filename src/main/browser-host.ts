import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

type TerminalEvent = { id: string; seq: number; data: string };
type Invoke = (method: unknown, args: unknown) => Promise<unknown>;
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

export interface BrowserHost {
  url: string;
  changed(): void;
  terminal(event: TerminalEvent): void;
  close(): Promise<void>;
}

export async function startBrowserHost(assetsDir: string, invoke: Invoke): Promise<BrowserHost> {
  const session = randomBytes(32).toString('hex');
  const clients = new Set<ServerResponse>();
  let origin = '';
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };
  const send = (response: ServerResponse, status: number, body: string | Buffer, type = 'application/json; charset=utf-8') => {
    response.writeHead(status, { ...headers, 'content-type': type }); response.end(body);
  };
  const authorized = (request: IncomingMessage) => request.headers.cookie?.split(';').some(part => part.trim() === `shellmate_browser=${session}`) ?? false;
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(origin).host) return send(response, 403, 'Forbidden', 'text/plain; charset=utf-8');
      const pathname = new URL(request.url ?? '/', origin).pathname;
      if (pathname === '/api/session' && request.method === 'GET') {
        response.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8', 'set-cookie': `shellmate_browser=${session}; HttpOnly; SameSite=Strict; Path=/` });
        return response.end('{}');
      }
      if (pathname === '/api/events' && request.method === 'GET') {
        if (!authorized(request)) return send(response, 403, 'Forbidden', 'text/plain; charset=utf-8');
        response.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
        clients.add(response); response.write(': ready\n\n'); request.on('close', () => clients.delete(response)); return;
      }
      if (pathname === '/api/call' && request.method === 'POST') {
        if (!authorized(request) || request.headers.origin !== origin || request.headers['x-shellmate-browser'] !== '1' || !request.headers['content-type']?.startsWith('application/json')) return send(response, 403, JSON.stringify({ error: 'Untrusted browser request.' }));
        let body = '';
        for await (const chunk of request) { body += chunk.toString(); if (body.length > 1_000_000) return send(response, 413, JSON.stringify({ error: 'Request is too large.' })); }
        let payload: unknown;
        try { payload = JSON.parse(body); } catch { return send(response, 400, JSON.stringify({ error: 'Invalid JSON.' })); }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return send(response, 400, JSON.stringify({ error: 'Invalid operation.' }));
        const call = payload as { method?: unknown; args?: unknown };
        try { return send(response, 200, JSON.stringify({ result: await invoke(call.method, call.args) })); }
        catch (error) { return send(response, 400, JSON.stringify({ error: error instanceof Error ? error.message : 'Operation failed.' })); }
      }
      if (request.method !== 'GET' || !['/', '/index.html'].includes(pathname) && !/^\/assets\/[A-Za-z0-9_.-]+$/.test(pathname)) return send(response, 404, 'Not found', 'text/plain; charset=utf-8');
      const name = pathname === '/' ? 'index.html' : pathname.slice(1);
      send(response, 200, await readFile(join(assetsDir, name)), contentTypes[extname(name)] ?? 'application/octet-stream');
    } catch { if (!response.headersSent) send(response, 500, 'Browser host error', 'text/plain; charset=utf-8'); else response.end(); }
  });
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser host could not bind.');
  origin = `http://127.0.0.1:${address.port}`;
  const broadcast = (event: string, data: unknown) => { const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const client of clients) client.write(frame); };
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': keepalive\n\n'); }, 20_000);
  return {
    url: origin,
    changed: () => broadcast('changed', {}),
    terminal: event => broadcast('terminal', event),
    close: async () => { clearInterval(heartbeat); for (const client of clients) client.end(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };
}
