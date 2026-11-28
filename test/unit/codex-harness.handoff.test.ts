import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as codex from '../../lib/harnesses/codex.ts';
import type * as model from '../../lib/model.ts';
import * as cliReplay from '../support/cli-replay.ts';
import * as codexHookHandlers from '../support/codex-hook-handlers.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// The Codex Harness's launch of an Agent with a contextBudget (#485): the hand-off hook it installs, the keys that let
// it fire, and the hook files in gg's Codex home that would fire beside it.

const RUN_DIRECTORY = join('common', 'gg', 'runs', 'run-1');
const CWD = join('worktrees', 'ticket 1');
const SESSION = '01a2044a-1251-7180-8d49-dc1220e52393';
const BUDGET = 150000;
const READER: model.Agent = {
  harness: 'codex',
  persona: 'reviewer.md',
  model: 'gpt-6.1-sol',
  effort: 'high',
  access: 'read-only',
};
const CONTEXT = { commands: { test: 'npm test' }, platform: 'win32' as const };

// `codex plugin list --json` in gg's Codex home as #479 recorded it.
const RECORDED_PLUGINS = (
  JSON.parse(readFileSync(new URL('../fixtures/codex/cli-plugin-list.json', import.meta.url), 'utf8')) as {
    stdout: string;
  }
).stdout;

// The Codex CLI answering its two listings in-process: the recorded plugins, no MCP server.
const codexCli = () =>
  cliReplay.replayLaunch((args) => ({ stdout: args[0] === 'plugin' ? RECORDED_PLUGINS : '[]', exitCode: 0 }), {});

// A Codex home holding the superpowers plugin, a plugin of skills, where Codex keeps it, and `files` at its top.
function codexHome(t: TestContext, files: Record<string, string> = {}) {
  const home = tempDirectory.tempDirectory(t, 'gg-codex-home-');
  const { installed } = JSON.parse(RECORDED_PLUGINS) as { installed: codex.InstalledPlugin[] };
  const plugin = installed.find(({ name }) => name === 'superpowers')!;
  const directory = join(home, 'plugins', 'cache', plugin.marketplaceName, plugin.name, plugin.version);
  mkdirSync(join(directory, '.codex-plugin'), { recursive: true });
  writeFileSync(join(directory, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: plugin.name, skills: './s' }));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(home, file), text);
  return home;
}

const callFor = (agent: model.Agent, call: Partial<codex.CodexCall> = {}): codex.CodexCall => ({
  marker: 'gg:e1:implement:1:p:0:r1:1',
  agent,
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  cwd: CWD,
  resume: null,
  runDirectory: RUN_DIRECTORY,
  access: String(agent.access),
  ...call,
});

const budgetedOf = (agent: model.Agent, contextBudget: number | undefined): model.Agent =>
  contextBudget === undefined ? agent : { ...agent, contextBudget };

// Every kind of launch: each access, fresh and resumed, with and without a listed plugin, with and without a budget.
const LAUNCH_SITES = ['read-only', 'workspace-write'].flatMap((access) =>
  [null, SESSION].flatMap((resume) =>
    [[], ['superpowers']].flatMap((plugins) =>
      [undefined, BUDGET].map((contextBudget) => ({ access, resume, plugins, contextBudget })),
    ),
  ),
);

// What a launch's argv shows of its hooks: the keys that turn them on, its hooks tables, and the hand-off hook among
// their handlers, by its module and its budget on both its commands.
function hooksShown(argv: string[], contextBudget: number | undefined) {
  const passed = codexHookHandlers.overrides(argv);
  const handlers = codexHookHandlers.hookHandlers(argv);
  const atBudget = handlers.filter(
    ({ event, keys }) =>
      event === 'PostToolUse' &&
      [keys.command, keys.commandWindows].every(
        (command) => command?.includes('codex-handoff-hook') && command.includes(String(contextBudget)),
      ),
  );
  return {
    hooksOn: passed.includes('features.hooks=true'),
    hooksOff: passed.includes('features.hooks=false'),
    bypass: argv.includes('--dangerously-bypass-hook-trust'),
    hooksTables: codexHookHandlers.hooksOverrides(argv).length,
    handlers: handlers.length,
    atBudget: atBudget.length,
    withoutWindows: handlers.filter(({ keys }) => !keys.command || !keys.commandWindows).length,
    untrusted: passed.includes(`projects={${JSON.stringify(CWD)}={trust_level="untrusted"}}`),
    compaction: passed.find((key) => key.startsWith('model_auto_compact_token_limit=')) ?? null,
  };
}

// Every launch of a Codex Agent with a contextBudget, whatever else its call varies, turns hooks on with the trust
// bypass, without which none fires (`hooks-untrusted`), and installs the hand-off hook at its budget as a PostToolUse
// hook with its Windows command beside its command (request 3.2); every other launch keeps hooks off with no bypass;
// each keeps the project untrusted, so no project hook loads (Q18 A, `repository-untrusted`) (#485 rules 1 to 3).
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('every launch of a Codex Agent with a contextBudget turns hooks on with the hand-off hook at its budget, and no other does', async (t) => {
  const home = codexHome(t);
  const harness = codex.createCodex({ codexHome: home });
  const listings = await codex.list(codexCli(), home);
  const wrong = LAUNCH_SITES.flatMap(({ access, resume, plugins, contextBudget }) => {
    const agent = budgetedOf({ ...READER, access, plugins }, contextBudget);
    const tools = harness.resolveTools(agent, CONTEXT);
    const { argv } = harness.launchArgs(callFor(agent, { access, resume }), tools, listings);
    const budgeted = contextBudget !== undefined;
    const expected = {
      hooksOn: budgeted,
      hooksOff: !budgeted,
      bypass: budgeted,
      hooksTables: Number(budgeted),
      handlers: Number(budgeted),
      atBudget: Number(budgeted),
      withoutWindows: 0,
      untrusted: true,
      compaction: budgeted ? 'model_auto_compact_token_limit=187500' : null,
    };
    const found = JSON.stringify(hooksShown(argv, contextBudget));
    const site = `${access} ${resume === null ? 'fresh' : 'resumed'} [${plugins.join()}] budget ${contextBudget}`;
    return found === JSON.stringify(expected) ? [] : [`${site}: ${found}`];
  });
  assert.equal(LAUNCH_SITES.length, 16);
  assert.deepEqual(wrong, []);
});

// The error a launch throws, or '' when it builds.
function launchError(home: string, agent: model.Agent, listings: codex.Listings) {
  const harness = codex.createCodex({ codexHome: home });
  try {
    harness.launchArgs(callFor(agent), harness.resolveTools(agent, CONTEXT), listings);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

// Q3 A: a budgeted call turns hooks on, which also runs the hooks of a hooks.json or a config.toml in gg's Codex home
// (`hooks-on`: its `home` hooks fired), so such a file fails a budgeted Agent at preflight and again before spawn,
// naming it, and leaves every other Agent as it was (Q8 A: no hook but gg's reaches a call).
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test("a hook file in gg's Codex home fails a Codex Agent with a contextBudget at preflight and before spawn, naming it", async (t) => {
  const wrong: string[] = [];
  // Each form a config.toml declares hooks in refuses; one with plugins, MCP servers or a comment only does not (D1 A).
  const files: [file: string, text: string, hooks: boolean][] = [
    ['hooks.json', '{"hooks":{}}', true],
    ['config.toml', '[hooks]\nPostToolUse = []\n', true],
    ['config.toml', '[[hooks.PostToolUse]]\nmatcher = ".*"\n', true],
    ['config.toml', 'hooks.SessionStart = []\n', true],
    ['config.toml', 'hooks = { PostToolUse = [] }\n', true],
    ['config.toml', '["hooks".PostToolUse]\nx = 1\n', true],
    ['config.toml', '[plugins."superpowers@openai-curated"]\nenabled = true\n', false],
    ['config.toml', '[plugins."git-hooks@x"]\nenabled = true\n', false],
    ['config.toml', '[mcp_servers.docs]\ncommand = "node"\nargs = ["server.js"]\n', false],
    ['config.toml', '# hooks = {}\n[features]\n', false],
  ];
  for (const [file, text, hooks] of files)
    for (const contextBudget of [undefined, BUDGET]) {
      const home = codexHome(t, { [file]: text });
      const agent = budgetedOf(READER, contextBudget);
      const { ok, errors } = await codex.createCli(codexCli(), { codexHome: home }).validate(agent);
      const launched = launchError(home, agent, await codex.list(codexCli(), home));
      const refused = hooks && contextBudget !== undefined;
      const named = (message: string) => message.includes(join(home, file));
      if (ok === refused || named(errors.join('; ')) !== refused || named(launched) !== refused)
        wrong.push(
          `${file} ${JSON.stringify(text)} budget ${contextBudget}: ` +
            `validate ${JSON.stringify({ ok, errors })}, launch "${launched}"`,
        );
    }
  assert.deepEqual(wrong, []);
});
