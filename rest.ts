// REST v3 surface: /api/v3/*.
//
// The store is shared with GraphQL and MCP, so objects created here read
// back identically over the other surfaces. Every reply is JSON with a
// non-empty X-GitHub-Request-Id (added by app.ts) and an error body of
// {"message": ...} for failures.

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
import { commitFileChange } from './git.ts';

export interface Resp {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface RestContext {
  store: Store;
  origin: string;
  method: string;
  segments: string[];
  path: string;
  query: URLSearchParams;
  body: unknown;
}

function json(status: number, body: unknown, headers?: Record<string, string>): Resp {
  return { status, body, headers };
}

function err(status: number, message: string): Resp {
  return { status, body: { message } };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function globalId(kind: string, parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: globalId('User', [VIEWER_ID]),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER_LOGIN}`,
    html_url: `https://github.com/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
  };
}

export function repoJson(ctx: RestContext, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', [repo.id]),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, node_id: globalId('User', [repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0]), avatar_url: '', type: 'User', site_admin: false },
    private: repo.priv,
    html_url: `https://github.com/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `${ctx.origin}/api/v3/repos/${repo.fullName}`,
    clone_url: `${ctx.origin}/${repo.fullName}.git`,
    git_url: `git://${ctx.origin}/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    homepage: null,
    language: null,
    topics: [],
    visibility: repo.priv ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
    pushed_at: TRIAL_NOW_ISO,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    forks: 0,
    open_issues: 0,
    watchers: 0,
    size: 0,
  };
}

export function issueJson(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', [repo.id, issue.number]),
    url: `${ctx.origin}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `${ctx.origin}/api/v3/repos/${repo.fullName}`,
    labels_url: `${ctx.origin}/api/v3/repos/${repo.fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `${ctx.origin}/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    events_url: `${ctx.origin}/api/v3/repos/${repo.fullName}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: { login: issue.user, id: issue.user === VIEWER_LOGIN ? VIEWER_ID : 0, node_id: globalId('User', [issue.user === VIEWER_LOGIN ? VIEWER_ID : 0]), avatar_url: '', type: 'User', site_admin: false },
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { id: 0, node_id: globalId('Label', [repo.id, name]), url: `${ctx.origin}/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(name)}`, name, color: l ? l.color : 'ffffff', default: false, description: '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
    closed_at: issue.state === 'closed' ? TRIAL_NOW_ISO : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function mergeableOf(repo: Repo, pull: Pull): boolean {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (!headTip || !baseTip) return false;
  return !hasMergeConflict(repo, baseTip, headTip);
}

export function pullJson(ctx: RestContext, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', [repo.id, pull.number]),
    url: `${ctx.origin}/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.fullName}/pull/${pull.number}.patch`,
    issue_url: `${ctx.origin}/api/v3/repos/${repo.fullName}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: { login: pull.user, id: pull.user === VIEWER_LOGIN ? VIEWER_ID : 0, node_id: globalId('User', [pull.user === VIEWER_LOGIN ? VIEWER_ID : 0]), avatar_url: '', type: 'User', site_admin: false },
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
    closed_at: pull.state === 'closed' ? TRIAL_NOW_ISO : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? mergeableOf(repo, pull) : null,
    mergeable_state: pull.state === 'open' ? (mergeableOf(repo, pull) ? 'clean' : 'dirty') : 'unknown',
    merged_by: null,
    commits_url: `${ctx.origin}/api/v3/repos/${repo.fullName}/pulls/${pull.number}/commits`,
    review_comments_url: `${ctx.origin}/api/v3/repos/${repo.fullName}/pulls/${pull.number}/comments`,
    review_comment_url: `${ctx.origin}/api/v3/repos/${repo.fullName}/pulls/comments{/number}`,
    comments_url: `${ctx.origin}/api/v3/repos/${repo.fullName}/issues/${pull.number}/comments`,
    statuses_url: `${ctx.origin}/api/v3/repos/${repo.fullName}/statuses/${pull.headSha}`,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' }, repo: repoJson(ctx, repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' }, repo: repoJson(ctx, repo) },
    author_association: 'OWNER',
    draft: false,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; perPage: number; pageNum: number; total: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNum, total: items.length };
}

function linkHeader(ctx: RestContext, total: number, perPage: number, pageNum: number): string | undefined {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (pageNum >= lastPage) return undefined;
  const url = new URL(ctx.origin + ctx.path);
  for (const [k, v] of ctx.query) if (k !== 'page' && k !== 'per_page') url.searchParams.set(k, v);
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('page', String(pageNum + 1));
  return `<${url.toString()}>; rel="next"`;
}

function listResp(ctx: RestContext, items: unknown[], query: URLSearchParams): Resp {
  const p = paginate(items, query);
  const link = linkHeader(ctx, p.total, p.perPage, p.pageNum);
  return json(200, p.page, link ? { Link: link } : undefined);
}

function lookupRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return null;
  if (repo.owner !== owner) return null;
  return repo;
}

function commitJson(ctx: RestContext, repo: Repo, sha: string): Record<string, unknown> | null {
  const c = repo.commit(sha);
  if (!c) return null;
  const parsePerson = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (!m) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO };
    return { name: m[1], email: m[2], date: new Date(parseInt(m[3], 10) * 1000).toISOString().replace('.000Z', 'Z') };
  };
  const author = parsePerson(c.author);
  const committer = parsePerson(c.committer);
  return {
    sha,
    node_id: globalId('Commit', [repo.id, sha]),
    commit: {
      author,
      committer,
      message: c.message,
      tree: { sha: c.tree, url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/trees/${c.tree}` },
      url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `${ctx.origin}/api/v3/repos/${repo.fullName}/commits/${sha}`,
    html_url: `https://github.com/${repo.fullName}/commit/${sha}`,
    comments_url: `${ctx.origin}/api/v3/repos/${repo.fullName}/commits/${sha}/comments`,
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', [VIEWER_ID]), avatar_url: '', type: 'User', site_admin: false },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', [VIEWER_ID]), avatar_url: '', type: 'User', site_admin: false },
    parents: c.parents.map((p) => ({ sha: p, url: `${ctx.origin}/api/v3/repos/${repo.fullName}/commits/${p}`, html_url: `https://github.com/${repo.fullName}/commit/${p}` })),
  };
}

export function handleRest(ctx: RestContext): Resp {
  const { method, segments } = ctx;
  const seg = segments;
  // Root and meta.
  if (seg.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, {
      current_user_url: `${ctx.origin}/api/v3/user`,
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: `${ctx.origin}/api/v3/authorizations`,
      code_search_url: `${ctx.origin}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
      commit_search_url: `${ctx.origin}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
      emails_url: `${ctx.origin}/api/v3/user/emails`,
      emojis_url: `${ctx.origin}/api/v3/emojis`,
      events_url: `${ctx.origin}/api/v3/events`,
      feeds_url: `${ctx.origin}/api/v3/feeds`,
      followers_url: `${ctx.origin}/api/v3/user/followers`,
      following_url: `${ctx.origin}/api/v3/user/following{/target}`,
      gists_url: `${ctx.origin}/api/v3/gists{/gist_id}`,
      hub_url: `${ctx.origin}/api/v3/hub`,
      issue_search_url: `${ctx.origin}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
      issues_url: `${ctx.origin}/api/v3/issues`,
      keys_url: `${ctx.origin}/api/v3/user/keys`,
      label_search_url: `${ctx.origin}/api/v3/search/labels?q={query}{&page,per_page,sort,order}`,
      notifications_url: `${ctx.origin}/api/v3/notifications`,
      organization_url: `${ctx.origin}/api/v3/orgs/{org}`,
      organization_repositories_url: `${ctx.origin}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
      organization_teams_url: `${ctx.origin}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${ctx.origin}/api/v3/gists/public`,
      rate_limit_url: `${ctx.origin}/api/v3/rate_limit`,
      repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${ctx.origin}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
      current_user_repositories_url: `${ctx.origin}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${ctx.origin}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${ctx.origin}/api/v3/gists/starred`,
      user_url: `${ctx.origin}/api/v3/users/{user}`,
      user_organizations_url: `${ctx.origin}/api/v3/users/{user}/orgs`,
      user_repositories_url: `${ctx.origin}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${ctx.origin}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
    }, { 'X-OAuth-Scopes': 'repo, read:org', 'X-Accepted-OAuth-Scopes': 'repo, read:org' });
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, {
      verifiable_password_authentication: false,
      installed_version: '1.0.0',
      version: '1.0.0',
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      git: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
    });
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, userJson());
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const repos = ctx.store.viewerRepos();
      return listResp(ctx, repos.map((r) => repoJson(ctx, r)), ctx.query);
    }
    if (method === 'POST') {
      if (!isObj(ctx.body)) return err(422, 'Validation Failed');
      const name = str(ctx.body.name);
      if (!name) return err(422, 'Validation Failed: name is required');
      if (ctx.store.getRepo(VIEWER_LOGIN, name)) return err(422, 'Repository creation failed: name already exists on this account');
      const repo = ctx.store.createRepo(
        VIEWER_LOGIN,
        name,
        ctx.body.private === true,
        str(ctx.body.description),
        str(ctx.body.default_branch, 'main'),
      );
      return json(201, repoJson(ctx, repo));
    }
    return err(404, 'Not Found');
  }
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = decodeURIComponent(seg[1]);
    const name = decodeURIComponent(seg[2]);
    const repo = lookupRepo(ctx, owner, name);
    if (!repo) return err(404, 'Not Found');
    const rest = seg.slice(3);
    // /repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(ctx, repo));
      if (method === 'PATCH') {
        if (!isObj(ctx.body)) return err(422, 'Validation Failed');
        if (typeof ctx.body.description === 'string') repo.description = ctx.body.description;
        if (typeof ctx.body.private === 'boolean') repo.priv = ctx.body.private;
        if (typeof ctx.body.default_branch === 'string' && ctx.body.default_branch) repo.defaultBranch = ctx.body.default_branch;
        return json(200, repoJson(ctx, repo));
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }
    // branches
    if (rest[0] === 'branches') {
      if (method !== 'GET') return err(404, 'Not Found');
      if (rest.length === 1) {
        const branches: Record<string, unknown>[] = [];
        for (const [ref, sha] of repo.refs) {
          if (!ref.startsWith('refs/heads/')) continue;
          const branch = ref.slice('refs/heads/'.length);
          branches.push({ name: branch, commit: { sha, url: `${ctx.origin}/api/v3/repos/${repo.fullName}/commits/${sha}` }, protected: false });
        }
        branches.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
        return json(200, branches);
      }
      const branch = rest.slice(1).map(decodeURIComponent).join('/');
      const sha = repo.branchTip(branch);
      if (!sha) return err(404, 'Branch not found');
      return json(200, { name: branch, commit: { sha, url: `${ctx.origin}/api/v3/repos/${repo.fullName}/commits/${sha}` }, protected: false });
    }
    // commits
    if (rest[0] === 'commits') {
      if (method !== 'GET') return err(404, 'Not Found');
      if (rest.length === 1) {
        const ref = ctx.query.get('sha');
        let tip: string | undefined;
        if (ref) {
          tip = repo.branchTip(ref) ?? (repo.getObject(ref) ? ref : undefined);
        } else {
          tip = repo.branchTip(repo.defaultBranch);
        }
        if (!tip) return err(404, 'No commits yet');
        const walked = repo.walkCommits(tip, 1000);
        const items = walked.map((s) => commitJson(ctx, repo, s)).filter((x): x is Record<string, unknown> => x !== null);
        return listResp(ctx, items, ctx.query);
      }
      const sha = rest[1];
      const item = commitJson(ctx, repo, sha);
      if (!item) return err(404, 'Not Found');
      return json(200, item);
    }
    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        if (!isObj(ctx.body)) return err(422, 'Validation Failed');
        const ref = str(ctx.body.ref);
        const sha = str(ctx.body.sha);
        if (!ref.startsWith('refs/') || !sha) return err(422, 'Validation Failed');
        if (!repo.commit(sha)) return err(422, 'Validation Failed: sha is not a commit');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.setRef(ref, sha);
        return json(201, { ref, node_id: globalId('Ref', [repo.id, ref]), url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/refs/${ref.slice(5)}`, object: { sha, type: 'commit', url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          const all: Record<string, unknown>[] = [];
          for (const [ref, sha] of repo.refs) {
            if (ref === 'HEAD') continue;
            all.push({ ref, node_id: globalId('Ref', [repo.id, ref]), url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/refs/${ref.slice(5)}`, object: { sha, type: 'commit', url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
          }
          return json(200, all);
        }
        const ref = 'refs/' + rest.slice(2).map(decodeURIComponent).join('/');
        const sha = repo.refs.get(ref);
        if (!sha) return err(404, 'Not Found');
        return json(200, { ref, node_id: globalId('Ref', [repo.id, ref]), url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/refs/${ref.slice(5)}`, object: { sha, type: 'commit', url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
      }
      return err(404, 'Not Found');
    }
    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decodeURIComponent).join('/');
      if (method === 'GET') return contentsGet(ctx, repo, path);
      if (method === 'PUT') return contentsPut(ctx, repo, path);
      if (method === 'DELETE') return contentsDelete(ctx, repo, path);
      return err(404, 'Not Found');
    }
    // labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'GET') {
        return json(200, [...repo.labels.values()].map((l) => ({ id: 0, node_id: globalId('Label', [repo.id, l.name]), url: `${ctx.origin}/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(l.name)}`, name: l.name, color: l.color, default: false, description: '' })));
      }
      if (method === 'POST') {
        if (!isObj(ctx.body)) return err(422, 'Validation Failed');
        const name = str(ctx.body.name);
        if (!name) return err(422, 'Validation Failed: name is required');
        const color = str(ctx.body.color, 'ffffff');
        const existing = repo.labels.get(name);
        if (existing) return json(201, { id: 0, node_id: globalId('Label', [repo.id, name]), url: `${ctx.origin}/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(name)}`, name, color: existing.color, default: false, description: '' });
        repo.labels.set(name, { name, color });
        return json(201, { id: 0, node_id: globalId('Label', [repo.id, name]), url: `${ctx.origin}/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(name)}`, name, color, default: false, description: '' });
      }
      return err(404, 'Not Found');
    }
    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          let items = repo.issues.slice();
          if (state !== 'all') items = items.filter((i) => i.state === state);
          if (sort === 'created') items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          return listResp(ctx, items.map((i) => issueJson(ctx, repo, i)), ctx.query);
        }
        if (method === 'POST') {
          if (!isObj(ctx.body)) return err(422, 'Validation Failed');
          const title = str(ctx.body.title);
          if (!title) return err(422, 'Validation Failed: title is required');
          const labels: string[] = [];
          if (Array.isArray(ctx.body.labels)) {
            for (const l of ctx.body.labels) {
              const name = typeof l === 'string' ? l : isObj(l) ? str(l.name) : '';
              if (!name) continue;
              if (!repo.labels.has(name)) return err(422, `Validation Failed: label "${name}" does not exist`);
              labels.push(name);
            }
          }
          const issue: Issue = {
            id: ctx.store.nextObjectId++,
            number: repo.nextNumber++,
            title,
            body: str(ctx.body.body),
            state: 'open',
            labels,
            user: VIEWER_LOGIN,
            seq: ctx.store.nextIssueSeq++,
            comments: [],
          };
          repo.issues.push(issue);
          repo.issuesByNumber.set(issue.number, issue);
          return json(201, issueJson(ctx, repo, issue));
        }
        return err(404, 'Not Found');
      }
      const num = parseInt(rest[1], 10);
      if (!Number.isFinite(num)) return err(404, 'Not Found');
      const issue = repo.issuesByNumber.get(num);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!issue) return err(404, 'Not Found');
          return json(200, issueJson(ctx, repo, issue));
        }
        if (method === 'PATCH') {
          if (!issue) return err(404, 'Not Found');
          if (!isObj(ctx.body)) return err(422, 'Validation Failed');
          if (typeof ctx.body.title === 'string') issue.title = ctx.body.title;
          if (typeof ctx.body.body === 'string') issue.body = ctx.body.body;
          if (ctx.body.state === 'open' || ctx.body.state === 'closed') issue.state = ctx.body.state;
          if (Array.isArray(ctx.body.labels)) {
            const labels: string[] = [];
            for (const l of ctx.body.labels) {
              const name = typeof l === 'string' ? l : isObj(l) ? str(l.name) : '';
              if (!name) continue;
              if (!repo.labels.has(name)) return err(422, `Validation Failed: label "${name}" does not exist`);
              labels.push(name);
            }
            issue.labels = labels;
          }
          return json(200, issueJson(ctx, repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') {
          return json(200, issue.comments.map((c) => commentJson(ctx, repo, issue, c)));
        }
        if (method === 'POST') {
          if (!isObj(ctx.body)) return err(422, 'Validation Failed');
          const body = str(ctx.body.body);
          if (!body) return err(422, 'Validation Failed: body is required');
          const comment = { id: ctx.store.nextObjectId++, body, user: VIEWER_LOGIN, seq: ctx.store.nextIssueSeq++ };
          issue.comments.push(comment);
          return json(201, commentJson(ctx, repo, issue, comment));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }
    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let items = repo.pulls.slice();
          if (state !== 'all') items = items.filter((p) => p.state === state);
          items.sort((a, b) => b.seq - a.seq);
          return listResp(ctx, items.map((p) => pullJson(ctx, repo, p)), ctx.query);
        }
        if (method === 'POST') {
          if (!isObj(ctx.body)) return err(422, 'Validation Failed');
          const title = str(ctx.body.title);
          if (!title) return err(422, 'Validation Failed: title is required');
          const headRaw = str(ctx.body.head);
          const baseRaw = str(ctx.body.base);
          const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
          const base = baseRaw.includes(':') ? baseRaw.slice(baseRaw.indexOf(':') + 1) : baseRaw;
          const headSha = repo.branchTip(head);
          const baseSha = repo.branchTip(base);
          if (!headSha || !baseSha) return err(422, 'Validation Failed: head or base branch does not exist');
          const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head);
          if (existing) return err(422, 'Validation Failed: a pull request already exists for this head branch');
          const pull: Pull = {
            id: ctx.store.nextObjectId++,
            number: repo.nextNumber++,
            title,
            body: str(ctx.body.body),
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
          return json(201, pullJson(ctx, repo, pull));
        }
        return err(404, 'Not Found');
      }
      const num = parseInt(rest[1], 10);
      if (!Number.isFinite(num)) return err(404, 'Not Found');
      const pull = repo.pullsByNumber.get(num);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!pull) return err(404, 'Not Found');
          return json(200, pullJson(ctx, repo, pull));
        }
        return err(404, 'Not Found');
      }
      if (rest[2] === 'files' && rest.length === 3) {
        if (method !== 'GET') return err(404, 'Not Found');
        if (!pull) return err(404, 'Not Found');
        const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
        const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
        const mergeBase = repo.mergeBase(headTip, baseTip);
        const baseTree = mergeBase ? repo.commit(mergeBase)?.tree ?? '' : repo.commit(baseTip)?.tree ?? '';
        const headTree = repo.commit(headTip)?.tree ?? '';
        const changes = diffTrees(repo, baseTree, headTree);
        return json(200, changes.map((c) => ({ sha: '', filename: c.filename, status: c.status, additions: c.additions, deletions: c.deletions, changes: c.changes, blob_url: '', raw_url: '', contents_url: '', patch: '' })));
      }
      if (rest[2] === 'merge' && rest.length === 3) {
        if (method !== 'PUT') return err(404, 'Not Found');
        if (!pull) return err(404, 'Not Found');
        if (pull.state !== 'open') return err(405, 'Pull request is already closed');
        const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
        const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
        if (!headTip || !baseTip) return err(404, 'Not Found');
        if (hasMergeConflict(repo, baseTip, headTip)) return err(405, 'Pull request has merge conflicts');
        const headTree = repo.commit(headTip)?.tree ?? '';
        const author = authorLine(TRIAL_NOW_EPOCH);
        const message = `${pull.title} (#${pull.number})`;
        const commitData = buildCommit(headTree, [baseTip], author, author, message);
        const mergeSha = repo.putObject('commit', commitData);
        repo.setRef(`refs/heads/${pull.baseRef}`, mergeSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = TRIAL_NOW_ISO;
        pull.mergeCommitSha = mergeSha;
        return json(200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
      }
      return err(404, 'Not Found');
    }
  }
  return err(404, 'Not Found');
}

function commentJson(ctx: RestContext, repo: Repo, issue: Issue, c: { id: number; body: string; user: string }): Record<string, unknown> {
  return {
    id: c.id,
    node_id: globalId('IssueComment', [repo.id, c.id]),
    url: `${ctx.origin}/api/v3/repos/${repo.fullName}/issues/comments/${c.id}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${c.id}`,
    body: c.body,
    user: { login: c.user, id: c.user === VIEWER_LOGIN ? VIEWER_ID : 0, node_id: globalId('User', [c.user === VIEWER_LOGIN ? VIEWER_ID : 0]), avatar_url: '', type: 'User', site_admin: false },
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
    author_association: 'OWNER',
  };
}

function contentsGet(ctx: RestContext, repo: Repo, path: string): Resp {
  const ref = ctx.query.get('ref');
  const tip = ref ? repo.branchTip(ref) : repo.branchTip(repo.defaultBranch);
  if (!tip) return err(404, 'Not Found');
  const commit = repo.commit(tip);
  if (!commit) return err(404, 'Not Found');
  if (!path) {
    return json(200, dirListing(ctx, repo, commit.tree, ''));
  }
  const parts = path.split('/').filter((p) => p.length > 0);
  let treeOid = commit.tree;
  for (let i = 0; i < parts.length; i++) {
    const entries = repo.treeEntries(treeOid);
    const entry = entries.find((e) => e.name === parts[i]);
    if (!entry) return err(404, 'Not Found');
    if (i === parts.length - 1) {
      if (entry.mode === '40000') return json(200, dirListing(ctx, repo, entry.oid, path));
      const obj = repo.getObject(entry.oid);
      const data = obj ? obj.data : Buffer.alloc(0);
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: parts[i],
        path,
        content: data.toString('base64'),
        sha: entry.oid,
        url: `${ctx.origin}/api/v3/repos/${repo.fullName}/contents/${path}`,
        git_url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`,
        html_url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
        download_url: `${ctx.origin}/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
        _links: { git: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`, self: `${ctx.origin}/api/v3/repos/${repo.fullName}/contents/${path}`, html: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}` },
      });
    }
    if (entry.mode !== '40000') return err(404, 'Not Found');
    treeOid = entry.oid;
  }
  return err(404, 'Not Found');
}

function dirListing(ctx: RestContext, repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  const entries = repo.treeEntries(treeOid);
  return entries.map((e) => {
    const path = dirPath ? `${dirPath}/${e.name}` : e.name;
    const obj = e.mode === '40000' ? undefined : repo.getObject(e.oid);
    return {
      type: e.mode === '40000' ? 'dir' : 'file',
      size: obj ? obj.data.length : 0,
      name: e.name,
      path,
      sha: e.oid,
      url: `${ctx.origin}/api/v3/repos/${repo.fullName}/contents/${path}`,
      git_url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/blobs/${e.oid}`,
      html_url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
      download_url: `${ctx.origin}/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
      _links: { git: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/blobs/${e.oid}`, self: `${ctx.origin}/api/v3/repos/${repo.fullName}/contents/${path}`, html: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}` },
    };
  });
}

function contentsPut(ctx: RestContext, repo: Repo, path: string): Resp {
  if (!path) return err(422, 'Validation Failed');
  if (!isObj(ctx.body)) return err(422, 'Validation Failed');
  const contentB64 = str(ctx.body.content);
  const message = str(ctx.body.message, `Update ${path}`);
  const branch = str(ctx.body.branch, repo.defaultBranch);
  if (!contentB64) return err(422, 'Validation Failed: content is required');
  const content = Buffer.from(contentB64, 'base64');
  const tip = repo.branchTip(branch);
  const existed = tip ? fileBlobAt(repo, tip, path) : null;
  const sha = str(ctx.body.sha);
  if (sha && existed && sha !== existed) return err(409, 'Conflict: sha does not match the current file');
  const result = commitFileChange(repo, branch, path, content, message, TRIAL_NOW_EPOCH);
  const status = existed ? 200 : 201;
  return json(status, {
    content: { name: path.split('/').pop() ?? '', path, sha: result.blobSha, size: content.length, url: `${ctx.origin}/api/v3/repos/${repo.fullName}/contents/${path}`, git_url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/blobs/${result.blobSha}`, html_url: `https://github.com/${repo.fullName}/blob/${branch}/${path}`, download_url: `${ctx.origin}/${repo.fullName}/raw/${branch}/${path}`, type: 'file', encoding: 'base64', _links: { git: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/blobs/${result.blobSha}`, self: `${ctx.origin}/api/v3/repos/${repo.fullName}/contents/${path}`, html: `https://github.com/${repo.fullName}/blob/${branch}/${path}` } },
    commit: { sha: result.commitSha, node_id: globalId('Commit', [repo.id, result.commitSha]), message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO }, tree: { sha: result.treeSha, url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/trees/${result.treeSha}` }, url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/commits/${result.commitSha}`, html_url: `https://github.com/${repo.fullName}/commit/${result.commitSha}` },
  });
}

function contentsDelete(ctx: RestContext, repo: Repo, path: string): Resp {
  if (!path) return err(422, 'Validation Failed');
  if (!isObj(ctx.body)) return err(422, 'Validation Failed');
  const message = str(ctx.body.message, `Delete ${path}`);
  const branch = str(ctx.body.branch, repo.defaultBranch);
  const tip = repo.branchTip(branch);
  if (!tip) return err(404, 'Not Found');
  const existed = fileBlobAt(repo, tip, path);
  if (!existed) return err(404, 'Not Found');
  const sha = str(ctx.body.sha);
  if (sha && sha !== existed) return err(409, 'Conflict: sha does not match the current file');
  const result = commitFileChange(repo, branch, path, null, message, TRIAL_NOW_EPOCH);
  return json(200, {
    commit: { sha: result.commitSha, node_id: globalId('Commit', [repo.id, result.commitSha]), message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO }, tree: { sha: result.treeSha, url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/trees/${result.treeSha}` }, url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/commits/${result.commitSha}`, html_url: `https://github.com/${repo.fullName}/commit/${result.commitSha}` },
  });
}

function fileBlobAt(repo: Repo, tip: string, path: string): string | null {
  const commit = repo.commit(tip);
  if (!commit) return null;
  const files = repo.treeFiles(commit.tree);
  const f = files.get(path);
  return f ? f.oid : null;
}
