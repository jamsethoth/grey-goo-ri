import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as codex from '../../lib/harnesses/codex.ts';
import * as contract from '../../lib/harnesses/contract.ts';
import type * as model from '../../lib/model.ts';
import * as cliReplay from '../support/cli-replay.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// The Codex Harness as a declaration (#481): its Capabilities, what it refuses of an Agent, the listings it reads of
// gg's Codex home, and the argv and environment of its launch profile, each as #479 recorded the CLI
// (test/fixtures/codex/, docs/research/codex-cli.md).

const RUN_DIRECTORY = join('common', 'gg', 'runs', 'run-1');
const CWD = join('worktrees', 'ticket 1');
const SESSION = '01a2044a-1251-7180-8d49-dc1220e52393';
const SCHEMA = {
  type: 'object',
  properties: { claim: { type: 'string' } },
  required: ['claim'],
  additionalProperties: false,
};
const WRITER: model.Agent = {
  harness: 'codex',
  persona: 'implementer.md',
  model: 'gpt-6.1-sol',
  effort: 'high',
  access: 'workspace-write',
};
const READER: model.Agent = { ...WRITER, persona: 'reviewer.md', access: 'read-only' };
const CONTEXT = { commands: { test: 'npm test' }, platform: 'win32' as const };

const recording = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/codex/${name}.json`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;

// `codex plugin list --json` in gg's Codex home as #479 recorded it: ten remote plugins, installed and enabled.
const RECORDED_PLUGINS = recording('cli-plugin-list').stdout as string;
const RECORDED_IDS = (JSON.parse(RECORDED_PLUGINS) as { installed: { pluginId: string }[] }).installed.map(
  ({ pluginId }) => pluginId,
);

// A plugin listing of the installed plugins `entries` names, each `[name, marketplace, version]`, as the CLI prints it.
const pluginList = (entries: [string, string, string][]) =>
  JSON.stringify({
    installed: entries.map(([name, marketplaceName, version]) => ({
      pluginId: `${name}@${marketplaceName}`,
      name,
      marketplaceName,
      version,
      installed: true,
      enabled: true,
      source: { source: 'local', path: name },
    })),
    available: [],
  });

// An MCP listing of the servers `names` configures, as `codex mcp list --json` prints it.
const serverList = (...names: string[]) => JSON.stringify(names.map((name) => ({ name, enabled: true })));

// The Codex CLI answering its two listings in-process, and every launch it was asked for; `fails` exits 1 on the
// listing whose first argument it names.
function codexCli({
  plugins = RECORDED_PLUGINS,
  mcp = '[]',
  fails,
}: { plugins?: string; mcp?: string; fails?: string } = {}) {
  return cliReplay.replayLaunch(
    (args) => {
      if (args[0] === 'plugin') return { stdout: plugins, exitCode: 0 };
      if (args[0] === 'mcp') return { stdout: mcp, exitCode: 0 };
      throw new Error(`no recording answers codex ${args.join(' ')}`);
    },
    fails === undefined ? {} : { fails },
  );
}

// The first two arguments of each launch, which name the command.
const commandsOf = (launches: { args: string[] }[]) => launches.map(({ args }) => args.slice(0, 2).join(' '));

// What a plugin's folder holds: its manifest's keys and the files beside it.
interface Folder {
  keys: string[];
  files: string[];
}

const DESCRIPTIVE = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'];

// gg's ten installed plugins as their folders in gg's Codex home hold them (a read-only look, #481 Q3): two of skills,
// one of apps alone, six of skills and apps, and openai-developers with MCP servers beside them.
const INSTALLED: Record<string, Folder> = {
  github: { keys: [...DESCRIPTIVE, 'apps', 'interface'], files: ['.app.json'] },
  'openai-developers': {
    keys: [...DESCRIPTIVE, 'skills', 'mcpServers', 'apps', 'interface', 'extensions'],
    files: ['.app.json', '.mcp.json'],
  },
  superpowers: { keys: [...DESCRIPTIVE, 'skills', 'interface'], files: [] },
  'build-web-apps': { keys: [...DESCRIPTIVE, 'skills', 'interface'], files: [] },
  'openai-templates': { keys: [...DESCRIPTIVE, 'skills', 'apps', 'interface'], files: ['.app.json'] },
  pages: {
    keys: ['apps', 'author', 'description', 'interface', 'keywords', 'license', 'name', 'skills', 'version'],
    files: ['.app.json'],
  },
  sites: { keys: [...DESCRIPTIVE, 'skills', 'apps', 'interface'], files: ['.app.json'] },
  'plugin-management': { keys: [...DESCRIPTIVE, 'skills', 'apps', 'interface'], files: ['.app.json'] },
  'work-pets': { keys: [...DESCRIPTIVE, 'skills', 'apps', 'interface'], files: ['.app.json'] },
  visualize: { keys: [...DESCRIPTIVE, 'skills', 'interface', 'apps'], files: ['.app.json'] },
};

// A Codex home holding each listed plugin `folders` names in its cache, where Codex keeps an installed plugin:
// plugins/cache/<marketplace>/<name>/<version>/, with its manifest at .codex-plugin/plugin.json.
function codexHomeWith(t: TestContext, folders: Record<string, Folder> = INSTALLED, listing = RECORDED_PLUGINS) {
  const home = tempDirectory.tempDirectory(t, 'gg-codex-home-');
  const { installed } = JSON.parse(listing) as { installed: codex.InstalledPlugin[] };
  for (const plugin of installed) {
    const folder = folders[plugin.name];
    if (folder === undefined) continue;
    const directory = join(home, 'plugins', 'cache', plugin.marketplaceName, plugin.name, plugin.version);
    mkdirSync(join(directory, '.codex-plugin'), { recursive: true });
    const manifest = Object.fromEntries(folder.keys.map((key) => [key, key === 'name' ? plugin.name : `./${key}`]));
    writeFileSync(join(directory, '.codex-plugin', 'plugin.json'), JSON.stringify(manifest));
    for (const file of folder.files) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), '{}');
    }
  }
  return home;
}

const callFor = (agent: model.Agent, call: Partial<codex.CodexCall> = {}): codex.CodexCall => ({
  marker: 'gg:e1:implement:1:p:0:r1:1',
  agent,
  schema: SCHEMA,
  cwd: CWD,
  resume: null,
  runDirectory: RUN_DIRECTORY,
  access: String(agent.access),
  ...call,
});

// The launch of a call for `agent` over a Codex home and its listings.
async function launched(
  t: TestContext,
  agent: model.Agent,
  { call = {}, mcp = '[]', folders = INSTALLED, plugins = RECORDED_PLUGINS } = {} as {
    call?: Partial<codex.CodexCall>;
    mcp?: string;
    folders?: Record<string, Folder>;
    plugins?: string;
  },
) {
  const home = codexHomeWith(t, folders, plugins);
  const harness = codex.createCodex({ codexHome: home });
  const listings = await codex.list(codexCli({ plugins, mcp }), home);
  return { home, launch: harness.launchArgs(callFor(agent, call), harness.resolveTools(agent, CONTEXT), listings) };
}

// Every kind of launch, by a label naming it: each access, fresh and resumed, with and without a listed plugin and a
// listed MCP server.
async function everyLaunch(t: TestContext) {
  const home = codexHomeWith(t);
  const harness = codex.createCodex({ codexHome: home });
  const listings = await codex.list(codexCli({ mcp: serverList('playwright', 'node_repl') }), home);
  const launches: [string, codex.Launch][] = [];
  for (const access of ['read-only', 'workspace-write'])
    for (const resume of [null, SESSION])
      for (const plugins of [[], ['superpowers']])
        for (const mcp of [[], ['playwright']]) {
          const agent: model.Agent = { ...READER, access, plugins, mcp };
          const label = `${access} ${resume === null ? 'fresh' : 'resumed'} [${plugins.join()}] [${mcp.join()}]`;
          const tools = harness.resolveTools(agent, CONTEXT);
          launches.push([label, harness.launchArgs(callFor(agent, { access, resume }), tools, listings)]);
        }
  return { home, launches };
}

// The value after `flag` in argv, or undefined when argv does not carry the flag.
const flagValue = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

// Every `-c` override argv passes, in order.
const overrides = (argv: string[]) => argv.flatMap((argument, index) => (argv[index - 1] === '-c' ? [argument] : []));

// The argv a recording ran: a model call's under its command, a command's at the top.
const recordedArgv = (name: string) => {
  const recorded = recording(name) as { command?: { argv: string[] }; argv?: string[] };
  return recorded.command?.argv ?? recorded.argv ?? [];
};

// The `-c` overrides of a recorded call that every launch passes: all but the model, the effort and the project, which
// differ by call (decision 1, D10 A).
const recordedProfile = (name: string) =>
  overrides(recordedArgv(name)).filter((override) => !/^(?:model|model_reasoning_effort|projects)=/.test(override));

// --- The declaration

test('the launch profile is codex-exec at version 1', () => {
  assert.deepEqual(codex.launchProfile, { name: 'codex-exec', version: 1 });
});

// A field not shown exact is unsupported, and hint only where something real reaches the call (Q15 A): skills reach
// Codex as text only (D10 A); config MCP servers run under their approval key (D17 A); plugins are switched by the
// plugins table (D11 A); both access intents hold under MXC; no recording shows network blocked or allowed; the
// context budget is enforced by the hand-off hook, its firing recorded (`hooks-on`), its hand-off a stand-in (#485).
test('Codex declares every Capability field, each intent as #479 showed it', () => {
  const declared = codex.capabilities as Record<string, unknown>;
  assert.deepEqual(
    contract.CAPABILITY_FIELDS.filter((field) => declared[field] === undefined),
    [],
  );
  assert.deepEqual(
    {
      skills: declared.skills,
      mcp: declared.mcp,
      plugins: declared.plugins,
      access: declared.access,
      network: declared.network,
      contextBudget: declared.contextBudget,
    },
    {
      skills: 'hint',
      mcp: 'exact',
      plugins: 'exact',
      access: 'exact',
      network: 'unsupported',
      contextBudget: 'exact',
    },
  );
});

// The stream reports reasoning tokens and each command and tool call, but no cost (F11); the schema is held by
// --output-schema; a Session resumes by id; and the call runs in Codex's sandbox, never Claude's Trusted-Command Mode.
test("Codex's other Capabilities are as its stream and sandbox showed them", () => {
  const { sandbox, structuredOutput, sessionResume, costReporting, reasoningTokenReporting, toolCallReporting } =
    codex.capabilities;
  assert.deepEqual(
    {
      sandbox,
      structuredOutput,
      resumes: sessionResume.supported,
      costReporting,
      reasoningTokenReporting,
      toolCallReporting,
    },
    {
      sandbox: process.platform === 'win32' ? 'codex-windows' : 'codex-posix',
      structuredOutput: true,
      resumes: true,
      costReporting: false,
      reasoningTokenReporting: true,
      toolCallReporting: true,
    },
  );
  assert.notEqual(codex.capabilities.confinement, 'trusted-commands');
});

// --- gg's Codex home (Q8 A)

test("the Codex home is codex under GG_HOME, never the user's own", () => {
  const home = join('home', 'person');
  assert.equal(
    codex.codexHome({ GG_HOME: join('elsewhere', 'gg'), CODEX_HOME: join(home, '.codex') }, home),
    join('elsewhere', 'gg', 'codex'),
  );
  assert.equal(codex.codexHome({ CODEX_HOME: join(home, '.codex') }, home), join(home, '.agents', 'gg', 'codex'));
});

test('the launch uses the Codex home the ADR records', async (t) => {
  const { home, launch } = await launched(t, READER);
  assert.equal(launch.env.CODEX_HOME, home);
  const cli = codexCli();
  await codex.list(cli, home);
  assert.deepEqual(
    cli.launches.map(({ env }) => env?.CODEX_HOME),
    [home, home],
  );
});

// --- The launch profile

test('a read-only Agent launches with the read-only sandbox', async (t) => {
  const { launch } = await launched(t, READER);
  assert.equal(flagValue(launch.argv, '-s'), 'read-only');
});

test('a workspace-write Agent launches with workspace-write and mxc', async (t) => {
  const { launch } = await launched(t, WRITER);
  assert.equal(flagValue(launch.argv, '-s'), 'workspace-write');
  assert.ok(overrides(launch.argv).includes('windows.sandbox="mxc"'), JSON.stringify(launch.argv));
});

// F1, F2: the user's auto-reviewer never runs, no hook runs until #485's budget hook asks for one (DoD 4 not built:
// #479 recorded no plugin hook under exec), and the response is the final message Codex writes to -o.
const EVERY_CALL =
  'every call sets approval_policy never, features.hooks explicitly, and reads the final message from -o';
test(EVERY_CALL, async (t) => {
  const { launches } = await everyLaunch(t);
  const wrong = launches.filter(([, { argv, lastMessage }]) => {
    const passed = overrides(argv);
    return (
      !passed.includes('approval_policy="never"') ||
      !passed.includes('features.hooks=false') ||
      argv.includes('--dangerously-bypass-hook-trust') ||
      flagValue(argv, '-o') !== lastMessage ||
      !lastMessage.startsWith(RUN_DIRECTORY)
    );
  });
  assert.equal(launches.length, 16);
  assert.deepEqual(
    wrong.map(([label, { argv }]) => `${label}: ${JSON.stringify(argv)}`),
    [],
  );
});

// The empty start #479 proved (finding 1, D10 A): every key the recorded calls ran under, allow_login_shell=false
// among them, read from the recordings, on every kind of launch, with the project never trusted (Q18 A).
test('every launch passes each key of the recorded profile, with the project untrusted', async (t) => {
  const profile = recordedProfile('login-shell-off');
  assert.ok(profile.includes('allow_login_shell=false') && profile.includes('skills.include_instructions=false'));
  const { launches } = await everyLaunch(t);
  const untrusted = `projects={${JSON.stringify(CWD)}={trust_level="untrusted"}}`;
  const missing = launches.flatMap(([label, { argv }]) =>
    [...profile, untrusted].filter((key) => !overrides(argv).includes(key)).map((key) => `${label}: ${key}`),
  );
  assert.deepEqual(missing, []);
});

test("a fresh read-only call launches with exactly the profile's argv", async (t) => {
  const { launch } = await launched(t, READER);
  const schemaPath = flagValue(launch.argv, '--output-schema') ?? '';
  assert.deepEqual(launch.argv, [
    'exec',
    ...['-s', 'read-only', '-C', CWD],
    ...['-c', 'model="gpt-6.1-sol"', '-c', 'model_reasoning_effort="high"'],
    ...['-c', 'approval_policy="never"', '-c', 'windows.sandbox="mxc"'],
    ...['-c', `projects={${JSON.stringify(CWD)}={trust_level="untrusted"}}`],
    ...['-c', 'features.hooks=false', '-c', 'features.apps=false', '-c', 'features.tool_suggest=false'],
    ...['-c', 'check_for_update_on_startup=false', '-c', 'project_doc_max_bytes=0'],
    ...['-c', 'skills.include_instructions=false', '-c', 'allow_login_shell=false'],
    ...['--disable', 'plugins'],
    ...['--json', '--output-schema', schemaPath, '-o', launch.lastMessage, '-'],
  ]);
});

test('the model and effort are overrides, left out when the Agent sets none', async (t) => {
  const { launch } = await launched(t, { ...READER, model: null, effort: null });
  assert.deepEqual(
    overrides(launch.argv).filter((override) => /^model/.test(override)),
    [],
  );
  assert.ok(launch.argv.includes('--json'), JSON.stringify(launch.argv));
});

// Resume and fork take exec's -s and -C only before the subcommand, and a resumed turn runs in the invocation's cwd
// (codex-cli.md question 2), so every resume passes both, for each access.
test('a resume carries the sandbox the way the ADR records', async (t) => {
  for (const agent of [READER, WRITER]) {
    const { launch } = await launched(t, agent, { call: { resume: SESSION } });
    const resumeAt = launch.argv.indexOf('resume');
    assert.deepEqual(launch.argv.slice(0, resumeAt + 2), [
      'exec',
      ...['-s', String(agent.access), '-C', CWD],
      ...['resume', SESSION],
    ]);
  }
});

// Ported (feature-flow 89e1d67 lib/stages.mjs:2-6): Codex holds the strict schema gg sends, from a file.
test('the output schema goes to the file --output-schema names, as sent', async (t) => {
  const { launch } = await launched(t, READER);
  const path = flagValue(launch.argv, '--output-schema') ?? '';
  assert.ok(path.startsWith(RUN_DIRECTORY), `the schema file is in the Run directory: ${path}`);
  assert.deepEqual(JSON.parse(launch.files[path] ?? 'null'), SCHEMA);
});

// The Run's Tickets share its directory, so each call's final message has a file of its own.
test("two calls' final messages go to two files in the Run directory", async (t) => {
  const first = await launched(t, READER, { call: { marker: 'gg:e1:review:1:p:0:r1:1' } });
  const second = await launched(t, READER, { call: { marker: 'gg:e2:review:1:p:0:r1:1' } });
  assert.notEqual(first.launch.lastMessage, second.launch.lastMessage);
  assert.ok(first.launch.lastMessage.startsWith(RUN_DIRECTORY), first.launch.lastMessage);
});

// --- Repository instruction files (Q18 A, DoD 3)

// #479 planted each name of the discovery set alone in a repository, AGENTS.override.md among them, and recorded what
// reaches a call with and without project_doc_max_bytes=0; the profile passes it on every launch.
test('no repository instruction file reaches a call', async (t) => {
  const planted = readdirSync(new URL('../fixtures/codex/', import.meta.url))
    .map((file) => /^prompt-input-only-(.+)-max-bytes-0\.json$/.exec(file)?.[1])
    .filter((slug) => slug !== undefined)
    .sort();
  assert.deepEqual(planted, ['agents-md', 'agents-override-md', 'dot-agents-md', 'team_guide-md']);
  const reaching = planted.filter((slug) =>
    JSON.stringify(recording(`prompt-input-only-${slug}-max-bytes-0`)).includes('SENTINEL-'),
  );
  assert.deepEqual(reaching, []);
  // Without the key, the two names Codex loads by default reach the call: the recordings can show a leak.
  assert.ok(JSON.stringify(recording('prompt-input-only-agents-override-md')).includes('SENTINEL-AGENTSOVERRIDEMD'));
  assert.ok(JSON.stringify(recording('prompt-input-only-agents-md')).includes('SENTINEL-AGENTSMD'));
  assert.ok(recordedProfile('prompt-input-only-agents-md-max-bytes-0').includes('project_doc_max_bytes=0'));
  const { launches } = await everyLaunch(t);
  assert.deepEqual(
    launches.filter(([, { argv }]) => !overrides(argv).includes('project_doc_max_bytes=0')).map(([label]) => label),
    [],
  );
  assert.equal(launches.length, 16);
});

// --- Plugins and MCP servers (decision 7, D11 A, D17 A)

// Ported (feature-flow 89e1d67 lib/toolkit.mjs:123-149, test/core.test.mjs:340-367): Codex splits a -c key on every
// '.', so each id goes inside one inline-table value. The remote catalog is not turned off, the ported line's other
// half: gg's admitted plugins are remote ones (Q3 C), and the table alone decides which load (owner D1 A).
test('listed plugins and servers are one inline table each', async (t) => {
  const agent: model.Agent = { ...READER, plugins: ['superpowers'], mcp: ['playwright'] };
  const { launch } = await launched(t, agent, { mcp: serverList('playwright', 'node_repl', 'my server') });
  const passed = overrides(launch.argv);
  assert.ok(
    passed.includes(
      'plugins={"_default"={enabled=false},' +
        '"github@openai-curated-remote"={enabled=false},' +
        '"openai-developers@openai-curated-remote"={enabled=false},' +
        '"superpowers@openai-curated-remote"={enabled=true},' +
        '"build-web-apps@openai-curated-remote"={enabled=false},' +
        '"openai-templates@openai-curated-remote"={enabled=false},' +
        '"pages@openai-curated-remote"={enabled=false},' +
        '"sites@openai-curated-remote"={enabled=false},' +
        '"plugin-management@openai-curated-remote"={enabled=false},' +
        '"work-pets@openai-curated-remote"={enabled=false},' +
        '"visualize@openai-curated-remote"={enabled=false}}',
    ),
    JSON.stringify(passed),
  );
  assert.ok(
    passed.includes(
      'mcp_servers={"playwright"={enabled=true},"node_repl"={enabled=false},"my server"={enabled=false}}',
    ),
    JSON.stringify(passed),
  );
  assert.deepEqual(
    passed.filter((override) => override.startsWith('plugins.')),
    [],
  );
  assert.equal(launch.argv.includes('--disable'), false, JSON.stringify(launch.argv));
});

// D11 A: the table excludes a plugin its Codex home enables (prompt-input-plugin-excluded), so every installed plugin
// the Agent does not list is named in it, disabled.
test('every installed plugin an Agent does not list is disabled in the table', async (t) => {
  const { launch } = await launched(t, { ...READER, plugins: ['superpowers@openai-curated-remote'] });
  const table = overrides(launch.argv).find((override) => override.startsWith('plugins=')) ?? '';
  assert.equal(RECORDED_IDS.length, 10);
  assert.deepEqual(
    RECORDED_IDS.filter((id) => id !== 'superpowers@openai-curated-remote').filter(
      (id) => !table.includes(`"${id}"={enabled=false}`),
    ),
    [],
  );
});

test('an Agent that lists no plugin launches with plugins disabled and no plugin table', async (t) => {
  const { launch } = await launched(t, READER);
  assert.equal(flagValue(launch.argv, '--disable'), 'plugins');
  assert.deepEqual(
    overrides(launch.argv).filter((override) => override.startsWith('plugins')),
    [],
  );
});

// Ported (test/core.test.mjs:350, 363-366): a dotted id stays one quoted key, and TOML forbids a raw DEL.
test('an id with a dot or a DEL stays one quoted key of its table', async (t) => {
  const plugins = pluginList([
    ['a.b', 'm', '1.0.0'],
    ['kit', 'm', '1.0.0'],
  ]);
  const folders = { 'a.b': { keys: ['name', 'skills'], files: [] }, kit: { keys: ['name', 'skills'], files: [] } };
  const { launch } = await launched(
    t,
    { ...READER, plugins: ['kit'] },
    { plugins, folders, mcp: serverList('x\u007fy') },
  );
  const passed = overrides(launch.argv);
  assert.ok(passed.includes('plugins={"_default"={enabled=false},"a.b@m"={enabled=false},"kit@m"={enabled=true}}'));
  assert.ok(passed.includes('mcp_servers={"x\\u007fy"={enabled=false}}'), JSON.stringify(passed));
});

// D17 A: under approval_policy never a config server's tool runs only with the server's approval key, passed after
// its table (mcp-approve).
test('every listed server gets its approval key after the servers table', async (t) => {
  const agent: model.Agent = { ...READER, mcp: ['playwright', 'files'] };
  const { launch } = await launched(t, agent, { mcp: serverList('playwright', 'files', 'node_repl') });
  const passed = overrides(launch.argv);
  const tableAt = passed.findIndex((override) => override.startsWith('mcp_servers={'));
  assert.ok(tableAt >= 0, JSON.stringify(passed));
  assert.deepEqual(
    passed.slice(tableAt + 1).filter((override) => override.includes('default_tools_approval_mode')),
    [
      'mcp_servers.playwright.default_tools_approval_mode="approve"',
      'mcp_servers.files.default_tools_approval_mode="approve"',
    ],
  );
});

test('a launch over no configured server passes no servers table', async (t) => {
  const { launch } = await launched(t, { ...READER, plugins: ['superpowers'] });
  assert.deepEqual(
    overrides(launch.argv).filter((override) => override.startsWith('mcp_servers')),
    [],
  );
  assert.ok(
    overrides(launch.argv).some((override) => override.startsWith('plugins={')),
    JSON.stringify(launch.argv),
  );
});

// Ported (lib/adapters.mjs:59, test/core.test.mjs:399-414): a missing plugin fails at preflight, at validate, and
// again at the launch after the listing before each call, so no exec starts.
test('a missing listed plugin fails before spawn', async (t) => {
  const home = codexHomeWith(t);
  const cli = codexCli();
  const agent: model.Agent = { ...READER, plugins: ['ponytail@other'] };
  const { ok, errors } = await codex.createCli(cli, { codexHome: home }).validate(agent);
  assert.equal(ok, false);
  assert.match(errors.join('; '), /plugin ponytail@other\b/);
  assert.deepEqual(commandsOf(cli.launches).sort(), ['mcp list', 'plugin list']);
  const harness = codex.createCodex({ codexHome: home });
  const listings = await codex.list(codexCli(), home);
  assert.throws(
    () => harness.launchArgs(callFor(agent), harness.resolveTools(agent, CONTEXT), listings),
    /plugin ponytail@other\b/,
  );
});

// Ported (test/core.test.mjs:369-374).
test('a listed server that is not configured fails before spawn, naming it', async (t) => {
  const home = codexHomeWith(t);
  const agent: model.Agent = { ...READER, mcp: ['ghost', 'playwright'] };
  const { ok, errors } = await codex
    .createCli(codexCli({ mcp: serverList('playwright') }), { codexHome: home })
    .validate(agent);
  assert.equal(ok, false);
  assert.match(errors.join('; '), /\bghost\b/);
  assert.doesNotMatch(errors.join('; '), /playwright/);
  const harness = codex.createCodex({ codexHome: home });
  const listings = await codex.list(codexCli({ mcp: serverList('playwright') }), home);
  assert.throws(() => harness.launchArgs(callFor(agent), harness.resolveTools(agent, CONTEXT), listings), /\bghost\b/);
});

// Ported (lib/toolkit.mjs:132-136, test/core.test.mjs:351-352): a qualified name matches its id exactly, a bare one
// any id it starts, and two such ids are one error naming both.
test('a bare plugin name matching two installed plugins is refused naming both', async (t) => {
  const plugins = pluginList([
    ['x', 'a', '1.0.0'],
    ['x', 'b', '1.0.0'],
  ]);
  const home = codexHomeWith(t, { ['x']: { keys: ['name', 'skills'], files: [] } }, plugins);
  const validate = codex.createCli(codexCli({ plugins }), { codexHome: home }).validate;
  const bare = await validate({ ...READER, plugins: ['x'] });
  assert.deepEqual(bare.errors, ['plugin x ambiguous: x@a, x@b']);
  const qualified = await validate({ ...READER, plugins: ['x@b'] });
  assert.deepEqual(qualified, { ok: true, errors: [], hinted: [] });
});

// --- The listings (Q2 A; ported, lib/toolkit.mjs:73-96, test/core.test.mjs:298-338)

test('a failed listing is an error naming its command', async (t) => {
  const home = codexHomeWith(t);
  await assert.rejects(codex.list(codexCli({ fails: 'plugin' }), home), /codex plugin list --json/);
  await assert.rejects(codex.list(codexCli({ fails: 'mcp' }), home), /codex mcp list --json/);
  const { ok, errors } = await codex
    .createCli(codexCli({ fails: 'plugin' }), { codexHome: home })
    .validate({ ...READER, plugins: ['superpowers'] });
  assert.equal(ok, false);
  assert.match(errors.join('; '), /codex plugin list --json/);
});

// An empty list would leave every plugin and server on, so a listing Codex printed in another shape fails.
test('a listing of an unexpected shape is an error naming its command', async (t) => {
  const home = codexHomeWith(t);
  const good = pluginList([['kit', 'm', '1.0.0']]);
  const badPlugins = ['not json', '{"installed":{}}', '{"installed":[{}]}', '{"installed":[{"pluginId":""}]}'];
  const badServers = ['not json', '{}', '[{}]', '[{"name":""}]'];
  const listed = async (plugins: string, mcp: string) => {
    try {
      await codex.list(codexCli({ plugins, mcp }), home);
      return 'listed';
    } catch (err) {
      return (err as Error).message;
    }
  };
  const answers = [
    ...(await Promise.all(badPlugins.map((plugins) => listed(plugins, '[]')))),
    ...(await Promise.all(badServers.map((mcp) => listed(good, mcp)))),
  ];
  assert.deepEqual(
    answers.map((message) => /codex (?:plugin|mcp) list --json/.exec(message)?.[0] ?? message),
    [...badPlugins.map(() => 'codex plugin list --json'), ...badServers.map(() => 'codex mcp list --json')],
  );
});

test('validate lists plugins and servers once however many Agents it checks, only for one listing them', async (t) => {
  const home = codexHomeWith(t);
  const cli = codexCli({ mcp: serverList('playwright') });
  const { validate } = codex.createCli(cli, { codexHome: home });
  await validate(READER);
  assert.deepEqual(commandsOf(cli.launches), [], 'an Agent that lists neither starts no CLI');
  await validate({ ...READER, plugins: ['superpowers'] });
  await validate({ ...WRITER, mcp: ['playwright'] });
  await validate({ ...WRITER, plugins: ['build-web-apps'], mcp: ['playwright'] });
  assert.deepEqual(commandsOf(cli.launches).sort(), ['mcp list', 'plugin list']);
});

test('a failed listing is not listed again', async (t) => {
  const home = codexHomeWith(t);
  const cli = codexCli({ plugins: 'not json' });
  const { validate } = codex.createCli(cli, { codexHome: home });
  const first = await validate({ ...READER, plugins: ['superpowers'] });
  const second = await validate({ ...WRITER, plugins: ['superpowers'] });
  assert.match(first.errors.join('; '), /codex plugin list --json/);
  assert.match(second.errors.join('; '), /codex plugin list --json/);
  assert.deepEqual(commandsOf(cli.launches).sort(), ['mcp list', 'plugin list']);
});

// Q2 A: run (#482) lists again before each spawn, so a plugin removed after preflight fails that call.
test('each listing before a call lists afresh', async (t) => {
  const home = codexHomeWith(t);
  const cli = codexCli();
  await codex.list(cli, home);
  await codex.list(cli, home);
  assert.deepEqual(commandsOf(cli.launches).sort(), ['mcp list', 'mcp list', 'plugin list', 'plugin list']);
});

// --- What validate and resolveTools give

test('validate refuses plugins or mcp that are not lists of names', async (t) => {
  const { validate } = codex.createCli(codexCli(), { codexHome: codexHomeWith(t) });
  const plugins = await validate({ ...READER, plugins: 'superpowers' });
  const mcp = await validate({ ...READER, mcp: [7] });
  assert.equal(plugins.ok, false);
  assert.match(plugins.errors.join('; '), /plugins/);
  assert.equal(mcp.ok, false);
  assert.match(mcp.errors.join('; '), /mcp/);
});

test('skills are marked hinted', () => {
  assert.deepEqual(codex.resolveTools({ ...READER, skills: ['tdd'] }, CONTEXT).hinted, ['skills']);
  assert.deepEqual(codex.resolveTools(READER, CONTEXT).hinted, []);
});

test('resolveTools gives the plugins and servers the Agent lists, at once', () => {
  const tools = codex.resolveTools({ ...READER, plugins: ['superpowers'], mcp: ['playwright'] }, CONTEXT);
  assert.deepEqual(tools, { plugins: ['superpowers'], mcp: ['playwright'], hinted: [] });
});

// --- Which listed plugins Codex admits (Q3 C, with the folder check)

// Every installed plugin, listed alone: a plugin whose apps stay off is admitted, one bringing MCP servers is not.
test("of gg's ten installed plugins nine are admitted, openai-developers refused naming its MCP servers", async (t) => {
  const home = codexHomeWith(t);
  const { validate } = codex.createCli(codexCli(), { codexHome: home });
  const results = await Promise.all(
    RECORDED_IDS.map(async (id) => [id, await validate({ ...READER, plugins: [id] })] as const),
  );
  const refused = results.filter(([, { ok }]) => !ok);
  assert.equal(results.length, 10);
  assert.deepEqual(
    refused.map(([id]) => id),
    ['openai-developers@openai-curated-remote'],
  );
  assert.match(refused[0]?.[1].errors.join('; ') ?? '', /openai-developers@openai-curated-remote.*mcpServers/);
});

test('a plugin whose folder holds an MCP server file is refused whatever its manifest says', async (t) => {
  const folders = { superpowers: { keys: [...DESCRIPTIVE, 'skills'], files: ['.mcp.json'] } };
  const { validate } = codex.createCli(codexCli(), { codexHome: codexHomeWith(t, folders) });
  const { ok, errors } = await validate({ ...READER, plugins: ['superpowers'] });
  assert.equal(ok, false);
  assert.match(errors.join('; '), /superpowers@openai-curated-remote.*mcpServers/);
});

test('a plugin whose folder holds a hooks file is refused whatever its manifest says', async (t) => {
  const folders = { superpowers: { keys: [...DESCRIPTIVE, 'skills'], files: [join('hooks', 'hooks.json')] } };
  const { validate } = codex.createCli(codexCli(), { codexHome: codexHomeWith(t, folders) });
  const { ok, errors } = await validate({ ...READER, plugins: ['superpowers'] });
  assert.equal(ok, false);
  assert.match(errors.join('; '), /superpowers@openai-curated-remote.*hooks/);
});

test('a plugin whose manifest declares hooks or another working key is refused naming it', async (t) => {
  const folders = {
    superpowers: { keys: [...DESCRIPTIVE, 'skills', 'hooks'], files: [] },
    'build-web-apps': { keys: [...DESCRIPTIVE, 'skills', 'lspServers'], files: [] },
  };
  const { validate } = codex.createCli(codexCli(), { codexHome: codexHomeWith(t, folders) });
  const hooks = await validate({ ...READER, plugins: ['superpowers'] });
  const other = await validate({ ...READER, plugins: ['build-web-apps'] });
  assert.match(hooks.errors.join('; '), /superpowers@openai-curated-remote.*hooks/);
  assert.match(other.errors.join('; '), /build-web-apps@openai-curated-remote.*lspServers/);
});

test('a listed plugin with no manifest in its folder is refused', async (t) => {
  const { validate } = codex.createCli(codexCli(), { codexHome: codexHomeWith(t, {}) });
  const { ok, errors } = await validate({ ...READER, plugins: ['superpowers'] });
  assert.equal(ok, false);
  assert.match(errors.join('; '), /superpowers@openai-curated-remote.*manifest/);
});

// features.apps=false keeps every plugin's apps off (D10 A), so gg takes only a listed plugin's skills and notes on
// the Action that its apps were off: nothing is dropped silently (request section 2).
test('a listed plugin with apps is admitted and its apps are noted as off', async (t) => {
  const { launch } = await launched(t, { ...READER, plugins: ['github', 'superpowers'] });
  assert.deepEqual(launch.appsOff, ['github@openai-curated-remote']);
  assert.ok(overrides(launch.argv).includes('features.apps=false'), JSON.stringify(launch.argv));
});

// --- The skills list gg writes into the prompt (D2 A)

// A skill folder under `root` whose SKILL.md's front matter gives `name` and `description`.
function writeSkill(root: string, folder: string, name: string, description: string) {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(
    join(root, folder, 'SKILL.md'),
    `---\nname: "${name}"\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

// Where gg's Codex home keeps an installed plugin's skills: the skills/ folder its manifest names.
const pluginSkills = (home: string, name: string) => {
  const { installed } = JSON.parse(RECORDED_PLUGINS) as { installed: codex.InstalledPlugin[] };
  const plugin = installed.find((entry) => entry.name === name)!;
  return join(home, 'plugins', 'cache', plugin.marketplaceName, plugin.name, plugin.version, 'skills');
};

// The launch of a call for `agent` over a Codex home and a user's skills folder, each filled by `fill` first.
async function skillsLaunch(t: TestContext, agent: model.Agent, fill: (home: string, skills: string) => void) {
  const home = codexHomeWith(t);
  const skills = tempDirectory.tempDirectory(t, 'gg-skills-');
  fill(home, skills);
  const harness = codex.createCodex({ codexHome: home, skillsHome: skills });
  const listings = await codex.list(codexCli(), home);
  const launch = harness.launchArgs(callFor(agent), harness.resolveTools(agent, CONTEXT), listings);
  return { home, skills, launch };
}

test("every call lists Codex's bundled skills by their front matter's name, description and file", async (t) => {
  const { home, launch } = await skillsLaunch(t, READER, (codexHome) =>
    writeSkill(join(codexHome, 'skills', '.system'), 'image-folder', 'imagegen', 'Generate or edit raster images.'),
  );
  const file = join(home, 'skills', '.system', 'image-folder', 'SKILL.md');
  assert.ok(launch.skills.includes(`- imagegen: Generate or edit raster images. (file: ${file})`), launch.skills);
  assert.ok(overrides(launch.argv).includes('skills.include_instructions=false'), JSON.stringify(launch.argv));
});

test("a declared skill from the user's skills folder is listed, and one not declared is not", async (t) => {
  const { skills, launch } = await skillsLaunch(t, { ...READER, skills: ['tdd'] }, (_home, skillsFolder) => {
    writeSkill(skillsFolder, 'tdd', 'tdd', 'Write the failing test first.');
    writeSkill(skillsFolder, 'caveman', 'caveman', 'Talk like a caveman.');
  });
  assert.ok(launch.skills.includes(`- tdd: Write the failing test first. (file: ${join(skills, 'tdd', 'SKILL.md')})`));
  assert.doesNotMatch(launch.skills, /caveman/);
});

test("a declared skill the user's skills folder lacks fails preflight and the launch, naming it", async (t) => {
  const home = codexHomeWith(t);
  const skills = tempDirectory.tempDirectory(t, 'gg-skills-');
  const agent: model.Agent = { ...READER, skills: ['tdd'] };
  const cli = codexCli();
  const { ok, errors } = await codex.createCli(cli, { codexHome: home, skillsHome: skills }).validate(agent);
  assert.equal(ok, false);
  assert.match(errors.join('; '), /skill tdd/);
  assert.deepEqual(commandsOf(cli.launches), [], 'a skill is found without listing plugins');
  const harness = codex.createCodex({ codexHome: home, skillsHome: skills });
  const listings = await codex.list(codexCli(), home);
  assert.throws(() => harness.launchArgs(callFor(agent), harness.resolveTools(agent, CONTEXT), listings), /skill tdd/);
});

test('validate refuses skills that are not a list of names', async (t) => {
  const { validate } = codex.createCli(codexCli(), { codexHome: codexHomeWith(t) });
  const { ok, errors } = await validate({ ...READER, skills: 'tdd' });
  assert.equal(ok, false);
  assert.match(errors.join('; '), /skills must be a list of names/);
});

test("a listed plugin's skills are listed under its name, and an unlisted plugin's are not", async (t) => {
  const { launch } = await skillsLaunch(t, { ...READER, plugins: ['superpowers'] }, (home) => {
    writeSkill(pluginSkills(home, 'superpowers'), 'brainstorming', 'brainstorming', 'Explore before building.');
    writeSkill(pluginSkills(home, 'build-web-apps'), 'shadcn-best-practices', 'shadcn', 'Manages shadcn.');
  });
  assert.match(launch.skills, /^- superpowers:brainstorming: Explore before building\. \(file: .*SKILL\.md\)$/m);
  assert.doesNotMatch(launch.skills, /shadcn/);
});

test('a call with no skill to list gets no skills list', async (t) => {
  const { launch } = await skillsLaunch(t, READER, () => undefined);
  assert.equal(launch.skills, '');
});
