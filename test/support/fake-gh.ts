// A stand-in for the gh executable at lib/github.ts's seam, passed as `github.createGh(fake.gh)`: it records every argv
// and answers with canned JSON, holding the issues' labels, the comments and the pull requests a case's calls leave.
// gh is never run in tests, so it has no contract suite (docs/testing.md).
import * as exec from '../../lib/exec.ts';
import * as github from '../../lib/github.ts';
import * as labelModule from '../../lib/labels.ts';

export interface GhCall {
  args: string[];
  cwd?: string;
  input?: string;
}

// A failure `fail(failure)` queues: the first unspent one whose `matches(args)` holds fails that call, after its effect
// when `afterEffect` is set, as a gh process that exited with `status` would.
export interface GhFailure {
  matches: (args: string[]) => boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: { message?: string; [field: string]: unknown };
  stderr?: string;
  afterEffect?: boolean;
}

export interface FakeComment {
  id: number;
  body: string;
  created_at: string;
  user: { login: string };
  target: 'pr' | 'issue';
  number: number;
}

// A label event on an issue, as `gh api repos/{owner}/{repo}/issues/<n>/events` lists it.
export interface FakeEvent {
  id: number;
  event: 'labeled' | 'unlabeled';
  created_at: string;
  label: { name: string };
  actor: { login: string };
}

// The login gg's own label edits are made under.
export const GG_LOGIN = 'gg-bot';

export interface FakePullRequest {
  number: number;
  state: string;
  isDraft: boolean;
  url: string;
  body: string | undefined;
  headRefName: string;
  headRefOid?: string;
}

const commentsPath = (issue?: number) =>
  issue === undefined ? /issues\/\d+\/comments$/ : new RegExp(`issues/${issue}/comments$`);

// A comment POST through `gh api`, on issue or PR `issue` when given.
export const isCommentPost = (args: string[], issue?: number): boolean =>
  args[0] === 'api' && args.includes('POST') && args.some((arg) => commentsPath(issue).test(arg));
export const isCommentRead = (args: string[], issue?: number): boolean =>
  args[0] === 'api' && !args.includes('POST') && args.some((arg) => commentsPath(issue).test(arg));

const STATUS_TEXT: Record<number, string> = {
  201: 'Created',
  401: 'Unauthorized',
  403: 'Forbidden',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  502: 'Bad Gateway',
};

// `gh api --include` stdout: the status line and headers, a blank line, then the body.
export const included = (status: number, headers: Record<string, string>, body: unknown): string =>
  `HTTP/2.0 ${status} ${STATUS_TEXT[status] ?? ''}\r\n${Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('')}\r\n${JSON.stringify(body)}`;

// A failed gh call as exec.run rejects it: the message and stderr carry gh's reason, stdout what `--include` printed.
export function ghError(
  args: string[],
  { status, headers = {}, body, stderr }: Omit<GhFailure, 'matches'>,
): exec.CommandError {
  const message = body?.message ?? (status === undefined ? undefined : STATUS_TEXT[status]);
  const reason = stderr ?? `gh: ${message} (HTTP ${status})`;
  const stdout = args.includes('--include') && status ? included(status, headers, body ?? { message }) : '';
  return new exec.CommandError(`${reason}\ngh ${args.join(' ')}`, { code: 1, stdout, stderr: reason });
}

// What the fake holds, which its answers read and change.
function ghState(branch: string, repoLabels: string[], repository: string) {
  const calls: GhCall[] = [];
  // Each issue's label events, in the order they happened, one second apart, as GitHub's REST API gives them.
  const events = new Map<number, FakeEvent[]>();
  const eventsOf = (issue: number) => {
    if (!events.has(issue)) events.set(issue, []);
    return events.get(issue) as FakeEvent[];
  };
  const clock = { count: 0 };
  const recordEvent = (issue: number, event: 'labeled' | 'unlabeled', name: string, login: string) => {
    clock.count += 1;
    eventsOf(issue).push({
      id: 900_000 - clock.count,
      event,
      created_at: new Date(Date.parse('2026-10-15T00:00:00Z') + clock.count * 1000).toISOString(),
      label: { name },
      actor: { login },
    });
  };
  const permissions = new Map<string, string>();
  const comments: FakeComment[] = [];
  const failures: (GhFailure & { spent?: boolean })[] = [];
  // Each issue's labels on GitHub, as issue edits leave them and issue view reports them.
  const issueLabels = new Map<number, Set<string>>();
  const labelsOf = (issue: number) => {
    const known = issueLabels.get(issue);
    if (known) return known;
    const fresh = new Set<string>();
    issueLabels.set(issue, fresh);
    return fresh;
  };
  // Pull requests by head branch, so each Ticket of an epic gets its own.
  const prs = new Map<string, FakePullRequest>();
  const prOf = (number: number) => [...prs.values()].find((pr) => pr.number === number) ?? null;
  const post = (issue: number, body: string, login = GG_LOGIN) => {
    const id = 1000 + comments.length;
    const target = prOf(issue) ? 'pr' : 'issue';
    comments.push({ id, body, created_at: '2026-10-15T00:00:00Z', user: { login }, target, number: issue });
    return id;
  };
  return {
    branch,
    repository,
    calls,
    comments,
    failures,
    labelsOf,
    available: new Set(repoLabels),
    prs,
    prOf,
    post,
    eventsOf,
    recordEvent,
    permissions,
  };
}
type GhState = ReturnType<typeof ghState>;
type HeadOf = (branch: string) => Promise<string | null>;

// GitHub resolves label names case-insensitively and keeps the repository's spelling.
const named = (set: Set<string>, name: string | undefined) =>
  [...set].find((label) => label.toLowerCase() === name?.toLowerCase());
const numberArg = (args: string[]) => Number(args[2]);

async function answerPr(state: GhState, args: string[], input: string | undefined, headOf: HeadOf) {
  const verb = args[1];
  const head = args[args.indexOf('--head') + 1] as string;
  if (verb === 'list') return JSON.stringify(state.prs.has(head) ? [state.prs.get(head)] : []);
  if (verb === 'create') {
    const number = 7 + state.prs.size;
    const url = `https://github.com/o/r/pull/${number}`;
    const isDraft = args.includes('--draft');
    state.prs.set(head, { number, state: 'OPEN', isDraft, url, body: input, headRefName: head });
    return `${url}\n`;
  }
  const pr = state.prOf(numberArg(args));
  if (verb === 'view') {
    return JSON.stringify(
      pr && { ...pr, isCrossRepository: false, headRefOid: pr.headRefOid ?? (await headOf(pr.headRefName)) },
    );
  }
  // A PR the fake does not hold fails the call.
  const known = pr as FakePullRequest;
  if (verb === 'edit') known.body = input;
  else if (verb === 'ready') known.isDraft = false;
  else return null;
  return '';
}

function answerApi(state: GhState, args: string[], input: string | undefined) {
  if (isCommentPost(args)) {
    const issue = Number(args.join(' ').match(/issues\/(\d+)\/comments/)?.[1]);
    const id = state.post(issue, (JSON.parse(input as string) as { body: string }).body);
    return included(
      201,
      { 'Content-Type': 'application/json; charset=utf-8' },
      { id, html_url: `https://github.com/o/r/issues/${issue}#issuecomment-${id}` },
    );
  }
  const eventsAt = args.join(' ').match(/issues\/(\d+)\/events/);
  if (eventsAt) return JSON.stringify([state.eventsOf(Number(eventsAt[1]))]);
  const permissionOf = args.join(' ').match(/collaborators\/([^/\s]+)\/permission/);
  if (permissionOf) {
    const permission = state.permissions.get(permissionOf[1] as string);
    if (!permission) throw ghError(args, { status: 404, body: { message: 'Not Found' } });
    return JSON.stringify({ permission });
  }
  if (args.at(-1)?.includes('/labels')) return JSON.stringify([[...state.available].map((name) => ({ name }))]);
  const issue = Number(args.join(' ').match(/issues\/(\d+)\/comments/)?.[1]);
  return JSON.stringify([state.comments.filter((comment) => comment.number === issue)]);
}

function answerIssue(state: GhState, args: string[]) {
  const issue = numberArg(args);
  if (args[1] === 'view') {
    const labels = [...state.labelsOf(issue)].map((name) => ({ name }));
    return JSON.stringify({ number: issue, title: '', body: '', state: 'OPEN', labels, blockedBy: [], subIssues: [] });
  }
  if (args[1] !== 'edit') return null;
  const labels = state.labelsOf(issue);
  args.forEach((arg, i) => {
    const label = args[i + 1] as string;
    if (arg === '--add-label') {
      const name = named(state.available, label) ?? label;
      if (!labels.has(name)) state.recordEvent(issue, 'labeled', name, GG_LOGIN);
      labels.add(name);
    }
    if (arg === '--remove-label' && named(labels, label)) {
      state.recordEvent(issue, 'unlabeled', named(labels, label) as string, GG_LOGIN);
      labels.delete(named(labels, label) as string);
    }
  });
  return '';
}

function answerLabel(state: GhState, args: string[]) {
  if (args[1] !== 'create') return null;
  const label = args[2] as string;
  if (named(state.available, label))
    throw new Error(`label with name "${label}" already exists; use --force to update its color and description`);
  state.available.add(label);
  return '';
}

async function answer(state: GhState, { args, input }: GhCall, headOf: HeadOf): Promise<string> {
  const noun = args[0];
  let answered: string | null = null;
  if (noun === 'repo' && args[1] === 'view') answered = JSON.stringify({ nameWithOwner: state.repository });
  else if (noun === 'pr') answered = await answerPr(state, args, input, headOf);
  else if (noun === 'api') answered = answerApi(state, args, input);
  else if (noun === 'issue') answered = answerIssue(state, args);
  else if (noun === 'label') answered = answerLabel(state, args);
  if (answered === null) throw new Error(`fake gh has no answer for ${args.join(' ')}`);
  return answered;
}

export interface FakeGhOptions {
  branch: string;
  ticket: number;
  observe?: (what: string) => void;
  headOf?: HeadOf;
  repoLabels?: string[];
  // The owner/name `gh repo view` gives.
  repository?: string;
}

// A PR's head commit is what `headOf(branch)` says origin has, unless a case sets the PR's `headRefOid`.
export function fakeGh({
  branch,
  ticket,
  observe = () => {},
  headOf = async () => null,
  repoLabels = labelModule.STATE_NAMES.map(labelModule.labelsFor().state),
  repository = 'o/r',
}: FakeGhOptions) {
  const state = ghState(branch, repoLabels, repository);
  const gh: github.Transport = async (args, cwd, input) => {
    observe(`gh ${args[0]} ${args[1]}`);
    state.calls.push({ args, cwd, input });
    const failure = state.failures.find((queued) => !queued.spent && queued.matches(args));
    if (!failure) return answer(state, { args, input }, headOf);
    failure.spent = true;
    if (failure.afterEffect) await answer(state, { args, input }, headOf);
    throw ghError(args, failure);
  };
  return {
    gh,
    calls: state.calls,
    comments: state.comments,
    // The fixture Ticket's labels.
    labels: state.labelsOf(ticket),
    labelsOf: state.labelsOf,
    repoLabels: state.available,
    pr: () => state.prs.get(branch) ?? null,
    fail: (failure: GhFailure) => state.failures.push({ ...failure }),
    // Each actor's collaborator permission; one it does not hold reads as a 404, as GitHub answers a non-collaborator.
    permissions: state.permissions,
    // What a human does on GitHub, which leaves an event gg reads back: the fixture Ticket by default.
    humanAddsLabel: (label: string, login: string, issue = ticket) => {
      state.labelsOf(issue).add(label);
      state.recordEvent(issue, 'labeled', label, login);
    },
    humanRemovesLabel: (label: string, login: string, issue = ticket) => {
      state.labelsOf(issue).delete(label);
      state.recordEvent(issue, 'unlabeled', label, login);
    },
    humanComments: (body: string, login: string, issue = ticket) => state.post(issue, body, login),
  };
}

export type FakeGh = ReturnType<typeof fakeGh>;

// A transport a case puts in front of the fake's: each call goes to `intercept` with the fake's transport as `next`, so
// it answers the call itself, fails it, or passes it on. The fake's transport is read now, so the result may replace
// it.
export function ghThrough(
  fake: Pick<FakeGh, 'gh'>,
  intercept: (call: GhCall, next: () => Promise<string>) => Promise<string>,
): github.Transport {
  const transport = fake.gh;
  return (args, cwd, input) => intercept({ args, cwd, input }, () => transport(args, cwd, input));
}
