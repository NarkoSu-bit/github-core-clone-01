// A minimal GraphQL parser + executor for the fixed documents gh and
// github-mcp-server send: queries, mutations, batched operations, inline
// fragments, and __type introspection. No external dependency.

export type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { kind: 'InlineFragment'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'FragmentSpread'; name: string };

export interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: SelectionNode[];
}

export interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface Token {
  kind: 'Name' | 'String' | 'Int' | 'Float' | 'Punct' | 'Spread' | 'EOF';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'Spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$@&|'.includes(c)) {
      tokens.push({ kind: 'Punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      // A string, possibly a block string (""").
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string in GraphQL document');
        tokens.push({ kind: 'String', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string in GraphQL document');
      tokens.push({ kind: 'String', value });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'Float' : 'Int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'Name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'Punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document, got ${token.value}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'Punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'Name') throw new Error(`expected a name in GraphQL document, got ${token.value}`);
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'EOF') {
      const token = this.peek();
      if (token.kind === 'Punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'Name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.peek().kind === 'Name') name = this.next().value;
        this.skipVariableDefinitions();
        this.skipDirectives();
        operations.push({ operation, name, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'Name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${token.value} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    if (!this.skipPunct('(')) return;
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'EOF') throw new Error('unterminated variable definitions');
      if (token.kind === 'Punct' && token.value === '(') depth += 1;
      else if (token.kind === 'Punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'Punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'Punct' && this.peek().value === '(') this.skipArguments();
    }
  }

  private skipArguments(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'EOF') throw new Error('unterminated arguments');
      if (token.kind === 'Punct' && token.value === '(') depth += 1;
      else if (token.kind === 'Punct' && token.value === ')') depth -= 1;
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'Punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'EOF') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'Spread') {
      this.next();
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'InlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'Name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'FragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'InlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    return this.parseField();
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'Punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'Punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'Punct' && this.peek().value === ')')) {
        if (this.peek().kind === 'EOF') throw new Error('unterminated arguments');
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'Punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'Field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'Punct' && token.value === '$') return { kind: 'Variable', name: this.expectName() };
    if (token.kind === 'String') return { kind: 'String', value: token.value };
    if (token.kind === 'Int') return { kind: 'Int', value: Number(token.value) };
    if (token.kind === 'Float') return { kind: 'Float', value: Number(token.value) };
    if (token.kind === 'Name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    if (token.kind === 'Punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'Punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'EOF') throw new Error('unterminated list value');
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'List', values };
    }
    if (token.kind === 'Punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'Punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'EOF') throw new Error('unterminated object value');
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'Object', fields };
    }
    throw new Error(`unexpected value token ${token.value} in GraphQL document`);
  }
}

export function parseGraphQL(source: string): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
  return new Parser(source).parseDocument();
}

/** Resolve a parsed value against the operation's variables. */
export function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'String':
    case 'Int':
    case 'Float':
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((entry) => valueOf(entry, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- executor

import type { Issue, Pull, Repo, Store } from './store.ts';
import { ENTRY_ISO_DATE, VIEWER } from './store.ts';
import { diffTrees, mergeBase, parseCommit } from './gitproto.ts';
import { createIssueInRepo, createPullInRepo, isPullMergeable, mergePullInRepo } from './rest.ts';

interface GqlObj {
  __gqlType: string;
  __gqlValue: unknown;
}

function obj(type: string, value: unknown): GqlObj {
  return { __gqlType: type, __gqlValue: value };
}

function isGqlObj(value: unknown): value is GqlObj {
  return typeof value === 'object' && value !== null && '__gqlType' in (value as Record<string, unknown>);
}

/** The fields each GraphQL type exposes (validation + introspection). */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url'],
  RepositoryOwner: ['login', 'id'],
  BranchRef: ['name'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changes'],
  Label: ['id', 'name', 'color'],
  LabelConnection: ['nodes', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const TYPE_KIND: Record<string, string> = {
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
};

export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

interface IssueNode {
  repo: Repo;
  issue: Issue;
}

interface PullNode {
  repo: Repo;
  pull: Pull;
}

interface ConnectionData {
  nodes: GqlObj[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function paginate<T extends { number: number }>(
  items: T[],
  args: Record<string, unknown>,
): { page: T[]; totalCount: number; hasNextPage: boolean; endCursor: string | null; startCursor: string | null } {
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const descending = orderBy !== undefined && orderBy !== null && String(orderBy.direction ?? '') === 'DESC';
  const sorted = [...items].sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  let rest = sorted;
  if (after !== null) rest = sorted.filter((item) => (descending ? item.number < after : item.number > after));
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : rest.length;
  const page = rest.slice(0, first);
  return {
    page,
    totalCount: items.length,
    hasNextPage: rest.length > page.length,
    endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null,
    startCursor: page.length > 0 ? encodeCursor(page[0]!.number) : null,
  };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): ConnectionData {
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  const wanted = new Set(states.map((s) => String(s).toUpperCase()));
  const filtered = repo.issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  const result = paginate(filtered, args);
  return {
    nodes: result.page.map((issue) => obj('Issue', { repo, issue } as IssueNode)),
    totalCount: result.totalCount,
    hasNextPage: result.hasNextPage,
    endCursor: result.endCursor,
    startCursor: result.startCursor,
  };
}

function pullConnection(store: Store, repo: Repo, args: Record<string, unknown>): ConnectionData {
  void store;
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  const wanted = new Set(states.map((s) => String(s).toUpperCase()));
  const stateOf = (pull: Pull): string => (pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED');
  const filtered = repo.pulls.filter((pull) => wanted.has(stateOf(pull)));
  const result = paginate(filtered, args);
  return {
    nodes: result.page.map((pull) => obj('PullRequest', { repo, pull } as PullNode)),
    totalCount: result.totalCount,
    hasNextPage: result.hasNextPage,
    endCursor: result.endCursor,
    startCursor: result.startCursor,
  };
}

function resolveNode(store: Store, id: string): GqlObj | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const parts = decoded.key.split('/');
  if (decoded.type === 'Repository' && parts.length === 2) {
    const repo = store.getRepo(parts[0]!, parts[1]!);
    return repo ? obj('Repository', repo) : null;
  }
  if (decoded.type === 'Issue' && parts.length === 3) {
    const repo = store.getRepo(parts[0]!, parts[1]!);
    const issue = repo?.issues.find((entry) => entry.number === Number(parts[2]));
    return repo && issue ? obj('Issue', { repo, issue } as IssueNode) : null;
  }
  if (decoded.type === 'PullRequest' && parts.length === 3) {
    const repo = store.getRepo(parts[0]!, parts[1]!);
    const pull = repo?.pulls.find((entry) => entry.number === Number(parts[2]));
    return repo && pull ? obj('PullRequest', { repo, pull } as PullNode) : null;
  }
  if (decoded.type === 'IssueComment' && parts.length === 4) {
    const repo = store.getRepo(parts[0]!, parts[1]!);
    const issue = repo?.issues.find((entry) => entry.number === Number(parts[2]));
    const comment = issue?.comments.find((entry) => entry.id === Number(parts[3]));
    return repo && issue && comment ? obj('IssueComment', { repo, issue, comment }) : null;
  }
  return null;
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function argMap(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx.variables);
  return out;
}

function resolveField(
  store: Store,
  typeName: string,
  value: unknown,
  field: FieldNode,
  ctx: ExecContext,
): unknown {
  const args = argMap(field, ctx);
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return obj('User', VIEWER);
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER.login) return null;
        const repo = store.getRepo(owner, name);
        return repo ? obj('Repository', repo) : null;
      }
      if (field.name === 'node') return resolveNode(store, String(args.id ?? ''));
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name] !== undefined || TYPE_ENUMS[name] !== undefined) return obj('__Type', { name });
        return null;
      }
      if (field.name === '__schema') return obj('__Schema', {});
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (!decoded || decoded.type !== 'Repository') throw new Error('createIssue: the repositoryId does not name a repository');
        const [owner, name] = decoded.key.split('/');
        const repo = store.getRepo(owner ?? '', name ?? '');
        if (!repo) throw new Error('createIssue: the repository does not exist');
        const created = createIssueInRepo(store, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          labels: Array.isArray(input.labels) ? (input.labels as string[]) : [],
        });
        if ('error' in created) throw new Error(`createIssue: ${created.error.status}`);
        return obj('CreateIssuePayload', { issue: obj('Issue', { repo, issue: created.issue } as IssueNode) });
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        if (!decoded || decoded.type !== 'Issue') throw new Error('closeIssue: the issueId does not name an issue');
        const [owner, name, num] = decoded.key.split('/');
        const repo = store.getRepo(owner ?? '', name ?? '');
        const issue = repo?.issues.find((entry) => entry.number === Number(num));
        if (!repo || !issue) throw new Error('closeIssue: the issue does not exist');
        issue.state = 'closed';
        issue.jsonCache = null;
        return obj('CloseIssuePayload', { issue: obj('Issue', { repo, issue } as IssueNode) });
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (!decoded || decoded.type !== 'Repository') throw new Error('createPullRequest: the repositoryId does not name a repository');
        const [owner, name] = decoded.key.split('/');
        const repo = store.getRepo(owner ?? '', name ?? '');
        if (!repo) throw new Error('createPullRequest: the repository does not exist');
        const created = createPullInRepo(store, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
        });
        if ('error' in created) throw new Error(`createPullRequest: ${created.error.status}`);
        return obj('CreatePullRequestPayload', { pullRequest: obj('PullRequest', { repo, pull: created.pull } as PullNode) });
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        if (!decoded || decoded.type !== 'PullRequest') throw new Error('mergePullRequest: the pullRequestId does not name a pull request');
        const [owner, name, num] = decoded.key.split('/');
        const repo = store.getRepo(owner ?? '', name ?? '');
        const pull = repo?.pulls.find((entry) => entry.number === Number(num));
        if (!repo || !pull) throw new Error('mergePullRequest: the pull request does not exist');
        const merged = mergePullInRepo(store, repo, pull);
        if ('error' in merged) throw new Error(`mergePullRequest: ${merged.error.status}`);
        return obj('MergePullRequestPayload', { pullRequest: obj('PullRequest', { repo, pull } as PullNode) });
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        if (!decoded || decoded.type !== 'Issue') throw new Error('addComment: the subjectId does not name an issue');
        const [owner, name, num] = decoded.key.split('/');
        const repo = store.getRepo(owner ?? '', name ?? '');
        const issue = repo?.issues.find((entry) => entry.number === Number(num));
        if (!repo || !issue) throw new Error('addComment: the issue does not exist');
        const comment = { id: store.nextId(), body: String(input.body ?? ''), user: VIEWER, createdSeq: store.nextSeqNum() };
        issue.comments.push(comment);
        issue.jsonCache = null;
        const edge = obj('IssueCommentEdge', { node: obj('IssueComment', { repo, issue, comment }) });
        return obj('AddCommentPayload', { commentEdge: edge });
      }
      return null;
    }
    case 'User': {
      const user = value as { login: string; id: number; name: string; email: string };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return globalId('User', user.login);
      if (field.name === 'name') return user.name;
      if (field.name === 'email') return user.email;
      return null;
    }
    case 'RepositoryOwner': {
      const user = value as { login: string; id: number };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return globalId('User', user.login);
      return null;
    }
    case 'Repository': {
      const repo = value as Repo;
      if (field.name === 'id') return globalId('Repository', `${repo.owner}/${repo.name}`);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return obj('RepositoryOwner', VIEWER);
      if (field.name === 'defaultBranchRef') return obj('BranchRef', { name: repo.defaultBranch });
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
      if (field.name === 'issue') {
        const issue = repo.issues.find((entry) => entry.number === Number(args.number));
        return issue ? obj('Issue', { repo, issue } as IssueNode) : null;
      }
      if (field.name === 'issues') return obj('IssueConnection', issueConnection(repo, args));
      if (field.name === 'pullRequest') {
        const pull = repo.pulls.find((entry) => entry.number === Number(args.number));
        return pull ? obj('PullRequest', { repo, pull } as PullNode) : null;
      }
      if (field.name === 'pullRequests') return obj('PullRequestConnection', pullConnection(store, repo, args));
      return null;
    }
    case 'BranchRef': {
      const ref = value as { name: string };
      if (field.name === 'name') return ref.name;
      return null;
    }
    case 'Issue': {
      const node = value as IssueNode;
      const { repo, issue } = node;
      if (field.name === 'id') return globalId('Issue', `${repo.owner}/${repo.name}/${issue.number}`);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'body') return issue.body;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'createdAt') return ENTRY_ISO_DATE;
      if (field.name === 'author') return obj('User', VIEWER);
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field.name === 'labels') {
        return obj('LabelConnection', {
          nodes: issue.labels.map((name) => obj('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed' })),
          totalCount: issue.labels.length,
          hasNextPage: false,
          endCursor: null,
          startCursor: null,
        } as ConnectionData);
      }
      if (field.name === 'comments') {
        return obj('IssueCommentConnection', {
          nodes: issue.comments.map((comment) => obj('IssueComment', { repo, issue, comment })),
          totalCount: issue.comments.length,
          hasNextPage: false,
          endCursor: null,
          startCursor: null,
        } as ConnectionData);
      }
      return null;
    }
    case 'PullRequest': {
      const node = value as PullNode;
      const { repo, pull } = node;
      if (field.name === 'id') return globalId('PullRequest', `${repo.owner}/${repo.name}/${pull.number}`);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'mergeable') return isPullMergeable(store, repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'headRef') return obj('BranchRef', { name: pull.headRef });
      if (field.name === 'baseRef') return obj('BranchRef', { name: pull.baseRef });
      if (field.name === 'author') return obj('User', VIEWER);
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      if (field.name === 'files') {
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        if (headTip === undefined || baseTip === undefined) return obj('PullRequestFileConnection', { nodes: [], totalCount: 0, hasNextPage: false, endCursor: null, startCursor: null } as ConnectionData);
        const base = mergeBase(repo, headTip, baseTip);
        const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
        const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
        const files = diffTrees(repo, baseTree, headTree);
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : files.length;
        const page = files.slice(0, first);
        return obj('PullRequestFileConnection', {
          nodes: page.map((file) => obj('PullRequestFile', { path: file.path })),
          totalCount: files.length,
          hasNextPage: files.length > page.length,
          endCursor: null,
          startCursor: null,
        } as ConnectionData);
      }
      return null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'IssueCommentConnection':
    case 'PullRequestFileConnection':
    case 'LabelConnection': {
      const conn = value as ConnectionData;
      if (field.name === 'nodes') return conn.nodes;
      if (field.name === 'totalCount') return conn.totalCount;
      if (field.name === 'pageInfo') {
        return obj('PageInfo', {
          hasNextPage: conn.hasNextPage,
          hasPreviousPage: false,
          endCursor: conn.endCursor,
          startCursor: conn.startCursor,
        });
      }
      if (field.name === 'edges') {
        return conn.nodes.map((node, index) =>
          obj(typeName === 'IssueConnection' ? 'IssueEdge' : typeName === 'PullRequestConnection' ? 'PullRequestEdge' : typeName === 'IssueCommentConnection' ? 'IssueCommentEdge' : typeName === 'PullRequestFileConnection' ? 'PullRequestFileEdge' : 'IssueEdge', {
            node,
            cursor: encodeCursor(index + 1),
          }),
        );
      }
      return null;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'IssueCommentEdge':
    case 'PullRequestFileEdge': {
      const edge = value as { node: GqlObj; cursor: string };
      if (field.name === 'node') return edge.node;
      if (field.name === 'cursor') return edge.cursor;
      return null;
    }
    case 'PageInfo': {
      const info = value as { hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null; startCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'hasPreviousPage') return info.hasPreviousPage;
      if (field.name === 'endCursor') return info.endCursor;
      if (field.name === 'startCursor') return info.startCursor;
      return null;
    }
    case 'IssueComment': {
      const node = value as { repo: Repo; issue: Issue; comment: { id: number; body: string } };
      if (field.name === 'id') return globalId('IssueComment', `${node.repo.owner}/${node.repo.name}/${node.issue.number}/${node.comment.id}`);
      if (field.name === 'body') return node.comment.body;
      if (field.name === 'author') return obj('User', VIEWER);
      if (field.name === 'createdAt') return ENTRY_ISO_DATE;
      return null;
    }
    case 'PullRequestFile': {
      const file = value as { path: string };
      if (field.name === 'path') return file.path;
      if (field.name === 'additions') return 0;
      if (field.name === 'deletions') return 0;
      if (field.name === 'changes') return 0;
      return null;
    }
    case 'Label': {
      const label = value as { name: string; color: string };
      if (field.name === 'name') return label.name;
      if (field.name === 'color') return label.color;
      if (field.name === 'id') return globalId('Label', label.name);
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = value as { issue: GqlObj };
      if (field.name === 'issue') return payload.issue;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = value as { pullRequest: GqlObj };
      if (field.name === 'pullRequest') return payload.pullRequest;
      return null;
    }
    case 'AddCommentPayload': {
      const payload = value as { commentEdge: GqlObj };
      if (field.name === 'commentEdge') return payload.commentEdge;
      return null;
    }
    case '__Type': {
      const type = value as { name: string };
      if (field.name === 'name') return type.name;
      if (field.name === 'kind') return TYPE_KIND[type.name] ?? 'OBJECT';
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[type.name] ?? [];
        return names.map((name) => obj('__Field', { name }));
      }
      if (field.name === 'enumValues') {
        const names = TYPE_ENUMS[type.name] ?? [];
        return names.map((name) => obj('__EnumValue', { name }));
      }
      return null;
    }
    case '__Field': {
      const entry = value as { name: string };
      if (field.name === 'name') return entry.name;
      if (field.name === 'description') return null;
      if (field.name === 'type') return null;
      return null;
    }
    case '__EnumValue': {
      const entry = value as { name: string };
      if (field.name === 'name') return entry.name;
      if (field.name === 'description') return null;
      return null;
    }
    case '__Schema': {
      if (field.name === 'types') return [];
      if (field.name === 'queryType') return obj('__Type', { name: 'Query' });
      if (field.name === 'mutationType') return obj('__Type', { name: 'Mutation' });
      return null;
    }
    default:
      return null;
  }
}

function executeSelections(typeName: string, value: unknown, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelections(typeName, value, selection.selections, ctx));
      }
      continue;
    }
    if (selection.kind === 'FragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition === typeName) {
        Object.assign(out, executeSelections(typeName, value, fragment.selections, ctx));
      }
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    const allowed = TYPE_FIELDS[typeName] ?? [];
    if (!allowed.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    let resolved: unknown;
    try {
      resolved = resolveField(ctx.store, typeName, value, field, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    if (resolved === null || resolved === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (isGqlObj(resolved)) {
      if (field.selections === null) {
        out[responseKey] = null;
      } else {
        out[responseKey] = executeSelections(resolved.__gqlType, resolved.__gqlValue, field.selections, ctx);
      }
      continue;
    }
    if (Array.isArray(resolved)) {
      if (field.selections === null) {
        out[responseKey] = resolved;
      } else {
        out[responseKey] = resolved.map((item) =>
          isGqlObj(item) ? executeSelections(item.__gqlType, item.__gqlValue, field.selections!, ctx) : item,
        );
      }
      continue;
    }
    out[responseKey] = resolved;
  }
  return out;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

/** Execute one GraphQL operation document. Never throws: a bad document is a GraphQL error. */
export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): GraphQLResult {
  let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    parsed = parseGraphQL(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (parsed.operations.length === 0) {
    return { data: null, errors: [{ message: 'The document holds no operation.' }] };
  }
  let operation = parsed.operations[0]!;
  if (operationName !== undefined && operationName !== '') {
    const named = parsed.operations.find((entry) => entry.name === operationName);
    if (!named) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    operation = named;
  } else if (parsed.operations.length > 1) {
    return { data: null, errors: [{ message: 'The document holds more than one operation and no operationName was given.' }] };
  }
  const ctx: ExecContext = { store, variables, fragments: parsed.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, null, operation.selections, ctx);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
