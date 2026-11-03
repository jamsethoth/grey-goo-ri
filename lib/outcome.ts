import * as labels from './labels.ts';
import type * as procedures from './procedures.ts';
import * as rules from './rules.ts';
import type * as visit from './visit.ts';

// The Resolution Policy's retry budgets, by the kind of retry each spends.
export type RetryKind = 'transient' | 'rateLimited' | 'timeout' | 'parse';
export type ResolutionPolicy = Record<RetryKind, number>;
export const DEFAULT_POLICY: ResolutionPolicy = { transient: 2, rateLimited: 2, timeout: 1, parse: 1 };

export type FailureClass =
  'transient' | 'rate-limited' | 'auth' | 'quota' | 'budget' | 'permission' | 'rejected' | 'invalid' | 'unknown';
interface FailureReach {
  reach: 'retry' | 'run' | 'ticket';
  budget: 'transient' | 'rateLimited' | null;
}
// What each Failure Class does, whichever source reports it (request 3.4): `retry` spends the `policy` budget named,
// `run` stops the whole Run, and `ticket` ends only its own Ticket.
export const FAILURE_CLASSES: Record<FailureClass, FailureReach> = {
  transient: { reach: 'retry', budget: 'transient' },
  'rate-limited': { reach: 'retry', budget: 'rateLimited' },
  auth: { reach: 'run', budget: null },
  quota: { reach: 'run', budget: null },
  budget: { reach: 'run', budget: null },
  permission: { reach: 'ticket', budget: null },
  rejected: { reach: 'ticket', budget: null },
  invalid: { reach: 'ticket', budget: null },
  unknown: { reach: 'ticket', budget: null },
};

// A Check as the transition table reads it: an Integrity Assertion or a Check signal, by name, and whether it passed.
export interface TableCheck {
  name: string;
  passed: boolean;
  integrity: boolean;
}
// An Action's Signals as the transition table reads them, the retries its Attempts already spent by kind, and the
// Resolution Policy's budgets.
export interface Signals {
  result: visit.CallSignal;
  claim: visit.ClaimSignal;
  checks: TableCheck[];
  retries: Partial<Record<RetryKind, number>>;
  policy?: ResolutionPolicy;
}
type Resolving = Signals & { policy: ResolutionPolicy };

const within = (signals: Resolving, kind: RetryKind | null | undefined) =>
  (signals.retries[kind as RetryKind] ?? 0) < signals.policy[kind as RetryKind];
// A failed result's Failure Class row; null for any other result, or a class the table does not name.
function failureOf(signals: Resolving) {
  const failureClass = signals.result.status === 'failed' ? signals.result.failure?.failureClass : undefined;
  return failureClass !== undefined && Object.hasOwn(FAILURE_CLASSES, failureClass)
    ? FAILURE_CLASSES[failureClass as FailureClass]
    : null;
}
const reaches = (signals: Resolving, reach: FailureReach['reach']) => failureOf(signals)?.reach === reach;
const transientKind = (signals: Resolving) => failureOf(signals)?.budget;
const timedOut = (signals: Resolving) => signals.result.status === 'timed-out' || signals.result.status === 'killed';
const completed = (signals: Resolving) => signals.result.status === 'completed';
const unparsed = (signals: Resolving) =>
  completed(signals) && (signals.result.response == null || !signals.claim?.valid);
const violated = (signals: Resolving) => signals.checks.find((check) => !check.passed && check.integrity);
// Harness exhaustion, which a Vertex may route; unrouted, each ends at needs-human (Q3f, R12c). A run stop, an
// Integrity Violation and any other failure are never routable.
export const HARNESS_OUTCOMES = ['harness-timeout', 'harness-transient', 'harness-unparsed'];
// The engine's own routable Outcomes: a required Check's final failure is `failed` (T7, U14).
export const ENGINE_OUTCOMES = ['failed', ...HARNESS_OUTCOMES];

interface TableRow {
  name: visit.FixedRow;
  matches: (signals: Resolving) => boolean;
  outcome: string | null;
  direction: visit.Direction;
}
// gg's fixed rows, ordered; the first whose matches() holds fires. The last hands a valid Claim over to the
// Procedure's tables (decide).
export const ROWS: TableRow[] = [
  {
    name: 'integrity-violation',
    matches: (signals) => !!violated(signals),
    outcome: 'integrity-violation',
    direction: 'stop',
  },
  {
    name: 'transient-retry',
    matches: (signals) => reaches(signals, 'retry') && within(signals, transientKind(signals)),
    outcome: 'transient-retry',
    direction: 'retry',
  },
  {
    name: 'transient-exhausted',
    matches: (signals) => reaches(signals, 'retry'),
    outcome: 'harness-transient',
    direction: 'stop',
  },
  { name: 'run-stop', matches: (signals) => reaches(signals, 'run'), outcome: 'run-stop', direction: 'stop' },
  {
    name: 'timeout-retry',
    matches: (signals) => timedOut(signals) && within(signals, 'timeout'),
    outcome: 'timeout-retry',
    direction: 'retry',
  },
  { name: 'timeout-exhausted', matches: timedOut, outcome: 'harness-timeout', direction: 'stop' },
  {
    name: 'unknown-failure',
    matches: (signals) => signals.result.status === 'failed',
    outcome: labels.NEEDS_HUMAN,
    direction: 'stop',
  },
  {
    name: 'parse-retry',
    matches: (signals) => unparsed(signals) && within(signals, 'parse'),
    outcome: 'parse-retry',
    direction: 'retry',
  },
  { name: 'parse-exhausted', matches: unparsed, outcome: 'harness-unparsed', direction: 'stop' },
  { name: 'claimed', matches: () => true, outcome: null, direction: 'advance' },
];

export function resolve({ result, claim, checks, retries, policy = DEFAULT_POLICY }: Signals): visit.TableResolution {
  const input = { result, claim, checks, retries, policy };
  // The last row matches every input.
  const row = ROWS.find((candidate) => candidate.matches(input)) as TableRow;
  const check = row.name === 'integrity-violation' ? (violated(input) as TableCheck).name : null;
  const retryKinds: Partial<Record<visit.FixedRow, RetryKind | null | undefined>> = {
    'parse-retry': 'parse',
    'timeout-retry': 'timeout',
    'transient-retry': transientKind(input),
  };
  return {
    // The claimed row fires only on a completed call with a valid Claim, whose token the claim enum makes a string.
    outcome: row.outcome ?? (claim.token as string),
    direction: row.direction,
    row: row.name,
    rule: { table: 'fixed', row: row.name },
    check,
    retryAfterMs:
      row.name === 'transient-retry' ? ((result.failure as visit.HarnessFailure).retryAfterMs ?? null) : null,
    // The `policy` budget a retry spends, null for any other row.
    retryKind: retryKinds[row.name] ?? null,
    failureClass: result.status === 'failed' ? (result.failure?.failureClass ?? null) : null,
  };
}

// What decide reads beside the Signals: the claimed token, the Procedure whose tables decide, the scope its rows read,
// and whether a recovery pass is left.
export interface Deciding extends Signals {
  token: procedures.ClaimToken;
  procedure: procedures.Procedure;
  scope: unknown;
  recoverable?: boolean;
}

// The table that decides a claimed token: `stopped` for a stop token, `passed` when every Check it requires passed,
// else `failed`.
function tableOf(token: procedures.ClaimToken, checks: TableCheck[]) {
  if (token.stop) return 'stopped';
  const passed = token.requires.every((id) =>
    checks.some((check) => !check.integrity && check.name === id && check.passed),
  );
  return passed ? 'passed' : 'failed';
}

// The Visit's Outcome (Q3d): gg's fixed rows; then a stop `token` through the `stopped` table, else the token; then the
// `passed` table when every Check the token requires passed, else recovery while it is left (`recoverable`) and then
// the `failed` table; then `otherwise`; then the token, or the engine Outcome `failed` (T7). `rule` is the rule
// identity { table, row }: a row's index, `otherwise`, or null when neither matched.
export function decide(input: Deciding): visit.TableResolution {
  const resolution = resolve(input);
  if (resolution.row !== 'claimed') return resolution;
  const { token, procedure, scope } = input;
  const table = tableOf(token, input.checks);
  if (table === 'failed' && input.recoverable)
    return {
      ...resolution,
      outcome: 'recover',
      direction: 'retry',
      row: 'recover',
      rule: { table: 'fixed', row: 'recover' },
    };
  const rows = procedure[table] ?? [];
  const row = rules.evaluate({ rows }, scope);
  const otherwise = row === null && !token.stop && procedure.otherwise != null;
  let outcome;
  if (row !== null) outcome = rows[row].outcome;
  else if (otherwise) outcome = procedure.otherwise as string;
  else if (table === 'failed') outcome = 'failed';
  else outcome = input.claim.token as string;
  return {
    ...resolution,
    outcome,
    direction: table === 'passed' ? 'advance' : 'stop',
    row: null,
    rule: { table, row: row ?? (otherwise ? 'otherwise' : null) },
  };
}

// gh's and git's own words for a remote failure. A bare 403 is a permission refusal (a token scope, branch protection):
// only gh's rate-limit message or headers make it a rate limit. git's credential failures carry no status.
const RATE_LIMITED = /secondary rate limit|API rate limit (?:already )?exceeded/i;
const TRANSPORT = new RegExp(
  'connection reset|connection refused|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|i/o timeout|' +
    'TLS handshake timeout|context deadline exceeded|unexpected EOF|Could not resolve host|Failed to connect to|' +
    'The remote end hung up unexpectedly',
  'i',
);
const CREDENTIAL = /Authentication failed for|could not read (?:Username|Password) for/i;
const REJECTED = /! \[(?:remote )?rejected\]|\(non-fast-forward\)|\(fetch first\)/;
const seconds = (value: unknown) => (/^\d+$/.test(String(value ?? '').trim()) ? Number(value) * 1000 : null);

// A failed gh or git call: a process's output, or a message; `http` is what `gh api --include` showed, and
// `rateLimit` the reset github.mjs read from the quota.
export interface RemoteError {
  stderr?: string;
  stdout?: string;
  message?: string;
  http?: { status?: number | null; headers?: Record<string, string> };
  rateLimit?: { resetAt?: number | null };
}
export interface RemoteFailure {
  failureClass: FailureClass;
  retryable: boolean;
  status: number | null;
  retryAfterMs: number | null;
  resetAt: number | null;
}

// exec.run appends the command, arguments and all, to its message, so a failed process is read from its own output.
const textOf = (err: RemoteError | null | undefined) =>
  err && ('stderr' in err || 'stdout' in err) ? `${err.stderr ?? ''}\n${err.stdout ?? ''}` : String(err?.message ?? '');
// gh says "HTTP 502"; git (http.c) says "The requested URL returned error: 503".
const statusOf = (err: RemoteError | null | undefined, text: string) =>
  err?.http?.status ??
  (Number(
    text
      .match(/\bHTTP (\d{3})\b|The requested URL returned error: (\d{3})\b/)
      ?.slice(1)
      .find(Boolean),
  ) ||
    null);
const rateLimited = (failure: Omit<RemoteFailure, 'failureClass' | 'retryable'>, text: string) =>
  failure.status === 429 ||
  ((failure.status === 403 || !failure.status) && RATE_LIMITED.test(text)) ||
  (failure.status === 403 && (failure.retryAfterMs !== null || failure.resetAt !== null));

function classOf(failure: Omit<RemoteFailure, 'failureClass' | 'retryable'>, text: string): FailureClass {
  const { status } = failure;
  if (REJECTED.test(text)) return 'rejected';
  if (rateLimited(failure, text)) return 'rate-limited';
  if (status === 401 || CREDENTIAL.test(text)) return 'auth';
  if (status === 403) return 'permission';
  if ((status !== null && status >= 500) || (!status && TRANSPORT.test(text))) return 'transient';
  if (status !== null && status >= 400) return 'invalid';
  return 'unknown';
}

// Classifies a failed gh or git call of a remote Action; FAILURE_CLASSES says which are retried. `err.http` is what
// `gh api --include` showed; other calls carry their status in gh's message, and a GraphQL rate limit none.
// `err.rateLimit` is the reset github.mjs read from the quota when the response gave no wait.
export function classifyRemoteFailure(err: RemoteError | null | undefined): RemoteFailure {
  const text = textOf(err);
  const headers = err?.http?.headers ?? {};
  const status = statusOf(err, text);
  const retryAfterMs = seconds(headers['retry-after']);
  const resetAt =
    (headers['x-ratelimit-remaining'] === '0' ? seconds(headers['x-ratelimit-reset']) : null) ??
    err?.rateLimit?.resetAt ??
    null;
  const failure = { status, retryAfterMs, resetAt };
  const failureClass = classOf(failure, text);
  return { failureClass, retryable: FAILURE_CLASSES[failureClass].reach === 'retry', ...failure };
}

// GitHub's documented order: Retry-After, then the reset time once no requests remain, else at least 60 s, doubling
// with each retry (`retry` from 1).
export const remoteRetryDelay = (failure: RemoteFailure, retry: number, now: number) =>
  failure.retryAfterMs ?? (failure.resetAt != null ? Math.max(0, failure.resetAt - now) : 60_000 * 2 ** (retry - 1));
