// The Model Context Protocol endpoint (JSON-RPC 2.0 over streamable HTTP).
// Speaks both eras the suite accepts: the modern 2026-07-28 `server/discover`
// and the legacy `initialize` handshake. `tools/call` requires the bearer
// token; the other methods are lenient. A malformed body is HTTP 400 / -32700.

import type { Store } from './store.ts';
import { VIEWER } from './store.ts';
import { createIssueInRepo, createPullInRepo, issueObject, mergePullInRepo, pullJson, repoJson } from './rest.ts';

export interface McpResult {
  status: number;
  body: string;
  contentType: string;
}

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), contentType: 'application/json' };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), contentType: 'application/json' };
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findRepo(store: Store, owner: string, repo: string): { repo: import('./store.ts').Repo } | { error: string } {
  if (owner !== VIEWER.login) return { error: `repository ${owner}/${repo} does not exist` };
  const found = store.getRepo(owner, repo);
  if (!found) return { error: `repository ${owner}/${repo} does not exist` };
  return { repo: found };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return toolError(`Unknown tool: ${name}`);
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return toolError(`Missing required argument(s): ${missing.join(', ')}`);

  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return toolError('invalid repository name');
    if (store.getRepo(VIEWER.login, repoName)) return toolError('Repository already exists');
    const repo = store.createRepo(repoName, {
      private: args.private === true,
      description: typeof args.description === 'string' ? args.description : '',
    });
    return toolResult(repoJson(repo));
  }
  if (name === 'get_repo') {
    const found = findRepo(store, String(args.owner), String(args.repo));
    if ('error' in found) return toolError(found.error);
    return toolResult(repoJson(found.repo));
  }
  if (name === 'create_issue') {
    const found = findRepo(store, String(args.owner), String(args.repo));
    if ('error' in found) return toolError(found.error);
    const created = createIssueInRepo(store, found.repo, {
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
    });
    if ('error' in created) return toolError(`create_issue failed: ${created.error.status}`);
    return toolResult(issueObject(found.repo, created.issue));
  }
  if (name === 'list_issues') {
    const found = findRepo(store, String(args.owner), String(args.repo));
    if ('error' in found) return toolError(found.error);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const issues = found.repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return toolResult({ issues: issues.map((issue) => issueObject(found.repo, issue)) });
  }
  if (name === 'create_pull_request') {
    const found = findRepo(store, String(args.owner), String(args.repo));
    if ('error' in found) return toolError(found.error);
    const created = createPullInRepo(store, found.repo, {
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      head: String(args.head),
      base: String(args.base),
    });
    if ('error' in created) return toolError(`create_pull_request failed: ${created.error.status}`);
    return toolResult(pullJson(store, found.repo, created.pull));
  }
  if (name === 'merge_pull_request') {
    const found = findRepo(store, String(args.owner), String(args.repo));
    if ('error' in found) return toolError(found.error);
    const number = Number(args.pull_number);
    const pull = found.repo.pulls.find((entry) => entry.number === number);
    if (!pull) return toolError(`pull request #${number} does not exist`);
    const merged = mergePullInRepo(store, found.repo, pull);
    if ('error' in merged) return toolError(`merge_pull_request failed: ${merged.error.status}`);
    return toolResult(pullJson(store, found.repo, pull));
  }
  return toolError(`Unknown tool: ${name}`);
}

/** POST /mcp. `authorization` is the request's Authorization header (or undefined). */
export function handleMcp(store: Store, bodyText: string, authorization: string | undefined, expectedToken: string): McpResult {
  let request: unknown;
  try {
    request = JSON.parse(bodyText);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(request)) return rpcError(null, -32600, 'Invalid Request', 400);
  const id = request.id;
  const method = request.method;
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');
  // A notification (no id) needs no JSON-RPC answer.
  if (id === undefined) {
    if (method === 'notifications/initialized') return { status: 202, body: '', contentType: 'application/json' };
    return { status: 202, body: '', contentType: 'application/json' };
  }
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'DiscoverResult',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = LEGACY_VERSIONS.includes(wanted) ? wanted : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    // Authentication is decided before any tool exists.
    const token = authorization !== undefined && authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    const authed = expectedToken === '' ? token !== '' : token === expectedToken;
    if (!authed) return rpcError(id, -32000, 'Unauthorized', 401);
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (name === '') return rpcError(id, -32602, 'Invalid params: tools/call needs a tool name');
    if (TOOLS.find((entry) => entry.name === name) === undefined) {
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    const result = callTool(store, name, args);
    return rpcResult(id, result);
  }
  if (method === 'notifications/initialized') {
    return rpcResult(id, {});
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
