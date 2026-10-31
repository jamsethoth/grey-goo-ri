import * as rules from './rules.mjs';

export const DEFAULT_POLICY = { transient: 2, rateLimited: 2, timeout: 1, parse: 1 };

const within = (i, kind) => (i.retries[kind] ?? 0) < i.policy[kind];
const failedAs = (i, ...classes) => i.result.status === 'failed' && classes.includes(i.result.failure?.class);
const transientKind = i => (i.result.failure?.class === 'rate-limited' ? 'rateLimited' : 'transient');
const timedOut = i => i.result.status === 'timed-out' || i.result.status === 'killed';
const completed = i => i.result.status === 'completed';
const unparsed = i => completed(i) && (i.result.response == null || !i.claim?.valid);
const violated = i => i.checks.find(c => !c.passed && c.integrity);
// Harness exhaustion, which a Vertex may route; unrouted, each ends at needs-human (Q3f, R12c). A run stop, an Integrity
// Violation and any other failure are never routable.
export const HARNESS_OUTCOMES = ['harness-timeout', 'harness-transient', 'harness-unparsed'];
// The engine's own routable Outcomes: a required Check's final failure is `failed` (T7, U14).
export const ENGINE_OUTCOMES = ['failed', ...HARNESS_OUTCOMES];

// gg's fixed rows, ordered; the first whose matches() holds fires. The last hands a valid Claim over to the Procedure's
// tables (decide).
export const ROWS = [
  { name: 'integrity-violation', matches: i => !!violated(i), outcome: 'integrity-violation', direction: 'stop' },
  { name: 'transient-retry', matches: i => failedAs(i, 'transient', 'rate-limited') && within(i, transientKind(i)), outcome: 'transient-retry', direction: 'retry' },
  { name: 'transient-exhausted', matches: i => failedAs(i, 'transient', 'rate-limited'), outcome: 'harness-transient', direction: 'stop' },
  { name: 'run-stop', matches: i => failedAs(i, 'auth', 'quota', 'budget'), outcome: 'run-stop', direction: 'stop' },
  { name: 'timeout-retry', matches: i => timedOut(i) && within(i, 'timeout'), outcome: 'timeout-retry', direction: 'retry' },
  { name: 'timeout-exhausted', matches: timedOut, outcome: 'harness-timeout', direction: 'stop' },
  { name: 'unknown-failure', matches: i => i.result.status === 'failed', outcome: 'needs-human', direction: 'stop' },
  { name: 'parse-retry', matches: i => unparsed(i) && within(i, 'parse'), outcome: 'parse-retry', direction: 'retry' },
  { name: 'parse-exhausted', matches: unparsed, outcome: 'harness-unparsed', direction: 'stop' },
  { name: 'claimed', matches: () => true, outcome: null, direction: 'advance' },
];

export function resolve({ result, claim, checks, retries, policy = DEFAULT_POLICY }) {
  const input = { result, claim, checks, retries, policy };
  const row = ROWS.find(r => r.matches(input));
  const check = row.name === 'integrity-violation' ? violated(input).name : null;
  return {
    outcome: row.outcome ?? claim.claim,
    direction: row.direction,
    row: row.name,
    rule: { table: 'fixed', row: row.name },
    check,
    retryAfterMs: row.name === 'transient-retry' ? result.failure.retryAfterMs ?? null : null,
    // The `policy` budget a retry spends, null for any other row.
    retryKind: { 'parse-retry': 'parse', 'timeout-retry': 'timeout', 'transient-retry': transientKind(input) }[row.name] ?? null,
    failureClass: result.status === 'failed' ? result.failure?.class ?? null : null,
  };
}

// The Visit's Outcome (Q3d): gg's fixed rows; then a stop `token` through the `stopped` table, else the token; then the
// `passed` table when every Check the token requires passed, else recovery while it is left (`recoverable`) and then the
// `failed` table; then `otherwise`; then the token, or the engine Outcome `failed` (T7). `rule` is the rule identity
// { table, row }: a row's index, `otherwise`, or null when neither matched.
export function decide(input) {
  const r = resolve(input);
  if (r.row !== 'claimed') return r;
  const { token, procedure, scope } = input;
  const table = token.stop ? 'stopped' : token.requires.every((id) => input.checks.some((c) => !c.integrity && c.name === id && c.passed)) ? 'passed' : 'failed';
  if (table === 'failed' && input.recoverable) return { ...r, outcome: 'recover', direction: 'retry', row: 'recover', rule: { table: 'fixed', row: 'recover' } };
  const rows = procedure[table] ?? [];
  const row = rules.evaluate({ rows }, scope);
  const otherwise = row === null && !token.stop && procedure.otherwise != null;
  const outcome = row !== null ? rows[row].outcome : otherwise ? procedure.otherwise : table === 'failed' ? 'failed' : input.claim.claim;
  return { ...r, outcome, direction: table === 'passed' ? 'advance' : 'stop', row: null, rule: { table, row: row ?? (otherwise ? 'otherwise' : null) } };
}

// gh's and git's own words for a remote failure. A bare 403 is a permission failure: only gh's rate-limit message or
// headers make it a rate limit.
const RATE_LIMITED = /secondary rate limit|API rate limit (?:already )?exceeded/i;
const TRANSPORT = /connection reset|connection refused|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|i\/o timeout|TLS handshake timeout|context deadline exceeded|unexpected EOF|Could not resolve host|Failed to connect to|The remote end hung up unexpectedly/i;
const REJECTED = /! \[(?:remote )?rejected\]|\(non-fast-forward\)|\(fetch first\)/;
const seconds = (v) => (/^\d+$/.test(String(v ?? '').trim()) ? Number(v) * 1000 : null);

// Classifies a failed gh or git call of a remote Action. Only transient and rate-limited failures are retried; unknown
// stays a fault. `err.http` is what `gh api --include` showed; other calls carry their status in gh's message, and a
// GraphQL rate limit none. `err.rateLimit` is the reset github.mjs read from the quota when the response gave no wait.
export function classifyRemoteFailure(err) {
  // exec.run appends the command, arguments and all, to its message, so a failed process is read from its own output.
  const text = err && ('stderr' in err || 'stdout' in err) ? `${err.stderr ?? ''}\n${err.stdout ?? ''}` : String(err?.message ?? '');
  const headers = err?.http?.headers ?? {};
  // gh says "HTTP 502"; git (http.c) says "The requested URL returned error: 503".
  const status = err?.http?.status ?? (Number(text.match(/\bHTTP (\d{3})\b|The requested URL returned error: (\d{3})\b/)?.slice(1).find(Boolean)) || null);
  const retryAfterMs = seconds(headers['retry-after']);
  const resetAt = (headers['x-ratelimit-remaining'] === '0' ? seconds(headers['x-ratelimit-reset']) : null) ?? err?.rateLimit?.resetAt ?? null;
  const as = (cls, retryable) => ({ class: cls, retryable, status, retryAfterMs, resetAt });
  if (REJECTED.test(text)) return as('rejected', false);
  if (status === 429 || ((status === 403 || !status) && RATE_LIMITED.test(text)) || (status === 403 && (retryAfterMs !== null || resetAt !== null))) {
    return as('rate-limited', true);
  }
  if (status === 401 || status === 403) return as('auth', false);
  if (status >= 500 || (!status && TRANSPORT.test(text))) return as('transient', true);
  if (status >= 400) return as('invalid', false);
  return as('unknown', false);
}

// GitHub's documented order: Retry-After, then the reset time once no requests remain, else at least 60 s, doubling
// with each retry (`n` from 1).
export const remoteRetryDelay = (failure, n, now) => failure.retryAfterMs
  ?? (failure.resetAt != null ? Math.max(0, failure.resetAt - now) : 60_000 * 2 ** (n - 1));
