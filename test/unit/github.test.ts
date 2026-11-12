import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as github from '../../lib/github.ts';
import type * as jsonValue from '../../lib/json-value.ts';
import * as labels from '../../lib/labels.ts';
import * as outcome from '../../lib/outcome.ts';
import * as fakeGhModule from '../support/fake-gh.ts';

// A stand-in for the gh executable: records every argv and answers from `answer(args)`, as gh's stdout. Unlike
// fakeGhModule.fakeGh, it keeps no GitHub state: each case scripts the answers it needs.
const scriptedGh = (answer: (args: string[]) => unknown = () => '') => {
  const calls: fakeGhModule.GhCall[] = [];
  const gh: github.Transport = async (args, cwd, input) => {
    calls.push({ args, cwd, input });
    const answered = await answer(args);
    return typeof answered === 'string' ? answered : JSON.stringify(answered);
  };
  return { gh, calls };
};

const failingGh = (failure: () => Error) =>
  scriptedGh(() => {
    throw failure();
  });

const labelArgs = (calls: fakeGhModule.GhCall[]) =>
  calls.flatMap(({ args }) =>
    args.flatMap((arg, i) =>
      ['--add-label', '--remove-label', '--label'].includes(args[i - 1]) || (args[0] === 'label' && i === 2)
        ? [arg]
        : [],
    ),
  );

// An Event setLabels reported: its type and its fields.
type ReportedEvent = [string, Record<string, unknown>];

test('setLabels logs and records a failed label update with the ticket number, and reports failure', async (t) => {
  const logs: string[] = [];
  const events: ReportedEvent[] = [];
  const client = github.createGh(failingGh(() => new Error('HTTP 502')).gh);
  const ok = await client.setLabels(7, { add: ['gg:state:ready-for-qa'], remove: ['gg:state:in-progress'] }, '/repo', {
    log: (message) => logs.push(message),
    ev: (type, fields) => events.push([type, fields]),
  });
  assert.equal(ok, false);
  assert.ok(
    logs.some((line) => line.includes('#7') && line.includes('HTTP 502')),
    JSON.stringify(logs),
  );
  assert.ok(
    events.some(([type, fields]) => type === 'label_failed' && fields.ticket === 7),
    JSON.stringify(events),
  );
});

test('setLabels returns true and records nothing when the update succeeds', async (t) => {
  const events: string[] = [];
  const client = github.createGh(scriptedGh().gh);
  assert.equal(
    await client.setLabels(7, { add: ['gg:state:in-progress'] }, '/repo', {
      log() {},
      ev: (type) => events.push(type),
    }),
    true,
  );
  assert.deepEqual(events, []);
});

const ghFailure = () =>
  new Error(
    'gh issue edit 7 --add-label in-progress exited 1\n' +
      "failed to update https://github.com/o/r/issues/7: 'in-progress' not found",
  );

test('setLabels keeps the reason from the later lines of the error in the log and the event', async (t) => {
  const logs: string[] = [];
  const events: ReportedEvent[] = [];
  const client = github.createGh(failingGh(ghFailure).gh);
  await client.setLabels(7, { add: ['gg:state:in-progress'] }, '/repo', {
    log: (message) => logs.push(message),
    ev: (type, fields) => events.push([type, fields]),
  });
  assert.ok(
    logs.some((line) => line.includes("'in-progress' not found")),
    JSON.stringify(logs),
  );
  assert.ok(
    events.some(
      ([type, fields]) => type === 'label_failed' && (fields.error as string).includes("'in-progress' not found"),
    ),
    JSON.stringify(events),
  );
});

test('error excerpts are bounded', async (t) => {
  const logs: string[] = [];
  const client = github.createGh(failingGh(() => new Error(`first\n${'x'.repeat(5000)}`)).gh);
  await client.setLabels(7, {}, '/repo', { log: (message) => logs.push(message), ev() {} });
  assert.ok(logs[0].length < 500, `log line of ${logs[0].length} chars`);
  const excerpt = github.errorExcerpt(new Error(`first\n${'x'.repeat(5000)}`));
  assert.ok(excerpt.length <= 300, `excerpt of ${excerpt.length} chars`);
});

test('isReady is false while a blocking issue is open', () => {
  const issue = (extra?: Partial<github.Issue>) => ({
    number: 7,
    state: 'OPEN',
    labels: [] as github.IssueLabel[],
    blockedBy: [],
    ...extra,
  });
  assert.equal(github.isReady(issue()), true);
  assert.equal(github.isReady(issue({ blockedBy: [{ number: 3, state: 'OPEN' }] })), false);
  assert.equal(github.isReady(issue({ blockedBy: { nodes: [{ number: 3, state: 'OPEN' }] } })), false);
  assert.equal(github.isReady(issue({ blockedBy: [{ number: 3, state: 'CLOSED' }] })), true);
  assert.equal(github.isReady(issue({ state: 'CLOSED' })), false);
  // ff's unprefixed labels mean nothing to gg.
  assert.equal(github.isReady(issue({ labels: [{ name: 'in-progress' }] })), true);
});

for (const label of [
  'gg:state:in-progress',
  'gg:state:needs-human',
  'gg:state:ready-for-qa',
  'gg:state:needs-replan',
]) {
  test(`isReady is false while the Ticket carries ${label}`, () => {
    const issue = { number: 7, state: 'OPEN', labels: [{ name: label }], blockedBy: [] };
    assert.equal(github.isReady(issue), false);
  });
}

test('readiness names the closed Ticket or its open blockers', () => {
  const issue = { number: 7, state: 'OPEN', labels: [], blockedBy: [] };
  assert.equal(github.readinessReason(issue), null);
  assert.equal(github.readinessReason({ ...issue, state: 'CLOSED' }), 'closed');
  assert.equal(
    github.readinessReason({
      ...issue,
      blockedBy: {
        nodes: [
          { number: 3, state: 'OPEN' },
          { number: 4, state: 'CLOSED' },
          { number: 5, state: 'OPEN' },
        ],
      },
    }),
    'blocked by #3, #5',
  );
});

for (const [label, reason] of [
  ['x:state:in-progress', 'carries State Label x:state:in-progress'],
  ['x:state:needs-human', 'carries State Label x:state:needs-human'],
  ['x:state:ready-for-qa', 'carries State Label x:state:ready-for-qa'],
  ['x:state:needs-replan', 'carries State Label x:state:needs-replan'],
]) {
  test(`readiness with prefix x names the State Label ${label}`, () => {
    const issue = { number: 7, state: 'OPEN', labels: [{ name: label }], blockedBy: [] };
    assert.equal(github.readinessReason(issue, { prefix: 'x' }), reason);
  });
}

const viewLabelled = async (name: string) => {
  const fake = fakeGhModule.fakeGh({ branch: 'ticket/7-x', ticket: 7 });
  fake.labels.add(name);
  const client = github.createGh(fake.gh);
  return client.viewIssue(7, '/repo');
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
    const issue = await viewLabelled(label);
    assert.equal(github.isReady(issue, { prefix }), false);
    assert.equal(github.readinessReason(issue, { prefix }), reason);
  });
}

for (const [prefix, label] of [
  ['gg', 'X:STATE:IN-PROGRESS'],
  ['gg', 'IN-PROGRESS'],
  ['Gg', 'X:STATE:IN-PROGRESS'],
  ['Gg', 'IN-PROGRESS'],
]) {
  test(`readiness with prefix ${prefix} ignores ${label}`, async (t) => {
    assert.equal(github.readinessReason(await viewLabelled(label), { prefix }), null);
  });
}

test('upsertPr updates an existing PR found by head branch instead of creating', async (t) => {
  const pr = { number: 12, state: 'OPEN', isDraft: true, url: 'https://github.com/o/r/pull/12' };
  const { gh, calls } = scriptedGh((args) => (args[0] === 'pr' && args[1] === 'list' ? [pr] : ''));
  const client = github.createGh(gh);
  const got = await client.upsertPr({ branch: 'ticket/7-x', base: 'main', title: 'T', body: 'B' }, '/repo');
  assert.equal(got.number, 12);
  const verbs = calls.map(({ args }) => `${args[0]} ${args[1]}`);
  assert.deepEqual(
    verbs.filter((verb) => verb === 'pr list'),
    ['pr list'],
  );
  assert.ok(!verbs.includes('pr create'), JSON.stringify(verbs));
  const list = calls.find(({ args }) => args[1] === 'list')!.args;
  assert.equal(list[list.indexOf('--head') + 1], 'ticket/7-x');
  const edit = calls.find(({ args }) => args[1] === 'edit')!;
  assert.equal(edit.args[2], '12');
  assert.equal(edit.input, 'B');
});

for (const [prefix, expected] of [
  ['gg', ['gg:state:in-progress', 'gg:state:needs-human', 'gg:state:needs-replan', 'gg:state:ready-for-qa']],
  ['x', ['x:state:in-progress', 'x:state:needs-human', 'x:state:needs-replan', 'x:state:ready-for-qa']],
] as [string, string[]][]) {
  test(`ensureLabels creates the four ${prefix}-prefixed state labels`, async (t) => {
    const { gh, calls } = scriptedGh(() => []);
    const client = github.createGh(gh);
    await client.ensureLabels('/repo', { prefix });
    const created = calls.filter(({ args }) => args[0] === 'label' && args[1] === 'create').map(({ args }) => args[2]);
    assert.deepEqual(created.sort(), expected);
    assert.ok(
      calls.every(({ args }) => !args.includes('--force')),
      'existing label style is never overwritten',
    );
  });
}

test('ensureLabels reads all label pages once and creates only missing State Labels', async (t) => {
  const { gh, calls } = scriptedGh((args) =>
    args[0] === 'api'
      ? [[{ name: 'gg:state:in-progress' }, { name: 'unrelated' }], [{ name: 'gg:state:needs-human' }]]
      : '',
  );
  const client = github.createGh(gh);
  await client.ensureLabels('/repo');
  assert.equal(calls.filter(({ args }) => args[0] === 'api').length, 1);
  assert.deepEqual(
    calls
      .filter(({ args }) => args[0] === 'label')
      .map(({ args }) => args[2])
      .sort(),
    ['gg:state:needs-replan', 'gg:state:ready-for-qa'],
  );
  assert.ok(
    calls.every(({ args }) => !args.includes('--force')),
    'existing label style is never overwritten',
  );
});

test('every label written through gh carries the prefix', async (t) => {
  const { gh, calls } = scriptedGh(() => []);
  const client = github.createGh(gh);
  await client.ensureLabels('/repo', { prefix: 'x' });
  await client.editLabels(7, { add: ['x:state:in-progress'], remove: ['x:await:qa-approval'] }, '/repo');
  await client.setLabels(7, { add: ['x:state:ready-for-qa'], remove: ['x:state:in-progress'] }, '/repo', {
    log() {},
    ev() {},
  });
  assert.deepEqual(labelArgs(calls), [
    'x:state:in-progress',
    'x:state:ready-for-qa',
    'x:state:needs-human',
    'x:state:needs-replan',
    'x:state:in-progress',
    'x:await:qa-approval',
    'x:state:ready-for-qa',
    'x:state:in-progress',
  ]);
  assert.ok(
    !calls.some(({ args }) => args.some((arg) => arg === 'plan-approved' || arg.startsWith('ff:'))),
    JSON.stringify(calls),
  );
});

const prView = {
  number: 12,
  state: 'OPEN',
  isDraft: false,
  url: 'https://github.com/o/r/pull/12',
  body: 'PR body',
  headRefName: 'ticket/7-x',
  headRefOid: 'a'.repeat(40),
  isCrossRepository: false,
};
const commentPages = [
  [
    { id: 101, body: 'first', created_at: '2026-10-01T00:00:00Z', user: { login: 'a' } },
    { id: 102, body: 'second', created_at: '2026-10-02T00:00:00Z', user: { login: 'b' } },
  ],
];
const commentsGh = () =>
  scriptedGh((args) => {
    if (args[0] === 'api') return commentPages;
    return args[0] === 'pr' && args[1] === 'view' ? prView : '';
  });

test('viewPr reads the PR fields through gh pr view', async (t) => {
  const { gh, calls } = commentsGh();
  const client = github.createGh(gh);
  const got = await client.viewPr(12, '/repo');
  assert.equal(got.body, 'PR body');
  assert.equal(got.headRefName, 'ticket/7-x');
  const view = calls.find(({ args }) => args[0] === 'pr' && args[1] === 'view')!.args;
  assert.equal(view[2], '12');
  assert.deepEqual(view[view.indexOf('--json') + 1].split(',').sort(), [
    'body',
    'headRefName',
    'headRefOid',
    'isCrossRepository',
    'isDraft',
    'number',
    'state',
    'url',
  ]);
});

test("comments reads a PR's comments through gh api", async (t) => {
  const { gh, calls } = commentsGh();
  const client = github.createGh(gh);
  assert.deepEqual(await client.comments(12, '/repo'), [
    { id: 101, author: 'a', body: 'first', createdAt: '2026-10-01T00:00:00Z' },
    { id: 102, author: 'b', body: 'second', createdAt: '2026-10-02T00:00:00Z' },
  ]);
  const apiCalls = calls.filter(({ args }) => args[0] === 'api');
  assert.equal(apiCalls.length, 1);
  assert.ok(
    apiCalls[0].args.some((arg) => arg.includes('/12/comments')),
    JSON.stringify(apiCalls[0].args),
  );
});

test("comments reads an issue's comments through gh api", async (t) => {
  const { gh, calls } = commentsGh();
  const client = github.createGh(gh);
  assert.deepEqual(await client.comments(7, '/repo'), [
    { id: 101, author: 'a', body: 'first', createdAt: '2026-10-01T00:00:00Z' },
    { id: 102, author: 'b', body: 'second', createdAt: '2026-10-02T00:00:00Z' },
  ]);
  const apiCalls = calls.filter(({ args }) => args[0] === 'api');
  assert.equal(apiCalls.length, 1);
  assert.ok(
    apiCalls[0].args.some((arg) => arg.includes('/7/comments')),
    JSON.stringify(apiCalls[0].args),
  );
});

// GitHub matches label names case-insensitively, and a create can lose a race to another Run.
const COLLISION = (name: string) =>
  new Error(`label with name "${name}" already exists; use --force to update its color and description`);
const labelsApi = (args: string[]) => args[0] === 'api' && args.at(-1)!.includes('/labels');

test('ensureLabels accepts differently cased existing State Labels', async (t) => {
  const { gh, calls } = scriptedGh((args) =>
    labelsApi(args)
      ? [
          [{ name: 'gg:STATE:in-progress' }, { name: 'unrelated' }],
          [{ name: 'GG:state:Needs-Human' }, { name: 'Gg:State:Ready-For-QA' }],
        ]
      : '',
  );
  const client = github.createGh(gh);
  await client.ensureLabels('/repo', { prefix: 'Gg' });
  assert.equal(calls.filter(({ args }) => labelsApi(args)).length, 1, 'one label list read');
  assert.deepEqual(
    calls.filter(({ args }) => args[0] === 'label').map(({ args }) => args[2]),
    ['Gg:state:needs-replan'],
    'only the missing label is created, in the configured spelling',
  );
  assert.ok(
    calls.every(({ args }) => !args.includes('--force')),
    'existing label style is never overwritten',
  );
});

test('ensureLabels accepts a concurrent create after confirming presence', async (t) => {
  let reads = 0;
  const all = labels.STATE_NAMES.map((name) => ({ name: `GG:state:${name}` }));
  const { gh, calls } = scriptedGh((args) => {
    if (labelsApi(args)) return ++reads === 1 ? [[]] : [all];
    if (args[0] === 'label') throw COLLISION(args[2]);
    return '';
  });
  const client = github.createGh(gh);
  await client.ensureLabels('/repo');
  assert.equal(calls.filter(({ args }) => args[0] === 'label').length, 1, 'a confirmed label is not created again');
  assert.equal(reads, 2, 'the failed create is confirmed by one more read');
  assert.ok(
    calls.every(({ args }) => !args.includes('--force')),
    'existing label style is never overwritten',
  );
});

for (const [name, reread] of [
  ['the label is absent on re-read', () => [[]]],
  [
    'the re-read fails',
    () => {
      throw new Error('HTTP 502');
    },
  ],
  ['the re-read is malformed JSON', () => 'not json'],
] as const) {
  test(`ensureLabels does not accept a failed create when ${name}`, async (t) => {
    const denied = new Error('HTTP 403: label creation denied');
    let reads = 0;
    const { gh } = scriptedGh((args) => {
      if (labelsApi(args)) return ++reads === 1 ? [[]] : reread();
      if (args[0] === 'label') throw denied;
      return '';
    });
    const client = github.createGh(gh);
    await assert.rejects(client.ensureLabels('/repo'), (err) => err === denied);
  });
}

test('setLabels reports an unconfirmed setup failure without editing the issue', async (t) => {
  const logs: string[] = [];
  const events: ReportedEvent[] = [];
  const { gh, calls } = scriptedGh((args) => {
    if (labelsApi(args)) return [[]];
    if (args[0] === 'label') throw new Error('HTTP 403: label creation denied');
    return '';
  });
  const client = github.createGh(gh);
  const ok = await client.setLabels(7, { add: ['gg:state:in-progress'] }, '/repo', {
    log: (message) => logs.push(message),
    ev: (type, fields) => events.push([type, fields]),
    ensureLabels: () => client.ensureLabels('/repo'),
  });
  assert.equal(ok, false);
  assert.ok(
    events.some(
      ([type, fields]) => type === 'label_failed' && (fields.error as string).includes('label creation denied'),
    ),
    JSON.stringify(events),
  );
  assert.ok(!calls.some(({ args }) => args[0] === 'issue' && args[1] === 'edit'), 'the issue is not edited');
});

// #66: a comment POST keeps the response headers a retry needs.
test('a comment is posted through gh api, and a failed one keeps its status and headers', async (t) => {
  const url = 'https://github.com/o/r/issues/7#issuecomment-5';
  const { gh, calls } = scriptedGh(() =>
    fakeGhModule.included(201, { 'Content-Type': 'application/json' }, { id: 5, html_url: url }),
  );
  const client = github.createGh(gh);
  await client.comment(7, 'a "quoted"\nbody', '/repo');
  await client.comment(7, 'on the PR', '/repo');
  assert.ok(
    calls.every(({ args }) => fakeGhModule.isCommentPost(args, 7) && args.includes('--include')),
    JSON.stringify(calls),
  );
  assert.deepEqual(
    calls.map(({ input }) => JSON.parse(input as string)),
    [{ body: 'a "quoted"\nbody' }, { body: 'on the PR' }],
  );

  const rateLimited = github.createGh(async (args) => {
    throw fakeGhModule.ghError(args, {
      status: 403,
      headers: { 'Retry-After': '7', 'X-RateLimit-Remaining': '12' },
      body: { message: 'You have exceeded a secondary rate limit.' },
    });
  });
  await assert.rejects(rateLimited.comment(7, 'b', '/repo'), (err: github.GhError) => {
    assert.deepEqual(err.http, { status: 403, headers: { 'retry-after': '7', 'x-ratelimit-remaining': '12' } });
    assert.match(err.message, /secondary rate limit/);
    return true;
  });
});

// The id is the API's, never read back from the URL, so the two differ here.
test('comment returns the comment id and url', async (t) => {
  const url = 'https://github.com/o/r/issues/7#issuecomment-5';
  const { gh } = scriptedGh(() =>
    fakeGhModule.included(201, { 'Content-Type': 'application/json' }, { id: 6, html_url: url }),
  );
  assert.deepEqual(await github.createGh(gh).comment(7, 'body', '/repo'), { id: 6, url });
});

// #85: a rate limit whose response gives no wait is read from GitHub's own quota, once.
const NOW = Date.parse('2026-10-15T00:00:00Z');
const isProbe = (args: string[]) => args[0] === 'api' && args[1] === 'rate_limit';

test('a rate-limited PR write uses the wait GitHub gives', async (t) => {
  const { gh, calls } = scriptedGh((args) => {
    if (isProbe(args)) {
      return {
        resources: {
          core: { limit: 5000, remaining: 4999, reset: NOW / 1000 + 3600 },
          graphql: { limit: 5000, remaining: 0, reset: NOW / 1000 + 37 },
        },
      };
    }
    if (args[0] === 'pr' && args[1] === 'list') return [];
    // gh pr create goes through GraphQL, whose rate limit has no HTTP status.
    throw fakeGhModule.ghError(args, { stderr: 'GraphQL: API rate limit exceeded for user ID 1.' });
  });
  const client = github.createGh(gh);
  const err = await client.upsertPr({ branch: 'b', base: 'main', title: 'T', body: 'B' }, '/repo').then(
    () => null,
    (rejection: Error) => rejection,
  );

  assert.match(err?.message ?? '', /API rate limit exceeded/);
  assert.equal(calls.filter(({ args }) => isProbe(args)).length, 1, 'one probe');
  assert.equal(outcome.remoteRetryDelay(outcome.classifyRemoteFailure(err), 1, NOW), 37_000);
});

test('a failed rate-limit probe keeps the 60/120 s fallback', async (t) => {
  const { gh, calls } = scriptedGh((args) => {
    throw isProbe(args)
      ? new Error('HTTP 502')
      : fakeGhModule.ghError(args, { status: 403, body: { message: 'API rate limit exceeded for user ID 1.' } });
  });
  const client = github.createGh(gh);
  const err = await client.markReady(7, '/repo').then(
    () => null,
    (rejection: Error) => rejection,
  );

  assert.match(err?.message ?? '', /API rate limit exceeded/, 'the original error');
  assert.equal(calls.filter(({ args }) => isProbe(args)).length, 1, 'probed once');
  const failure = outcome.classifyRemoteFailure(err);
  assert.equal(failure.failureClass, 'rate-limited');
  assert.equal(outcome.remoteRetryDelay(failure, 1, NOW), 60_000);
  assert.equal(outcome.remoteRetryDelay(failure, 2, NOW), 120_000);
});

test("ensureLabels creates the Flow's await and decide labels", async (t) => {
  const { gh, calls } = scriptedGh(() => [[{ name: 'gg:await:approve' }]]);
  const client = github.createGh(gh);
  await client.ensureLabels('/repo', {
    prefix: 'gg',
    flowLabels: ['gg:await:approve', 'gg:decide:approve:approved', 'gg:decide:approve:rejected'],
  });
  const created = calls.filter(({ args }) => args[0] === 'label').map(({ args }) => args[2]);
  assert.deepEqual(
    created.filter((name) => !name!.includes(':state:')),
    ['gg:decide:approve:approved', 'gg:decide:approve:rejected'],
    'only those missing',
  );
});

test("repositoryLabels reads every page of the repository's label names", async (t) => {
  const { gh } = scriptedGh(() => [[{ name: 'one' }], [{ name: 'two' }]]);
  assert.deepEqual(await github.createGh(gh).repositoryLabels('/repo'), ['one', 'two']);
});

test("issueEvents reads every page of an issue's events", async (t) => {
  const first = { id: 1, event: 'labeled', created_at: '2026-10-15T00:00:00Z' };
  const second = { id: 2, event: 'unlabeled', created_at: '2026-10-15T00:00:01Z' };
  const { gh, calls } = scriptedGh(() => [[first], [second]]);
  assert.deepEqual(await github.createGh(gh).issueEvents(7, '/repo'), [first, second]);
  assert.deepEqual(calls[0]!.args, ['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/issues/7/events']);
});

test("collaboratorPermission reads an actor's permission", async (t) => {
  const { gh, calls } = scriptedGh(() => ({ permission: 'maintain', role_name: 'maintain' }));
  assert.equal(await github.createGh(gh).collaboratorPermission('some-actor', '/repo'), 'maintain');
  assert.deepEqual(calls[0]!.args, ['api', 'repos/{owner}/{repo}/collaborators/some-actor/permission']);
});

test('an actor GitHub does not know as a collaborator has no permission, and any other failure throws', async (t) => {
  const notFound = fakeGhModule.fakeGh({ branch: 'b', ticket: 1 });
  assert.equal(await github.createGh(notFound.gh).collaboratorPermission('a-stranger', '/repo'), 'none');
  const denied = fakeGhModule.fakeGh({ branch: 'b', ticket: 1 });
  denied.fail({ matches: () => true, status: 502 });
  await assert.rejects(github.createGh(denied.gh).collaboratorPermission('anyone', '/repo'), github.GhError);
});

test("repositoryName reads the repository's owner/name through gh repo view", async (t) => {
  const fake = fakeGhModule.fakeGh({ branch: 'b', ticket: 1, repository: 'acme/app' });
  assert.deepEqual(await github.createGh(fake.gh).repositoryName('/repo'), { repository: 'acme/app', error: null });
  assert.deepEqual(fake.calls, [{ args: ['repo', 'view', '--json', 'nameWithOwner'], cwd: '/repo', input: undefined }]);
});

// A Run's preflight reports the failure, so the read returns it instead of throwing, whatever failed (#321).
test('a failed owner/name read returns its reason and never throws', async (t) => {
  const failed = fakeGhModule.fakeGh({ branch: 'b', ticket: 1 });
  failed.fail({ matches: () => true, stderr: 'no git remotes found' });
  const unread = await github.createGh(failed.gh).repositoryName('/repo');
  assert.equal(unread.repository, null);
  assert.match(unread.error ?? '', /no git remotes found/);

  const spawnFailure = failingGh(() => Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
  const unspawned = await github.createGh(spawnFailure.gh).repositoryName('/repo');
  assert.equal(unspawned.repository, null);
  assert.match(unspawned.error ?? '', /spawn gh ENOENT/);
});

// The owner/name becomes two directories of a worktree's path, so only GitHub's own form is accepted.
const MALFORMED_ANSWERS = [
  'not json',
  '{}',
  '{"nameWithOwner":null}',
  '{"nameWithOwner":""}',
  '{"nameWithOwner":"app"}',
  '{"nameWithOwner":"acme/app/extra"}',
  '{"nameWithOwner":"../app"}',
  '{"nameWithOwner":"acme/.."}',
  '{"nameWithOwner":"acme\\\\app"}',
  '{"nameWithOwner":"acme/a p"}',
];
for (const answer of MALFORMED_ANSWERS) {
  test(`an owner/name answer ${answer} is a failed read naming it`, async (t) => {
    const { gh } = scriptedGh(() => answer);
    const read = await github.createGh(gh).repositoryName('/repo');
    assert.equal(read.repository, null);
    assert.ok(read.error?.includes(answer), read.error ?? 'no error');
  });
}

// Each verb that reads gh's JSON, with an answer holding every field it reads, linked issues in both of gh's forms
// (#354).
const JSON_VERBS: {
  verb: string;
  read: (client: github.Gh) => Promise<unknown>;
  answer: jsonValue.JsonValue;
  respond?: (answer: jsonValue.JsonValue) => string;
}[] = [
  { verb: 'repositoryLabels', read: (client) => client.repositoryLabels('/repo'), answer: [[{ name: 'one' }]] },
  {
    verb: 'viewIssue',
    read: (client) => client.viewIssue(7, '/repo'),
    answer: {
      number: 7,
      title: 'title',
      body: 'body',
      state: 'OPEN',
      labels: [{ name: 'one' }],
      blockedBy: [{ number: 3, state: 'OPEN' }],
      subIssues: { nodes: [{ number: 4 }] },
    },
  },
  {
    verb: 'comments',
    read: (client) => client.comments(7, '/repo'),
    answer: [[{ id: 101, user: { login: 'a' }, body: 'first', created_at: '2026-10-01T00:00:00Z' }]],
  },
  {
    verb: 'comment',
    read: (client) => client.comment(7, 'body', '/repo'),
    answer: { id: 6, html_url: 'https://github.com/o/r/issues/7#issuecomment-6' },
    respond: (answer) => fakeGhModule.included(201, { 'Content-Type': 'application/json' }, answer),
  },
  {
    verb: 'issueEvents',
    read: (client) => client.issueEvents(7, '/repo'),
    answer: [
      [
        {
          id: 1,
          event: 'labeled',
          created_at: '2026-10-15T00:00:00Z',
          label: { name: 'one' },
          actor: { login: 'a' },
        },
      ],
    ],
  },
  {
    verb: 'collaboratorPermission',
    read: (client) => client.collaboratorPermission('a', '/repo'),
    answer: { permission: 'write' },
  },
  {
    verb: 'findPr',
    read: (client) => client.findPr('ticket/7-x', '/repo'),
    answer: [{ number: 12, state: 'OPEN', isDraft: false, url: 'https://github.com/o/r/pull/12' }],
  },
  {
    verb: 'viewPr',
    read: (client) => client.viewPr(12, '/repo'),
    answer: prView,
  },
];

// The nodes a node holds, each with its path: `answer.key` or `answer[0]`.
const heldNodes = (value: jsonValue.JsonValue, path: string): [string, jsonValue.JsonValue][] => {
  if (Array.isArray(value)) return value.map((item, i) => [`${path}[${i}]`, item]);
  if (value !== null && typeof value === 'object')
    return Object.entries(value).map(([key, item]) => [`${path}.${key}`, item]);
  return [];
};
// Every node of an answer, by its path from the answer.
const answerNodes = (value: jsonValue.JsonValue, path = 'answer'): [string, jsonValue.JsonValue][] => [
  [path, value],
  ...heldNodes(value, path).flatMap(([held, item]) => answerNodes(item, held)),
];
// The answer with the node at `path` swapped for a value of another JSON type.
const swapped = (answer: jsonValue.JsonValue, path: string): jsonValue.JsonValue => {
  const swap = (value: jsonValue.JsonValue, where: string): jsonValue.JsonValue => {
    if (where === path) return typeof value === 'string' ? 7 : 'text';
    if (Array.isArray(value)) return value.map((item, i) => swap(item, `${where}[${i}]`));
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swap(item, `${where}.${key}`)]));
    return value;
  };
  return swap(answer, 'answer');
};

test("each verb that reads gh's JSON fails on a field of the wrong type, naming it", async (t) => {
  for (const { verb, read, answer, respond = (given: jsonValue.JsonValue) => JSON.stringify(given) } of JSON_VERBS) {
    await t.test(`${verb} reads its well-formed answer`, async () => {
      await read(github.createGh(scriptedGh(() => respond(answer)).gh));
    });
    for (const [path] of answerNodes(answer))
      await t.test(`${verb} fails on ${path} of the wrong type`, async () => {
        const { gh } = scriptedGh(() => respond(swapped(answer, path)));
        await assert.rejects(read(github.createGh(gh)), (err: Error) => {
          assert.ok(err.message.includes(`${path} `), err.message);
          return true;
        });
      });
  }
});
