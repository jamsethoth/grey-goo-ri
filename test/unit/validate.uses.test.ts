import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as procedures from '../../lib/procedures.ts';
import * as validate from '../../lib/validate/index.ts';
import * as exampleSource from '../support/example-source.ts';

// What each Flow uses, recorded as the validator checks it (#364): the files its Pinned Configuration takes and the
// commands its Checks run, beside the Resolved Flow, so no reader walks the Flow again.

/* eslint-disable id-denylist -- a Problem's key is at */

const PROBE = 'probe.md';
const PROBE_SCHEMA = 'probe.schema.json';

// Each place a file-naming key sits, by `<place>.<key>` of procedures.FILE_KEYS and the Action kind or owner it sits
// on: the edit that names the probe file there.
const FILE_SITES: Record<string, (source: exampleSource.Source) => void> = {
  'action.brief on an agent Action': (source) => (source.procedures['tests-fail'].actions[0].brief = PROBE),
  'action.schema on an agent Action': (source) => (source.procedures['tests-fail'].actions[0].schema = PROBE_SCHEMA),
  'action.body on a pr-upsert Action': (source) => (source.procedures.publish.actions[1].body = PROBE),
  'action.body on a comment Action': (source) => (source.procedures.review.actions[3].body = PROBE),
  'action.recoverBrief on a check Action': (source) =>
    (source.procedures['tests-fail'].actions[1].recoverBrief = PROBE),
  'recover.brief': (source) => (source.procedures['tests-fail'].recover.brief = PROBE),
  'claimToken.comment on a stop token': (source) =>
    (source.procedures['tests-fail'].claimTokens.blocked.comment = PROBE),
  'agent.persona on an Agent': (source) => (source.agents.reviewer.persona = PROBE),
  'agent.persona on a Vertex': (source) =>
    exampleSource.putAt(source.flows.default.ticket.vertices.red, ['persona'], PROBE),
};

// The example's schemas, and the probe schema as a copy of red's.
const schemasWithProbe = () => {
  const schemas = exampleSource.schemas();
  return { ...schemas, [PROBE_SCHEMA]: schemas['red.schema.json']! };
};

test('every file-naming key in procedures.FILE_KEYS has a site case, and every site case is one of them', () => {
  const declared = Object.entries(procedures.FILE_KEYS).flatMap(([place, keys]) =>
    keys.map((key) => `${place}.${key}`),
  );
  const sited = [...new Set(Object.keys(FILE_SITES).map((site) => site.split(' ')[0]))];
  assert.deepEqual(declared.sort(), sited.sort());
});

for (const [site, edit] of Object.entries(FILE_SITES)) {
  test(`a Flow uses the file named at ${site}`, () => {
    const source = exampleSource.config();
    edit(source);
    const { errors, uses } = exampleSource.check(source, schemasWithProbe());
    assert.deepEqual(exampleSource.firedRules(errors), []);
    assert.ok(uses.default?.files.includes(site.endsWith('schema on an agent Action') ? PROBE_SCHEMA : PROBE));
  });
}

// The order today's pinning took (Personas by Vertex, then each Procedure's files in the order the Vertices first use
// it), so the Pinned Configuration saves its files as before.
test("the example Flow uses each file it names once: its Personas, then its Procedures' files in use order", () => {
  const { errors, uses } = exampleSource.check(exampleSource.config());
  assert.deepEqual(errors, []);
  assert.deepEqual(uses.default?.files, [
    'implementer.md',
    'reviewer.md',
    'red.md',
    'red.schema.json',
    'tests-fail-recovery.md',
    'recover.md',
    'blocked.md',
    'green.md',
    'implement.schema.json',
    'command-recovery.md',
    'pr-body.md',
    'review.md',
    'review.schema.json',
    'review-comment.md',
    'fix.md',
  ]);
});

// The Config Hash fingerprints a Flow's content, not its source (Q25): a file only an unused Agent or Procedure names
// stays out of it. Moved from config.test.ts with config.usedFiles.
test('a Flow uses only the files of the Agents and Procedures its Vertices use', () => {
  const source = exampleSource.config();
  exampleSource.putAt(source.agents, ['spare'], { harness: 'fake', persona: 'spare-persona.md' });
  exampleSource.putAt(source.procedures, ['spare'], {
    actions: [{ id: 'pr', do: 'pr-upsert', body: 'spare-body.md' }],
  });
  const { errors, uses } = exampleSource.check(source);
  assert.deepEqual(exampleSource.firedRules(errors), []);
  assert.deepEqual(
    uses.default?.files.filter((name) => name.startsWith('spare')),
    [],
  );
  assert.equal(uses.default?.files.length, 15);
});

test('a Flow uses each command its Checks run, once, in the order its Vertices first use them', () => {
  const source = exampleSource.config();
  exampleSource.putAt(source, ['commands'], { ...source.commands, lint: 'npm run lint' });
  source.procedures.publish.actions[0].command = 'lint';
  const { errors, uses } = exampleSource.check(source);
  assert.deepEqual(exampleSource.firedRules(errors), []);
  assert.deepEqual(uses.default?.commands, ['test', 'lint']);
});

// A Flow's uses follow its Procedures' order in its JSON, which puts integer-like names first, as pinning did (D1).
test('a Flow uses the files and commands of Procedures named "2" then "1" in the order "1", "2"', () => {
  const procedures = Object.fromEntries(
    ['2', '1'].map((name) => [
      name,
      {
        actions: [
          { id: 'verify', do: 'check', kind: 'command', command: `command-${name}` },
          { id: 'post', do: 'comment', target: 'ticket', body: `body-${name}.md` },
        ],
      },
    ]),
  );
  const vertices = { first: { procedure: '2', route: { ok: 'second' } }, second: { procedure: '1' } };
  const flows = {
    default: { actionCap: 10, ticket: { entry: 'first', routes: { '*': { end: 'ready-for-qa' } }, vertices } },
  };
  const { uses } = validate.validate({ commands: {}, procedures, flows }, { harnesses: {}, readSchema: () => ({}) });
  assert.deepEqual(uses.default, { files: ['body-1.md', 'body-2.md'], commands: ['command-1', 'command-2'] });
});

// A user Flow that names a command the repository lacks is a misfit (Q21), however its Action is written, as before.
test('a Flow uses a command named on an Action of any kind, beside the unknown key it is', () => {
  const source = exampleSource.config();
  exampleSource.putAt(source.procedures.review.actions, ['0', 'command'], 'lint');
  const { errors, uses } = exampleSource.check(source);
  assert.ok(errors.some(({ at, code }) => at === 'procedures.review.actions[0]' && code === 'unknown-key'));
  assert.deepEqual(uses.default?.commands, ['test', 'lint']);
});

// gg doctor prints a held Flow as written (#305), so it is declared beside the Flows that resolve (#364, Q1 A).
test('a Flow with a field of the wrong type gets no Resolved Flow, and is declared as written', () => {
  const source = exampleSource.config();
  exampleSource.putAt(source.flows.default.ticket.vertices.publish, ['procedure'], ['publish']);
  const { errors, flows, declared } = exampleSource.check(source);
  assert.ok(errors.some(({ code }) => code === 'undeclared-procedure'));
  assert.equal(flows.default, undefined);
  assert.deepEqual(declared.default?.ticket.vertices.publish?.procedure, ['publish']);
});

// gg run pins a user Flow when the only error is an unused Procedure's misfit command, which it filters out (Q21).
test("a Flow whose fields all hold their types resolves beside another Procedure's error", () => {
  const source = exampleSource.config();
  exampleSource.putAt(source.procedures, ['spare'], {
    actions: [{ id: 'lint', do: 'check', kind: 'command', command: 'lint' }],
  });
  const { errors, flows, declared } = exampleSource.check(source);
  assert.deepEqual(exampleSource.firedRules(errors), [
    { at: 'procedures.spare.actions[0]', code: 'undeclared-command' },
  ]);
  assert.ok(flows.default);
  assert.ok(declared.default);
});
