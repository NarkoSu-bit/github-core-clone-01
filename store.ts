// The forge's in-memory store: one process, no persistence, no clock in state.
// Every identity below is fixed by the suite's deterministic scenario
// (wire.ts SCENARIO_SEED 0x6a09e667f3bcc909): the token's user is the viewer,
// and every repository the entry creates belongs to that login.

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export const VIEWER: User = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const TEAMMATE: User = { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' };
export const STRANGER: User = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' };
export const ORG = 'faint-meadow-org';
export const DEFAULT_BRANCH = 'main';
/** A fixed epoch every commit the entry creates derives from (never Date.now). */
export const ENTRY_EPOCH_SEC = 1700000000;
/** A fixed ISO date every REST object the entry creates carries (never the wall clock). */
export const ENTRY_ISO_DATE = '2025-02-10T08:19:57Z';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  /** Cached serialized REST JSON for GET /issues/{n}; null when dirty. */
  jsonCache: string | null;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  nextIssueNumber: number;
  labels: Map<string, Label>;
  pulls: Pull[];
  nextPullNumber: number;
}

/** The whole forge state. */
export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextGlobalId = 1;
  private nextSeq = 1;
  private commitSeq = 0;

  /** A fresh globally-unique numeric id (REST `id` fields). */
  nextId(): number {
    return this.nextGlobalId++;
  }

  /** A fresh creation-sequence number (sort=created ordering). */
  nextSeqNum(): number {
    return this.nextSeq++;
  }

  /** A deterministic timestamp for a commit the entry creates (seconds). */
  nextCommitTimestamp(): number {
    this.commitSeq += 1;
    return ENTRY_EPOCH_SEC + this.commitSeq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, opts: { private?: boolean; description?: string; defaultBranch?: string }): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER.login,
      private: opts.private ?? false,
      description: opts.description ?? '',
      defaultBranch: opts.defaultBranch ?? DEFAULT_BRANCH,
      createdSeq: this.nextSeqNum(),
      objects: new Map(),
      refs: new Map(),
      issues: [],
      nextIssueNumber: 1,
      labels: new Map(),
      pulls: [],
      nextPullNumber: 1,
    };
    this.repos.set(this.repoKey(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** The viewer's repositories in creation order. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }
}
