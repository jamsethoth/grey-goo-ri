import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as publicText from '../../lib/public-text.ts';
import * as render from '../../lib/render.ts';
import * as marker from '../../lib/marker.ts';
import type * as record from '../../lib/record.ts';
import * as actionMarkerParts from '../support/action-marker-parts.ts';
import * as exampleLayer from '../support/example-layer.ts';

// A template of the example `gg init` writes.
const shipped = (name: string) => exampleLayer.fixtureText(name);

const { asText } = actionMarkerParts;
const parts = { ...actionMarkerParts.parts, visit: 1, action: 'commit', recovery: 0 };

test('fence redacts before truncating and prefers complete lines', () => {
  const directory = '/private/' + 'person'.repeat(20);
  const raw = `${directory}/proj/file\n${'x'.repeat(2970)}`;
  const redact = (text: string) => publicText.publicText(text, [directory]);
  assert.equal(render.fence(raw, redact), '```\n[local]/proj/file\n' + 'x'.repeat(2970) + '\n```');
  assert.equal(render.fence('x'.repeat(3100) + '\nlast line'), '```\nlast line\n```');
  assert.equal(render.fence('x'.repeat(3100)), '```\n' + 'x'.repeat(3000) + '\n```');
});

test('fence retains a character tail for JSON errors and overlong final lines', () => {
  const json = JSON.stringify({ error: 'x'.repeat(3100) });
  const http = 'gh: HTTP 422 Validation Failed\n' + 'y'.repeat(3100);
  assert.deepEqual(
    [render.fence(json), render.fence(http)],
    ['```\n' + 'x'.repeat(2998) + '"}\n```', '```\n' + 'y'.repeat(3000) + '\n```'],
  );
});

for (const [kind, subject] of [
  ['test', 'test: Add the cart total (#7)'],
  ['feat', 'feat: Add the cart total (#7)'],
  ['fix', 'fix: Add the cart total (#7)'],
]) {
  test(`a ${kind} commit message carries the stage and action trailers`, () => {
    const actionMarker = marker.formatMarker(parts);
    const message = render.commitMessage({
      kind,
      title: 'Add the cart total',
      ticket: 7,
      summary: 'Sums line items.',
      vertex: 'implement',
      harness: 'claude',
      model: 'opus',
      effort: 'high',
      marker: actionMarker,
    });
    const lines = message.trimEnd().split('\n');
    assert.equal(lines[0], subject);
    assert.match(message, /Sums line items\./);
    assert.deepEqual(lines.slice(-2), [
      'Gg-Vertex: implement claude/opus/high',
      'Gg-Action: gg:e1:implement:1:commit:0:r1:1',
    ]);
    assert.deepEqual(asText(marker.parseMarker(message)), asText(parts));
  });
}

const implementationReport = {
  summary: 'Adds the cart total.',
  definitionOfDone: [
    { item: 'Total sums items', met: true, evidence: 'test/cart.test.mjs' },
    { item: 'Docs', met: false, evidence: '' },
  ],
  red: { command: 'npm test', output: 'not ok 1 - total' },
  green: { command: 'npm test', output: 'ok 1 - total' },
  qa: {
    setup: 'npm ci',
    steps: [{ action: 'Run gg', expected: 'Total shown' }],
    edgeCases: ['empty cart'],
    automated: ['total'],
    manual: [],
  },
};
interface PrBodyFields {
  ticket: { number: number };
  implementationReport: Record<string, unknown>;
  provenance: unknown[];
  marker: string;
}
interface StopFields {
  end: string;
  outcome: string;
  response: Record<string, unknown>;
  reason: { text: string } | null;
}
// The shipped PR body, review comment and stop comment over the context their Actions give them.
const prBody = (
  { ticket, implementationReport, provenance, marker: actionMarker }: PrBodyFields,
  redact?: publicText.Redact,
) =>
  render.publicBody(
    shipped('pr-body.md'),
    {
      ticket,
      report: implementationReport,
      red: implementationReport.red,
      green: implementationReport.green,
      provenance,
    },
    actionMarker,
    redact,
  );
const reviewComment = (response: unknown, agent: unknown, actionMarker: string, redact?: publicText.Redact) =>
  render.publicBody(shipped('review-comment.md'), { review: { response }, agent }, actionMarker, redact);
const stopComment = (
  { end, outcome, response, reason }: StopFields,
  actionMarker: string,
  redact?: publicText.Redact,
) => render.publicBody(shipped('blocked.md'), { end, outcome, response, reason: reason?.text }, actionMarker, redact);
const provenance = [
  {
    vertex: 'implement',
    harness: 'claude',
    model: 'opus',
    effort: 'high',
    persona: 'tdd-implementer',
    personaHash: 'abc123',
    calls: 2,
    inputTokens: 100,
    cacheReadTokens: 40,
    outputTokens: 20,
  },
  {
    vertex: 'review',
    harness: 'codex',
    model: 'gpt',
    effort: 'medium',
    persona: 'reviewer',
    personaHash: 'def456',
    calls: 1,
    inputTokens: 50,
    cacheReadTokens: 0,
    outputTokens: 10,
  },
];

test('the PR body carries the marker line and provenance', async () => {
  const actionMarker = marker.formatMarker(parts);
  const body = await prBody({ ticket: { number: 7 }, implementationReport, provenance, marker: actionMarker });
  assert.match(body, /^Closes #7/);
  assert.equal(body.trimEnd().split('\n').at(-1), `<!-- gg-action ${actionMarker} -->`);
  assert.deepEqual(asText(marker.parseMarker(body)), asText(parts));
  const row = body.split('\n').find((line) => line.startsWith('| implement |'));
  assert.ok(row, 'provenance row for the implement vertex');
  assert.match(row, /tdd-implementer@abc123/);
  assert.match(body, /- \[x\] Total sums items/);
  assert.match(body, /- \[ \] Docs/);
});

test('provenance counts one call per Attempt and a resumed Session once', () => {
  const markerAt = (vertex: string, action: string, recovery: number, attempt: number) =>
    marker.formatMarker({ execution: 'e1', vertex, visit: 1, action, recovery, run: 'r1', attempt });
  const usage = (input: number, cached: number, output: number) => ({
    inputTokens: input,
    cacheReadTokens: cached,
    outputTokens: output,
  });
  // Each Attempt's completion saves its own usage.delta; the Session keeps only the last cumulative usage.
  const call = (actionMarker: string, delta: ReturnType<typeof usage>) => [
    { step: 'intent', actionMarker, effect: 'call', payload: {}, evidence: null },
    { step: 'evidence', actionMarker, effect: 'call', payload: null, evidence: { usageDelta: delta } },
    { step: 'complete', actionMarker, effect: 'call', payload: null, evidence: null },
  ];
  const session = (vertex: string, cumulative: ReturnType<typeof usage>) => ({
    vertex,
    harness: 'claude',
    model: 'opus',
    effort: 'high',
    personaName: 'tdd.md',
    personaHash: 'abcdef0123456789',
    cumulativeUsage: cumulative,
  });
  const executionRecord = {
    sessions: {
      // The recovery pass resumed red's Session, so its cumulative usage holds red's tokens too.
      'red/1/red': session('red', usage(130, 10, 13)),
      'green/1/green': session('green', usage(60, 0, 6)),
    },
    writeAheadLog: [
      ...call(markerAt('red', 'red', 0, 1), usage(100, 10, 10)),
      ...call(markerAt('red', 'red', 1, 1), usage(30, 0, 3)),
      // A commit's evidence is not a call's, so it counts nothing.
      {
        step: 'evidence',
        actionMarker: markerAt('red', 'commit', 1, 1),
        effect: 'commit',
        payload: null,
        evidence: { sha: 'abc' },
      },
      // A parse retry: two Attempts of one Action, each one call.
      ...call(markerAt('green', 'green', 0, 1), usage(50, 0, 5)),
      ...call(markerAt('green', 'green', 0, 2), usage(60, 0, 6)),
    ],
  };
  const row = (vertex: string, calls: number, tokens: ReturnType<typeof usage>) => ({
    vertex,
    harness: 'claude',
    model: 'opus',
    effort: 'high',
    persona: 'tdd.md',
    personaHash: 'abcdef012345',
    calls,
    ...tokens,
  });
  assert.deepEqual(render.provenance(executionRecord as unknown as record.ExecutionRecord), [
    row('red', 2, usage(130, 10, 13)),
    row('green', 2, usage(110, 0, 11)),
  ]);
});

const last = (text: string) => text.trimEnd().split('\n').at(-1);
const fenced = (text: string) => '```\n' + text + '\n```';

test('a section renders once per list item', async () => {
  assert.equal(
    await render.renderTemplate('{{#items}}- {{name}}\n{{/items}}', { items: [{ name: 'a' }, { name: 'b' }] }),
    '- a\n- b\n',
  );
});

test('a section renders once for a present value and not for an empty one', async () => {
  assert.equal(
    await render.renderTemplate('[{{#met}}x{{/met}}][{{#none}}y{{/none}}][{{#empty}}z{{/empty}}]', {
      met: true,
      none: '',
      empty: [],
    }),
    '[x][][]',
  );
});

test('an inverted section renders for an absent value', async () => {
  assert.equal(await render.renderTemplate('{{^missing}}none{{/missing}}', {}), 'none');
});

test('an inverted section renders for an empty list and not for a present value', async () => {
  assert.equal(
    await render.renderTemplate('{{^items}}none{{/items}}{{^met}}no{{/met}}', { items: [], met: true }),
    'none',
  );
});

test('a dotted name reads a nested field, and an absent name renders empty', async () => {
  assert.equal(
    await render.renderTemplate('#{{ticket.number}} [{{ticket.missing}}] [{{nothing.here}}]', {
      ticket: { number: 7 },
    }),
    '#7 [] []',
  );
});

test('inside a list section a name reads the item first, then the outer context', async () => {
  const context = { base: 'main', files: ['a.mjs', 'b.mjs'], rows: [{ name: 'r1' }] };
  assert.equal(
    await render.renderTemplate('{{#files}}{{.}}@{{base}} {{/files}}{{#rows}}{{name}}@{{base}}{{/rows}}', context),
    'a.mjs@main b.mjs@main r1@main',
  );
});

test('a section tag alone on its line leaves no line behind', async () => {
  assert.equal(
    await render.renderTemplate('head\n  {{#items}}\n- {{.}}\n  {{/items}}\n{{^items}}\nnone\n{{/items}}\ntail', {
      items: ['a'],
    }),
    'head\n- a\ntail',
  );
});

test('an unnamed context value is not computed', async () => {
  let named = 0;
  const context = {
    named: () => {
      named++;
      return 'yes';
    },
    unnamed: () => {
      throw new Error('the unnamed value was computed');
    },
  };
  assert.equal(await render.renderTemplate('{{named}} {{#named}}{{named}}{{/named}}', context), 'yes yes');
  assert.equal(named, 1, 'a named value is computed once');
});

test('an async context value is awaited', async () => {
  assert.equal(
    await render.renderTemplate('{{#files}}{{.}} {{/files}}', { files: async () => ['a.mjs', 'b.mjs'] }),
    'a.mjs b.mjs ',
  );
});

test('a section without its closing tag is refused', async () => {
  await assert.rejects(render.renderTemplate('{{#items}}x', { items: [1] }), /\{\{#items\}\} is not closed/);
  await assert.rejects(render.renderTemplate('x{{/items}}', {}), /\{\{\/items\}\} closes no open section/);
});

test("a fence whose opening line names a value fences every value it holds past that value's backticks", async () => {
  assert.equal(
    await render.renderTemplate('```{{lang}}\n{{text}}\n```', { lang: 'text', text: 'x\n```\n## Outside' }),
    '````text\nx\n```\n## Outside\n````',
  );
});

test('a value between two fences is not fenced', async () => {
  assert.equal(
    await render.renderTemplate('```\na\n```\n{{value}}\n```\nb\n```', { value: '``` v' }),
    '```\na\n```\n``` v\n```\nb\n```',
  );
});

test(
  'a tilde fence outruns the tildes it holds, ' + 'and an info string holding a backtick takes a tilde fence',
  async () => {
    assert.equal(
      await render.renderTemplate('~~~\n{{text}}\n~~~', { text: '~~~\n## Outside' }),
      '~~~~\n~~~\n## Outside\n~~~~',
    );
    assert.equal(
      await render.renderTemplate('```{{lang}}\n{{text}}\n```', { lang: 'a`b', text: 'x' }),
      '~~~a`b\nx\n~~~',
    );
  },
);

test('a section that crosses a fence, and a fence that is not closed, are refused', async () => {
  await assert.rejects(
    // eslint-disable-next-line id-length -- the section name the expected error quotes
    render.renderTemplate('{{#a}}\n```\n{{/a}}\n```', { a: 1 }),
    /\{\{\/a\}\} closes no open section/,
  );
  await assert.rejects(
    // eslint-disable-next-line id-length -- the section name the expected error quotes
    render.renderTemplate('```\n{{#a}}\n```\n{{/a}}', { a: 1 }),
    /\{\{#a\}\} must close inside the fence it opens in/,
  );
  await assert.rejects(render.renderTemplate('```\nx', {}), /a fence is not closed/);
});

const fixture = (name: string) => readFileSync(new URL(`../fixtures/templates/${name}`, import.meta.url), 'utf8');
const shapes = JSON.parse(fixture('comments.json')) as {
  parts: Record<marker.MarkerPart, string | number>;
  prImpl: Record<string, unknown>;
  provenance: unknown[];
  review: Record<string, unknown>;
};
const fixtureMarker = marker.formatMarker(shapes.parts);

// The fixtures are the builders' output before #105.
test(`the PR body template matches its builder's output`, async () => {
  const body = await prBody({
    ticket: { number: 7 },
    implementationReport: shapes.prImpl,
    provenance: shapes.provenance,
    marker: fixtureMarker,
  });
  assert.equal(body, fixture('pr-body.txt'));
});

// After a retest the red input still holds an earlier Visit's Red Evidence (S4), so only red's latest report says that
// no test failed (N6, N10).
test("the rendered PR body shows red's no-test notes, also after a retest", async () => {
  const redReport = {
    claim: 'blocked',
    reason: 'no-test-needed',
    summary: 'No test is needed.',
    tests: [],
    notes: 'The change only renames a constant.',
    diagnosis: 'Nothing observable changes.',
  };
  const body = (red: unknown) =>
    render.publicBody(
      shipped('pr-body.md'),
      {
        ticket: { number: 7 },
        report: implementationReport,
        red,
        green: implementationReport.green,
        redReport,
        provenance,
      },
      fixtureMarker,
    );
  const first = await body(undefined);
  assert.ok(first.includes('The change only renames a constant.'), first);
  assert.match(first, /no failing test/i, first);
  const retest = await body(implementationReport.red);
  assert.ok(retest.includes('The change only renames a constant.'), retest);
  assert.ok(retest.includes('no-test-needed'), retest);
});

test(`the review comment template matches its builder's output`, async () => {
  assert.equal(await reviewComment(shapes.review, shapes.provenance[1], fixtureMarker), fixture('review-comment.txt'));
  assert.equal(
    await reviewComment({ ...shapes.review, claim: 'ok', findings: [] }, shapes.provenance[1], fixtureMarker),
    fixture('review-comment-no-findings.txt'),
  );
});

test(`the Terminal Reason comment template matches its builder's output`, async () => {
  const interrupted = { terminal: 'ready-for-qa', terminalReason: { text: 'PR #3 is ready.' } };
  assert.equal(
    await render.terminalComment({
      end: 'needs-human',
      reason: { text: 'An unexpected fault stopped the Execution at test.' },
      marker: fixtureMarker,
      detail: 'Error: boom',
      interrupted,
    }),
    fixture('terminal.txt'),
  );
  assert.equal(
    await render.terminalComment({
      end: 'ready-for-qa',
      reason: { text: 'Every Vertex passed. PR #3 is ready for review.' },
      marker: fixtureMarker,
    }),
    fixture('terminal-plain.txt'),
  );
});

test('the stop comment renders the blocked and needs-replan cases', async () => {
  const actionMarker = marker.formatMarker(parts);
  const response = {
    claim: 'blocked',
    summary: 'Cannot reach the API.',
    notes: 'NOTES stay out.',
    diagnosis: 'The ticket needs a token.',
  };
  const blocked = await stopComment(
    {
      end: 'needs-human',
      outcome: 'blocked',
      response,
      reason: { text: 'The agent made a blocked Claim at green.' },
    },
    actionMarker,
  );
  assert.equal(
    blocked,
    `### gg: blocked

${fenced('Cannot reach the API.')}

${fenced('The ticket needs a token.')}

**Terminal Reason:** The agent made a blocked Claim at green.

<!-- gg-action ${actionMarker} -->
`,
  );
  const replan = await stopComment(
    {
      end: 'needs-replan',
      outcome: 'misscoped',
      response: { ...response, claim: 'misscoped', diagnosis: 'Split into two tickets.' },
      reason: null,
    },
    actionMarker,
  );
  assert.equal(
    replan,
    `### gg: misscoped

${fenced('Cannot reach the API.')}

${fenced('Split into two tickets.')}

<!-- gg-action ${actionMarker} -->
`,
  );
});

test('a review comment fences each finding past its own backticks and carries the marker line', async () => {
  const actionMarker = marker.formatMarker(parts);
  const review = await reviewComment(
    {
      claim: 'changes',
      summary: 'One bug.',
      definitionOfDoneMet: true,
      redGreenEvidenceOk: true,
      diagnosis: '',
      findings: [
        {
          severity: 'major',
          file: 'lib/a.mjs',
          issue: 'off by one\n```\n## Injected heading',
          fix: 'use <=\n# Another',
        },
      ],
    },
    provenance[1],
    actionMarker,
  );
  assert.match(review, /reviewer@def456/);
  assert.match(review, /\*\*changes\*\*/);
  assert.match(review, /Verdict: changes/);
  assert.doesNotMatch(review, /undefined/);
  assert.ok(
    review.includes('````\noff by one\n```\n## Injected heading\n````'),
    `finding issue is fenced past its own backticks: ${review}`,
  );
  assert.ok(review.includes(fenced('use <=\n# Another')), `finding fix is fenced: ${review}`);
  assert.equal(last(review), `<!-- gg-action ${actionMarker} -->`);
});

test('a review comment fences a finding file so its text cannot leave the fence', async () => {
  const actionMarker = marker.formatMarker(parts);
  const file = 'a.mjs`\n\n## Outside fence\n\n`';
  const injected = await reviewComment(
    {
      claim: 'changes',
      summary: 'x',
      definitionOfDoneMet: true,
      redGreenEvidenceOk: true,
      diagnosis: '',
      findings: [{ severity: 'major', file, issue: 'i', fix: 'f' }],
    },
    provenance[1],
    actionMarker,
  );
  assert.ok(injected.includes(render.fence(file)), `finding file is fenced: ${injected}`);
  assert.doesNotMatch(injected.replace(render.fence(file), ''), /## Outside fence/);
});

// Marking `gg` too shows that no builder passes its Action Marker through the redactor.
const redact = (text: string) => text.replaceAll('TOKEN', 'TOKEN*').replaceAll('gg', 'g*g');
const reason = { text: 'TOKEN reason' };
const tokenProvenance = provenance.map((agentRow) => ({
  ...agentRow,
  vertex: `TOKEN ${agentRow.vertex}`,
  harness: `TOKEN ${agentRow.harness}`,
  model: `TOKEN ${agentRow.model}`,
  effort: `TOKEN ${agentRow.effort}`,
  persona: `TOKEN ${agentRow.persona}`,
}));
const tokenResponse = {
  claim: 'blocked',
  summary: 'TOKEN summary',
  notes: 'TOKEN notes',
  diagnosis: 'TOKEN diagnosis',
};
const tokenReport = {
  summary: 'TOKEN summary',
  definitionOfDone: [{ item: 'TOKEN item', met: true, evidence: 'TOKEN evidence' }],
  red: { command: 'TOKEN red', output: 'TOKEN red output' },
  green: { command: 'TOKEN green', output: 'TOKEN green output' },
  qa: {
    setup: 'TOKEN setup',
    steps: [{ action: 'TOKEN action', expected: 'TOKEN expected' }],
    edgeCases: ['TOKEN edge'],
    automated: ['TOKEN automated'],
    manual: ['TOKEN manual'],
  },
};
const tokenReview = {
  claim: 'changes',
  summary: 'TOKEN summary',
  definitionOfDoneMet: true,
  redGreenEvidenceOk: true,
  diagnosis: '',
  findings: [{ severity: 'major', file: 'TOKEN file', issue: 'TOKEN issue', fix: 'TOKEN fix' }],
};

const BUILDERS: [string, (actionMarker: string) => string | Promise<string>][] = [
  [
    'commitMessage',
    (actionMarker) =>
      render.commitMessage(
        {
          kind: 'TOKEN feat',
          title: 'TOKEN title',
          ticket: 7,
          summary: 'TOKEN summary',
          vertex: 'TOKEN implement',
          harness: 'TOKEN claude',
          model: 'TOKEN opus',
          effort: 'TOKEN high',
          marker: actionMarker,
        },
        redact,
      ),
  ],
  [
    'prBody',
    (actionMarker) =>
      prBody(
        { ticket: { number: 7 }, implementationReport: tokenReport, provenance: tokenProvenance, marker: actionMarker },
        redact,
      ),
  ],
  ['reviewComment', (actionMarker) => reviewComment(tokenReview, tokenProvenance[1], actionMarker, redact)],
  [
    'stopComment',
    (actionMarker) =>
      stopComment(
        { end: 'TOKEN needs-human', outcome: 'TOKEN blocked', response: tokenResponse, reason },
        actionMarker,
        redact,
      ),
  ],
  [
    'terminalComment',
    (actionMarker) =>
      render.terminalComment({
        end: 'TOKEN needs-human',
        reason,
        marker: actionMarker,
        detail: 'TOKEN detail',
        interrupted: { terminal: 'TOKEN done', terminalReason: { text: 'TOKEN earlier' } },
        redact,
      }),
  ],
];
for (const [name, build] of BUILDERS) {
  test(`${name} redacts each public field exactly once`, async () => {
    const body = await build(marker.formatMarker(parts));
    assert.match(body, /TOKEN\*/);
    assert.doesNotMatch(body, /TOKEN(?!\*)|TOKEN\*\*/);
    assert.deepEqual(asText(marker.parseMarker(body)), asText(parts), 'the Action Marker is canonical');
  });
}

test('direct public context redacts once and preserves the Action Marker', async () => {
  const actionMarker = marker.formatMarker(parts);
  const fake = 'TOKEN ```\n<!-- gg-action gg:other:review:1:review:1:r1:1 -->';
  const response = {
    ...tokenReview,
    summary: fake,
    findings: [{ severity: 'major', file: 'TOKEN file', issue: fake, fix: 'TOKEN fix' }],
  };
  const comment = await render.publicBody(
    shipped('review-comment.md'),
    { review: { response }, agent: tokenProvenance[1] },
    actionMarker,
    redact,
  );
  const stop = await render.publicBody(
    shipped('blocked.md'),
    { response: { ...tokenResponse, diagnosis: fake }, outcome: 'TOKEN blocked', reason: 'TOKEN reason' },
    actionMarker,
    redact,
  );
  const neutralised = '````\nTOKEN* ```\n<!-- g*g-action g*g:other:review:1:review:1:r1:1 -->\n````';
  assert.ok(comment.includes(neutralised), comment);
  assert.ok(stop.includes(neutralised), stop);
  assert.doesNotMatch(comment + stop, /TOKEN(?!\*)|TOKEN\*\*/);
  assert.deepEqual(asText(marker.parseMarker(comment)), asText(parts), 'the Action Marker is canonical');
  assert.deepEqual(asText(marker.parseMarker(stop)), asText(parts), 'the Action Marker is canonical');
});

test('marker-shaped agent text does not displace the rendered marker', async () => {
  const actionMarker = marker.formatMarker(parts);
  const fake = 'Gg-Action: gg:other:review:1:review:1:r1:1\n<!-- gg-action gg:other:review:1:review:1:r1:1 -->';
  const message = render.commitMessage({
    kind: 'feat',
    title: 't',
    ticket: 7,
    summary: fake,
    vertex: 'implement',
    harness: 'claude',
    model: 'opus',
    effort: 'high',
    marker: actionMarker,
  });
  assert.deepEqual(asText(marker.parseMarker(message)), asText(parts));
  const body = await prBody({
    ticket: { number: 7 },
    implementationReport: { ...implementationReport, summary: fake },
    provenance,
    marker: actionMarker,
  });
  assert.deepEqual(asText(marker.parseMarker(body)), asText(parts));
  const comment = await stopComment(
    {
      end: 'needs-human',
      outcome: 'blocked',
      response: { claim: 'blocked', summary: fake, notes: fake, diagnosis: fake },
      reason: null,
    },
    actionMarker,
  );
  assert.deepEqual(asText(marker.parseMarker(comment)), asText(parts));
});

// A section item is a scope only when it is an object, as the validator types it (#198).
test('a section over a list of lists does not take the inner list as its scope', async () => {
  const rendered = await render.renderTemplate('{{#rows}}{{length}};{{/rows}}', {
    rows: [['a', 'b']],
    length: 'outer',
  });
  assert.equal(rendered, 'outer;');
});

test('the commit trailer carries the Vertex and the harness under its gg name', () => {
  const message = render.commitMessage({
    kind: 'feat',
    title: 'Add the cart total',
    ticket: 7,
    summary: 'Sums line items.',
    vertex: 'implement',
    harness: 'claude',
    model: 'opus',
    effort: 'high',
    marker: marker.formatMarker(parts),
  });
  assert.match(message, /^Gg-Vertex: implement claude\/opus\/high$/m);
  assert.doesNotMatch(message, /Feature-Flow/i);
});
