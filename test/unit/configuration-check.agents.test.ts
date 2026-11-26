// Each shape a Vertex can give its Agent in reaches its Harness's doctor (#484 F1, D1 A): an area file of
// configuration-check.test.ts, which is at its line cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as util from 'node:util';
import type * as config from '../../lib/config.ts';
import * as configurationCheck from '../../lib/configuration-check.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as report from '../../lib/validate/report.ts';
import * as fakeHarness from '../support/fake-harness.ts';
import * as runFixture from '../support/run-fixture.ts';

const MACHINE_SETTINGS = { maxParallel: 2, worktreeRoot: '~/worktrees' };

// The run fixture's repository source: a red, green and publish Flow on the fake Harness.
const repositorySource = () => runFixture.testConfig('', {});
type Repository = ReturnType<typeof repositorySource>;

// `repository` as the repository's source, beside a user source that holds only the machine settings, or `user`; the
// files each names move beside it.
const sources = (
  { files: repositoryFiles = {}, ...repository }: config.Source & { files?: config.SourceFiles },
  { files: userFiles = {}, ...user }: config.Source & { files?: config.SourceFiles } = MACHINE_SETTINGS,
): config.Configuration => ({
  repository,
  user,
  repositoryFile: '/repo/.agents/gg/gg.json',
  userFile: '/home/.agents/gg/gg.json',
  files: { repository: repositoryFiles, user: userFiles },
});

// A user source: the run fixture's Procedures and Agents with the machine settings and no repository contract, whose
// one Flow `name` is a copy of the fixture's Flow; `change` may edit it.
function userSource(name: string, change: (user: Repository) => void) {
  const user = { ...structuredClone(repositorySource()), ...MACHINE_SETTINGS } as Repository;
  for (const key of ['commands', 'testPaths', 'labelPrefix', 'baseBranch']) delete user[key];
  user.flows = { [name]: user.flows.default! };
  change(user);
  return user;
}

// Each shape a Vertex can give its Agent in, as the case builds it, and the Agents the fake Harness's doctor is then
// given: a used Agent by its name; an inline one, or one that differs from the Agent already under its name, by
// `<flow>.<vertex>` of the first Vertex that runs it, or its next free `#<n>` when that is taken; an Agent equal to one
// already given, once (#484 F1, D1 A, F6, F7, D4 A).
const AGENT_SHAPES: Record<string, () => { configuration: config.Configuration; agents: Record<string, unknown> }> = {
  used: () => {
    const repository = repositorySource();
    return { configuration: sources(repository), agents: { implementer: repository.agents.implementer } };
  },
  inline: () => {
    const repository = repositorySource();
    const { implementer } = repository.agents;
    delete repository.agents.implementer;
    for (const vertex of Object.values(repository.flows.default!.ticket.vertices) as Record<string, unknown>[])
      if (vertex.use !== undefined) {
        delete vertex.use;
        Object.assign(vertex, implementer);
      }
    return { configuration: sources(repository), agents: { 'default.red': implementer } };
  },
  'used with Vertex keys': () => {
    const repository = repositorySource();
    const { implementer } = repository.agents;
    (repository.flows.default!.ticket.vertices.green as Record<string, unknown>).plugins = ['rewriter'];
    return {
      configuration: sources(repository),
      agents: { implementer, 'default.green': { ...implementer, plugins: ['rewriter'] } },
    };
  },
  'the same name in both Sources': () => {
    const repository = repositorySource();
    const user = userSource('mine', (source) => {
      source.agents.implementer!.model = 'model-y';
    });
    return {
      configuration: sources(repository, user),
      agents: { implementer: repository.agents.implementer, 'user:mine.red': user.agents.implementer },
    };
  },
  // An own key, as JSON.parse reads gg.json, so the name stays data (#174, #484 F6).
  'named __proto__': () => {
    const repository = repositorySource();
    const agent = { ...repository.agents.implementer, plugins: ['rewriter'] };
    repository.agents = Object.fromEntries([['__proto__', agent]]) as Repository['agents'];
    for (const vertex of Object.values(repository.flows.default!.ticket.vertices) as Record<string, unknown>[])
      if (vertex.use !== undefined) vertex.use = '__proto__';
    return { configuration: sources(repository), agents: Object.fromEntries([['__proto__', agent]]) };
  },
  'inline, then an identical named one': () => {
    const repository = repositorySource();
    const { implementer } = repository.agents;
    const red = repository.flows.default!.ticket.vertices.red as Record<string, unknown>;
    delete red.use;
    Object.assign(red, implementer);
    return { configuration: sources(repository), agents: { 'default.red': implementer } };
  },
  'two names for one Agent': () => {
    const repository = repositorySource();
    const { implementer } = repository.agents;
    repository.agents.twin = structuredClone(implementer);
    (repository.flows.default!.ticket.vertices.green as Record<string, unknown>).use = 'twin';
    return { configuration: sources(repository), agents: { implementer } };
  },
  // A taken key gets the next free suffix (#484 D4 A).
  'named like a Vertex key': () => {
    const repository = repositorySource();
    const { implementer } = repository.agents;
    const named = { ...implementer, plugins: ['rewriter'] };
    repository.agents = { 'default.green': named };
    const { red, green } = repository.flows.default!.ticket.vertices as Record<string, Record<string, unknown>>;
    red!.use = 'default.green';
    delete green!.use;
    Object.assign(green!, implementer);
    return { configuration: sources(repository), agents: { 'default.green': named, 'default.green#2': implementer } };
  },
};

test('every shape a Vertex gives its Agent in reaches its Harness doctor once, under a name of its own', async () => {
  for (const [shape, build] of Object.entries(AGENT_SHAPES)) {
    const { configuration, agents } = build();
    const given: unknown[] = [];
    const fake = {
      ...fakeHarness.fakeHarness(),
      doctor: (options: runContext.DoctorOptions) => {
        given.push(options.agents);
        return Promise.resolve({ ok: true, checks: [] });
      },
    };
    const checked = await configurationCheck.check({ config: configuration, harnesses: { fake } });
    const errors = [...checked.configurationErrors, ...checked.environmentErrors];
    assert.deepEqual(
      errors.map((problem) => report.line('error', problem)),
      [],
      shape,
    );
    assert.deepEqual(given, [agents], shape);
    // Whatever its key: no Agent given twice, and every Agent a Vertex runs given.
    const givenAgents = given.flatMap((byName) => Object.values(byName as Record<string, unknown>));
    givenAgents.forEach((agent, index) =>
      assert.ok(!givenAgents.slice(index + 1).some((other) => util.isDeepStrictEqual(agent, other)), shape),
    );
    for (const { declared } of checked.flows.values())
      for (const { agent } of Object.values(declared.ticket.vertices))
        if (agent != null)
          assert.ok(
            givenAgents.some((other) => util.isDeepStrictEqual(agent, other)),
            shape,
          );
  }
});
