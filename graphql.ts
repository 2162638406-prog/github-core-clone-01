// GraphQL v4 surface: POST /api/graphql.
//
// A small hand-written document parser plus field resolvers over the same
// store the REST surface uses. Supports the documents gh and
// github-mcp-server send: viewer/repository/issue/pull-request reads,
// create/close issue, create/merge pull request, add comment, node lookup,
// introspection (__type), aliases, fragments, variables and batched
// operation arrays. Unknown fields answer HTTP 200 with an errors array
// naming the field; unknown repositories answer data.repository null.

import {
  TRIAL_NOW_EPOCH,
  TRIAL_NOW_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  authorLine,
  buildCommit,
  diffTrees,
  hasMergeConflict,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') { tokens.push({ kind: 'spread' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      tokens.push(raw.includes('.') || raw.includes('e') || raw.includes('E') ? { kind: 'float', value: raw } : { kind: 'int', value: raw });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'enum'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selections: Sel[] | null;
}

interface FragmentSel {
  kind: 'spread';
  name: string;
}

interface InlineSel {
  kind: 'inline';
  typeCondition: string | null;
  selections: Sel[];
}

type Sel = FieldSel | FragmentSel | InlineSel;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: Record<string, ValueNode | null>;
  selections: Sel[];
}

interface Document {
  operations: Operation[];
  fragments: Record<string, { typeCondition: string; selections: Sel[] }>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    this.pos++;
    return t;
  }

  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}`);
  }

  private expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'name' || (v !== undefined && t.value !== v)) throw new Error(`expected name ${v ?? ''}`);
    return t.value;
  }

  private isPunct(v: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'punct' && t.value === v;
  }

  private isName(v: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'name' && t.value === v;
  }

  parseDocument(): Document {
    const doc: Document = { operations: [], fragments: {} };
    while (this.pos < this.tokens.length) {
      if (this.isName('fragment')) {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelections();
        doc.fragments[name] = { typeCondition, selections };
        continue;
      }
      let kind: 'query' | 'mutation' = 'query';
      if (this.isName('query') || this.isName('mutation')) kind = this.next().kind === 'name' ? (this.tokens[this.pos - 1].value as 'query' | 'mutation') : 'query';
      let name: string | null = null;
      const t = this.peek();
      if (t && t.kind === 'name') name = this.next().value;
      const varDefs: Record<string, ValueNode | null> = {};
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          this.expectPunct('$');
          const vname = this.expectName();
          this.expectPunct(':');
          this.parseType();
          let def: ValueNode | null = null;
          if (this.isPunct('=')) { this.next(); def = this.parseValue(); }
          varDefs[vname] = def;
        }
        this.expectPunct(')');
      }
      const selections = this.parseSelections();
      doc.operations.push({ kind, name, varDefs, selections });
    }
    return doc;
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private parseSelections(): Sel[] {
    this.expectPunct('{');
    const out: Sel[] = [];
    while (!this.isPunct('}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): Sel {
    const t = this.peek();
    if (t && t.kind === 'spread') {
      this.next();
      const n = this.peek();
      if (n && n.kind === 'name' && n.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelections() };
      }
      if (n && n.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelections() };
    }
    const nameOrAlias = this.expectName();
    let alias: string | null = null;
    let name = nameOrAlias;
    if (this.isPunct(':')) {
      this.next();
      alias = nameOrAlias;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selections = this.isPunct('{') ? this.parseSelections() : null;
    return { kind: 'field', alias, name, args, selections };
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) {
        this.next();
        let depth = 1;
        while (depth > 0 && this.pos < this.tokens.length) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth++;
          if (t.kind === 'punct' && t.value === ')') depth--;
        }
      }
    }
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek() && this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek() && this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const k = this.expectName();
        this.expectPunct(':');
        fields[k] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'literal', value: t.value };
    if (t.kind === 'int') return { kind: 'literal', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'literal', value: parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'literal', value: true };
      if (t.value === 'false') return { kind: 'literal', value: false };
      if (t.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'enum', name: t.value };
    }
    throw new Error('unexpected value');
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface GqlError {
  message: string;
  path?: (string | number)[];
}

interface GqlContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Record<string, { typeCondition: string; selections: Sel[] }>;
  errors: GqlError[];
}

export function globalId(kind: string, parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var': return variables[node.name];
    case 'literal': return node.value;
    case 'enum': return node.name;
    case 'list': return node.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

function argsOf(field: FieldSel, ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = resolveValue(v, ctx.variables);
  return out;
}

// Wrapped value: a plain object carrying __typename plus its fields.
type GqlObj = Record<string, unknown> & { __typename: string };

function repoObj(repo: Repo): GqlObj {
  return { __typename: 'Repository', __repo: repo };
}

function issueObj(repo: Repo, issue: Issue): GqlObj {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullObj(repo: Repo, pull: Pull): GqlObj {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function userObj(login: string, id: number): GqlObj {
  return { __typename: 'User', __login: login, __id: id, name: login === VIEWER_LOGIN ? VIEWER_NAME : login, email: login === VIEWER_LOGIN ? VIEWER_EMAIL : '' };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'repository', 'headRef', 'baseRef'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  Label: ['id', 'name', 'color', 'description'],
  Commit: ['oid', 'message', 'abbreviatedOid'],
};

const SEARCH_ENUM_VALUES = ['ISSUE', 'PULL_REQUEST', 'DISCUSSION', 'USER', 'REPOSITORY', 'ORGANIZATION', 'MILESTONE'];

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function cursorIndex(cursor: string | undefined): number {
  if (!cursor) return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : -1;
  } catch {
    return -1;
  }
}

function connectionOf<T>(items: T[], first: number | undefined, after: string | undefined): GqlObj {
  const afterIdx = cursorIndex(after);
  const start = afterIdx + 1;
  const limit = first !== undefined ? Math.max(0, first) : items.length;
  const slice = items.slice(start, start + limit);
  const endIdx = start + slice.length - 1;
  const nodes = slice as unknown as GqlObj[];
  return {
    __typename: 'Connection',
    __nodes: nodes,
    __edges: slice.map((item, i) => ({ __typename: 'Edge', node: item, cursor: cursorFor(start + i) })),
    __pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorFor(start) : null,
      endCursor: slice.length > 0 ? cursorFor(endIdx) : null,
    },
    __totalCount: items.length,
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveField(obj: GqlObj, field: FieldSel, ctx: GqlContext): unknown {
  const type = obj.__typename;
  const name = field.name;
  const args = argsOf(field, ctx);
  const known = TYPE_FIELDS[type];
  if (type !== 'Connection' && type !== 'Edge' && known && !known.includes(name) && name !== '__typename') {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${type}".`, path: [name] });
    throw new FieldError();
  }
  switch (type) {
    case 'Query': return resolveQuery(obj, field, args, ctx);
    case 'Mutation': return resolveMutation(obj, field, args, ctx);
    case 'Repository': return resolveRepository(obj, field, args, ctx);
    case 'Issue': return resolveIssue(obj, field, args, ctx);
    case 'PullRequest': return resolvePull(obj, field, args, ctx);
    case 'User': return resolveUser(obj, field, args, ctx);
    case 'Connection':
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection':
    case 'PullRequestFileConnection': {
      if (name === 'nodes') return obj.__nodes;
      if (name === 'edges') return obj.__edges;
      if (name === 'pageInfo') return obj.__pageInfo;
      if (name === 'totalCount') return obj.__totalCount;
      return null;
    }
    case 'Edge': {
      if (name === 'node') return obj.node;
      if (name === 'cursor') return obj.cursor;
      return null;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return obj.hasNextPage;
      if (name === 'hasPreviousPage') return obj.hasPreviousPage;
      if (name === 'startCursor') return obj.startCursor;
      if (name === 'endCursor') return obj.endCursor;
      return null;
    }
    case 'Ref': {
      if (name === 'name') return obj.__name;
      if (name === 'target') return obj.__target ? { __typename: 'Commit', oid: obj.__target as string, message: '', abbreviatedOid: (obj.__target as string).slice(0, 7) } : null;
      return null;
    }
    case 'IssueComment': {
      if (name === 'id') return obj.__gid;
      if (name === 'body') return obj.__body;
      if (name === 'author') return userObj(obj.__user as string, VIEWER_ID);
      if (name === 'createdAt' || name === 'updatedAt') return TRIAL_NOW_ISO;
      return null;
    }
    case 'Commit': {
      if (name === 'oid') return obj.oid;
      if (name === 'message') return obj.message;
      if (name === 'abbreviatedOid') return (obj.oid as string).slice(0, 7);
      return null;
    }
    case 'Label': {
      if (name === 'id') return obj.__gid;
      if (name === 'name') return obj.__name;
      if (name === 'color') return obj.__color;
      if (name === 'description') return '';
      return null;
    }
    case 'PullRequestFile': {
      if (name === 'path') return obj.__path;
      if (name === 'additions') return obj.__additions;
      if (name === 'deletions') return obj.__deletions;
      if (name === 'changeType') return obj.__status;
      return null;
    }
    case '__Type': {
      if (name === 'name') return obj.__typeName;
      if (name === 'kind') return obj.__kind;
      if (name === 'description') return null;
      if (name === 'fields') return (obj.__fields as string[] | null)?.map((f) => ({ __typename: '__Field', name: f, description: null, args: [], type: { __typename: '__Type', __typeName: 'String', __kind: 'SCALAR', __fields: null, __enumValues: null } })) ?? null;
      if (name === 'enumValues') return (obj.__enumValues as string[] | null)?.map((v) => ({ __typename: '__EnumValue', name: v, description: null })) ?? null;
      if (name === 'possibleTypes') return null;
      if (name === 'interfaces') return [];
      return null;
    }
    case '__Field': {
      if (name === 'name') return obj.name;
      if (name === 'description') return null;
      if (name === 'args') return [];
      if (name === 'type') return obj.type;
      return null;
    }
    case '__EnumValue': {
      if (name === 'name') return obj.name;
      if (name === 'description') return null;
      return null;
    }
    case '__Schema': {
      if (name === 'queryType') return { __typename: '__Type', __typeName: 'Query', __kind: 'OBJECT', __fields: null, __enumValues: null };
      if (name === 'mutationType') return { __typename: '__Type', __typeName: 'Mutation', __kind: 'OBJECT', __fields: null, __enumValues: null };
      if (name === 'subscriptionType') return null;
      if (name === 'types') return [];
      if (name === 'directives') return [];
      return null;
    }
    default: return (obj as Record<string, unknown>)[name] ?? null;
  }
}

class FieldError extends Error {}

function resolveQuery(_obj: GqlObj, field: FieldSel, args: Record<string, unknown>, ctx: GqlContext): unknown {
  switch (field.name) {
    case 'viewer': return userObj(VIEWER_LOGIN, VIEWER_ID);
    case 'repository': {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = ctx.store.getRepo(owner, name);
      if (!repo || repo.owner !== owner) return null;
      return repoObj(repo);
    }
    case 'node': {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = [...ctx.store.repos.values()].find((r) => r.id === parseInt(decoded.parts[0], 10));
        return repo ? repoObj(repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const repo = [...ctx.store.repos.values()].find((r) => r.id === parseInt(decoded.parts[0], 10));
        const issue = repo?.issuesByNumber.get(parseInt(decoded.parts[1], 10));
        return repo && issue ? issueObj(repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const repo = [...ctx.store.repos.values()].find((r) => r.id === parseInt(decoded.parts[0], 10));
        const pull = repo?.pullsByNumber.get(parseInt(decoded.parts[1], 10));
        return repo && pull ? pullObj(repo, pull) : null;
      }
      return null;
    }
    case '__type': {
      const typeName = String(args.name ?? '');
      if (typeName === 'SearchType') return { __typename: '__Type', __typeName: typeName, __kind: 'ENUM', __fields: null, __enumValues: SEARCH_ENUM_VALUES };
      if (TYPE_FIELDS[typeName]) return { __typename: '__Type', __typeName: typeName, __kind: 'OBJECT', __fields: TYPE_FIELDS[typeName], __enumValues: null };
      return null;
    }
    case '__schema': return { __typename: '__Schema' };
    case 'rateLimit': return { __typename: 'RateLimit', limit: 5000, remaining: 4999, resetAt: TRIAL_NOW_ISO, used: 1, cost: 1, nodeCount: 0 };
    default: {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".`, path: [field.name] });
      throw new FieldError();
    }
  }
}

function resolveRepository(obj: GqlObj, field: FieldSel, args: Record<string, unknown>, ctx: GqlContext): unknown {
  const repo = obj.__repo as Repo;
  switch (field.name) {
    case 'id': return globalId('Repository', [repo.id]);
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return repo.fullName;
    case 'owner': return userObj(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0);
    case 'description': return repo.description;
    case 'isPrivate': return repo.priv;
    case 'defaultBranchRef': {
      const tip = repo.branchTip(repo.defaultBranch);
      if (!tip) return null;
      return { __typename: 'Ref', __name: repo.defaultBranch, __target: tip };
    }
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'url': return `https://github.com/${repo.fullName}`;
    case 'createdAt': case 'updatedAt': return TRIAL_NOW_ISO;
    case 'issue': {
      const issue = repo.issuesByNumber.get(Number(args.number));
      return issue ? issueObj(repo, issue) : null;
    }
    case 'issues': {
      let items = repo.issues.slice();
      if (Array.isArray(args.states)) {
        const wanted = (args.states as unknown[]).map((s) => String(s));
        items = items.filter((i) => wanted.includes(issueState(i)));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      const dir = orderBy?.direction === 'ASC' ? 1 : -1;
      items.sort((a, b) => (a.seq - b.seq) * dir || (a.number - b.number) * dir);
      const conn = connectionOf(items.map((i) => issueObj(repo, i)), typeof args.first === 'number' ? args.first : undefined, typeof args.after === 'string' ? args.after : undefined);
      conn.__typename = 'IssueConnection';
      return conn;
    }
    case 'pullRequest': {
      const pull = repo.pullsByNumber.get(Number(args.number));
      return pull ? pullObj(repo, pull) : null;
    }
    case 'pullRequests': {
      let items = repo.pulls.slice();
      if (Array.isArray(args.states)) {
        const wanted = (args.states as unknown[]).map((s) => String(s));
        items = items.filter((p) => wanted.includes(pullState(p)));
      }
      items.sort((a, b) => b.seq - a.seq);
      const conn = connectionOf(items.map((p) => pullObj(repo, p)), typeof args.first === 'number' ? args.first : undefined, typeof args.after === 'string' ? args.after : undefined);
      conn.__typename = 'PullRequestConnection';
      return conn;
    }
    default: return null;
  }
}

function resolveIssue(obj: GqlObj, field: FieldSel, args: Record<string, unknown>, ctx: GqlContext): unknown {
  const repo = obj.__repo as Repo;
  const issue = obj.__issue as Issue;
  switch (field.name) {
    case 'id': return globalId('Issue', [repo.id, issue.number]);
    case 'number': return issue.number;
    case 'title': return issue.title;
    case 'state': return issueState(issue);
    case 'body': return issue.body;
    case 'createdAt': case 'updatedAt': return TRIAL_NOW_ISO;
    case 'closedAt': return issue.state === 'closed' ? TRIAL_NOW_ISO : null;
    case 'author': return userObj(issue.user, VIEWER_ID);
    case 'labels': {
      const nodes = issue.labels.map((name) => ({ __typename: 'Label', __gid: globalId('Label', [repo.id, name]), __name: name, __color: repo.labels.get(name)?.color ?? 'ffffff' }));
      const conn = connectionOf(nodes, typeof args.first === 'number' ? args.first : undefined, typeof args.after === 'string' ? args.after : undefined);
      conn.__typename = 'LabelConnection';
      return conn;
    }
    case 'comments': {
      const nodes = issue.comments.map((c) => ({ __typename: 'IssueComment', __gid: globalId('IssueComment', [repo.id, c.id]), __body: c.body, __user: c.user }));
      const conn = connectionOf(nodes, typeof args.first === 'number' ? args.first : undefined, typeof args.after === 'string' ? args.after : undefined);
      conn.__typename = 'IssueCommentConnection';
      return conn;
    }
    case 'url': return `https://github.com/${repo.fullName}/issues/${issue.number}`;
    case 'repository': return repoObj(repo);
    default: return null;
  }
}

function resolvePull(obj: GqlObj, field: FieldSel, args: Record<string, unknown>, ctx: GqlContext): unknown {
  const repo = obj.__repo as Repo;
  const pull = obj.__pull as Pull;
  switch (field.name) {
    case 'id': return globalId('PullRequest', [repo.id, pull.number]);
    case 'number': return pull.number;
    case 'title': return pull.title;
    case 'state': return pullState(pull);
    case 'body': return pull.body;
    case 'headRefName': return pull.headRef;
    case 'baseRefName': return pull.baseRef;
    case 'headRef': return { __typename: 'Ref', __name: pull.headRef, __target: pull.headSha };
    case 'baseRef': return { __typename: 'Ref', __name: pull.baseRef, __target: pull.baseSha };
    case 'mergeable': {
      const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
      const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
      if (!headTip || !baseTip) return 'UNKNOWN';
      return hasMergeConflict(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
    }
    case 'merged': return pull.merged;
    case 'createdAt': case 'updatedAt': return TRIAL_NOW_ISO;
    case 'mergedAt': return pull.mergedAt;
    case 'mergeCommit': return pull.mergeCommitSha ? { __typename: 'Commit', oid: pull.mergeCommitSha, message: '' } : null;
    case 'author': return userObj(pull.user, VIEWER_ID);
    case 'files': {
      const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
      const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
      const mergeBase = repo.mergeBase(headTip, baseTip);
      const baseTree = mergeBase ? repo.commit(mergeBase)?.tree ?? '' : repo.commit(baseTip)?.tree ?? '';
      const headTree = repo.commit(headTip)?.tree ?? '';
      const changes = diffTrees(repo, baseTree, headTree);
      const nodes = changes.map((c) => ({ __typename: 'PullRequestFile', __path: c.filename, __additions: c.additions, __deletions: c.deletions, __status: c.status === 'added' ? 'ADDED' : c.status === 'removed' ? 'DELETED' : 'CHANGED' }));
      const conn = connectionOf(nodes, typeof args.first === 'number' ? args.first : undefined, typeof args.after === 'string' ? args.after : undefined);
      conn.__typename = 'PullRequestFileConnection';
      return conn;
    }
    case 'repository': return repoObj(repo);
    default: return null;
  }
}

function resolveUser(obj: GqlObj, field: FieldSel, _args: Record<string, unknown>, _ctx: GqlContext): unknown {
  switch (field.name) {
    case 'id': return globalId('User', [obj.__id as number]);
    case 'login': return obj.__login;
    case 'name': return obj.name;
    case 'email': return obj.email;
    case 'avatarUrl': return '';
    default: return null;
  }
}

function findRepoById(ctx: GqlContext, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const repoId = parseInt(decoded.parts[0], 10);
  return [...ctx.store.repos.values()].find((r) => r.id === repoId) ?? null;
}

function createIssueInternal(ctx: GqlContext, repo: Repo, title: string, body: string): Issue {
  const issue: Issue = {
    id: ctx.store.nextObjectId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [],
    user: VIEWER_LOGIN,
    seq: ctx.store.nextIssueSeq++,
    comments: [],
  };
  repo.issues.push(issue);
  repo.issuesByNumber.set(issue.number, issue);
  return issue;
}

function createPullInternal(ctx: GqlContext, repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
  const headSha = repo.branchTip(head);
  const baseSha = repo.branchTip(base);
  if (!headSha || !baseSha) return null;
  const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head);
  if (existing) return null;
  const pull: Pull = {
    id: ctx.store.nextObjectId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    user: VIEWER_LOGIN,
    seq: ctx.store.nextIssueSeq++,
  };
  repo.pulls.push(pull);
  repo.pullsByNumber.set(pull.number, pull);
  return pull;
}

function mergePullInternal(ctx: GqlContext, repo: Repo, pull: Pull): boolean {
  void ctx;
  if (pull.state !== 'open') return false;
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  if (!headTip || !baseTip) return false;
  if (hasMergeConflict(repo, baseTip, headTip)) return false;
  const headTree = repo.commit(headTip)?.tree ?? '';
  const author = authorLine(TRIAL_NOW_EPOCH);
  const commitData = buildCommit(headTree, [baseTip], author, author, `${pull.title} (#${pull.number})`);
  const mergeSha = repo.putObject('commit', commitData);
  repo.setRef(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = TRIAL_NOW_ISO;
  pull.mergeCommitSha = mergeSha;
  return true;
}

function resolveMutation(_obj: GqlObj, field: FieldSel, args: Record<string, unknown>, ctx: GqlContext): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repo = findRepoById(ctx, String(input.repositoryId ?? ''));
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.', path: [field.name] });
        throw new FieldError();
      }
      const title = String(input.title ?? '');
      if (!title) {
        ctx.errors.push({ message: 'A title is required to create an issue.', path: [field.name] });
        throw new FieldError();
      }
      const issue = createIssueInternal(ctx, repo, title, String(input.body ?? ''));
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) };
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (!decoded || decoded.kind !== 'Issue') {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.', path: [field.name] });
        throw new FieldError();
      }
      const repo = [...ctx.store.repos.values()].find((r) => r.id === parseInt(decoded.parts[0], 10));
      const issue = repo?.issuesByNumber.get(parseInt(decoded.parts[1], 10));
      if (!repo || !issue) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.', path: [field.name] });
        throw new FieldError();
      }
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueObj(repo, issue) };
    }
    case 'createPullRequest': {
      const repo = findRepoById(ctx, String(input.repositoryId ?? ''));
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.', path: [field.name] });
        throw new FieldError();
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const pull = createPullInternal(ctx, repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      if (!pull) {
        ctx.errors.push({ message: 'Could not create pull request: head or base branch does not exist, or a pull request already exists for this head branch.', path: [field.name] });
        throw new FieldError();
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) };
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (!decoded || decoded.kind !== 'PullRequest') {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.', path: [field.name] });
        throw new FieldError();
      }
      const repo = [...ctx.store.repos.values()].find((r) => r.id === parseInt(decoded.parts[0], 10));
      const pull = repo?.pullsByNumber.get(parseInt(decoded.parts[1], 10));
      if (!repo || !pull) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.', path: [field.name] });
        throw new FieldError();
      }
      if (!mergePullInternal(ctx, repo, pull)) {
        ctx.errors.push({ message: 'Pull request could not be merged: it is closed or has merge conflicts.', path: [field.name] });
        throw new FieldError();
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
    }
    case 'addComment': {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (!decoded || decoded.kind !== 'Issue') {
        ctx.errors.push({ message: 'Could not resolve to a subject with the id provided.', path: [field.name] });
        throw new FieldError();
      }
      const repo = [...ctx.store.repos.values()].find((r) => r.id === parseInt(decoded.parts[0], 10));
      const issue = repo?.issuesByNumber.get(parseInt(decoded.parts[1], 10));
      if (!repo || !issue) {
        ctx.errors.push({ message: 'Could not resolve to a subject with the id provided.', path: [field.name] });
        throw new FieldError();
      }
      const body = String(input.body ?? '');
      const comment = { id: ctx.store.nextObjectId++, body, user: VIEWER_LOGIN, seq: ctx.store.nextIssueSeq++ };
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'Edge', node: { __typename: 'IssueComment', __gid: globalId('IssueComment', [repo.id, comment.id]), __body: body, __user: VIEWER_LOGIN }, cursor: cursorFor(issue.comments.length - 1) },
        subject: issueObj(repo, issue),
      };
    }
    default: {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".`, path: [field.name] });
      throw new FieldError();
    }
  }
}

// Expand fragment spreads and inline fragments into a flat selection list,
// honouring type conditions against the runtime object type.
function expandSelections(selections: Sel[], obj: GqlObj, ctx: GqlContext): FieldSel[] {
  const out: FieldSel[] = [];
  for (const sel of selections) {
    if (sel.kind === 'field') out.push(sel);
    else if (sel.kind === 'spread') {
      const frag = ctx.fragments[sel.name];
      if (frag) out.push(...expandSelections(frag.selections, obj, ctx));
    } else if (sel.kind === 'inline') {
      if (!sel.typeCondition || sel.typeCondition === obj.__typename) out.push(...expandSelections(sel.selections, obj, ctx));
    }
  }
  return out;
}

function executeSelections(obj: GqlObj, selections: Sel[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of expandSelections(selections, obj, ctx)) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = obj.__typename;
      continue;
    }
    const errorsBefore = ctx.errors.length;
    try {
      const value = resolveField(obj, field, ctx);
      if (ctx.errors.length > errorsBefore) {
        out[key] = null;
        continue;
      }
      out[key] = field.selections && value !== null && typeof value === 'object' && !Array.isArray(value)
        ? executeSelections(value as GqlObj, field.selections, ctx)
        : Array.isArray(value)
          ? value.map((item) => (field.selections && item !== null && typeof item === 'object' ? executeSelections(item as GqlObj, field.selections, ctx) : item))
          : value;
      if (ctx.errors.length > errorsBefore) out[key] = null;
    } catch (e) {
      if (e instanceof FieldError) out[key] = null;
      else throw e;
    }
  }
  return out;
}

export interface GqlResult {
  data: Record<string, unknown> | null;
  errors?: GqlError[];
}

export function executeOperation(store: Store, op: Operation, variables: Record<string, unknown>, fragments: Record<string, { typeCondition: string; selections: Sel[] }>): GqlResult {
  const ctx: GqlContext = { store, variables, fragments, errors: [] };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObj = { __typename: rootType };
  const data: Record<string, unknown> = {};
  const errorsBefore = ctx.errors.length;
  for (const field of expandSelections(op.selections, root, ctx)) {
    const key = field.alias ?? field.name;
    const before = ctx.errors.length;
    try {
      const value = resolveField(root, field, ctx);
      if (ctx.errors.length > before) {
        data[key] = null;
        continue;
      }
      data[key] = field.selections && value !== null && typeof value === 'object' && !Array.isArray(value)
        ? executeSelections(value as GqlObj, field.selections, ctx)
        : Array.isArray(value)
          ? value.map((item) => (field.selections && item !== null && typeof item === 'object' ? executeSelections(item as GqlObj, field.selections, ctx) : item))
          : value;
      if (ctx.errors.length > before) data[key] = null;
    } catch (e) {
      if (e instanceof FieldError) data[key] = null;
      else throw e;
    }
  }
  void errorsBefore;
  const result: GqlResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export function handleGraphql(store: Store, body: unknown): { status: number; body: unknown } {
  const runOne = (opBody: unknown): GqlResult => {
    if (typeof opBody !== 'object' || opBody === null || typeof (opBody as Record<string, unknown>).query !== 'string') {
      return { data: null, errors: [{ message: 'A query is required.' }] };
    }
    const rec = opBody as Record<string, unknown>;
    try {
      const doc = new Parser(tokenize(rec.query as string)).parseDocument();
      const variables = (rec.variables ?? {}) as Record<string, unknown>;
      const operationName = typeof rec.operationName === 'string' ? rec.operationName : null;
      let op = doc.operations[0];
      if (operationName) {
        const named = doc.operations.find((o) => o.name === operationName);
        if (named) op = named;
      }
      if (!op) return { data: null, errors: [{ message: 'No operation found in document.' }] };
      return executeOperation(store, op, variables, doc.fragments);
    } catch (e) {
      return { data: null, errors: [{ message: (e as Error).message }] };
    }
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((b) => runOne(b)) };
  }
  return { status: 200, body: runOne(body) };
}
