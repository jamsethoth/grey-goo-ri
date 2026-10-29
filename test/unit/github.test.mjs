import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as github from '../../lib/github.mjs';
import * as labels from '../../lib/labels.mjs';
import * as outcome from '../../lib/outcome.mjs';
import * as golden from '../support/golden.mjs';

// Installs gh as the transport until the case ends.
const useGh = (t, gh) => {
  const previous = github.setGh(gh);
  t.after(() => github.setGh(previous));
};

test('createIssue keeps malformed output complete for redaction before publication', async (t) => {
  const output = 'x'.repeat(190) + '/private/worktree/secret-file';
  useGh(t, async () => output);
  await assert.rejects(github.createIssue({ title: 'Ticket', body: 'body' }, '/repo'), (err) => err.message.includes(output));
});

// A stand-in for the gh executable: records every argv and answers from `answer(args)`, as gh's stdout.
const fakeGh = (answer = () => '') => {
  const calls = [];
  const gh = async (args, cwd, input) => {
    calls.push({ args, cwd, input });
    const out = await answer(args);
    return typeof out === 'string' ? out : JSON.stringify(out);
  };
  return { gh, calls };
};

const failingGh = (err) => fakeGh(() => { throw err(); });

const labelArgs = (calls) => calls.flatMap(({ args }) =>
  args.flatMap((a, i) => ['--add-label', '--remove-label', '--label'].includes(args[i - 1]) || (args[0] === 'label' && i === 2) ? [a] : []));

test('setLabels logs and records a failed label update with the ticket number, and reports failure', async (t) => {
  const logs = [], events = [];
  useGh(t, failingGh(() => new Error('HTTP 502')).gh);
  const ok = await github.setLabels(7, { add: ['gg:state:ready-for-qa'], remove: ['gg:state:in-progress'] }, '/repo', { log: (m) => logs.push(m), ev: (t, d) => events.push([t, d]) });
  assert.equal(ok, false);
  assert.ok(logs.some((l) => l.includes('#7') && l.includes('HTTP 502')), JSON.stringify(logs));
  assert.ok(events.some(([t, d]) => t === 'label_failed' && d.ticket === 7), JSON.stringify(events));
});

test('setLabels returns true and records nothing when the update succeeds', async (t) => {
  const events = [];
  useGh(t, fakeGh().gh);
  assert.equal(await github.setLabels(7, { add: ['gg:state:in-progress'] }, '/repo', { log() {}, ev: (t) => events.push(t) }), true);
  assert.deepEqual(events, []);
});

const ghFailure = () => new Error("gh issue edit 7 --add-label in-progress exited 1\nfailed to update https://github.com/o/r/issues/7: 'in-progress' not found");

test('setLabels keeps the reason from the later lines of the error in the log and the event', async (t) => {
  const logs = [], events = [];
  useGh(t, failingGh(ghFailure).gh);
  await github.setLabels(7, { add: ['gg:state:in-progress'] }, '/repo', { log: (m) => logs.push(m), ev: (t, d) => events.push([t, d]) });
  assert.ok(logs.some((l) => l.includes("'in-progress' not found")), JSON.stringify(logs));
  assert.ok(events.some(([t, d]) => t === 'label_failed' && d.error.includes("'in-progress' not found")), JSON.stringify(events));
});

test('error excerpts are bounded', async (t) => {
  const logs = [];
  useGh(t, failingGh(() => new Error(`first\n${'x'.repeat(5000)}`)).gh);
  await github.setLabels(7, {}, '/repo', { log: (m) => logs.push(m), ev() {} });
  assert.ok(logs[0].length < 500, `log line of ${logs[0].length} chars`);
  const excerpt = github.errorExcerpt(new Error(`first\n${'x'.repeat(5000)}`));
  assert.ok(excerpt.length <= 300, `excerpt of ${excerpt.length} chars`);
});

test('isReady is false while a blocking issue is open', () => {
  const issue = (extra) => ({ number: 7, state: 'OPEN', labels: [], blockedBy: [], ...extra });
  assert.equal(github.isReady(issue()), true);
  assert.equal(github.isReady(issue({ blockedBy: [{ number: 3, state: 'OPEN' }] })), false);
  assert.equal(github.isReady(issue({ blockedBy: { nodes: [{ number: 3, state: 'OPEN' }] } })), false);
  assert.equal(github.isReady(issue({ blockedBy: [{ number: 3, state: 'CLOSED' }] })), true);
  assert.equal(github.isReady(issue({ state: 'CLOSED' })), false);
  // ff's unprefixed labels mean nothing to gg.
  assert.equal(github.isReady(issue({ labels: [{ name: 'in-progress' }] })), true);
});

for (const label of ['gg:state:in-progress', 'gg:state:needs-human', 'gg:state:ready-for-qa', 'gg:state:needs-replan']) {
  test(`isReady is false while the Ticket carries ${label}`, () => {
    assert.equal(github.isReady({ number: 7, state: 'OPEN', labels: [{ name: label }], blockedBy: [] }), false);
  });
}

test('readiness names the closed Ticket or its open blockers', () => {
  const issue = { number: 7, state: 'OPEN', labels: [], blockedBy: [] };
  assert.equal(github.readinessReason(issue), null);
  assert.equal(github.readinessReason({ ...issue, state: 'CLOSED' }), 'closed');
  assert.equal(github.readinessReason({ ...issue, blockedBy: { nodes: [
    { number: 3, state: 'OPEN' }, { number: 4, state: 'CLOSED' }, { number: 5, state: 'OPEN' },
  ] } }), 'blocked by #3, #5');
});

for (const [label, reason] of [
  ['x:state:in-progress', 'carries State Label x:state:in-progress'],
  ['x:state:needs-human', 'carries State Label x:state:needs-human'],
  ['x:state:ready-for-qa', 'carries State Label x:state:ready-for-qa'],
  ['x:state:needs-replan', 'carries State Label x:state:needs-replan'],
]) {
  test(`readiness with prefix x names the State Label ${label}`, () => {
    assert.equal(github.readinessReason({ number: 7, state: 'OPEN', labels: [{ name: label }], blockedBy: [] }, { prefix: 'x' }), reason);
  });
}

const viewLabelled = async (t, name) => {
  const fake = golden.fakeGh({ ticket: 7 });
  fake.labels.add(name);
  useGh(t, fake.gh);
  return github.viewIssue(7, '/repo');
};

for (const [prefix, label, reason] of [
  ['gg', 'GG:STATE:IN-PROGRESS', 'carries State Label GG:STATE:IN-PROGRESS'],
  ['gg', 'GG:STATE:NEEDS-HUMAN', 'carries State Label GG:STATE:NEEDS-HUMAN'],
  ['gg', 'GG:STATE:READY-FOR-QA', 'carries State Label GG:STATE:READY-FOR-QA'],
  ['gg', 'GG:STATE:NEEDS-REPLAN', 'carries State Label GG:STATE:NEEDS-REPLAN'],
  ['Gg', 'GG:STATE:IN-PROGRESS', 'carries State Label GG:STATE:IN-PROGRESS'],
  ['Gg', 'GG:STATE:NEEDS-HUMAN', 'carries State Label GG:STATE:NEEDS-HUMAN'],
  ['Gg', 'GG:STATE:READY-FOR-QA', 'carries State Label GG:STATE:READY-FOR-QA'],
  ['Gg', 'GG:STATE:NEEDS-REPLAN', 'carries State Label GG:STATE:NEEDS-REPLAN'],
]) {
  test(`readiness with prefix ${prefix} recognises ${label} and preserves its spelling`, async (t) => {
    const issue = await viewLabelled(t, label);
    assert.equal(github.isReady(issue, { prefix }), false);
    assert.equal(github.readinessReason(issue, { prefix }), reason);
  });
}

for (const [prefix, label] of [['gg', 'X:STATE:IN-PROGRESS'], ['gg', 'IN-PROGRESS'], ['Gg', 'X:STATE:IN-PROGRESS'], ['Gg', 'IN-PROGRESS']]) {
  test(`readiness with prefix ${prefix} ignores ${label}`, async (t) => {
    assert.equal(github.readinessReason(await viewLabelled(t, label), { prefix }), null);
  });
}

const eventPages = [[
  { event: 'labeled', label: { name: 'GG:State:In-Progress' }, created_at: '2026-10-01T00:00:00Z' },
  { event: 'unlabeled', label: { name: 'gg:state:in-progress' }, created_at: '2026-10-02T00:00:00Z' },
  { event: 'labeled', label: { name: 'X:state:in-progress' }, created_at: '2026-10-03T00:00:00Z' },
], [
  { event: 'labeled', label: { name: 'gg:STATE:IN-PROGRESS' }, created_at: '2026-10-04T00:00:00Z' },
  { event: 'labeled', created_at: '2026-10-05T00:00:00Z' },
  { event: 'labeled', label: { name: 'gg:state:needs-human' }, created_at: '2026-10-06T00:00:00Z' },
  { event: 'commented', created_at: '2026-10-07T00:00:00Z' },
]];

for (const prefix of ['gg', 'Gg']) {
  test(`inProgressSince with prefix ${prefix} matches mixed-case event labels`, async (t) => {
    const { gh, calls } = fakeGh((args) => (args[0] === 'api' ? eventPages : ''));
    useGh(t, gh);
    assert.equal(await github.inProgressSince(7, '/repo', { prefix }), '2026-10-04T00:00:00Z');
    assert.ok(calls[0].args.includes('--paginate'), JSON.stringify(calls[0].args));
    assert.match(calls[0].args.at(-1), /\/issues\/7\/events$/);
  });
}

test('inProgressSince is null when no event adds the in-progress State Label', async (t) => {
  useGh(t, fakeGh(() => [eventPages[0].slice(1), eventPages[1].slice(1)]).gh);
  assert.equal(await github.inProgressSince(7, '/repo'), null);
});

test('upsertPr updates an existing PR found by head branch instead of creating', async (t) => {
  const pr = { number: 12, state: 'OPEN', isDraft: true, url: 'https://github.com/o/r/pull/12' };
  const { gh, calls } = fakeGh((args) => (args[0] === 'pr' && args[1] === 'list' ? [pr] : ''));
  useGh(t, gh);
  const got = await github.upsertPr({ branch: 'ticket/7-x', base: 'main', title: 'T', body: 'B' }, '/repo');
  assert.equal(got.number, 12);
  const verbs = calls.map(({ args }) => `${args[0]} ${args[1]}`);
  assert.deepEqual(verbs.filter((v) => v === 'pr list'), ['pr list']);
  assert.ok(!verbs.includes('pr create'), JSON.stringify(verbs));
  const list = calls.find(({ args }) => args[1] === 'list').args;
  assert.equal(list[list.indexOf('--head') + 1], 'ticket/7-x');
  const edit = calls.find(({ args }) => args[1] === 'edit');
  assert.equal(edit.args[2], '12');
  assert.equal(edit.input, 'B');
});

for (const [prefix, expected] of [
  ['gg', ['gg:state:in-progress', 'gg:state:needs-human', 'gg:state:needs-replan', 'gg:state:ready-for-qa']],
  ['x', ['x:state:in-progress', 'x:state:needs-human', 'x:state:needs-replan', 'x:state:ready-for-qa']],
]) {
  test(`ensureLabels creates the four ${prefix}-prefixed state labels`, async (t) => {
    const { gh, calls } = fakeGh(() => []);
    useGh(t, gh);
    await github.ensureLabels('/repo', { prefix });
    const created = calls.filter(({ args }) => args[0] === 'label' && args[1] === 'create').map(({ args }) => args[2]);
    assert.deepEqual(created.sort(), expected);
    assert.ok(calls.every(({ args }) => !args.includes('--force')), 'existing label style is never overwritten');
  });
}

test('ensureLabels reads all label pages once and creates only missing State Labels', async (t) => {
  const { gh, calls } = fakeGh((args) => args[0] === 'api' ? [
    [{ name: 'gg:state:in-progress' }, { name: 'unrelated' }], [{ name: 'gg:state:needs-human' }],
  ] : '');
  useGh(t, gh);
  await github.ensureLabels('/repo');
  assert.equal(calls.filter(({ args }) => args[0] === 'api').length, 1);
  assert.deepEqual(calls.filter(({ args }) => args[0] === 'label').map(({ args }) => args[2]).sort(),
    ['gg:state:needs-replan', 'gg:state:ready-for-qa']);
  assert.ok(calls.every(({ args }) => !args.includes('--force')), 'existing label style is never overwritten');
});

test('every label written through gh carries the prefix', async (t) => {
  const { gh, calls } = fakeGh(() => []);
  useGh(t, gh);
  await github.ensureLabels('/repo', { prefix: 'x' });
  await github.editLabels(7, { add: ['x:state:in-progress'], remove: ['x:await:qa-approval'] }, '/repo');
  await github.setLabels(7, { add: ['x:state:ready-for-qa'], remove: ['x:state:in-progress'] }, '/repo', { log() {}, ev() {} });
  assert.deepEqual(labelArgs(calls), [
    'x:state:in-progress', 'x:state:ready-for-qa', 'x:state:needs-human', 'x:state:needs-replan',
    'x:state:in-progress', 'x:await:qa-approval',
    'x:state:ready-for-qa', 'x:state:in-progress',
  ]);
  assert.ok(!calls.some(({ args }) => args.some((a) => a === 'plan-approved' || a.startsWith('ff:'))), JSON.stringify(calls));
});

const prView = { number: 12, state: 'OPEN', isDraft: false, url: 'https://github.com/o/r/pull/12', body: 'PR body', headRefName: 'ticket/7-x' };
const commentPages = [[
  { id: 101, body: 'first', created_at: '2026-10-01T00:00:00Z', user: { login: 'a' } },
  { id: 102, body: 'second', created_at: '2026-10-02T00:00:00Z', user: { login: 'b' } },
]];
const commentsGh = () => fakeGh((args) => (args[0] === 'api' ? commentPages : args[0] === 'pr' && args[1] === 'view' ? prView : ''));

test('viewPr reads the PR fields through gh pr view', async (t) => {
  const { gh, calls } = commentsGh();
  useGh(t, gh);
  const got = await github.viewPr(12, '/repo');
  assert.equal(got.body, 'PR body');
  assert.equal(got.headRefName, 'ticket/7-x');
  const view = calls.find(({ args }) => args[0] === 'pr' && args[1] === 'view').args;
  assert.equal(view[2], '12');
  assert.deepEqual(view[view.indexOf('--json') + 1].split(',').sort(), ['body', 'headRefName', 'headRefOid', 'isCrossRepository', 'isDraft', 'number', 'state', 'url']);
});

test('prComments reads the PR comments through gh api', async (t) => {
  const { gh, calls } = commentsGh();
  useGh(t, gh);
  assert.deepEqual(await github.prComments(12, '/repo'), [
    { id: 101, body: 'first', createdAt: '2026-10-01T00:00:00Z' },
    { id: 102, body: 'second', createdAt: '2026-10-02T00:00:00Z' },
  ]);
  const apiCalls = calls.filter(({ args }) => args[0] === 'api');
  assert.equal(apiCalls.length, 1);
  assert.ok(apiCalls[0].args.some((a) => a.includes('/12/comments')), JSON.stringify(apiCalls[0].args));
});

test('issueComments reads the issue comments through gh api', async (t) => {
  const { gh, calls } = commentsGh();
  useGh(t, gh);
  assert.deepEqual(await github.issueComments(7, '/repo'), [
    { id: 101, body: 'first', createdAt: '2026-10-01T00:00:00Z' },
    { id: 102, body: 'second', createdAt: '2026-10-02T00:00:00Z' },
  ]);
  const apiCalls = calls.filter(({ args }) => args[0] === 'api');
  assert.equal(apiCalls.length, 1);
  assert.ok(apiCalls[0].args.some((a) => a.includes('/7/comments')), JSON.stringify(apiCalls[0].args));
});

// GitHub matches label names case-insensitively, and a create can lose a race to another Run.
const COLLISION = (name) => new Error(`label with name "${name}" already exists; use --force to update its color and description`);
const labelsApi = (args) => args[0] === 'api' && args.at(-1).includes('/labels');

test('ensureLabels accepts differently cased existing State Labels', async (t) => {
  const { gh, calls } = fakeGh((args) => labelsApi(args) ? [
    [{ name: 'gg:STATE:in-progress' }, { name: 'unrelated' }], [{ name: 'GG:state:Needs-Human' }, { name: 'Gg:State:Ready-For-QA' }],
  ] : '');
  useGh(t, gh);
  await github.ensureLabels('/repo', { prefix: 'Gg' });
  assert.equal(calls.filter(({ args }) => labelsApi(args)).length, 1, 'one label list read');
  assert.deepEqual(calls.filter(({ args }) => args[0] === 'label').map(({ args }) => args[2]), ['Gg:state:needs-replan'],
    'only the missing label is created, in the configured spelling');
  assert.ok(calls.every(({ args }) => !args.includes('--force')), 'existing label style is never overwritten');
});

test('ensureLabels accepts a concurrent create after confirming presence', async (t) => {
  let reads = 0;
  const all = labels.STATE_LABELS.map((n) => ({ name: `GG:state:${n}` }));
  const { gh, calls } = fakeGh((args) => {
    if (labelsApi(args)) return ++reads === 1 ? [[]] : [all];
    if (args[0] === 'label') throw COLLISION(args[2]);
    return '';
  });
  useGh(t, gh);
  await github.ensureLabels('/repo');
  assert.equal(calls.filter(({ args }) => args[0] === 'label').length, 1, 'a confirmed label is not created again');
  assert.equal(reads, 2, 'the failed create is confirmed by one more read');
  assert.ok(calls.every(({ args }) => !args.includes('--force')), 'existing label style is never overwritten');
});

for (const [name, reread] of [
  ['the label is absent on re-read', () => [[]]],
  ['the re-read fails', () => { throw new Error('HTTP 502'); }],
  ['the re-read is malformed JSON', () => 'not json'],
]) {
  test(`ensureLabels does not accept a failed create when ${name}`, async (t) => {
    const denied = new Error('HTTP 403: label creation denied');
    let reads = 0;
    const { gh } = fakeGh((args) => {
      if (labelsApi(args)) return ++reads === 1 ? [[]] : reread();
      if (args[0] === 'label') throw denied;
      return '';
    });
    useGh(t, gh);
    await assert.rejects(github.ensureLabels('/repo'), (err) => err === denied);
  });
}

test('setLabels reports an unconfirmed setup failure without editing the issue', async (t) => {
  const logs = [], events = [];
  const { gh, calls } = fakeGh((args) => {
    if (labelsApi(args)) return [[]];
    if (args[0] === 'label') throw new Error('HTTP 403: label creation denied');
    return '';
  });
  useGh(t, gh);
  const ok = await github.setLabels(7, { add: ['gg:state:in-progress'] }, '/repo',
    { log: (m) => logs.push(m), ev: (t, d) => events.push([t, d]), ensureLabels: () => github.ensureLabels('/repo') });
  assert.equal(ok, false);
  assert.ok(events.some(([t, d]) => t === 'label_failed' && d.error.includes('label creation denied')), JSON.stringify(events));
  assert.ok(!calls.some(({ args }) => args[0] === 'issue' && args[1] === 'edit'), 'the issue is not edited');
});

// #66: a comment POST keeps the response headers a retry needs.
test('a comment is posted through gh api, and a failed one keeps its status and headers', async (t) => {
  const url = 'https://github.com/o/r/issues/7#issuecomment-5';
  const { gh, calls } = fakeGh(() => golden.included(201, { 'Content-Type': 'application/json' }, { id: 5, html_url: url }));
  useGh(t, gh);
  assert.equal(await github.commentIssue(7, 'a "quoted"\nbody', '/repo'), url);
  assert.equal(await github.comment(7, 'on the PR', '/repo'), url);
  assert.ok(calls.every(({ args }) => golden.isCommentPost(args, 7) && args.includes('--include')), JSON.stringify(calls));
  assert.deepEqual(calls.map(({ input }) => JSON.parse(input)), [{ body: 'a "quoted"\nbody' }, { body: 'on the PR' }]);

  github.setGh(async (args) => {
    throw golden.ghError(args, { status: 403, headers: { 'Retry-After': '7', 'X-RateLimit-Remaining': '12' },
      body: { message: 'You have exceeded a secondary rate limit.' } });
  });
  await assert.rejects(github.commentIssue(7, 'b', '/repo'), (err) => {
    assert.deepEqual(err.http, { status: 403, headers: { 'retry-after': '7', 'x-ratelimit-remaining': '12' } });
    assert.match(err.message, /secondary rate limit/);
    return true;
  });
});

// #85: a rate limit whose response gives no wait is read from GitHub's own quota, once.
const NOW = Date.parse('2026-10-15T00:00:00Z');
const isProbe = (args) => args[0] === 'api' && args[1] === 'rate_limit';

test('a rate-limited PR write uses the wait GitHub gives', async (t) => {
  const { gh, calls } = fakeGh((args) => {
    if (isProbe(args)) {
      return { resources: { core: { limit: 5000, remaining: 4999, reset: NOW / 1000 + 3600 }, graphql: { limit: 5000, remaining: 0, reset: NOW / 1000 + 37 } } };
    }
    if (args[0] === 'pr' && args[1] === 'list') return [];
    // gh pr create goes through GraphQL, whose rate limit has no HTTP status.
    throw golden.ghError(args, { stderr: 'GraphQL: API rate limit exceeded for user ID 1.' });
  });
  useGh(t, gh);
  const err = await github.upsertPr({ branch: 'b', base: 'main', title: 'T', body: 'B' }, '/repo').then(() => null, (e) => e);

  assert.match(err?.message ?? '', /API rate limit exceeded/);
  assert.equal(calls.filter(({ args }) => isProbe(args)).length, 1, 'one probe');
  assert.equal(outcome.remoteRetryDelay(outcome.classifyRemoteFailure(err), 1, NOW), 37_000);
});

test('a failed rate-limit probe keeps the 60/120 s fallback', async (t) => {
  const { gh, calls } = fakeGh((args) => {
    throw isProbe(args) ? new Error('HTTP 502') : golden.ghError(args, { status: 403, body: { message: 'API rate limit exceeded for user ID 1.' } });
  });
  useGh(t, gh);
  const err = await github.markReady(7, '/repo').then(() => null, (e) => e);

  assert.match(err?.message ?? '', /API rate limit exceeded/, 'the original error');
  assert.equal(calls.filter(({ args }) => isProbe(args)).length, 1, 'probed once');
  const failure = outcome.classifyRemoteFailure(err);
  assert.equal(failure.class, 'rate-limited');
  assert.equal(outcome.remoteRetryDelay(failure, 1, NOW), 60_000);
  assert.equal(outcome.remoteRetryDelay(failure, 2, NOW), 120_000);
});
