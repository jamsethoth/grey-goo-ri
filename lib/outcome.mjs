export const DEFAULT_POLICY = { transient: 2, rateLimited: 2, timeout: 1, parse: 1 };

const within = (i, kind) => (i.retries[kind] ?? 0) < i.policy[kind];
const failedAs = (i, ...classes) => i.result.status === 'failed' && classes.includes(i.result.failure?.class);
const transientKind = i => (i.result.failure?.class === 'rate-limited' ? 'rateLimited' : 'transient');
const timedOut = i => i.result.status === 'timed-out' || i.result.status === 'killed';
const completed = i => i.result.status === 'completed';
const unparsed = i => completed(i) && (i.result.response == null || !i.claim?.valid);
const claimed = (i, ...tokens) => completed(i) && !unparsed(i) && tokens.includes(i.claim.claim);
const failedCheck = (i, integrity) => i.checks.find(c => !c.passed && c.integrity === integrity);
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
  { name: 'check-failed', matches: i => settled(i) && !!failedCheck(i, false), outcome: 'check-failed', direction: 'retry' },
  { name: 'claim-route', matches: i => settled(i) && i.claim.claim !== 'ok', outcome: null, direction: 'advance' },
  { name: 'ok', matches: i => claimed(i, 'ok'), outcome: 'ok', direction: 'advance' },
];

export function resolve({ result, claim, checks, retries, policy = DEFAULT_POLICY }) {
  const input = { result, claim, checks, retries, policy };
  const row = ROWS.find(r => r.matches(input));
  return {
    outcome: row.outcome ?? claim.claim,
    direction: row.direction,
    row: row.name,
    check: row.name === 'check-failed' || row.name === 'integrity-violation' ? failedCheck(input, row.name === 'integrity-violation').name : null,
    retryAfterMs: row.name === 'transient-retry' ? result.failure.retryAfterMs ?? null : null,
    failureClass: result.status === 'failed' ? result.failure?.class ?? null : null,
  };
}
