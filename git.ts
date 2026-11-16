// Git smart HTTP: pkt-line framing, pack reading/writing, upload-pack
// (protocol v2 and v0) and receive-pack (v0). Written from the git wire
// format itself; no git binary is used anywhere.
//
// Objects live in the repo store in memory. Packs we emit are plain (no
// deltas); packs we read resolve deltas of both kinds.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash as createHashNode } from 'node:crypto';
import {
  DEFAULT_BRANCH,
  ZERO_OID,
  authorLine,
  buildCommit,
  buildTree,
  objectId,
  parseCommit,
  type CommitInfo,
  type ObjectType,
  type Repo,
  type Store,
} from './store.ts';

export const GIT_AGENT = 'forge/1.0';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from('0000', 'utf8');
export const DELIM = Buffer.from('0001', 'utf8');
export const RESPONSE_END = Buffer.from('0002', 'utf8');

// Decode a whole buffer into packets. Each entry is {kind, payload} where
// kind is 'data' | 'flush' | 'delim' | 'end'. Anything after the first flush
// packet is returned as `rest` (raw bytes, used for the pack in receive-pack).
export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

export function decodePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.toString('ascii', off, off + 4);
    if (head === '0000') { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; break; }
    if (head === '0001') { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (head === '0002') { packets.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

export function pktLines(packets: Packet[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
}

// ---------------------------------------------------------------------------
// Pack reading
// ---------------------------------------------------------------------------

const TYPE_COMMIT = 1;
const TYPE_TREE = 2;
const TYPE_BLOB = 3;
const TYPE_TAG = 4;
const TYPE_OFS_DELTA = 6;
const TYPE_REF_DELTA = 7;

function typeCode(type: ObjectType): number {
  return type === 'commit' ? TYPE_COMMIT : type === 'tree' ? TYPE_TREE : type === 'blob' ? TYPE_BLOB : TYPE_TAG;
}

function typeName(code: number): ObjectType | null {
  return code === TYPE_COMMIT ? 'commit' : code === TYPE_TREE ? 'tree' : code === TYPE_BLOB ? 'blob' : code === TYPE_TAG ? 'tag' : null;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = delta[off++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[off++];
      if (op & 0x02) cpOff |= delta[off++] << 8;
      if (op & 0x04) cpOff |= delta[off++] << 16;
      if (op & 0x08) cpOff |= delta[off++] << 24;
      if (op & 0x10) cpSize = delta[off++];
      if (op & 0x20) cpSize |= delta[off++] << 8;
      if (op & 0x40) cpSize |= delta[off++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      outLen += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
      outLen += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  if (outLen !== dstSize) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}

export interface PackEntry {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

// Read a pack buffer into objects. Deltas resolve against other pack entries
// or objects already in the repo (thin packs).
export function readPack(pack: Buffer, repo: Repo): PackEntry[] {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const byOid = new Map<string, PackEntry>();
  const raw: { type: number; data: Buffer; baseOid?: string; baseOff?: number; off: number }[] = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOff = off;
    let byte = pack[off++];
    const type = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOff: number | undefined;
    if (type === TYPE_REF_DELTA) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (type === TYPE_OFS_DELTA) {
      let b = pack[off++];
      let base = b & 0x7f;
      while (b & 0x80) {
        b = pack[off++];
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      baseOff = entryOff - base;
    }
    const inflated = inflateSync(pack.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    off += inflated.engine.bytesWritten;
    raw.push({ type, data: inflated.buffer as Buffer, baseOid, baseOff, off: entryOff });
  }
  const resolve = (idx: number, seen: Set<number>): PackEntry => {
    const entry = raw[idx];
    const name = typeName(entry.type);
    if (name) {
      const oid = objectId(name, entry.data);
      let resolved = byOid.get(oid);
      if (!resolved) {
        resolved = { oid, type: name, data: entry.data };
        byOid.set(oid, resolved);
      }
      return resolved;
    }
    if (seen.has(idx)) throw new Error('delta cycle');
    seen.add(idx);
    let base: PackEntry | null = null;
    if (entry.baseOid !== undefined) {
      base = byOid.get(entry.baseOid) ?? null;
      if (!base) {
        const obj = repo.getObject(entry.baseOid);
        if (obj) base = { oid: entry.baseOid, type: obj.type, data: obj.data };
      }
      if (!base) {
        // Base may appear later in the pack: resolve all plain entries first.
        for (let j = 0; j < raw.length; j++) {
          if (typeName(raw[j].type)) resolve(j, new Set<number>());
        }
        base = byOid.get(entry.baseOid) ?? null;
      }
    } else if (entry.baseOff !== undefined) {
      const baseIdx = raw.findIndex((r) => r.off === entry.baseOff);
      if (baseIdx < 0) throw new Error('ofs-delta base not found');
      base = resolve(baseIdx, seen);
    }
    if (!base) throw new Error('delta base missing');
    const data = applyDelta(base.data, entry.data);
    const oid = objectId(base.type, data);
    let resolved = byOid.get(oid);
    if (!resolved) {
      resolved = { oid, type: base.type, data };
      byOid.set(oid, resolved);
    }
    return resolved;
  };
  const out: PackEntry[] = [];
  for (let i = 0; i < raw.length; i++) out.push(resolve(i, new Set<number>()));
  return out;
}

// Write a pack of plain objects. Entries are ordered by oid so the bytes
// are deterministic for a given object set.
export function writePack(entries: { type: ObjectType; data: Buffer }[]): Buffer {
  const sorted = entries.slice().sort((a, b) => {
    const oa = objectId(a.type, a.data);
    const ob = objectId(b.type, b.data);
    return oa < ob ? -1 : oa > ob ? 1 : 0;
  });
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(sorted.length, 8);
  const chunks: Buffer[] = [head];
  for (const e of sorted) {
    const type = typeCode(e.type);
    let size = e.data.length;
    const headerBytes: number[] = [];
    let first = (type << 4) | (size & 15);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headerBytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      headerBytes.push(b);
    }
    chunks.push(Buffer.from(headerBytes));
    chunks.push(deflateSync(e.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHashNode('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Reachability / shallow computation
// ---------------------------------------------------------------------------

export interface FetchPlan {
  objects: Map<string, { type: ObjectType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
  common: string[];
}

// Reachable objects from `wants`, limited by depth, minus objects held by
// the client (reachable from `haves`, truncated at the client's shallow
// boundaries). `depth` is undefined for a full fetch.
export function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | undefined,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  const wantSet = new Set<string>();
  const shallowOut: string[] = [];
  const commitQueue: { oid: string; dist: number }[] = [];
  for (const w of wants) {
    const c = repo.commit(w);
    if (c) commitQueue.push({ oid: w, dist: 0 });
    else {
      const obj = repo.getObject(w);
      if (obj) {
        wantSet.add(w);
        if (obj.type === 'tag') {
          const target = parseTagTarget(obj.data);
          if (target && repo.commit(target)) commitQueue.push({ oid: target, dist: 0 });
        }
      }
    }
  }
  const seenCommits = new Set<string>();
  while (commitQueue.length > 0) {
    const { oid, dist } = commitQueue.shift() as { oid: string; dist: number };
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const c = repo.commit(oid);
    if (!c) continue;
    wantSet.add(oid);
    const atLimit = depth !== undefined && dist + 1 >= depth;
    if (atLimit && c.parents.length > 0) shallowOut.push(oid);
    if (!atLimit) {
      for (const p of c.parents) if (!seenCommits.has(p)) commitQueue.push({ oid: p, dist: dist + 1 });
    }
  }
  // Include the full tree closure of every wanted commit.
  const wanted = new Set<string>(wantSet);
  const addTreeClosure = (treeOid: string): void => {
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const t = stack.pop() as string;
      if (wanted.has(t)) continue;
      wanted.add(t);
      for (const e of repo.treeEntries(t)) {
        if (e.mode === '40000') stack.push(e.oid);
        else wanted.add(e.oid);
      }
    }
  };
  for (const oid of wantSet) {
    const c = repo.commit(oid);
    if (c) addTreeClosure(c.tree);
  }
  // Held objects: reachable from haves, stopping at the client's shallow
  // boundaries (the boundary commit itself is held, its parents are not).
  const held = new Set<string>();
  const heldQueue: string[] = [];
  for (const h of haves) {
    if (repo.commit(h)) heldQueue.push(h);
    else if (repo.getObject(h)) held.add(h);
  }
  const heldSeen = new Set<string>();
  while (heldQueue.length > 0) {
    const oid = heldQueue.shift() as string;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const c = repo.commit(oid);
    if (!c) continue;
    held.add(oid);
    addHeldTreeClosure(repo, c.tree, held);
    if (!shallowSet.has(oid)) {
      for (const p of c.parents) if (!heldSeen.has(p)) heldQueue.push(p);
    }
  }
  const objects = new Map<string, { type: ObjectType; data: Buffer }>();
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (obj) objects.set(oid, obj);
  }
  const unshallow: string[] = [];
  for (const s of clientShallow) {
    if (!shallowOut.includes(s) && !held.has(s)) {
      // A boundary the client had that we are now deepening past.
      if (seenCommits.has(s)) unshallow.push(s);
    }
  }
  // Any previously shallow commit that is now fully reachable is unshallow.
  const common: string[] = [];
  for (const h of haves) {
    if (wantSet.has(h) || seenCommits.has(h)) common.push(h);
  }
  return { objects, shallow: shallowOut, unshallow, common };
}

function addHeldTreeClosure(repo: Repo, treeOid: string, held: Set<string>): void {
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const t = stack.pop() as string;
    if (held.has(t)) continue;
    held.add(t);
    for (const e of repo.treeEntries(t)) {
      if (e.mode === '40000') stack.push(e.oid);
      else held.add(e.oid);
    }
  }
}

// ---------------------------------------------------------------------------
// Advertisement
// ---------------------------------------------------------------------------

function refLinesV0(repo: Repo): { head: string; lines: string[] } {
  const lines: string[] = [];
  const headTarget = repo.refs.get('HEAD') ?? `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget) ?? ZERO_OID;
  lines.push(`${headOid} HEAD\0symref=HEAD:${headTarget} multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not filter agent=${GIT_AGENT}`);
  const refs = [...repo.refs.entries()].filter(([r]) => r !== 'HEAD').sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) {
    lines.push(`${oid} ${ref}`);
    if (ref.startsWith('refs/tags/')) {
      const obj = repo.getObject(oid);
      if (obj && obj.type === 'tag') {
        const peeled = parseTagTarget(obj.data);
        if (peeled) lines.push(`${peeled} ${ref}^{}`);
      }
    }
  }
  if (headOid === ZERO_OID) lines.push(`${ZERO_OID} capabilities^{}`);
  return { head: headOid, lines };
}

function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const m = /^object ([0-9a-f]{40})$/m.exec(text);
  return m ? m[1] : null;
}

function refLinesV2(repo: Repo, prefix: string | undefined, wantPeel: boolean, wantSymrefs: boolean, wantUnborn: boolean): string[] {
  const out: string[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  const headLine = headOid ? `${headOid} HEAD symref-target:${headTarget}` : `unborn HEAD symref-target:${headTarget}`;
  if (!prefix || 'HEAD'.startsWith(prefix)) out.push(headLine);
  const refs = [...repo.refs.entries()].filter(([r]) => r !== 'HEAD').sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) {
    if (prefix && !ref.startsWith(prefix)) continue;
    let line = `${oid} ${ref}`;
    if (wantSymrefs && ref === headTarget) line += ` symref-target:${headTarget}`;
    if (wantPeel && ref.startsWith('refs/tags/')) {
      const obj = repo.getObject(oid);
      if (obj && obj.type === 'tag') {
        const peeled = parseTagTarget(obj.data);
        if (peeled) line += ` peeled:${peeled}`;
      }
    }
    out.push(line);
  }
  void wantUnborn;
  return out;
}

export function uploadPackAdvertisementV2(repo: Repo): Buffer {
  const chunks: Buffer[] = [pktLine('version 2\n'), pktLine(`agent=${GIT_AGENT}\n`), pktLine('ls-refs=unborn\n'), pktLine('fetch=shallow filter\n'), pktLine('object-format=sha1\n'), FLUSH];
  return Buffer.concat(chunks);
}

export function uploadPackAdvertisementV0(repo: Repo): Buffer {
  const { lines } = refLinesV0(repo);
  const chunks: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH];
  for (const l of lines) chunks.push(pktLine(l + '\n'));
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

export function receivePackAdvertisement(repo: Repo): Buffer {
  const { lines } = refLinesV0(repo);
  const rest = lines.slice(1);
  const caps = `report-status report-status-v2 delete-refs side-band side-band-64k ofs-delta agent=${GIT_AGENT}`;
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget) ?? ZERO_OID;
  const headLine = `${headOid} HEAD\0symref=HEAD:${headTarget} ${caps}`;
  const chunks: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH, pktLine(headLine + '\n')];
  for (const l of rest) chunks.push(pktLine(l + '\n'));
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Sideband framing
// ---------------------------------------------------------------------------

export function sidebandWrap(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const max = 65515;
  for (let off = 0; off < pack.length; off += max) {
    const slice = pack.subarray(off, Math.min(pack.length, off + max));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Upload-pack request handling
// ---------------------------------------------------------------------------

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function lsRefsV2(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  let prefix: string | undefined;
  for (const line of lines) {
    const l = line.trim();
    if (l === 'peel') peel = true;
    else if (l === 'symrefs') symrefs = true;
    else if (l === 'unborn') unborn = true;
    else if (l.startsWith('ref-prefix ')) prefix = l.slice('ref-prefix '.length);
  }
  const out = refLinesV2(repo, prefix, peel, symrefs, unborn);
  const chunks: Buffer[] = out.map((l) => pktLine(l + '\n'));
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function fetchV2(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let deepenSince: string | undefined;
  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('want ')) wants.push(l.slice(5).trim());
    else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
    else if (l.startsWith('shallow ')) shallow.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) {
      const n = parseInt(l.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    } else if (l.startsWith('deepen-since ')) deepenSince = l.slice('deepen-since '.length).trim();
  }
  void deepenSince;
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const chunks: Buffer[] = [];
  // acknowledgments
  chunks.push(pktLine('acknowledgments\n'));
  if (plan.common.length === 0) chunks.push(pktLine('NAK\n'));
  else {
    for (const c of plan.common) chunks.push(pktLine(`ACK ${c}\n`));
    chunks.push(pktLine('ready\n'));
  }
  chunks.push(FLUSH);
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) chunks.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) chunks.push(pktLine(`unshallow ${s}\n`));
    chunks.push(FLUSH);
  }
  // packfile
  const cacheKey = `${repo.version}|${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth ?? ''}`;
  let pack = repo.packCache.get(cacheKey);
  if (!pack) {
    pack = writePack([...plan.objects.values()]);
    repo.packCache.set(cacheKey, pack);
  }
  chunks.push(pktLine('packfile\n'));
  chunks.push(sidebandWrap(pack));
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function fetchV0(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let deepenSince: string | undefined;
  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('want ')) wants.push(l.slice(5).trim());
    else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
    else if (l.startsWith('shallow ')) shallow.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) {
      const n = parseInt(l.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    } else if (l.startsWith('deepen-since ')) deepenSince = l.slice('deepen-since '.length).trim();
  }
  void deepenSince;
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const chunks: Buffer[] = [];
  for (const s of plan.shallow) chunks.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) chunks.push(pktLine(`unshallow ${s}\n`));
  if (plan.common.length === 0) chunks.push(pktLine('NAK\n'));
  else for (const c of plan.common) chunks.push(pktLine(`ACK ${c}\n`));
  const cacheKey = `v0|${repo.version}|${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth ?? ''}`;
  let pack = repo.packCache.get(cacheKey);
  if (!pack) {
    pack = writePack([...plan.objects.values()]);
    repo.packCache.set(cacheKey, pack);
  }
  chunks.push(sidebandWrap(pack));
  return Buffer.concat(chunks);
}

export function handleUploadPack(repo: Repo, body: Buffer, protocolVersion: string): GitHttpResult {
  const { packets } = decodePackets(body);
  const lines = pktLines(packets);
  if (lines.length === 0) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed git request' }), 'utf8') };
  }
  const command = lines[0].trim();
  if (protocolVersion === '2') {
    if (command === 'command=ls-refs') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsV2(repo, lines.slice(1)) };
    }
    if (command === 'command=fetch') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(repo, lines.slice(1)) };
    }
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'unknown command' }), 'utf8') };
  }
  // v0: lines are want/have/shallow/deepen, possibly split by flush into
  // two sections; decodePackets already gave us all data lines.
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0(repo, lines) };
}

// ---------------------------------------------------------------------------
// Receive-pack request handling
// ---------------------------------------------------------------------------

function commitInfoOf(repo: Repo, oid: string): CommitInfo | undefined {
  return repo.commit(oid);
}

export function handleReceivePack(repo: Repo, body: Buffer): GitHttpResult {
  const { packets, rest } = decodePackets(body);
  const lines = pktLines(packets);
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  const stored: PackEntry[] = [];
  if (rest.length > 0 && rest.subarray(0, 4).toString('ascii') === 'PACK') {
    try {
      stored.push(...readPack(rest, repo));
    } catch {
      // A bad pack still gets a report; refs are not moved.
      return reportResult(repo, lines, [], true);
    }
  }
  // Parse commands first so objects are available for fast-forward checks.
  const commands: { old: string; new: string; ref: string }[] = [];
  for (const line of lines) {
    const clean = line.replace(/\n$/, '');
    const nul = clean.indexOf('\0');
    const head = nul >= 0 ? clean.slice(0, nul) : clean;
    const parts = head.split(' ');
    if (parts.length >= 3) commands.push({ old: parts[0], new: parts[1], ref: parts.slice(2).join(' ') });
  }
  // Store unpacked objects even when a ref update is refused.
  for (const e of stored) {
    if (!repo.getObject(e.oid)) repo.putObject(e.type, e.data);
  }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let ok = true;
    let reason = '';
    if (cmd.new === ZERO_OID) {
      // Delete.
      if (cmd.old !== ZERO_OID && current !== cmd.old) { ok = false; reason = 'non-fast-forward'; }
      else if (current === undefined) { ok = false; reason = 'non-fast-forward'; }
    } else if (cmd.old === ZERO_OID) {
      // Create.
      if (current !== undefined) { ok = false; reason = 'non-fast-forward'; }
    } else {
      // Update: old must match and new must descend from old.
      if (current !== cmd.old) { ok = false; reason = 'non-fast-forward'; }
      else if (cmd.ref.startsWith('refs/tags/')) { ok = false; reason = 'non-fast-forward'; }
      else if (!isDescendant(repo, cmd.new, cmd.old)) { ok = false; reason = 'non-fast-forward'; }
    }
    if (ok) {
      if (cmd.new === ZERO_OID) repo.deleteRef(cmd.ref);
      else repo.setRef(cmd.ref, cmd.new);
    }
    results.push({ ref: cmd.ref, ok, reason });
  }
  return reportResult(repo, lines, results, false);
}

function isDescendant(repo: Repo, tip: string, ancestor: string): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = commitInfoOf(repo, oid);
    if (!c) return false;
    for (const p of c.parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

function reportResult(repo: Repo, _lines: string[], results: { ref: string; ok: boolean; reason: string }[], packError: boolean): GitHttpResult {
  void repo;
  let text = 'unpack ok\n';
  if (packError) text = 'unpack error\n';
  for (const r of results) {
    text += r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`;
  }
  const inner = pktLine(text);
  const outer = pktLine(Buffer.concat([Buffer.from([1]), inner]));
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat([outer, FLUSH]) };
}

// ---------------------------------------------------------------------------
// Contents commits (REST PUT/DELETE create real git commits)
// ---------------------------------------------------------------------------

export interface FileCommitResult {
  commitSha: string;
  blobSha: string | null;
  treeSha: string;
}

export function commitFileChange(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
  epoch: number,
): FileCommitResult {
  let tip = repo.branchTip(branch);
  if (tip === undefined) {
    // Branch does not exist yet: start it from the default branch tip.
    const baseTip = repo.branchTip(repo.defaultBranch);
    if (baseTip !== undefined) {
      repo.setRef(`refs/heads/${branch}`, baseTip);
      tip = baseTip;
    }
  }
  const baseTree = tip ? (repo.commit(tip)?.tree ?? '') : '';
  const files = repo.treeFiles(baseTree);
  let blobSha: string | null = null;
  if (content === null) {
    files.delete(path);
  } else {
    blobSha = repo.putObject('blob', content);
    files.set(path, { oid: blobSha, mode: '100644' });
  }
  const treeSha = repo.buildTreeFromFiles(files);
  const author = authorLine(epoch);
  const parents = tip ? [tip] : [];
  const commitData = buildCommit(treeSha, parents, author, author, message);
  const commitSha = repo.putObject('commit', commitData);
  repo.setRef(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha, treeSha };
}
