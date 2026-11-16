// HTTP server: routing, body reading, auth and the JSON envelope.
//
// Routes:
//   GET  /healthz                    200 {"ok": true}, no auth
//   /{owner}/{repo}.git/...          git smart HTTP (no auth; git is public)
//   POST /api/graphql                GraphQL, Bearer auth
//   POST /mcp                        MCP JSON-RPC, Bearer auth (checked after parse)
//   /api/v3/*                        REST v3, Bearer auth, JSON + X-GitHub-Request-Id
//   anything else                    404 JSON

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  handleReceivePack,
  handleUploadPack,
  receivePackAdvertisement,
  uploadPackAdvertisementV0,
  uploadPackAdvertisementV2,
} from './git.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer (.+)$/.exec(header);
  return m ? m[1] : null;
}

function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null) return false;
  if (TOKEN === '') return true;
  return token === TOKEN;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const text = body === null ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  };
  if (body === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createApp(): Server {
  const store = new Store();
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(store, req, res);
    } catch (err) {
      // Never die on a bad request: answer 500 JSON and keep serving.
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } catch {
        // The socket is gone; nothing more to do.
      }
    }
  });
  return server;
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const host = req.headers.host ?? '127.0.0.1';
  const origin = `http://${host}`;

  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP.
  const gitMatch = GIT_ROUTE.exec(pathname);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const name = decodeURIComponent(gitMatch[2]);
    const service = gitMatch[3];
    const repo = store.getRepo(owner, name);
    if (!repo || repo.owner !== owner) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (service === 'info/refs') {
      if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
      const svc = url.searchParams.get('service');
      if (svc === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        const body = v2 ? uploadPackAdvertisementV2(repo) : uploadPackAdvertisementV0(repo);
        sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', body);
        return;
      }
      if (svc === 'git-receive-pack') {
        sendBytes(res, 200, 'application/x-git-receive-pack-advertisement', receivePackAdvertisement(repo));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
    const body = await readBody(req);
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const result = handleUploadPack(repo, body, v2 ? '2' : '0');
      sendBytes(res, result.status, result.contentType, result.body);
      return;
    }
    const result = handleReceivePack(repo, body);
    sendBytes(res, result.status, result.contentType, result.body);
    return;
  }

  // GraphQL.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (!authorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
    const result = handleGraphql(store, parsed.value);
    sendJson(res, result.status, result.body);
    return;
  }

  // MCP.
  if (pathname === '/mcp') {
    if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
    const body = await readBody(req);
    const result = handleMcp(store, origin, body.toString('utf8'), authorized(req));
    if (result.status === 202) {
      res.writeHead(202, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, result.headers);
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (!authorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
    const segments = pathname.slice('/api/v3'.length).split('/').filter((s) => s.length > 0).map(decodeURIComponent);
    let bodyValue: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
      bodyValue = parsed.value;
    }
    const result = handleRest({ store, origin, method, segments, path: pathname, query: url.searchParams, body: bodyValue });
    if (result.status === 204) {
      res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...result.headers });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, result.headers);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
