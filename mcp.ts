// MCP surface: POST /mcp, JSON-RPC 2.0 Streamable HTTP.
//
// Supports the modern 2026-07-28 discovery handshake (server/discover)
// and the legacy initialize + notifications/initialized handshake. Tools
// act on the same store as REST and GraphQL. Every tool result carries
// both a text content block (JSON) and structuredContent.

import {
  type Issue,
  type Repo,
  type Store,
} from './store.ts';
import { handleRest, issueJson, pullJson, repoJson, type RestContext } from './rest.ts';

// ---------------------------------------------------------------------------
// Tool definitions (built once; tools/list answers the same bytes twice)
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const S = (desc: string): Record<string, unknown> => ({ type: 'string', description: desc });
const B = (desc: string): Record<string, unknown> => ({ type: 'boolean', description: desc });
const I = (desc: string): Record<string, unknown> => ({ type: 'integer', description: desc });

export const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository owned by the authenticated user.', {
    name: S('The repository name.'),
    description: S('A short description of the repository.'),
    private: B('Whether the repository is private.'),
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: S('The repository owner login.'),
    repo: S('The repository name.'),
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: S('The repository owner login.'),
    repo: S('The repository name.'),
    title: S('The issue title.'),
    body: S('The issue body.'),
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    owner: S('The repository owner login.'),
    repo: S('The repository name.'),
    state: S('Filter by state: open, closed or all.'),
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request in a repository.', {
    owner: S('The repository owner login.'),
    repo: S('The repository name.'),
    title: S('The pull request title.'),
    head: S('The head branch name.'),
    base: S('The base branch name.'),
    body: S('The pull request body.'),
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request with a squash commit.', {
    owner: S('The repository owner login.'),
    repo: S('The repository name.'),
    pull_number: I('The pull request number.'),
  }, ['owner', 'repo', 'pull_number']),
  tool('list_repos', 'List repositories owned by the authenticated user.', {}, []),
  tool('get_issue', 'Get one issue by number.', {
    owner: S('The repository owner login.'),
    repo: S('The repository name.'),
    issue_number: I('The issue number.'),
  }, ['owner', 'repo', 'issue_number']),
];

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------------------
// Shared REST helpers: run a REST operation against the store and return the
// parsed result, so MCP tools share exactly the REST behaviour.
// ---------------------------------------------------------------------------

function restCtx(store: Store, origin: string, method: string, path: string, body: unknown): RestContext {
  const url = new URL(origin + path);
  return {
    store,
    origin,
    method,
    segments: url.pathname.split('/').filter((s) => s.length > 0).slice(2),
    path: url.pathname,
    query: url.searchParams,
    body,
  };
}

function callRest(store: Store, origin: string, method: string, path: string, body: unknown): { status: number; body: unknown } {
  const res = handleRest(restCtx(store, origin, method, path, body));
  return { status: res.status, body: res.body };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqStr(args: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function reqNum(args: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  return null;
}

function execTool(store: Store, origin: string, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = reqStr(args, ['name', 'repo']);
      if (!repoName) return { ok: false, message: 'Missing required argument: name' };
      const res = callRest(store, origin, 'POST', '/api/v3/user/repos', {
        name: repoName,
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      if (res.status === 201) return { ok: true, value: res.body };
      return { ok: false, message: isObj(res.body) && typeof res.body.message === 'string' ? res.body.message : 'Could not create repository' };
    }
    case 'get_repo': {
      const owner = reqStr(args, ['owner']);
      const repo = reqStr(args, ['repo', 'name']) ?? (typeof args.full_name === 'string' ? args.full_name.split('/').pop() ?? null : null);
      if (!owner || !repo) return { ok: false, message: 'Missing required argument: owner and repo' };
      const found = store.getRepo(owner, repo);
      if (!found || found.owner !== owner) return { ok: false, message: 'Not Found' };
      return { ok: true, value: repoJson(restCtx(store, origin, 'GET', '/api/v3/', null), found) };
    }
    case 'create_issue': {
      const owner = reqStr(args, ['owner']);
      const repo = reqStr(args, ['repo', 'name']);
      const title = reqStr(args, ['title']);
      if (!owner || !repo || !title) return { ok: false, message: 'Missing required argument: owner, repo and title' };
      const res = callRest(store, origin, 'POST', `/api/v3/repos/${owner}/${repo}/issues`, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
      });
      if (res.status === 201) return { ok: true, value: res.body };
      return { ok: false, message: isObj(res.body) && typeof res.body.message === 'string' ? res.body.message : 'Could not create issue' };
    }
    case 'list_issues': {
      const owner = reqStr(args, ['owner']);
      const repo = reqStr(args, ['repo', 'name']);
      if (!owner || !repo) return { ok: false, message: 'Missing required argument: owner and repo' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const found = store.getRepo(owner, repo);
      if (!found || found.owner !== owner) return { ok: false, message: 'Not Found' };
      let items = found.issues.slice();
      if (state !== 'all') items = items.filter((i: Issue) => i.state === state);
      const ctx = restCtx(store, origin, 'GET', '/api/v3/', null);
      const value = items.map((i: Issue) => issueJson(ctx, found, i));
      return { ok: true, value };
    }
    case 'create_pull_request': {
      const owner = reqStr(args, ['owner']);
      const repo = reqStr(args, ['repo', 'name']);
      const title = reqStr(args, ['title']);
      const head = reqStr(args, ['head']);
      const base = reqStr(args, ['base']);
      if (!owner || !repo || !title || !head || !base) return { ok: false, message: 'Missing required argument: owner, repo, title, head and base' };
      const res = callRest(store, origin, 'POST', `/api/v3/repos/${owner}/${repo}/pulls`, {
        title,
        head,
        base,
        body: typeof args.body === 'string' ? args.body : '',
      });
      if (res.status === 201) return { ok: true, value: res.body };
      return { ok: false, message: isObj(res.body) && typeof res.body.message === 'string' ? res.body.message : 'Could not create pull request' };
    }
    case 'merge_pull_request': {
      const owner = reqStr(args, ['owner']);
      const repo = reqStr(args, ['repo', 'name']);
      const pullNumber = reqNum(args, ['pull_number', 'number', 'pullNumber']);
      if (!owner || !repo || pullNumber === null) return { ok: false, message: 'Missing required argument: owner, repo and pull_number' };
      const res = callRest(store, origin, 'PUT', `/api/v3/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, { merge_method: 'squash' });
      if (res.status === 200) {
        const found = store.getRepo(owner, repo);
        const pull = found?.pullsByNumber.get(pullNumber);
        const ctx = restCtx(store, origin, 'GET', '/api/v3/', null);
        const value = found && pull ? pullJson(ctx, found, pull) : res.body;
        return { ok: true, value };
      }
      return { ok: false, message: isObj(res.body) && typeof res.body.message === 'string' ? res.body.message : 'Could not merge pull request' };
    }
    case 'list_repos': {
      const ctx = restCtx(store, origin, 'GET', '/api/v3/', null);
      return { ok: true, value: store.viewerRepos().map((r: Repo) => repoJson(ctx, r)) };
    }
    case 'get_issue': {
      const owner = reqStr(args, ['owner']);
      const repo = reqStr(args, ['repo', 'name']);
      const num = reqNum(args, ['issue_number', 'number']);
      if (!owner || !repo || num === null) return { ok: false, message: 'Missing required argument: owner, repo and issue_number' };
      const found = store.getRepo(owner, repo);
      const issue = found?.issuesByNumber.get(num);
      if (!found || !issue) return { ok: false, message: 'Not Found' };
      const ctx = restCtx(store, origin, 'GET', '/api/v3/', null);
      return { ok: true, value: issueJson(ctx, found, issue) };
    }
    default:
      return { ok: false, message: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC transport
// ---------------------------------------------------------------------------

export interface McpResult {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

function rpcError(id: unknown, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

export function handleMcp(store: Store, origin: string, bodyText: string, authorized: boolean): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isObj(parsed) || typeof parsed.method !== 'string') {
    return rpcError(isObj(parsed) ? parsed.id : null, -32600, 'Invalid Request');
  }
  const id = parsed.id;
  const isNotification = id === undefined;
  if (!authorized) {
    return { status: 401, body: { message: 'Unauthorized' } };
  }
  const method = parsed.method;
  const params = isObj(parsed.params) ? parsed.params : {};
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: 'forge', version: '1.0.0' };
      return rpcResult(id, {
        resultType: 'discover',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      const requested = typeof (params as Record<string, unknown>).protocolVersion === 'string'
        ? (params as Record<string, unknown>).protocolVersion as string
        : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      });
    }
    case 'ping': return rpcResult(id, {});
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isObj(params.arguments) ? params.arguments : {};
      const def = TOOLS.find((t) => t.name === name);
      if (!def) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const required = (def.inputSchema.required ?? []) as string[];
      for (const key of required) {
        const value = args[key];
        if (value === undefined || value === null || value === '') {
          return rpcError(id, -32602, `Missing required argument: ${key}`);
        }
      }
      const result = execTool(store, origin, name, args);
      if (!result.ok) {
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: result.message }) }],
          structuredContent: { error: result.message },
          isError: true,
        });
      }
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result.value) }],
        structuredContent: result.value,
      });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
