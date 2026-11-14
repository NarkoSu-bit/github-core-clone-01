// The entry's HTTP surface: git smart HTTP, REST v3, GraphQL v4 and the MCP endpoint,
// all served from one in-memory Store. The lifecycle (bind ephemeral port, register, wait for
// done) lives in main.ts and is unchanged.
//
// Routing:
//   GET  /healthz                       200 {"ok":true}, no auth.
//   GET  /api/v3  /api/v3/meta         200, no auth.
//   /{owner}/{repo}/info/refs         git smart-HTTP advertisement (auth).
//   /{owner}/{repo}/git-upload-pack    git fetch / clone (auth).
//   /{owner}/{repo}/git-receive-pack   git push (auth).
//   /api/v3/*                          REST v3 (auth).
//   POST /api/graphql                  GraphQL v4 (auth; a JSON array is answered as a batch).
//   POST /mcp                          MCP JSON-RPC (tools/call is authenticated inside).
// Every answer carries X-GitHub-Request-Id and is JSON, except the git binary bodies.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: string | Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  if (typeof body === 'string') {
    // A string body is written as-is; only its byte length is measured, no copy is made.
    res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body), ...headers });
    res.end(body);
    return;
  }
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

/** The request's bearer token matches the shop token (any non-empty token when none is set). */
function authed(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  return expectedToken === '' ? true : token === expectedToken;
}

/** Read the whole request body (a push pack can be large; the cap is generous). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestSeq = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      // Most requests carry no query string: split the path by hand and skip the URL parse.
      const rawUrl = req.url ?? '/';
      const qIndex = rawUrl.indexOf('?');
      const path = qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex);
      const search = qIndex < 0 ? new URLSearchParams() : new URLSearchParams(rawUrl.slice(qIndex + 1));
      const requestId = `req-${++requestSeq}`;
      const headers: Record<string, string> = { 'x-github-request-id': requestId };

      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, headers);
          return;
        }

        // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { ...headers, 'x-oauth-scopes': 'repo, read:org' });
          return;
        }

        // The API meta endpoint: the installed version.
        if (method === 'GET' && path === '/api/v3/meta') {
          sendJson(res, 200, { installed_version: '1.0.0' }, headers);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}/info/refs, git-upload-pack, git-receive-pack.
        // The client names the repo with a `.git` suffix (gitconf-foo.git); the store holds it without.
        // API and MCP paths never reach here (their prefix is checked first), so the regex
        // only runs for the git surface.
        const gitMatch =
          path.startsWith('/api/') || path === '/mcp'
            ? null
            : /^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]!);
          let repoName = decodeURIComponent(gitMatch[2]!);
          if (repoName.endsWith('.git')) repoName = repoName.slice(0, -'.git'.length);
          const action = gitMatch[3]!;
          if (!authed(req, expectedToken)) {
            sendJson(res, 401, { message: 'Bad credentials' }, headers);
            return;
          }
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' }, headers);
            return;
          }
          if (action === 'info/refs' && method === 'GET') {
            const service = search.get('service') ?? '';
            const protocol = req.headers['git-protocol'];
            const result = handleInfoRefs(repo, service, typeof protocol === 'string' ? protocol : undefined);
            if (result.status !== 200) {
              sendJson(res, result.status, { message: typeof result.body === 'string' ? result.body : result.body.toString('utf8') }, headers);
              return;
            }
            const contentType =
              service === 'git-receive-pack' ? 'application/x-git-receive-pack-advertisement' : 'application/x-git-upload-pack-advertisement';
            sendRaw(res, 200, result.body as Buffer, contentType, headers);
            return;
          }
          if (action === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const protocol = req.headers['git-protocol'];
            const result = handleUploadPack(repo, body, typeof protocol === 'string' ? protocol : undefined);
            if (result.status !== 200) {
              sendJson(res, result.status, { message: typeof result.body === 'string' ? result.body : result.body.toString('utf8') }, headers);
              return;
            }
            sendRaw(res, 200, result.body as Buffer, 'application/x-git-upload-pack-result', headers);
            return;
          }
          if (action === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            const result = handleReceivePack(repo, body);
            if (result.status !== 200) {
              sendJson(res, result.status, { message: typeof result.body === 'string' ? result.body : result.body.toString('utf8') }, headers);
              return;
            }
            sendRaw(res, 200, result.body as Buffer, 'application/x-git-receive-pack-result', headers);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, headers);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authed(req, expectedToken)) {
            sendJson(res, 401, { message: 'Bad credentials' }, headers);
            return;
          }
          // A GET carries no body: do not wait for the body's end event.
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          let parsed: unknown;
          if (body.length > 0) {
            try {
              parsed = JSON.parse(body.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' }, headers);
              return;
            }
          }
          const segments = path.split('/').slice(3).filter((segment) => segment !== '');
          const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
          const result = handleRest(store, method, segments, search, parsed, baseUrl);
          if (result === null) {
            sendJson(res, 404, { message: 'Not Found' }, headers);
            return;
          }
          sendRaw(res, result.status, result.body, JSON_TYPE, { ...headers, ...result.headers });
          return;
        }

        // GraphQL v4.
        if (method === 'POST' && path === '/api/graphql') {
          if (!authed(req, expectedToken)) {
            sendJson(res, 401, { message: 'Bad credentials' }, headers);
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'The request body is not valid JSON.' }] }, headers);
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((entry) => {
              if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'Invalid GraphQL request.' }] };
              const query = (entry as { query?: unknown }).query;
              if (typeof query !== 'string') return { data: null, errors: [{ message: 'The request holds no query.' }] };
              const variables = (entry as { variables?: unknown }).variables;
              const operationName = (entry as { operationName?: unknown }).operationName;
              return executeGraphQL(
                store,
                query,
                isRecord(variables) ? variables : {},
                typeof operationName === 'string' ? operationName : undefined,
              );
            });
            sendJson(res, 200, results, headers);
            return;
          }
          if (isRecord(parsed)) {
            const query = parsed.query;
            if (typeof query !== 'string') {
              sendJson(res, 400, { errors: [{ message: 'The request holds no query.' }] }, headers);
              return;
            }
            const variables = parsed.variables;
            const operationName = parsed.operationName;
            sendJson(
              res,
              200,
              executeGraphQL(store, query, isRecord(variables) ? variables : {}, typeof operationName === 'string' ? operationName : undefined),
              headers,
            );
            return;
          }
          sendJson(res, 400, { errors: [{ message: 'Invalid GraphQL request.' }] }, headers);
          return;
        }

        // MCP.
        if (method === 'POST' && path === '/mcp') {
          const body = await readBody(req);
          const authorization = req.headers.authorization;
          const result = handleMcp(store, body.toString('utf8'), typeof authorization === 'string' ? authorization : undefined, expectedToken);
          sendRaw(res, result.status, result.body, result.contentType, headers);
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, headers);
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) }, headers);
        else res.destroy();
      }
    })();
  });

  return server;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
