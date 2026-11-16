// Store: the in-memory data model for the forge.
// Repos, git objects, refs, issues, pull requests, labels and comments all
// live here and are shared by the REST, GraphQL and MCP surfaces, so every
// surface reads back exactly what another one wrote.
//
// Determinism: nothing here touches the wall clock. The trial clock is read
// once at startup from MAKEFUN_TRIAL_NOW and threaded through as fixed
// values; ordering is by insertion sequence counters, never by time.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';

// Trial clock: ISO-8601 UTC instant from the environment, parsed once.
// Fallback is the scenario epoch when the variable is absent.
const trialNowRaw = process.env.MAKEFUN_TRIAL_NOW ?? '';
const trialNowMs = Number.isFinite(Date.parse(trialNowRaw))
  ? Date.parse(trialNowRaw)
  : 1735689600000;
export const TRIAL_NOW_ISO = new Date(trialNowMs).toISOString().replace('.000Z', 'Z');
export const TRIAL_NOW_EPOCH = Math.floor(trialNowMs / 1000);

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  seq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  seq: number;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: string;
  seq: number;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.toString('utf8', off, sp);
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(name: string, mode: string): string {
  return mode === '40000' ? name + '/' : name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => {
    const ka = treeSortKey(a.name, a.mode);
    const kb = treeSortKey(b.name, b.mode);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`);
  lines.push(`committer ${committer}`);
  return Buffer.from(lines.join('\n') + '\n\n' + message, 'utf8');
}

export function authorLine(epoch: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
}

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

export class Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  commitInfo = new Map<string, CommitInfo>();
  treeCache = new Map<string, TreeEntry[]>();
  labels = new Map<string, Label>();
  issues: Issue[] = [];
  issuesByNumber = new Map<number, Issue>();
  pulls: Pull[] = [];
  pullsByNumber = new Map<number, Pull>();
  nextNumber = 1;
  nextCommentId = 1;
  version = 0;
  packCache = new Map<string, Buffer>();

  constructor(id: number, owner: string, name: string, priv: boolean, description: string, defaultBranch: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.priv = priv;
    this.description = description;
    this.defaultBranch = defaultBranch;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  putObject(type: ObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      if (type === 'commit') this.commitInfo.set(oid, parseCommit(data));
    }
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  treeEntries(oid: string): TreeEntry[] {
    let cached = this.treeCache.get(oid);
    if (cached) return cached;
    const obj = this.objects.get(oid);
    cached = obj && obj.type === 'tree' ? parseTree(obj.data) : [];
    this.treeCache.set(oid, cached);
    return cached;
  }

  commit(oid: string): CommitInfo | undefined {
    return this.commitInfo.get(oid);
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  setRef(ref: string, oid: string): void {
    this.refs.set(ref, oid);
    this.version++;
    this.packCache.clear();
  }

  deleteRef(ref: string): void {
    this.refs.delete(ref);
    this.version++;
    this.packCache.clear();
  }

  // Flatten a tree into path -> {oid, mode} for files (recursively).
  flatten(treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
    for (const e of this.treeEntries(treeOid)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') this.flatten(e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  }

  treeFiles(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (treeOid) this.flatten(treeOid, '', out);
    return out;
  }

  // Build a nested tree object from a flat path map; returns the root tree oid.
  buildTreeFromFiles(files: Map<string, { oid: string; mode: string }>): string {
    const build = (dir: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, f] of files) {
        if (!path.startsWith(dir)) continue;
        const rest = path.slice(dir.length);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: f.mode, name: rest, oid: f.oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const d of dirs) entries.push({ mode: '40000', name: d, oid: build(dir + d + '/') });
      return this.putObject('tree', buildTree(entries));
    };
    return build('');
  }

  // Walk commits newest-first from a tip (visited set, parents after the
  // commit itself). Used for GET /commits and merge-base.
  walkCommits(tip: string, limit: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const c = this.commitInfo.get(oid);
      if (!c) continue;
      out.push(oid);
      for (let i = c.parents.length - 1; i >= 0; i--) stack.push(c.parents[i]);
    }
    return out;
  }

  ancestors(tip: string): Set<string> {
    const out = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      out.add(oid);
      const c = this.commitInfo.get(oid);
      if (c) for (const p of c.parents) stack.push(p);
    }
    return out;
  }

  mergeBase(a: string, b: string): string | null {
    const ancA = this.ancestors(a);
    const queue: string[] = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancA.has(oid)) return oid;
      const c = this.commitInfo.get(oid);
      if (c) for (const p of c.parents) queue.push(p);
    }
    return null;
  }

  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    return this.ancestors(tip).has(ancestor);
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextObjectId = 1;
  nextIssueSeq = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}\0${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, priv: boolean, description: string, defaultBranch: string): Repo {
    const repo = new Repo(this.nextRepoId++, owner, name, priv, description, defaultBranch || DEFAULT_BRANCH);
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    return out;
  }
}

// Count changed lines between two texts with an LCS diff. Small files only;
// large inputs fall back to whole-file counts.
export function diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (a.length > 1200 || b.length > 1200) return { additions: b.length, deletions: a.length };
  const n = a.length;
  const m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { deletions++; i++; }
    else { additions++; j++; }
  }
  deletions += n - i;
  additions += m - j;
  return { additions, deletions };
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// Compare two trees and return file changes between them.
export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export function diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = repo.treeFiles(baseTree);
  const head = repo.treeFiles(headTree);
  const out: FileChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (!b && h) {
      const obj = repo.getObject(h.oid);
      const text = obj ? obj.data.toString('utf8') : '';
      const additions = countLines(text);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && !h) {
      const obj = repo.getObject(b.oid);
      const text = obj ? obj.data.toString('utf8') : '';
      const deletions = countLines(text);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b && h && b.oid !== h.oid) {
      const oldObj = repo.getObject(b.oid);
      const newObj = repo.getObject(h.oid);
      const d = diffLines(oldObj ? oldObj.data.toString('utf8') : '', newObj ? newObj.data.toString('utf8') : '');
      out.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
  }
  out.sort((x, y) => (x.filename < y.filename ? -1 : 1));
  return out;
}

// Three-way conflict test: a path changed on both sides of the merge-base
// to different blobs (or delete vs modify) is a conflict.
export function hasMergeConflict(repo: Repo, baseTip: string, headTip: string): boolean {
  const mergeBase = repo.mergeBase(headTip, baseTip);
  if (!mergeBase) return false;
  const baseCommit = repo.commit(mergeBase);
  if (!baseCommit) return false;
  const mb = repo.treeFiles(baseCommit.tree);
  const baseC = repo.commit(baseTip);
  const headC = repo.commit(headTip);
  if (!baseC || !headC) return false;
  const base = repo.treeFiles(baseC.tree);
  const head = repo.treeFiles(headC.tree);
  const paths = new Set<string>([...mb.keys(), ...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const m = mb.get(path);
    const b = base.get(path);
    const h = head.get(path);
    const changedBase = (b?.oid ?? null) !== (m?.oid ?? null);
    const changedHead = (h?.oid ?? null) !== (m?.oid ?? null);
    if (changedBase && changedHead && (b?.oid ?? null) !== (h?.oid ?? null)) return true;
  }
  return false;
}
