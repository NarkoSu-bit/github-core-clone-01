// Git primitives: SHA-1 objects, pkt-lines, packfiles, tree/commit parsing,
// reachability, and the smart-HTTP upload-pack / receive-pack handlers.
// Plain packs only (no deltas are ever sent); the client never sends deltas either.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, Repo, Store } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 of `<type> <size>\0` + data. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object, returning its id. */
export function storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- pkt-line

export const PKT_LINE_MAX = 65520;
const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (payload.length > PKT_LINE_MAX_PAYLOAD) throw new Error('pkt-line payload too long');
  const head = Buffer.alloc(4);
  head.write((payload.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole pkt-line stream (the bodies here always arrive complete). */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + len > buf.length) throw new Error('truncated pkt-line');
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

/** Split a sideband-framed payload into band-1 data (pack/report) and band-2 progress. */
export function demuxSideband(packets: Pkt[]): { band1: Buffer[]; progress: string } {
  const band1: Buffer[] = [];
  let progress = '';
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload.length < 1) continue;
    const band = packet.payload[0];
    const data = packet.payload.subarray(1);
    if (band === 1) band1.push(Buffer.from(data));
    else if (band === 2) progress += data.toString('utf8');
    else if (band === 3) throw new Error(`server sideband error: ${data.toString('utf8').trim()}`);
    else throw new Error(`invalid sideband band ${band}`);
  }
  return { band1, progress };
}

// ---------------------------------------------------------------- packfile

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 packfile of plain (non-delta) objects, with a SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface RawPackEntry {
  typeCode: number;
  size: number;
  data: Buffer;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Parse a packfile into objects (plain entries only; the client never sends deltas). */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    if (typeCode === 6 || typeCode === 7) throw new Error('delta pack entries are not accepted');
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${offset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    offset = inflated.next;
    const oid = hashObject(type, inflated.data);
    if (!objects.has(oid)) objects.set(oid, { type, data: inflated.data });
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  return objects;
}

// ---------------------------------------------------------------- object parsing

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
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

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree entry (no space)');
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('malformed tree entry (no NUL)');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('malformed tree entry (short oid)');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Git tree-entry sort: directories compare as if their name ends in '/'. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(fields: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------- tree helpers

/** Flatten a tree (recursively) into path -> {mode, oid} for files. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') flattenTree(repo, entry.oid, `${prefix}${entry.name}/`, out);
    else out.set(`${prefix}${entry.name}`, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

function buildDir(repo: Repo, flat: Map<string, { mode: string; oid: string }>, prefix: string): string {
  const entries: TreeEntry[] = [];
  const subdirs = new Map<string, string[]>();
  for (const [path, file] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) entries.push({ mode: file.mode, name: rest, oid: file.oid });
    else {
      const dir = rest.slice(0, slash);
      let list = subdirs.get(dir);
      if (!list) {
        list = [];
        subdirs.set(dir, list);
      }
      list.push(path);
    }
  }
  for (const [dir] of subdirs) {
    const subOid = buildDir(repo, flat, `${prefix}${dir}/`);
    entries.push({ mode: '40000', name: dir, oid: subOid });
  }
  return storeObject(repo, 'tree', buildTree(entries));
}

/** Build (and store) the nested trees for a flat path map; returns the root tree oid. */
export function buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
  return buildDir(repo, flat, '');
}

// ---------------------------------------------------------------- reachability

/** The objects reachable from one commit (itself, trees, blobs, ancestors), memoized per repo. */
const reachCache = new WeakMap<Repo, Map<string, Set<string>>>();

function reachableFrom(repo: Repo, oid: string): Set<string> {
  let cache = reachCache.get(repo);
  if (!cache) {
    cache = new Map();
    reachCache.set(repo, cache);
  }
  const hit = cache.get(oid);
  if (hit) return hit;
  const out = new Set<string>();
  cache.set(oid, out);
  const obj = repo.objects.get(oid);
  if (!obj) return out;
  out.add(oid);
  if (obj.type === 'commit') {
    const parsed = parseCommit(obj.data);
    const treeSet = reachableFromTree(repo, parsed.tree);
    for (const item of treeSet) out.add(item);
    for (const parent of parsed.parents) {
      const parentSet = reachableFrom(repo, parent);
      for (const item of parentSet) out.add(item);
    }
  } else if (obj.type === 'tree') {
    const treeSet = reachableFromTree(repo, oid);
    for (const item of treeSet) out.add(item);
  } else if (obj.type === 'tag') {
    const parsed = parseTag(obj.data);
    const targetSet = reachableFrom(repo, parsed.object);
    for (const item of targetSet) out.add(item);
  }
  return out;
}

function reachableFromTree(repo: Repo, treeOid: string): Set<string> {
  const out = new Set<string>([treeOid]);
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    out.add(entry.oid);
    if (entry.mode === '40000') {
      const sub = reachableFromTree(repo, entry.oid);
      for (const item of sub) out.add(item);
    }
  }
  return out;
}

export interface Collected {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch must send: reachable from `wants`, minus reachable from `haves`,
 * optionally cut to `depth` generations. Also the shallow boundary that results, and the
 * previously-shallow boundaries that are now complete.
 */
export function collectObjects(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  depth: number | undefined,
  declaredShallow: string[],
): Collected {
  const objects = new Map<string, GitObject>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth === undefined) {
    const haveReach = new Set<string>();
    for (const have of haves) {
      const set = reachableFrom(repo, have);
      for (const oid of set) haveReach.add(oid);
    }
    for (const want of wants) {
      const set = reachableFrom(repo, want);
      for (const oid of set) {
        if (haveReach.has(oid)) continue;
        const obj = repo.objects.get(oid);
        if (obj) objects.set(oid, obj);
      }
    }
  } else {
    // Depth-limited walk: commits within `depth` generations of a want.
    const included = new Set<string>();
    const processed = new Set<string>();
    const queue: Array<{ oid: string; dist: number }> = [];
    const seenDist = new Map<string, number>();
    for (const want of wants) {
      if (!seenDist.has(want)) {
        seenDist.set(want, 0);
        queue.push({ oid: want, dist: 0 });
      }
    }
    const treeSeen = new Set<string>();
    while (queue.length > 0) {
      const { oid, dist } = queue.shift()!;
      if (dist >= depth) continue;
      if (processed.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type !== 'commit') {
        // A want that is a tag/tree/blob: send it (and its target) whole.
        processed.add(oid);
        const set = reachableFrom(repo, oid);
        for (const item of set) {
          if (haves.has(item)) continue;
          const target = repo.objects.get(item);
          if (target) objects.set(item, target);
        }
        continue;
      }
      processed.add(oid);
      const parsed = parseCommit(obj.data);
      // Send the commit (and its tree) unless the client already holds it.
      if (!haves.has(oid)) {
        included.add(oid);
        objects.set(oid, obj);
        const treeSet = reachableFromTree(repo, parsed.tree);
        for (const item of treeSet) {
          if (treeSeen.has(item)) continue;
          treeSeen.add(item);
          const treeObj = repo.objects.get(item);
          if (treeObj) objects.set(item, treeObj);
        }
      }
      // Walk on to the parents even through a held commit: a deepen extends
      // below what the client already has.
      for (const parent of parsed.parents) {
        if (!seenDist.has(parent) || seenDist.get(parent)! > dist + 1) {
          seenDist.set(parent, dist + 1);
          queue.push({ oid: parent, dist: dist + 1 });
        }
      }
    }
    // The shallow boundary: included commits whose parent is cut off (not included, not a have).
    for (const oid of included) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parsed = parseCommit(obj.data);
      for (const parent of parsed.parents) {
        if (!included.has(parent) && !haves.has(parent) && repo.objects.has(parent)) {
          shallow.push(oid);
          break;
        }
      }
    }
  }
  // Previously-shallow boundaries that are now complete: every parent is sent or held.
  const sentOrHeld = new Set<string>([...objects.keys(), ...haves]);
  for (const boundary of declaredShallow) {
    const obj = repo.objects.get(boundary);
    if (!obj || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    if (parsed.parents.every((parent) => sentOrHeld.has(parent))) unshallow.push(boundary);
  }
  return { objects, shallow, unshallow };
}

/** Whether `ancestor` is reachable from `commit` (following parents). */
export function isAncestor(repo: Repo, ancestor: string, commit: string): boolean {
  if (ancestor === commit) return true;
  const visited = new Set<string>();
  const stack = [commit];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    for (const parent of parsed.parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The newest common ancestor of two commits (minimising the sum of distances). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const distA = new Map<string, number>();
  const queueA: Array<{ oid: string; dist: number }> = [{ oid: a, dist: 0 }];
  while (queueA.length > 0) {
    const { oid, dist } = queueA.shift()!;
    if (distA.has(oid)) continue;
    distA.set(oid, dist);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queueA.push({ oid: parent, dist: dist + 1 });
  }
  const distB = new Map<string, number>();
  const queueB: Array<{ oid: string; dist: number }> = [{ oid: b, dist: 0 }];
  while (queueB.length > 0) {
    const { oid, dist } = queueB.shift()!;
    if (distB.has(oid)) continue;
    distB.set(oid, dist);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queueB.push({ oid: parent, dist: dist + 1 });
  }
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, da] of distA) {
    const db = distB.get(oid);
    if (db === undefined) continue;
    const score = da + db;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

// ---------------------------------------------------------------- diff

export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

/** The file-level diff between two trees (by blob oid). */
export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileDiff[] {
  const base = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map<string, { mode: string; oid: string }>();
  const head = headTreeOid ? flattenTree(repo, headTreeOid) : new Map<string, { mode: string; oid: string }>();
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  return out;
}

/** The commit a ref points at, or null. */
export function refTip(repo: Repo, ref: string): string | null {
  return repo.refs.get(ref) ?? null;
}

/** The tip commit oid of a branch name, or null. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

// ---------------------------------------------------------------- smart HTTP

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';

function v0Capabilities(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): string {
  const head = `refs/heads/${repo.defaultBranch}`;
  const base =
    service === 'git-upload-pack'
      ? `side-band-64k multi_ack thin-pack ofs-delta shallow agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  return `${base} symref=HEAD:${head}`;
}

function refLines(repo: Repo): Array<{ oid: string; name: string }> {
  const lines: Array<{ oid: string; name: string }> = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid) lines.push({ oid: headOid, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    lines.push({ oid, name });
    const obj = repo.objects.get(oid);
    if (name.startsWith('refs/tags/') && obj && obj.type === 'tag') {
      const parsed = parseTag(obj.data);
      if (parsed.type === 'commit' && isObjectId(parsed.object)) lines.push({ oid: parsed.object, name: `${name}^{}` });
    }
  }
  return lines;
}

/** GET {owner}/{repo}/info/refs?service=... — v0, or v2 for upload-pack when asked. */
export function handleInfoRefs(repo: Repo | undefined, service: string, gitProtocol: string | undefined): GitHttpResult {
  const notFound: GitHttpResult = { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('Not Found\n') };
  if (!repo) return notFound;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound;
  const contentType =
    service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    const lines = [
      `# service=${service}\n`,
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow filter\n',
      'object-format=sha1\n',
      'flush' as const,
    ];
    return { status: 200, contentType, body: encodePktLines(lines) };
  }
  const caps = v0Capabilities(repo, service);
  const lines: Array<string | 'flush'> = [`# service=${service}\n`];
  const refs = refLines(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, i) => {
      lines.push(i === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`);
    });
  }
  lines.push('flush');
  return { status: 200, contentType, body: encodePktLines(lines) };
}

const SIDEBAND_CHUNK = 65515;

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(off, Math.min(off + SIDEBAND_CHUNK, pack.length));
    out.push(Buffer.concat([Buffer.from([1]), chunk]));
  }
  return out;
}

function ackLines(repo: Repo, haves: string[]): string[] {
  if (haves.length === 0) return ['NAK\n'];
  const lines: string[] = [];
  for (const have of haves) if (repo.objects.has(have)) lines.push(`ACK ${have}\n`);
  if (lines.length === 0) lines.push('NAK\n');
  return lines;
}

function lsRefsResponse(repo: Repo, argLines: string[]): GitHttpResult {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of argLines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const lines: string[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  const matchPrefix = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (symrefs && prefixes.length === 0) {
    if (headOid) lines.push(`${headOid} HEAD symref-target:${headTarget}\n`);
    else if (unborn) lines.push(`unborn HEAD symref-target:${headTarget}\n`);
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!matchPrefix(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (name.startsWith('refs/tags/') && obj && obj.type === 'tag') {
        const parsed = parseTag(obj.data);
        if (parsed.type === 'commit' && isObjectId(parsed.object)) line += ` peeled:${parsed.object}`;
      }
    }
    lines.push(`${line}\n`);
  }
  const body = encodePktLines([...lines, 'flush' as const]);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

function fetchResponseV2(repo: Repo, argLines: string[]): GitHttpResult {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | undefined;
  for (const raw of argLines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const collected = collectObjects(repo, wants, new Set(haves), depth, shallowBoundaries);
  const parts: Buffer[] = [];
  parts.push(encodePktLines(['acknowledgments\n', ...ackLines(repo, haves), 'flush' as const]));
  if (collected.shallow.length > 0 || collected.unshallow.length > 0) {
    const lines: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of collected.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of collected.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    parts.push(encodePktLines(lines));
  }
  if (collected.objects.size > 0) {
    const pack = writePack(collected.objects.values());
    const items: Array<string | Buffer | 'flush'> = ['packfile\n', ...sidebandPackets(pack), 'flush'];
    parts.push(encodePktLines(items));
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function handleUploadPackV2(repo: Repo, packets: Pkt[]): GitHttpResult {
  let i = 0;
  const commandLines: string[] = [];
  while (i < packets.length && packets[i]!.kind === 'data') {
    commandLines.push(packets[i]!.payload.toString('utf8'));
    i += 1;
  }
  if (i >= packets.length || packets[i]!.kind !== 'delim') throw new Error('v2 request has no delim after the command');
  i += 1;
  const argLines: string[] = [];
  while (i < packets.length && packets[i]!.kind === 'data') {
    argLines.push(packets[i]!.payload.toString('utf8'));
    i += 1;
  }
  const command = (commandLines[0] ?? '').replace(/\n$/, '');
  if (command === 'command=ls-refs') return lsRefsResponse(repo, argLines);
  if (command === 'command=fetch') return fetchResponseV2(repo, argLines);
  throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
}

function handleUploadPackV0(repo: Repo, packets: Pkt[]): GitHttpResult {
  const sections: string[][] = [];
  let current: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push(current);
      current = [];
      continue;
    }
    if (packet.kind === 'data') current.push(packet.payload.toString('utf8'));
  }
  if (current.length > 0) sections.push(current);
  const wantSection = sections[0] ?? [];
  const haveSection = sections[1] ?? [];
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | undefined;
  for (const raw of wantSection) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      const space = rest.indexOf(' ');
      wants.push(space < 0 ? rest : rest.slice(0, space));
    } else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  for (const raw of haveSection) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const collected = collectObjects(repo, wants, new Set(haves), depth, shallowBoundaries);
  const parts: Buffer[] = [];
  const textLines = [...ackLines(repo, haves)];
  for (const oid of collected.shallow) textLines.push(`shallow ${oid}\n`);
  for (const oid of collected.unshallow) textLines.push(`unshallow ${oid}\n`);
  if (textLines.length > 0) parts.push(encodePktLines(textLines));
  if (collected.objects.size > 0) {
    const pack = writePack(collected.objects.values());
    const items: Array<string | Buffer | 'flush'> = [...sidebandPackets(pack), 'flush'];
    parts.push(encodePktLines(items));
  } else {
    parts.push(encodePktLines(['flush' as const]));
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

/** Identical fetches of an unchanged repo answer identically: the clone workload issues
 * the same shallow fetch 50 times, and re-deflating the same pack each time is pure waste.
 * The key names the repo, its ref tips and object count (so a push changes the key), and
 * the request body itself. Bounded, oldest-first eviction. */
const uploadPackCache = new Map<string, GitHttpResult>();
const UPLOAD_PACK_CACHE_MAX = 32;

function uploadPackCacheKey(repo: Repo, body: Buffer, isV2: boolean): string {
  const refs = [...repo.refs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ref, oid]) => `${ref}=${oid}`)
    .join(',');
  return `${repo.owner}/${repo.name}|${repo.objects.size}|${refs}|${isV2 ? 'v2' : 'v0'}|${body.toString('base64')}`;
}

/** POST {owner}/{repo}/git-upload-pack. Never throws: a malformed body is a 400. */
export function handleUploadPack(repo: Repo, body: Buffer, gitProtocol: string | undefined): GitHttpResult {
  try {
    const packets = decodePktLines(body);
    // v2 is named by the Git-Protocol header; a body that starts with `command=`
    // is v2 too, even if the header was dropped.
    const firstData = packets.find((packet) => packet.kind === 'data');
    const looksV2 = firstData !== undefined && firstData.payload.toString('utf8').startsWith('command=');
    const isV2 = gitProtocol === 'version=2' || looksV2;
    const cacheKey = uploadPackCacheKey(repo, body, isV2);
    const cached = uploadPackCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result = isV2 ? handleUploadPackV2(repo, packets) : handleUploadPackV0(repo, packets);
    if (result.status === 200) {
      if (uploadPackCache.size >= UPLOAD_PACK_CACHE_MAX) {
        const oldest = uploadPackCache.keys().next().value;
        if (oldest !== undefined) uploadPackCache.delete(oldest);
      }
      uploadPackCache.set(cacheKey, result);
    }
    return result;
  } catch (err) {
    return {
      status: 400,
      contentType: 'text/plain; charset=utf-8',
      body: Buffer.from(`bad request: ${String((err as Error).message).replace(/[\r\n]+/g, ' ')}\n`),
    };
  }
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function applyPushCommand(repo: Repo, cmd: PushCommand, unpackOk: boolean): { ok: boolean; reason: string } {
  if (!unpackOk) return { ok: false, reason: 'unpack-failed' };
  if (!isObjectId(cmd.oldOid) || !isObjectId(cmd.newOid)) return { ok: false, reason: 'bad-object-id' };
  const current = repo.refs.get(cmd.ref);
  if (cmd.newOid === ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'not-found' };
    if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) return { ok: false, reason: 'old-mismatch' };
    repo.refs.delete(cmd.ref);
    return { ok: true, reason: '' };
  }
  if (!repo.objects.has(cmd.newOid)) return { ok: false, reason: 'missing-object' };
  if (cmd.oldOid === ZERO_OID) {
    if (current !== undefined) return { ok: false, reason: 'already-exists' };
    repo.refs.set(cmd.ref, cmd.newOid);
    return { ok: true, reason: '' };
  }
  if (current === undefined) return { ok: false, reason: 'not-found' };
  if (cmd.oldOid !== current) return { ok: false, reason: 'old-mismatch' };
  if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(cmd.ref, cmd.newOid);
  return { ok: true, reason: '' };
}

/** POST {owner}/{repo}/git-receive-pack. Unpacks first, then applies ref updates per-ref. */
export function handleReceivePack(repo: Repo, body: Buffer): GitHttpResult {
  const contentType = 'application/x-git-receive-pack-result';
  try {
    const commands: PushCommand[] = [];
    let caps = '';
    let offset = 0;
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('truncated pkt-line');
      const lenText = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error('bad pkt-line length in push');
      const len = parseInt(lenText, 16);
      if (len === 0) {
        offset += 4;
        break;
      }
      if (len === 1 || len === 2) {
        offset += 4;
        continue;
      }
      if (offset + len > body.length) throw new Error('truncated pkt-line in push');
      let text = body.subarray(offset + 4, offset + len).toString('utf8');
      offset += len;
      if (commands.length === 0) {
        const nul = text.indexOf('\0');
        if (nul >= 0) {
          caps = text.slice(nul + 1);
          text = text.slice(0, nul);
        }
      }
      const trimmed = text.replace(/\n$/, '');
      const parts = trimmed.split(' ');
      if (parts.length < 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) {
        throw new Error(`bad push command ${JSON.stringify(trimmed.slice(0, 60))}`);
      }
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    const packBytes = body.subarray(offset);
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        const objects = readPack(packBytes);
        for (const [oid, obj] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      } catch (err) {
        unpackOk = false;
        unpackDetail = String((err as Error).message).replace(/[\r\n]+/g, ' ').slice(0, 120);
      }
    }
    const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
    for (const cmd of commands) {
      const result = applyPushCommand(repo, cmd, unpackOk);
      reportLines.push(result.ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${result.reason}\n`);
    }
    const reportText = reportLines.join('');
    let responseBody: Buffer;
    if (caps.includes('side-band-64k')) {
      const reportBuf = Buffer.from(reportText, 'utf8');
      const items: Array<string | Buffer | 'flush'> = [];
      for (let off = 0; off < reportBuf.length; off += SIDEBAND_CHUNK) {
        items.push(Buffer.concat([Buffer.from([1]), reportBuf.subarray(off, Math.min(off + SIDEBAND_CHUNK, reportBuf.length))]));
      }
      items.push('flush');
      responseBody = encodePktLines(items);
    } else {
      responseBody = encodePktLines([...reportLines, 'flush' as const]);
    }
    return { status: 200, contentType, body: responseBody };
  } catch (err) {
    return {
      status: 400,
      contentType: 'text/plain; charset=utf-8',
      body: Buffer.from(`bad request: ${String((err as Error).message).replace(/[\r\n]+/g, ' ')}\n`),
    };
  }
}
