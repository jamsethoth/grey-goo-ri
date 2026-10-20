export const DEFAULT_POLICY = { transient: 2, rateLimited: 2, timeout: 1, parse: 1 };

const within = (i, kind) => (i.retries[kind] ?? 0) < i.policy[kind];
const failedAs = (i, ...classes) => i.result.status === 'failed' && classes.includes(i.result.failure?.class);
const transientKind = i => (i.result.failure?.class === 'rate-limited' ? 'rateLimited' : 'transient');
const timedOut = i => i.result.status === 'timed-out' || i.result.status === 'killed';
const completed = i => i.result.status === 'completed';
const unparsed = i => completed(i) && (i.result.response == null || !i.claim?.valid);
const claimed = (i, ...tokens) => completed(i) && !unparsed(i) && tokens.includes(i.claim.claim);
// A relaxed check (requireTestPass false) is recorded but never blocks advance.
const failedCheck = (i, integrity) => i.checks.find(c => !c.passed && !c.relaxed && c.integrity === integrity);
const stopClaims = ['blocked', 'misscoped'];
const settled = i => completed(i) && !unparsed(i) && !stopClaims.includes(i.claim.claim);

// Ordered; the first row whose matches() holds fires.
export const ROWS = [
  { name: 'integrity-violation', matches: i => !!failedCheck(i, true), outcome: 'integrity-violation', direction: 'stop' },
  { name: 'transient-retry', matches: i => failedAs(i, 'transient', 'rate-limited') && within(i, transientKind(i)), outcome: 'transient-retry', direction: 'retry' },
  { name: 'transient-exhausted', matches: i => failedAs(i, 'transient', 'rate-limited'), outcome: 'needs-human', direction: 'stop' },
  { name: 'run-stop', matches: i => failedAs(i, 'auth', 'quota', 'budget'), outcome: 'run-stop', direction: 'stop' },
  { name: 'timeout-retry', matches: i => timedOut(i) && within(i, 'timeout'), outcome: 'timeout-retry', direction: 'retry' },
  { name: 'timeout-exhausted', matches: timedOut, outcome: 'needs-human', direction: 'stop' },
  { name: 'unknown-failure', matches: i => i.result.status === 'failed', outcome: 'needs-human', direction: 'stop' },
  { name: 'parse-retry', matches: i => unparsed(i) && within(i, 'parse'), outcome: 'parse-retry', direction: 'retry' },
  { name: 'parse-exhausted', matches: unparsed, outcome: 'needs-human', direction: 'stop' },
  { name: 'blocked', matches: i => claimed(i, 'blocked'), outcome: 'blocked', direction: 'stop' },
  { name: 'misscoped', matches: i => claimed(i, 'misscoped'), outcome: 'misscoped', direction: 'stop' },
  // The procedure signals `exhausted` when it has no recovery left for the check; the failure outcome is its own.
  // Only a claim ok is held to its checks; any other settled claim routes by its token (a review's changes).
  { name: 'check-exhausted', matches: i => claimed(i, 'ok') && !!failedCheck(i, false) && i.exhausted, outcome: null, direction: 'stop' },
  { name: 'check-failed', matches: i => claimed(i, 'ok') && !!failedCheck(i, false), outcome: 'check-failed', direction: 'retry' },
  { name: 'claim-route', matches: i => settled(i) && i.claim.claim !== 'ok', outcome: null, direction: 'advance' },
  { name: 'ok', matches: i => claimed(i, 'ok'), outcome: 'ok', direction: 'advance' },
];

// `routes` maps a check with no recovery Phase (review-pass) to the Outcome its failure routes by, advancing.
export function resolve({ result, claim, checks, retries, policy = DEFAULT_POLICY, exhausted = false, failureOutcomes = {}, routes = {} }) {
  const input = { result, claim, checks, retries, policy, exhausted };
  const row = ROWS.find(r => r.matches(input));
  const check = ['check-exhausted', 'check-failed', 'integrity-violation'].includes(row.name) ? failedCheck(input, row.name === 'integrity-violation').name : null;
  const routed = row.name === 'check-failed' ? routes[check] : undefined;
  return {
    outcome: row.name === 'check-exhausted' ? failureOutcomes[check] ?? 'needs-human' : routed ?? row.outcome ?? claim.claim,
    direction: routed ? 'advance' : row.direction,
    row: row.name,
    check,
    retryAfterMs: row.name === 'transient-retry' ? result.failure.retryAfterMs ?? null : null,
    failureClass: result.status === 'failed' ? result.failure?.class ?? null : null,
  };
}

// gh's and git's own words for a remote failure. A bare 403 is a permission failure: only gh's rate-limit message or
// headers make it a rate limit.
const RATE_LIMITED = /secondary rate limit|API rate limit exceeded/i;
const TRANSPORT = /connection reset|connection refused|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|i\/o timeout|TLS handshake timeout|context deadline exceeded|unexpected EOF|Could not resolve host|Failed to connect to|The remote end hung up unexpectedly/i;
const REJECTED = /! \[(?:remote )?rejected\]|\(non-fast-forward\)|\(fetch first\)/;
const seconds = (v) => (/^\d+$/.test(String(v ?? '').trim()) ? Number(v) * 1000 : null);

// Classifies a failed gh or git call of a remote Action. Only transient and rate-limited failures are retried; unknown
// stays a fault. `err.http` is what `gh api --include` showed; other calls carry their status in gh's message.
export function classifyRemoteFailure(err) {
  // exec.run appends the command, arguments and all, to its message, so a failed process is read from its own output.
  const text = err && ('stderr' in err || 'stdout' in err) ? `${err.stderr ?? ''}\n${err.stdout ?? ''}` : String(err?.message ?? '');
  const headers = err?.http?.headers ?? {};
  const status = err?.http?.status ?? (Number(text.match(/\bHTTP (\d{3})\b/)?.[1]) || null);
  const retryAfterMs = seconds(headers['retry-after']);
  const resetAt = headers['x-ratelimit-remaining'] === '0' ? seconds(headers['x-ratelimit-reset']) : null;
  const as = (cls, retryable) => ({ class: cls, retryable, status, retryAfterMs, resetAt });
  if (REJECTED.test(text)) return as('rejected', false);
  if (status === 429 || (status === 403 && (RATE_LIMITED.test(text) || retryAfterMs !== null || resetAt !== null))) return as('rate-limited', true);
  if (status === 401 || status === 403) return as('auth', false);
  if (status >= 500 || (!status && TRANSPORT.test(text))) return as('transient', true);
  if (status >= 400) return as('invalid', false);
  return as('unknown', false);
}

// GitHub's documented order: Retry-After, then the reset time once no requests remain, else at least 60 s, doubling
// with each retry (`n` from 1).
export const remoteRetryDelay = (failure, n, now) => failure.retryAfterMs
  ?? (failure.resetAt != null ? Math.max(0, failure.resetAt - now) : 60_000 * 2 ** (n - 1));
