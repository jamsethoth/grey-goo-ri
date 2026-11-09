import type * as approval from './approval.ts';
import * as exec from './exec.ts';
import * as labels from './labels.ts';
import * as outcome from './outcome.ts';

const STATE_STYLE: Record<labels.StateName, [color: string, description: string]> = {
  'in-progress': ['fbca04', 'An agent is working on this ticket'],
  [labels.NEEDS_HUMAN]: ['d93f0b', 'gg stopped; a human is needed'],
  'ready-for-qa': ['0e8a16', 'Review passed; ready for human QA'],
  'needs-replan': ['5319e7', 'The ticket needs a new plan'],
};

// The Await and Decide Labels' style: they ask for a Decision and give one.
const ASK_STYLE: [color: string, description: string] = ['c5def5', 'gg asks a human, or a human answers'];

// What `gh api --include` showed of a failed response.
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
}

// An exhausted quota's reset, read from GitHub when the response gave no wait (#85).
export interface RateLimit {
  resetAt: number;
}

// A gh process that exited nonzero, with what its response showed, so a catch site can test the type and
// outcome.classifyRemoteFailure can read `http` and `rateLimit` from it. Each is set only when gh showed it.
export class GhError extends exec.CommandError {
  name = 'GhError';
  declare http?: HttpResponse;
  declare rateLimit?: RateLimit;
}

// Runs gh with argv, a working directory and stdin, and returns its stdout. A gh process that fails must reject with
// an exec.CommandError: only that becomes a GhError with the status and rate limit a retry waits on, and any other
// error passes through unread. The type cannot say what a function throws (#208 makes the failure a returned value).
export type Transport = (args: string[], cwd?: string, input?: string) => Promise<string>;

const defaultTransport: Transport = async (args, cwd, input) => (await exec.run('gh', args, { cwd, input })).stdout;

export interface IssueLabel {
  name: string;
}
export interface IssueRef {
  number: number;
  state: string;
}
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: IssueLabel[];
  blockedBy?: Linked<IssueRef>;
  subIssues?: Linked<Pick<IssueRef, 'number'>>;
}
// gh gives an issue's linked issues as a list, or as a connection with its list under `nodes`.
type Linked<Item> = Item[] | { nodes?: Item[] };
export const linkedIssues = <Item>(given: Linked<Item> | undefined): Item[] =>
  ((given as { nodes?: Item[] } | undefined)?.nodes ?? given ?? []) as Item[];
export interface PullRequest {
  number: number;
  state: string;
  isDraft: boolean;
  url: string;
}
// The head (repository, ref and commit) is what pr-ready checks before every launch (M1).
export interface PullRequestView extends PullRequest {
  body: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
}
export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

interface PrefixOption {
  prefix?: string;
}

export const labelNames = (issue: Pick<Issue, 'labels'>) => issue.labels.map((label) => label.name);

// A ticket is ready when it is open, idle, and every blocker is closed.
export function readinessReason(issue: Pick<Issue, 'state' | 'labels' | 'blockedBy'>, { prefix }: PrefixOption = {}) {
  // Admission treats in-progress specially (stuck detection); every State Label still means the ticket is not idle.
  const busy = labels.STATE_NAMES.map(labels.labelsFor(prefix).state);
  const blockers = linkedIssues(issue.blockedBy);
  if (issue.state !== 'OPEN') return 'closed';
  const open = blockers.filter((blocker) => blocker.state !== 'CLOSED');
  if (open.length) return `blocked by ${open.map((blocker) => `#${blocker.number}`).join(', ')}`;
  const label = labelNames(issue).find((name) => labels.hasLabel(busy, name));
  return label ? `carries State Label ${label}` : null;
}

export const isReady = (issue: Pick<Issue, 'state' | 'labels' | 'blockedBy'>, options?: PrefixOption) =>
  readinessReason(issue, options) === null;

// `gh api --include` stdout: the status line and headers before the body.
function included(text: string) {
  const [, head = '', body = ''] = String(text).match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/) ?? [];
  const [statusLine = '', ...lines] = head.split(/\r?\n/);
  const headers: Record<string, string> = Object.fromEntries(
    lines
      .map((line) => line.match(/^([^:]+):\s*(.*)$/))
      .filter((match) => match !== null)
      .map(([, key = '', value = '']) => [key.toLowerCase(), value]),
  );
  return { status: Number(statusLine.match(/^HTTP\/\S+ (\d{3})/)?.[1]) || null, headers, body };
}

// gh and git put the useful reason on the lines after "exited N", so keep a few, bounded.
export const errorExcerpt = (err: Error) =>
  err.message.split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 300);

// gh pr verbs spend the GraphQL quota and gh api the REST one. Only an exhausted quota's reset is a wait; a failed
// read leaves the fallback.
async function probeRateLimit(transport: Transport, err: GhError, args: string[], cwd?: string) {
  const failure = outcome.classifyRemoteFailure(err);
  if (failure.failureClass !== 'rate-limited' || failure.retryAfterMs !== null || failure.resetAt !== null) return;
  try {
    const { remaining, reset } = JSON.parse(await transport(['api', 'rate_limit'], cwd)).resources[
      args[0] === 'api' ? 'core' : 'graphql'
    ];
    if (remaining === 0 && Number.isFinite(reset)) err.rateLimit = { resetAt: reset * 1000 };
  } catch {}
}

// How the verbs call gh: for its stdout, or for its stdout parsed as JSON.
interface Client {
  gh(args: string[], cwd?: string, input?: string): Promise<string>;
  ghJson<T>(args: string[], cwd?: string): Promise<T>;
}

// `gh api --include` prints the status line and headers on an HTTP error too, so a retry reads Retry-After and the
// rate-limit headers from them. A rate limit that gives no wait is read from GitHub's own quota, once (#85). Only a gh
// process that failed becomes a GhError; any other error, a failed spawn or a test's own, passes through as it is.
function client(transport: Transport): Client {
  async function gh(args: string[], cwd?: string, input?: string) {
    try {
      return await transport(args, cwd, input);
    } catch (err) {
      if (!(err instanceof exec.CommandError)) throw err;
      const ghError = new GhError(err.message, err, { cause: err });
      const { status, headers } = included(err.stdout);
      if (status) ghError.http = { status, headers };
      await probeRateLimit(transport, ghError, args, cwd);
      throw ghError;
    }
  }
  return { gh, ghJson: async (args, cwd) => JSON.parse(await gh(args, cwd)) };
}

// A label change: the names to add and to remove.
export interface LabelChange {
  add?: string[];
  remove?: string[];
}

function labelVerbs({ gh, ghJson }: Client) {
  const repositoryLabels = async (cwd?: string): Promise<string[]> =>
    (await ghJson<IssueLabel[][]>(['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/labels?per_page=100'], cwd))
      .flat()
      .map((label) => label.name);

  // GitHub matches label names case-insensitively, and another Run may create a label between the read and the
  // create: a failed create counts as done only once a fresh read shows the label. `flowLabels` are the Await and
  // Decide Labels a Run can write, beside the State Labels.
  async function ensureLabels(
    cwd?: string,
    { prefix, flowLabels = [] }: PrefixOption & { flowLabels?: string[] } = {},
  ) {
    let existing = await repositoryLabels(cwd);
    const wanted = [
      ...labels.STATE_NAMES.map((name) => [labels.labelsFor(prefix).state(name), STATE_STYLE[name]] as const),
      ...flowLabels.map((label) => [label, ASK_STYLE] as const),
    ];
    for (const [label, [color, description]] of wanted) {
      if (labels.hasLabel(existing, label)) continue;
      try {
        await gh(['label', 'create', label, '--color', color, '--description', description], cwd);
      } catch (err) {
        existing = await repositoryLabels(cwd).catch(() => {
          throw err;
        });
        if (!labels.hasLabel(existing, label)) throw err;
      }
    }
  }

  const editLabels = (issue: number, { add = [], remove = [] }: LabelChange, cwd?: string) =>
    gh(
      [
        'issue',
        'edit',
        String(issue),
        ...add.flatMap((label) => ['--add-label', label]),
        ...remove.flatMap((label) => ['--remove-label', label]),
      ],
      cwd,
    );

  return { ensureLabels, editLabels, repositoryLabels };
}

// What setLabels reports a failed label update to.
export interface LabelReport {
  log: (message: string) => void;
  ev: (type: string, fields: Record<string, unknown>) => void;
  ensureLabels?: () => Promise<unknown>;
}

// A failed label update must not vanish: it leaves the ticket looking idle or stuck on GitHub.
async function setLabels(
  editLabels: ReturnType<typeof labelVerbs>['editLabels'],
  [issue, change, cwd]: [issue: number, change: LabelChange, cwd: string | undefined],
  { log, ev, ensureLabels }: LabelReport,
) {
  try {
    if (ensureLabels) await ensureLabels();
    await editLabels(issue, change, cwd);
    return true;
  } catch (err) {
    const error = errorExcerpt(err as Error);
    log(`#${issue} ERROR label update ${JSON.stringify(change)} failed: ${error}`);
    ev('label_failed', { ticket: issue, change, error });
    return false;
  }
}

function issueVerbs({ gh, ghJson }: Client) {
  const viewIssue = (issue: number, cwd?: string) =>
    ghJson<Issue>(
      ['issue', 'view', String(issue), '--json', 'number,title,body,state,labels,blockedBy,subIssues'],
      cwd,
    );

  // PR conversation comments live on the issues endpoint, so one read serves an issue and a PR.
  const comments = async (issue: number, cwd?: string): Promise<IssueComment[]> =>
    (
      await ghJson<{ id: number; body: string; created_at: string }[][]>(
        ['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${issue}/comments`],
        cwd,
      )
    )
      .flat()
      .map((posted) => ({ id: posted.id, body: posted.body, createdAt: posted.created_at }));

  // A PR conversation comment is an issue comment, so one POST serves an issue and a PR.
  async function comment(issue: number, body: string, cwd?: string): Promise<{ id: number; url: string }> {
    const args = [
      'api',
      '--include',
      '--method',
      'POST',
      `repos/{owner}/{repo}/issues/${issue}/comments`,
      '--input',
      '-',
    ];
    const { id, html_url: url } = JSON.parse(included(await gh(args, cwd, JSON.stringify({ body }))).body);
    return { id, url };
  }

  return { viewIssue, comments, comment };
}

// An issue's events, which GitHub gives no way to edit or delete, so a Decision is read from them (ADR 0003).
const issueEvents = async ({ ghJson }: Client, issue: number, cwd?: string): Promise<approval.IssueEvent[]> =>
  (
    await ghJson<approval.IssueEvent[][]>(
      ['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${issue}/events`],
      cwd,
    )
  ).flat();

// GitHub answers 404 for a login it does not know as a collaborator, which has no permission (L5).
async function collaboratorPermission({ ghJson }: Client, login: string, cwd?: string): Promise<string> {
  try {
    const path = `repos/{owner}/{repo}/collaborators/${encodeURIComponent(login)}/permission`;
    return (await ghJson<{ permission: string }>(['api', path], cwd)).permission;
  } catch (err) {
    if (outcome.classifyRemoteFailure(err as outcome.RemoteError).status === 404) return 'none';
    throw err;
  }
}

const PR_FIELDS = 'number,state,isDraft,url';

function prVerbs({ gh, ghJson }: Client) {
  const findPr = async (branch: string, cwd?: string) =>
    (await ghJson<PullRequest[]>(['pr', 'list', '--head', branch, '--state', 'all', '--json', PR_FIELDS], cwd))[0];

  async function upsertPr(
    { branch, base, title, body }: { branch: string; base: string; title: string; body: string },
    cwd?: string,
  ) {
    const pr = await findPr(branch, cwd);
    if (pr && pr.state === 'OPEN') {
      await gh(['pr', 'edit', String(pr.number), '--body-file', '-'], cwd, body);
      return pr;
    }
    await gh(
      ['pr', 'create', '--draft', '--head', branch, '--base', base, '--title', title, '--body-file', '-'],
      cwd,
      body,
    );
    return findPr(branch, cwd);
  }

  const viewPr = (pr: number, cwd?: string) =>
    ghJson<PullRequestView>(
      ['pr', 'view', String(pr), '--json', `${PR_FIELDS},body,headRefName,headRefOid,isCrossRepository`],
      cwd,
    );

  const markReady = (pr: number, cwd?: string) => gh(['pr', 'ready', String(pr)], cwd);

  return { findPr, upsertPr, viewPr, markReady };
}

// The gh verbs over `transport`, which runs gh with argv, a working directory and stdin and returns its stdout. The
// entry point passes none, so gh itself runs; a test passes a fake that records argv and answers canned stdout.
export function createGh(transport: Transport = defaultTransport) {
  const ghClient = client(transport);
  const { ensureLabels, editLabels, repositoryLabels } = labelVerbs(ghClient);
  return {
    ensureLabels,
    repositoryLabels,
    ...issueVerbs(ghClient),
    editLabels,
    ...prVerbs(ghClient),
    issueEvents: (issue: number, cwd?: string) => issueEvents(ghClient, issue, cwd),
    collaboratorPermission: (login: string, cwd?: string) => collaboratorPermission(ghClient, login, cwd),
    setLabels: (issue: number, change: LabelChange, cwd: string | undefined, report: LabelReport) =>
      setLabels(editLabels, [issue, change, cwd], report),
    labelNames,
    readinessReason,
    isReady,
    errorExcerpt,
  };
}

// The gh verbs the entry point builds and passes down as `gh` (ADR 0019); the fake gh matches them.
export type Gh = ReturnType<typeof createGh>;
