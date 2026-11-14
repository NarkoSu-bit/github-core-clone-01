// GitHub REST v3 handlers, over the shared store. Every reply is JSON; every
// error body carries a string `message`. Ownership: a repo belongs to the token's
// login (the viewer); the same name under another login is 404, never 403.

import type { Issue, Label, Pull, Repo, Store } from './store.ts';
import { ENTRY_ISO_DATE, VIEWER } from './store.ts';
import {
  ZERO_OID,
  branchTip,
  buildCommit,
  buildTreeFromFlat,
  diffTrees,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  refTip,
  storeObject,
} from './gitproto.ts';

export interface RestResult {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export function jsonResult(status: number, value: unknown, headers?: Record<string, string>): RestResult {
  return { status, body: JSON.stringify(value), headers };
}

export function errorResult(status: number, message: string): RestResult {
  return { status, body: JSON.stringify({ message }) };
}

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: ENTRY_ISO_DATE,
    updated_at: ENTRY_ISO_DATE,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: '' };
}

export function buildIssueJson(repo: Repo, issue: Issue): string {
  const labels = issue.labels.map((name) => {
    const label = repo.labels.get(name);
    return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed', description: '' };
  });
  return JSON.stringify({
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: userJson(),
    created_at: ENTRY_ISO_DATE,
    updated_at: ENTRY_ISO_DATE,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  });
}

/** The cached REST JSON for one issue (rebuilt when the issue changes). */
export function issueJson(repo: Repo, issue: Issue): string {
  if (issue.jsonCache === null) issue.jsonCache = buildIssueJson(repo, issue);
  return issue.jsonCache;
}

export function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return JSON.parse(issueJson(repo, issue)) as Record<string, unknown>;
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: ENTRY_ISO_DATE };
  const epoch = Number(match[3]);
  const date = Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : ENTRY_ISO_DATE;
  return { name: match[1] ?? '', email: match[2] ?? '', date };
}

export function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  const author = parseIdentity(parsed.author);
  const committer = parseIdentity(parsed.committer);
  return {
    sha: oid,
    commit: {
      // The stored object ends the message with a newline; the API answers it without.
      message: parsed.message.replace(/\n$/, ''),
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: parsed.tree },
    },
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
    parents: parsed.parents.map((sha) => ({ sha })),
  };
}

/** Resolve a ref query (branch name, commit oid, or the default branch) to a tip commit. */
export function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return branchTip(repo, repo.defaultBranch);
  if (isObjectId(ref) && repo.objects.has(ref)) return ref;
  const branch = branchTip(repo, ref);
  if (branch !== null) return branch;
  if (ref.startsWith('refs/heads/')) return refTip(repo, ref);
  return null;
}

/** The commits reachable from a tip, newest first (pre-order walk). */
export function listCommits(repo: Repo, tip: string | null): string[] {
  if (tip === null) return [];
  const out: string[] = [];
  const visited = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
  }
  return out;
}

// ---------------------------------------------------------------- shared operations (REST, GraphQL and MCP all use these)

export function createIssueInRepo(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; labels?: string[] },
): { issue: Issue } | { error: RestResult } {
  if (typeof input.title !== 'string' || input.title === '') return { error: errorResult(422, 'title is required') };
  const labels: string[] = [];
  for (const name of input.labels ?? []) {
    if (!repo.labels.has(name)) return { error: errorResult(422, `label ${name} does not exist`) };
    labels.push(name);
  }
  const issue: Issue = {
    id: store.nextId(),
    number: repo.nextIssueNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    comments: [],
    createdSeq: store.nextSeqNum(),
    jsonCache: null,
  };
  repo.issues.push(issue);
  return { issue };
}

export function createPullInRepo(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): { pull: Pull } | { error: RestResult } {
  if (typeof input.title !== 'string' || input.title === '') return { error: errorResult(422, 'title is required') };
  const headTip = branchTip(repo, input.head);
  const baseTip = branchTip(repo, input.base);
  if (headTip === null) return { error: errorResult(422, `head branch ${input.head} does not exist`) };
  if (baseTip === null) return { error: errorResult(422, `base branch ${input.base} does not exist`) };
  if (input.head === input.base) return { error: errorResult(422, 'head and base are the same branch') };
  for (const existing of repo.pulls) {
    if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
      return { error: errorResult(422, 'a pull request is already open for this head and base') };
    }
  }
  const pull: Pull = {
    id: store.nextId(),
    number: repo.nextPullNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: store.nextSeqNum(),
  };
  repo.pulls.push(pull);
  return { pull };
}

/** Whether a pull request can merge cleanly (no file changed differently on both sides). */
export function isPullMergeable(store: Store, repo: Repo, pull: Pull): boolean {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return false;
  if (headTip === baseTip) return true;
  const base = mergeBase(repo, headTip, baseTip);
  const headObj = repo.objects.get(headTip);
  const baseObj = repo.objects.get(baseTip);
  if (!headObj || !baseObj || headObj.type !== 'commit' || baseObj.type !== 'commit') return false;
  const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
  const headDiff = diffTrees(repo, baseTree, parseCommit(headObj.data).tree);
  const baseDiff = diffTrees(repo, baseTree, parseCommit(baseObj.data).tree);
  const baseByPath = new Map(baseDiff.map((d) => [d.path, d]));
  for (const change of headDiff) {
    const other = baseByPath.get(change.path);
    if (!other) continue;
    if (change.newOid !== other.newOid) return false;
  }
  return true;
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? ZERO_OID;
  const baseSha = branchTip(repo, pull.baseRef) ?? ZERO_OID;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: isPullMergeable(store, repo, pull),
    user: userJson(),
    created_at: ENTRY_ISO_DATE,
    updated_at: ENTRY_ISO_DATE,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Squash-merge a pull request onto its base branch. */
export function mergePullInRepo(
  store: Store,
  repo: Repo,
  pull: Pull,
): { sha: string; message: string } | { error: RestResult } {
  if (pull.state !== 'open') return { error: errorResult(405, 'pull request is not open') };
  if (!isPullMergeable(store, repo, pull)) return { error: errorResult(405, 'pull request is conflicted') };
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return { error: errorResult(422, 'head or base branch is missing') };
  const base = mergeBase(repo, headTip, baseTip);
  const headObj = repo.objects.get(headTip)!;
  const baseObj = repo.objects.get(baseTip)!;
  const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(headObj.data).tree;
  const headDiff = diffTrees(repo, baseTree, headTree);
  // Start from the base tree, apply the head's changes (relative to the merge base).
  const mergedFlat = new Map(baseTree === null ? [] : flattenTree(repo, parseCommit(baseObj.data).tree));
  for (const change of headDiff) {
    if (change.status === 'removed') mergedFlat.delete(change.path);
    else if (change.newOid !== null) mergedFlat.set(change.path, { mode: '100644', oid: change.newOid });
  }
  const newTree = buildTreeFromFlat(repo, mergedFlat);
  const timestamp = store.nextCommitTimestamp();
  const identity = `${VIEWER.name} <${VIEWER.email}> ${timestamp} +0000`;
  const message = `${pull.title} (#${pull.number})\n`;
  const commitData = buildCommit({
    tree: newTree,
    parents: [baseTip],
    author: identity,
    committer: identity,
    message,
  });
  const mergeSha = storeObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = ENTRY_ISO_DATE;
  pull.mergeCommitSha = mergeSha;
  return { sha: mergeSha, message };
}

/** Create a commit on a branch that writes (or deletes) one file. Returns the commit sha. */
export function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const tip = branchTip(repo, branch);
  const flat = tip === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
  let blobSha: string | null = null;
  if (content !== null) {
    blobSha = storeObject(repo, 'blob', content);
    flat.set(path, { mode: '100644', oid: blobSha });
  } else {
    flat.delete(path);
  }
  const newTree = buildTreeFromFlat(repo, flat);
  const timestamp = store.nextCommitTimestamp();
  const identity = `${VIEWER.name} <${VIEWER.email}> ${timestamp} +0000`;
  const commitData = buildCommit({
    tree: newTree,
    parents: tip === null ? [] : [tip],
    author: identity,
    committer: identity,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const commitSha = storeObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha };
}

// ---------------------------------------------------------------- routing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { page, perPage };
}

/** A GitHub-style Link header for a paged list (absolute URLs, same origin). */
function linkHeader(baseUrl: string, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const build = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${baseUrl}${path}?${q.toString()}`;
  };
  const parts: string[] = [];
  if (page < lastPage) parts.push(`<${build(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${build(page - 1)}>; rel="prev"`);
  parts.push(`<${build(1)}>; rel="first"`);
  parts.push(`<${build(lastPage)}>; rel="last"`);
  return parts.length > 0 ? parts.join(', ') : null;
}

function pageOf<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** The repo a route names, or the 404 for a wrong owner / missing repo. */
function findRepo(store: Store, owner: string, name: string): { repo: Repo } | { error: RestResult } {
  if (owner !== VIEWER.login) return { error: errorResult(404, 'Not Found') };
  const repo = store.getRepo(owner, name);
  if (!repo) return { error: errorResult(404, 'Not Found') };
  return { repo };
}

function lineCounts(repo: Repo, oid: string | null): number {
  if (oid === null) return 0;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'blob') return 0;
  const text = obj.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function countLinesDiff(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
  const oldText = oldOid === null ? '' : (repo.objects.get(oldOid)?.data.toString('utf8') ?? '');
  const newText = newOid === null ? '' : (repo.objects.get(newOid)?.data.toString('utf8') ?? '');
  if (oldOid === null) return { additions: lineCounts(repo, newOid), deletions: 0 };
  if (newOid === null) return { additions: 0, deletions: lineCounts(repo, oldOid) };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  const remaining = new Map(oldCount);
  for (const line of newLines) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) remaining.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const count of remaining.values()) deletions += count;
  return { additions, deletions };
}

/**
 * Route one REST v3 request. `segments` is the path after /api/v3, split on '/'
 * (a contents path keeps its slashes inside one trailing segment list).
 * Returns null when no route matches (the caller answers a JSON 404).
 */
export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): RestResult | null {
  const b = isRecord(body) ? body : {};

  // GET /api/v3/user — the token's login (the MCP setup reads it).
  if (method === 'GET' && segments.length === 1 && segments[0] === 'user') {
    return jsonResult(200, { ...userJson(), name: VIEWER.name, email: VIEWER.email });
  }

  // POST /api/v3/user/repos
  if (method === 'POST' && segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    const name = b.name;
    if (typeof name !== 'string' || name === '') return errorResult(422, 'name is required');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return errorResult(422, 'invalid repository name');
    if (store.getRepo(VIEWER.login, name)) return errorResult(422, 'Repository already exists');
    const repo = store.createRepo(name, {
      private: b.private === true,
      description: typeof b.description === 'string' ? b.description : '',
      defaultBranch: typeof b.default_branch === 'string' && b.default_branch !== '' ? b.default_branch : undefined,
    });
    return jsonResult(201, repoJson(repo));
  }

  // GET /api/v3/user/repos (paged)
  if (method === 'GET' && segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    const repos = store.listRepos(VIEWER.login);
    const { page, perPage } = parsePage(query);
    const headers: Record<string, string> = {};
    const link = linkHeader(baseUrl, '/api/v3/user/repos', query, page, perPage, repos.length);
    if (link !== null) headers.link = link;
    return jsonResult(200, pageOf(repos, page, perPage).map(repoJson), headers);
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeURIComponent(segments[1]!);
    const name = decodeURIComponent(segments[2]!);
    const rest = segments.slice(3);
    const found = findRepo(store, owner, name);
    if ('error' in found) return found.error;
    const repo = found.repo;

    // GET /repos/{o}/{r}
    if (rest.length === 0 && method === 'GET') return jsonResult(200, repoJson(repo));
    // PATCH /repos/{o}/{r}
    if (rest.length === 0 && method === 'PATCH') {
      if (typeof b.description === 'string') repo.description = b.description;
      if (b.private === true || b.private === false) repo.private = b.private;
      return jsonResult(200, repoJson(repo));
    }
    // DELETE /repos/{o}/{r}
    if (rest.length === 0 && method === 'DELETE') {
      store.deleteRepo(owner, name);
      return { status: 204, body: '' };
    }

    // POST /repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const ref = b.ref;
      const sha = b.sha;
      if (typeof ref !== 'string' || !ref.startsWith('refs/')) return errorResult(422, 'ref must start with refs/');
      if (typeof sha !== 'string' || !isObjectId(sha) || !repo.objects.has(sha)) return errorResult(422, 'sha does not exist');
      if (repo.refs.has(ref)) return errorResult(422, 'ref already exists');
      repo.refs.set(ref, sha);
      return jsonResult(201, { ref, object: { sha } });
    }
    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (rest.length === 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && method === 'GET') {
      const branch = decodeURIComponent(rest[3]!);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return errorResult(404, 'Not Found');
      return jsonResult(200, { ref: `refs/heads/${branch}`, object: { sha } });
    }

    // GET /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      return jsonResult(200, branches);
    }
    // GET /repos/{o}/{r}/branches/{branch}
    if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
      const branch = decodeURIComponent(rest[1]!);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return errorResult(404, 'Not Found');
      return jsonResult(200, { name: branch, commit: { sha } });
    }

    // GET /repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const tip = resolveRef(repo, query.get('sha'));
      const commits = listCommits(repo, tip)
        .map((oid) => commitJson(repo, oid))
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      const { page, perPage } = parsePage(query);
      return jsonResult(200, pageOf(commits, page, perPage));
    }

    // Contents: /repos/{o}/{r}/contents/{path...}
    if (rest.length >= 1 && rest[0] === 'contents') {
      const rawPath = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
      const path = rawPath.replace(/^\/+/, '');
      if (method === 'PUT') return putContents(store, repo, path, b);
      if (method === 'GET') return getContents(repo, path, query.get('ref'));
      if (method === 'DELETE') return deleteContents(store, repo, path, b);
      return null;
    }

    // POST /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels' && method === 'POST') {
      const name = b.name;
      if (typeof name !== 'string' || name === '') return errorResult(422, 'name is required');
      if (repo.labels.has(name)) return errorResult(422, 'label already exists');
      const label: Label = { id: store.nextId(), name, color: typeof b.color === 'string' ? b.color : 'ededed' };
      repo.labels.set(name, label);
      return jsonResult(201, labelJson(label));
    }
    // GET /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels' && method === 'GET') {
      return jsonResult(200, [...repo.labels.values()].map(labelJson));
    }

    // Issues
    if (rest.length >= 1 && rest[0] === 'issues') {
      return handleIssues(store, repo, rest.slice(1), method, query, b, baseUrl);
    }

    // Pulls
    if (rest.length >= 1 && rest[0] === 'pulls') {
      return handlePulls(store, repo, rest.slice(1), method, query, b);
    }
  }
  return null;
}

function putContents(store: Store, repo: Repo, path: string, b: Record<string, unknown>): RestResult {
  if (path === '') return errorResult(422, 'path is required');
  const message = bodyString(b.message);
  if (message === '') return errorResult(422, 'message is required');
  const content = b.content;
  if (typeof content !== 'string') return errorResult(422, 'content is required');
  const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
  let tip = branchTip(repo, branch);
  if (tip === null && branch !== repo.defaultBranch) {
    // A contents write on a branch that does not exist yet starts it from the default branch.
    const baseTip = branchTip(repo, repo.defaultBranch);
    if (baseTip !== null) {
      repo.refs.set(`refs/heads/${branch}`, baseTip);
      tip = baseTip;
    }
  }
  let blob: Buffer;
  try {
    blob = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return errorResult(422, 'content is not valid base64');
  }
  const isUpdate = tip !== null && flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree).has(path);
  if (isUpdate && typeof b.sha === 'string') {
    const current = flattenTree(repo, parseCommit(repo.objects.get(tip!)!.data).tree).get(path);
    if (!current || current.oid !== b.sha) return errorResult(409, 'sha does not match the current file');
  }
  const { commitSha, blobSha } = commitFile(store, repo, branch, path, blob, message);
  const size = blob.length;
  return jsonResult(isUpdate ? 200 : 201, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size, type: 'file', encoding: 'base64' },
    commit: { sha: commitSha, message },
  });
}

function getContents(repo: Repo, path: string, ref: string | null): RestResult {
  const tip = resolveRef(repo, ref);
  if (tip === null) return errorResult(404, 'Not Found');
  const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
  if (path === '') {
    return jsonResult(200, dirEntries(repo, treeOid, ''));
  }
  const flat = flattenTree(repo, treeOid);
  const file = flat.get(path);
  if (file) {
    const obj = repo.objects.get(file.oid);
    if (!obj || obj.type !== 'blob') return errorResult(404, 'Not Found');
    return jsonResult(200, {
      type: 'file',
      encoding: 'base64',
      size: obj.data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: obj.data.toString('base64'),
      sha: file.oid,
    });
  }
  // A directory: the entries directly under `path/`.
  const prefix = `${path}/`;
  const names = new Set<string>();
  for (const key of flat.keys()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    names.add(rest.split('/')[0]!);
  }
  if (names.size === 0) return errorResult(404, 'Not Found');
  const entries: Array<Record<string, unknown>> = [];
  for (const name of [...names].sort()) {
    const childPath = `${prefix}${name}`;
    const childFile = flat.get(childPath);
    if (childFile) {
      entries.push({ type: 'file', name, path: childPath, sha: childFile.oid, size: repo.objects.get(childFile.oid)?.data.length ?? 0 });
    } else {
      // A directory: find its tree oid by walking the tree to the child path.
      const oid = dirTreeOid(repo, treeOid, childPath);
      entries.push({ type: 'dir', name, path: childPath, sha: oid ?? '' });
    }
  }
  return jsonResult(200, entries);
}

function dirTreeOid(repo: Repo, treeOid: string, path: string): string | null {
  let current = treeOid;
  for (const segment of path.split('/')) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current;
}

function dirEntries(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  const entries: Array<Record<string, unknown>> = [];
  for (const entry of parseTree(obj.data)) {
    const childPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') entries.push({ type: 'dir', name: entry.name, path: childPath, sha: entry.oid });
    else {
      entries.push({ type: 'file', name: entry.name, path: childPath, sha: entry.oid, size: repo.objects.get(entry.oid)?.data.length ?? 0 });
    }
  }
  return entries;
}

function deleteContents(store: Store, repo: Repo, path: string, b: Record<string, unknown>): RestResult {
  if (path === '') return errorResult(422, 'path is required');
  const message = bodyString(b.message);
  if (message === '') return errorResult(422, 'message is required');
  const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (tip === null) return errorResult(404, 'Not Found');
  const flat = flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
  const current = flat.get(path);
  if (!current) return errorResult(404, 'Not Found');
  if (typeof b.sha === 'string' && b.sha !== current.oid) return errorResult(409, 'sha does not match the current file');
  const { commitSha } = commitFile(store, repo, branch, path, null, message);
  return jsonResult(200, { commit: { sha: commitSha, message } });
}

function handleIssues(
  store: Store,
  repo: Repo,
  rest: string[],
  method: string,
  query: URLSearchParams,
  b: Record<string, unknown>,
  baseUrl: string,
): RestResult | null {
  // POST /repos/{o}/{r}/issues
  if (rest.length === 0 && method === 'POST') {
    const labels = Array.isArray(b.labels) ? b.labels.filter((entry): entry is string => typeof entry === 'string') : [];
    const created = createIssueInRepo(store, repo, { title: bodyString(b.title), body: bodyString(b.body), labels });
    if ('error' in created) return created.error;
    return { status: 201, body: issueJson(repo, created.issue) };
  }
  // GET /repos/{o}/{r}/issues
  if (rest.length === 0 && method === 'GET') {
    const state = query.get('state') ?? 'open';
    const sort = query.get('sort') ?? 'created';
    const direction = query.get('direction') ?? 'desc';
    let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    if (sort === 'created') {
      issues = [...issues].sort((a, c) => (direction === 'asc' ? a.createdSeq - c.createdSeq : c.createdSeq - a.createdSeq));
    }
    const { page, perPage } = parsePage(query);
    const headers: Record<string, string> = {};
    const link = linkHeader(baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, query, page, perPage, issues.length);
    if (link !== null) headers.link = link;
    const pageItems = pageOf(issues, page, perPage);
    return { status: 200, body: `[${pageItems.map((issue) => issueJson(repo, issue)).join(',')}]`, headers };
  }
  if (rest.length >= 1) {
    const number = Number(rest[0]);
    if (!Number.isInteger(number) || number < 1) return errorResult(404, 'Not Found');
    const issue = repo.issues.find((entry) => entry.number === number);
    if (!issue) return errorResult(404, 'Not Found');
    // GET /repos/{o}/{r}/issues/{n}
    if (rest.length === 1 && method === 'GET') return { status: 200, body: issueJson(repo, issue) };
    // PATCH /repos/{o}/{r}/issues/{n}
    if (rest.length === 1 && method === 'PATCH') {
      if (typeof b.title === 'string' && b.title !== '') issue.title = b.title;
      if (typeof b.body === 'string') issue.body = b.body;
      if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
      if (Array.isArray(b.labels)) {
        const labels = b.labels.filter((entry): entry is string => typeof entry === 'string');
        for (const name of labels) if (!repo.labels.has(name)) return errorResult(422, `label ${name} does not exist`);
        issue.labels = labels;
      }
      issue.jsonCache = null;
      return { status: 200, body: issueJson(repo, issue) };
    }
    // POST /repos/{o}/{r}/issues/{n}/comments
    if (rest.length === 2 && rest[1] === 'comments' && method === 'POST') {
      const text = bodyString(b.body);
      if (text === '') return errorResult(422, 'body is required');
      const comment = { id: store.nextId(), body: text, user: VIEWER, createdSeq: store.nextSeqNum() };
      issue.comments.push(comment);
      issue.jsonCache = null;
      return jsonResult(201, { id: comment.id, body: comment.body, user: userJson(), created_at: ENTRY_ISO_DATE });
    }
    // GET /repos/{o}/{r}/issues/{n}/comments
    if (rest.length === 2 && rest[1] === 'comments' && method === 'GET') {
      return jsonResult(
        200,
        issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: userJson(), created_at: ENTRY_ISO_DATE })),
      );
    }
  }
  return null;
}

function handlePulls(
  store: Store,
  repo: Repo,
  rest: string[],
  method: string,
  query: URLSearchParams,
  b: Record<string, unknown>,
): RestResult | null {
  // POST /repos/{o}/{r}/pulls
  if (rest.length === 0 && method === 'POST') {
    const created = createPullInRepo(store, repo, {
      title: bodyString(b.title),
      body: bodyString(b.body),
      head: bodyString(b.head),
      base: bodyString(b.base),
    });
    if ('error' in created) return created.error;
    return jsonResult(201, pullJson(store, repo, created.pull));
  }
  // GET /repos/{o}/{r}/pulls
  if (rest.length === 0 && method === 'GET') {
    const state = query.get('state') ?? 'open';
    let pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
    pulls = [...pulls].sort((a, c) => c.createdSeq - a.createdSeq);
    const { page, perPage } = parsePage(query);
    return jsonResult(200, pageOf(pulls, page, perPage).map((pull) => pullJson(store, repo, pull)));
  }
  if (rest.length >= 1) {
    const number = Number(rest[0]);
    if (!Number.isInteger(number) || number < 1) return errorResult(404, 'Not Found');
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (!pull) return errorResult(404, 'Not Found');
    // GET /repos/{o}/{r}/pulls/{n}
    if (rest.length === 1 && method === 'GET') return jsonResult(200, pullJson(store, repo, pull));
    // GET /repos/{o}/{r}/pulls/{n}/files
    if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
      const headTip = branchTip(repo, pull.headRef);
      const baseTip = branchTip(repo, pull.baseRef);
      if (headTip === null || baseTip === null) return errorResult(422, 'head or base branch is missing');
      const base = mergeBase(repo, headTip, baseTip);
      const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
      const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
      const files = diffTrees(repo, baseTree, headTree).map((change) => {
        const counts = countLinesDiff(repo, change.oldOid, change.newOid);
        return {
          filename: change.path,
          status: change.status,
          additions: counts.additions,
          deletions: counts.deletions,
          changes: counts.additions + counts.deletions,
        };
      });
      return jsonResult(200, files);
    }
    // PUT /repos/{o}/{r}/pulls/{n}/merge
    if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
      const merged = mergePullInRepo(store, repo, pull);
      if ('error' in merged) return merged.error;
      return jsonResult(200, { merged: true, sha: merged.sha, message: merged.message });
    }
  }
  return null;
}
