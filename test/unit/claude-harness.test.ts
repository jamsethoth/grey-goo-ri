import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as claude from '../../lib/harnesses/claude.ts';
import type * as model from '../../lib/model.ts';
import * as recordedCli from '../support/recorded-cli.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// The Claude Harness as a pure declaration (#424): what it refuses, the tools and rules it resolves, and the argv and
// environment of its launch profile (request 3.2, bullets 1-3).

const RUN_DIRECTORY = join('common', 'gg', 'runs', 'run-1');
const PERSONA = { name: 'implementer.md', bytes: 'You are the implementer.\n', hash: 'a'.repeat(64) };
const SCHEMA = {
  type: 'object',
  properties: { claim: { type: 'string' } },
  required: ['claim'],
  additionalProperties: false,
};
const WRITER: model.Agent = {
  harness: 'claude',
  persona: 'implementer.md',
  model: 'opus',
  effort: 'high',
  access: 'workspace-write',
  network: false,
};
const READER: model.Agent = { ...WRITER, persona: 'reviewer.md', access: 'read-only' };
const COMMANDS = { test: 'npm test', lint: 'npm run lint' };

// A Claude configuration directory with no plugin installed: a case that lists none reads nothing of the user's.
const harness = claude.createClaude({ configDirectory: join('no-claude-home') });

// A Claude configuration directory where plugin `alpha@mkt` is installed, as Claude Code lists it.
function homeWithAlpha(t: TestContext) {
  const configDirectory = tempDirectory.tempDirectory(t, 'gg-claude-home-');
  const installPath = join(configDirectory, 'cache', 'alpha');
  mkdirSync(installPath, { recursive: true });
  mkdirSync(join(configDirectory, 'plugins'));
  const installed = { plugins: { 'alpha@mkt': [{ installPath }] } };
  writeFileSync(join(configDirectory, 'plugins', 'installed_plugins.json'), JSON.stringify(installed));
  return { configDirectory, installPath };
}

interface Launching {
  agent?: model.Agent;
  call?: Partial<claude.ClaudeCall>;
  platform?: NodeJS.Platform;
  harness?: ReturnType<typeof claude.createClaude>;
}

// The launch of a call for `agent`, its tools resolved with the Declared Commands on `platform`.
function launched({ agent = WRITER, call = {}, platform = 'linux', harness: chosen = harness }: Launching = {}) {
  const tools = chosen.resolveTools(agent, { commands: COMMANDS, platform });
  const access = agent.access as string;
  const sent: claude.ClaudeCall = {
    agent,
    persona: PERSONA,
    schema: SCHEMA,
    resume: null,
    runDirectory: RUN_DIRECTORY,
    access,
    ...(agent.network !== undefined && { network: agent.network }),
    ...call,
  };
  return chosen.launchArgs(sent, tools);
}

// The value after `flag` in argv, or undefined when argv does not carry the flag.
const flagValue = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

// The tools `--tools` offers.
const offered = (launch: claude.Launch) => new Set(flagValue(launch.argv, '--tools')?.split(','));

// gg's settings file, which `--settings` names, as the launch writes it.
function settingsOf(launch: claude.Launch) {
  const path = flagValue(launch.argv, '--settings');
  const text = path === undefined ? undefined : launch.files[path];
  assert.ok(text !== undefined, `--settings names a file the launch writes: ${JSON.stringify(launch)}`);
  return JSON.parse(text) as {
    permissions: { allow: string[]; deny: string[]; blockWritesOutsideWorkingDirectories?: boolean };
  };
}

// The rules of `expected` that `rules` lacks.
const missing = (rules: string[], expected: string[]) => expected.filter((rule) => !rules.includes(rule));

test('a read-only call adds --restricted and denies mcp tools', () => {
  const reading = launched({ agent: READER });
  assert.ok(reading.argv.includes('--restricted'), JSON.stringify(reading.argv));
  assert.equal(flagValue(reading.argv, '--disallowedTools'), 'mcp__*');
  const writing = launched({ agent: WRITER });
  assert.equal(writing.argv.includes('--restricted'), false, JSON.stringify(writing.argv));
});

test('a write call allows the Declared Commands and denies git writes and gh', () => {
  const { permissions } = settingsOf(launched({ agent: WRITER }));
  assert.deepEqual(
    missing(permissions.allow, [
      'Bash(npm test)',
      'Bash(npm test:*)',
      'Bash(npm run lint)',
      'Bash(npm run lint:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git status:*)',
    ]),
    [],
  );
  assert.deepEqual(
    missing(permissions.deny, ['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(gh:*)']),
    [],
  );
});

test('network false denies WebFetch and WebSearch', () => {
  const closed = settingsOf(launched({ agent: { ...WRITER, network: false } }));
  assert.deepEqual(missing(closed.permissions.deny, ['WebFetch', 'WebSearch']), []);
  const open = settingsOf(launched({ agent: { ...WRITER, network: true } }));
  assert.deepEqual(missing(open.permissions.deny, ['WebFetch', 'WebSearch']), ['WebFetch', 'WebSearch']);
});

test('every call reads no settings source and no CLAUDE.md', () => {
  const reading = launched({ agent: READER });
  const writing = launched({ agent: WRITER });
  assert.equal(flagValue(reading.argv, '--setting-sources'), '');
  assert.equal(flagValue(writing.argv, '--setting-sources'), '');
  assert.ok(reading.argv.includes('--strict-mcp-config') && writing.argv.includes('--strict-mcp-config'));
  assert.equal(reading.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(writing.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(reading.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(writing.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
});

test('the persona is appended from a file, never argv', () => {
  const launch = launched();
  const path = flagValue(launch.argv, '--append-system-prompt-file') ?? '';
  assert.ok(path.startsWith(RUN_DIRECTORY), `the persona file is in the Run directory: ${path}`);
  assert.equal(launch.files[path], PERSONA.bytes);
  assert.equal(flagValue(launch.argv, '--system-prompt-snapshot'), 'off');
  assert.deepEqual(
    launch.argv.filter((argument) => argument.includes('You are the implementer')),
    [],
  );
});

test('a resumed call passes --resume with the stored session', () => {
  assert.equal(flagValue(launched({ call: { resume: 'session-7' } }).argv, '--resume'), 'session-7');
  assert.equal(launched({ call: { resume: null } }).argv.includes('--resume'), false);
});

// The validator refuses a field the Capability matrix declares unsupported, once, at its key (Q2 A of #429).
test('validate leaves a field Claude declares unsupported to the validator', async () => {
  assert.deepEqual(await harness.validate({ ...READER, mcp: ['github'] }), { ok: true, errors: [], hinted: [] });
});

test('a listed plugin that is not installed fails resolveTools naming it', (t) => {
  const withAlpha = claude.createClaude(homeWithAlpha(t));
  assert.throws(
    () =>
      withAlpha.resolveTools(
        { ...WRITER, plugins: ['alpha', 'gg-no-such-plugin'] },
        { commands: COMMANDS, platform: 'linux' },
      ),
    /plugin gg-no-such-plugin/,
  );
});

test('skills are marked hinted', async () => {
  const agent = { ...WRITER, skills: ['tdd'] };
  assert.deepEqual(await harness.validate(agent), { ok: true, errors: [], hinted: ['skills'] });
  assert.deepEqual(harness.resolveTools(agent, { commands: COMMANDS, platform: 'linux' }).hinted, ['skills']);
});

test('contextBudget sets --autocompact above it', () => {
  const autocompact = flagValue(launched({ agent: { ...WRITER, contextBudget: 100000 } }).argv, '--autocompact');
  assert.ok(Number(autocompact) > 100000, `--autocompact ${autocompact}`);
});

// The commands of the PostToolUse hooks gg's settings file installs for a launch.
function postToolUseHooks(launch: claude.Launch): string[] {
  settingsOf(launch);
  const path = flagValue(launch.argv, '--settings')!;
  const { hooks } = JSON.parse(launch.files[path]!) as {
    hooks?: { PostToolUse?: { hooks?: { type?: string; command?: string }[] }[] };
  };
  return (hooks?.PostToolUse ?? []).flatMap((matcher) =>
    (matcher.hooks ?? []).map((hook) => (hook.type === 'command' ? (hook.command ?? '') : `${hook.type} hook`)),
  );
}

// Every launch an Attempt makes, whatever else its call varies (a first Attempt, a retry, a recovery pass that resumes,
// the fresh Attempt after a hand-off; a reader or a writer; either shell), carries the hand-off hook at its Agent's
// contextBudget, and a launch of an Agent with none carries no hook (#430, rule 1 of its Clarify).
const LAUNCH_SITES = [READER, WRITER, { ...WRITER, network: true }].flatMap((agent) =>
  [null, 'session-7'].flatMap((resume) =>
    (['win32', 'linux'] as const).flatMap((platform) =>
      [undefined, 150000].map((contextBudget) => ({ agent, resume, platform, contextBudget })),
    ),
  ),
);

test('every launch of an Agent with a contextBudget carries the hand-off hook at its budget, and no other does', () => {
  const wrong = LAUNCH_SITES.flatMap(({ agent, resume, platform, contextBudget }) => {
    const budgeted = contextBudget === undefined ? agent : { ...agent, contextBudget };
    const commands = postToolUseHooks(launched({ agent: budgeted, call: { resume }, platform }));
    const expected = contextBudget === undefined ? 0 : 1;
    const atBudget = commands.filter(
      (command) => command.includes('claude-handoff-hook.ts') && command.includes(String(contextBudget)),
    );
    if (commands.length === expected && atBudget.length === expected) return [];
    const site = `${agent.access} network ${agent.network} resume ${resume} on ${platform} budget ${contextBudget}`;
    return [`${site}: ${commands.join('; ')}`];
  });
  assert.deepEqual(wrong, []);
});

test('a read-only call offers no Edit or Write tool', () => {
  assert.deepEqual(offered(launched({ agent: READER })), new Set(['Bash', 'Read', 'Grep', 'Glob']));
});

test('network false offers no web tool', () => {
  assert.deepEqual(
    offered(launched({ agent: { ...WRITER, network: false } })),
    new Set(['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write']),
  );
  assert.deepEqual(
    offered(launched({ agent: { ...WRITER, network: true } })),
    new Set(['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebFetch', 'WebSearch']),
  );
});

// One table of rules, emitted for the shell `platform` gives (G5 C): every rule that names a command names the shell.
test('on win32 the shell is PowerShell and every rule is a PowerShell rule', () => {
  const launch = launched({ platform: 'win32' });
  const { permissions } = settingsOf(launch);
  const rules = [...permissions.allow, ...permissions.deny].filter((rule) => rule.includes('('));
  assert.deepEqual(
    rules.filter((rule) => !rule.startsWith('PowerShell(')),
    [],
  );
  assert.deepEqual(missing(rules, ['PowerShell(npm test)', 'PowerShell(gh:*)']), []);
  assert.equal(offered(launch).has('PowerShell'), true);
  assert.equal(offered(launch).has('Bash'), false);
  assert.deepEqual(launch.env, {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
  });
});

test('on linux the shell is Bash and every rule is a Bash rule', () => {
  const launch = launched({ platform: 'linux' });
  const { permissions } = settingsOf(launch);
  const rules = [...permissions.allow, ...permissions.deny].filter((rule) => rule.includes('('));
  assert.deepEqual(
    rules.filter((rule) => !rule.startsWith('Bash(')),
    [],
  );
  assert.deepEqual(missing(rules, ['Bash(npm test)', 'Bash(gh:*)']), []);
  assert.equal(offered(launch).has('Bash'), true);
  assert.equal(offered(launch).has('PowerShell'), false);
});

// The tools and permission rules `resolveTools` gives `agent` on `platform`, without the hinted and plugin lists.
function resolved(agent: model.Agent, platform: NodeJS.Platform) {
  const { tools, allow, deny } = harness.resolveTools(agent, { commands: COMMANDS, platform });
  return { tools, allow, deny };
}

// Each rule turns on one input (the shell on platform, Edit and Write on access, the web tools on network), and these
// five cases give each input each value, win32 as both reader and writer. Claude allows read-only PowerShell commands
// itself, as it does on Bash, so gg lists only its read-only git commands on either shell (#425 Q5 A).
test("on win32 a read-only Agent gets PowerShell, gg's read-only git commands and no file-writing tool", () => {
  assert.deepEqual(resolved({ ...READER, network: false }, 'win32'), {
    tools: ['PowerShell', 'Read', 'Grep', 'Glob'],
    allow: [
      'PowerShell(npm test)',
      'PowerShell(npm test:*)',
      'PowerShell(npm run lint)',
      'PowerShell(npm run lint:*)',
      'PowerShell(git diff:*)',
      'PowerShell(git log:*)',
      'PowerShell(git show:*)',
      'PowerShell(git status:*)',
    ],
    deny: [
      'PowerShell(git add:*)',
      'PowerShell(git commit:*)',
      'PowerShell(git push:*)',
      'PowerShell(gh:*)',
      'WebFetch',
      'WebSearch',
    ],
  });
});

test('on win32 a writer with network gets Edit, Write and the web tools, and still no git write or gh', () => {
  assert.deepEqual(resolved({ ...WRITER, network: true }, 'win32'), {
    tools: ['PowerShell', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebFetch', 'WebSearch'],
    allow: [
      'PowerShell(npm test)',
      'PowerShell(npm test:*)',
      'PowerShell(npm run lint)',
      'PowerShell(npm run lint:*)',
      'PowerShell(git diff:*)',
      'PowerShell(git log:*)',
      'PowerShell(git show:*)',
      'PowerShell(git status:*)',
    ],
    deny: ['PowerShell(git add:*)', 'PowerShell(git commit:*)', 'PowerShell(git push:*)', 'PowerShell(gh:*)'],
  });
});

test('on linux a read-only Agent with network gets the web tools and no file-writing tool', () => {
  assert.deepEqual(resolved({ ...READER, network: true }, 'linux'), {
    tools: ['Bash', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
    allow: [
      'Bash(npm test)',
      'Bash(npm test:*)',
      'Bash(npm run lint)',
      'Bash(npm run lint:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git status:*)',
    ],
    deny: ['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(gh:*)'],
  });
});

test('on darwin a writer without network gets Bash, Edit and Write, and the web tools denied', () => {
  assert.deepEqual(resolved({ ...WRITER, network: false }, 'darwin'), {
    tools: ['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write'],
    allow: [
      'Bash(npm test)',
      'Bash(npm test:*)',
      'Bash(npm run lint)',
      'Bash(npm run lint:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git status:*)',
    ],
    deny: ['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(gh:*)', 'WebFetch', 'WebSearch'],
  });
});

test('an Agent that omits access and network is read-only with no network', () => {
  const agent: model.Agent = { harness: 'claude', persona: 'reviewer.md', model: 'opus', effort: 'high' };
  assert.deepEqual(resolved(agent, 'linux'), {
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    allow: [
      'Bash(npm test)',
      'Bash(npm test:*)',
      'Bash(npm run lint)',
      'Bash(npm run lint:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git status:*)',
    ],
    deny: ['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(gh:*)', 'WebFetch', 'WebSearch'],
  });
});

// Every flag and environment variable of the launch profile, and no other (DoD line 1): a read-only call that resumes,
// lists a plugin and sets a context budget carries each of them.
test("a read-only call launches with exactly the profile's flags and environment", (t) => {
  const { configDirectory, installPath } = homeWithAlpha(t);
  const launch = launched({
    agent: { ...READER, plugins: ['alpha'], contextBudget: 100000 },
    call: { resume: 'session-7' },
    harness: claude.createClaude({ configDirectory }),
  });
  assert.equal(launch.argv[0], '-p', 'Claude runs headless');
  assert.deepEqual(launch.argv.filter((argument) => argument.startsWith('--')).sort(), [
    '--append-system-prompt-file',
    '--autocompact',
    '--disallowedTools',
    '--effort',
    '--json-schema',
    '--model',
    '--output-format',
    '--permission-mode',
    '--permission-prompts',
    '--plugin-dir',
    '--restricted',
    '--resume',
    '--setting-sources',
    '--settings',
    '--strict-mcp-config',
    '--system-prompt-snapshot',
    '--tools',
    '--verbose',
  ]);
  assert.equal(flagValue(launch.argv, '--permission-mode'), 'manual');
  assert.equal(flagValue(launch.argv, '--permission-prompts'), 'none');
  assert.equal(flagValue(launch.argv, '--output-format'), 'stream-json');
  assert.deepEqual(JSON.parse(flagValue(launch.argv, '--json-schema') ?? 'null'), SCHEMA);
  assert.equal(flagValue(launch.argv, '--model'), 'opus');
  assert.equal(flagValue(launch.argv, '--effort'), 'high');
  assert.equal(flagValue(launch.argv, '--plugin-dir'), installPath);
  assert.deepEqual(launch.env, {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  });
});

test("a write call launches with exactly the profile's flags and environment", () => {
  const launch = launched({ agent: WRITER });
  assert.deepEqual(launch.argv.filter((argument) => argument.startsWith('--')).sort(), [
    '--append-system-prompt-file',
    '--effort',
    '--json-schema',
    '--model',
    '--output-format',
    '--permission-mode',
    '--permission-prompts',
    '--setting-sources',
    '--settings',
    '--strict-mcp-config',
    '--system-prompt-snapshot',
    '--tools',
    '--verbose',
  ]);
  assert.equal(flagValue(launch.argv, '--permission-mode'), 'acceptEdits');
  assert.deepEqual(launch.env, {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  });
});

test("gg's settings file blocks writes outside the working directories", () => {
  assert.equal(settingsOf(launched()).permissions.blockWritesOutsideWorkingDirectories, true);
});

// Decision 1 of #424, and Trusted-Command Mode on every platform (Q3 A): the profile turns no sandbox on anywhere.
test('the capabilities are the decided ones, with trusted-commands confinement on every platform', () => {
  const { plugins, mcp, skills, contextBudget, backgroundWork, confinement, sandbox } = claude.capabilities;
  assert.deepEqual(
    { plugins, mcp, skills, contextBudget, backgroundWork, confinement, sandbox },
    {
      plugins: 'exact',
      mcp: 'unsupported',
      skills: 'hint',
      contextBudget: 'exact',
      backgroundWork: 'none',
      confinement: 'trusted-commands',
      sandbox: 'none',
    },
  );
});

// The stream reports peak context, cost, turns and tool calls (#425, recorded from Claude Code 2.1.328); its thinking
// tokens arrive only as estimates, so reasoning tokens stay unreported.
test('Claude reports peak context, cost, turns and tool calls, and no reasoning tokens', () => {
  const { peakContextReporting, costReporting, turnCountReporting, toolCallReporting, reasoningTokenReporting } =
    claude.capabilities;
  assert.deepEqual(
    { peakContextReporting, costReporting, turnCountReporting, toolCallReporting, reasoningTokenReporting },
    {
      peakContextReporting: true,
      costReporting: true,
      turnCountReporting: true,
      toolCallReporting: true,
      reasoningTokenReporting: false,
    },
  );
});

test('the launch profile the Config Hash pins has a name and a version', () => {
  assert.match(claude.launchProfile.name, /^[a-z][a-z0-9-]*$/);
  assert.ok(Number.isInteger(claude.launchProfile.version) && claude.launchProfile.version >= 1);
});

// A Claude configuration directory listing `installed` (key to installPath, made unless named in `absent`) and
// account-synced plugins at plugins/synced/<path>, each named in its plugin.json.
function claudeHome(
  t: TestContext,
  installed: Record<string, string>,
  { synced = {}, absent = [] }: { synced?: Record<string, string>; absent?: string[] } = {},
) {
  const configDirectory = tempDirectory.tempDirectory(t, 'gg-claude-home-');
  mkdirSync(join(configDirectory, 'plugins'));
  const plugins: Record<string, { installPath: string }[]> = {};
  for (const [key, directory] of Object.entries(installed)) {
    const installPath = join(configDirectory, 'cache', directory);
    if (!absent.includes(key)) mkdirSync(installPath, { recursive: true });
    plugins[key] = [{ installPath }];
  }
  writeFileSync(join(configDirectory, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins }));
  for (const [path, pluginName] of Object.entries(synced)) {
    const directory = join(configDirectory, 'plugins', 'synced', path, '.claude-plugin');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'plugin.json'), JSON.stringify({ name: pluginName }));
  }
  return configDirectory;
}

const pluginDirectoriesOf = (configDirectory: string, plugins: string[]) =>
  claude
    .createClaude({ configDirectory })
    .resolveTools({ ...WRITER, plugins }, { commands: COMMANDS, platform: 'linux' }).pluginDirectories;

// Ported, feature-flow 89e1d67 test/core.test.mjs:187.
test('claudeToolkit plugin names: qualified exact match, qualified miss, ambiguous bare name', (t) => {
  const home = claudeHome(t, { 'alpha@mkt': 'alpha' });
  assert.deepEqual(pluginDirectoriesOf(home, ['alpha@mkt']), [join(home, 'cache', 'alpha')]);
  assert.throws(() => pluginDirectoriesOf(home, ['alpha@other']), /plugin alpha@other is not installed/);
  const two = claudeHome(t, { 'alpha@a': 'a', 'alpha@b': 'b' });
  assert.throws(() => pluginDirectoriesOf(two, ['alpha']), /plugin alpha ambiguous: alpha@a, alpha@b/);
});

// Ported, feature-flow 89e1d67 test/core.test.mjs:263; a listed installPath that is gone counts as not installed.
test('findClaudePlugin resolves installed and nested synced plugins', (t) => {
  const home = claudeHome(
    t,
    { 'alpha@mkt': 'a', 'gone@mkt': 'gone' },
    { synced: { 'acct/uuid': 'beta' }, absent: ['gone@mkt'] },
  );
  assert.deepEqual(pluginDirectoriesOf(home, ['alpha']), [join(home, 'cache', 'a')]);
  assert.deepEqual(pluginDirectoriesOf(home, ['beta']), [join(home, 'plugins', 'synced', 'acct', 'uuid')]);
  assert.throws(() => pluginDirectoriesOf(home, ['gamma']), /plugin gamma is not installed/);
  assert.throws(() => pluginDirectoriesOf(home, ['gone']), /plugin gone is not installed/);
});

test('validate fails plugins that are not names and a contextBudget that is not a positive integer', async () => {
  for (const [field, value, error] of [
    ['plugins', 'alpha', 'plugins must be a list of plugin names'],
    ['contextBudget', 0, 'contextBudget must be a positive integer of tokens'],
    ['contextBudget', 1.5, 'contextBudget must be a positive integer of tokens'],
  ] as const)
    assert.deepEqual(await harness.validate({ ...WRITER, [field]: value }), { ok: false, errors: [error], hinted: [] });
});

test("the settings file is named by its content, so a Run's parallel Tickets never share one by accident", () => {
  const settingsPath = (agent: model.Agent) => flagValue(launched({ agent }).argv, '--settings');
  assert.equal(settingsPath(WRITER), settingsPath(WRITER));
  assert.notEqual(settingsPath(WRITER), settingsPath({ ...WRITER, network: true }));
});

test('every listed plugin that is not installed is named in one error', () => {
  assert.throws(
    () => harness.resolveTools({ ...WRITER, plugins: ['nope-a', 'nope-b'] }, { commands: COMMANDS, platform: 'linux' }),
    { message: 'plugin nope-a is not installed; plugin nope-b is not installed' },
  );
});

test('--autocompact stays within the window Claude accepts, 100,000 to 1,000,000 tokens', () => {
  const autocompact = (contextBudget: number) =>
    flagValue(launched({ agent: { ...WRITER, contextBudget } }).argv, '--autocompact');
  assert.equal(autocompact(50000), '100000');
  assert.equal(autocompact(100000), '125000');
  assert.equal(autocompact(100001), '125002');
  assert.equal(autocompact(1000000), '1000000');
});

// The pinned minimum is 2.1.328, the version #425's recordings came from (decision 2 of #427): each part of a version
// is compared as a number, so 2.10.0 is newer than 2.1.328.
const VERSIONS: [string, boolean][] = [
  ['2.0.999', false],
  ['2.1.327', false],
  ['2.1.328', true],
  ['2.1.400', true],
  ['2.10.0', true],
  ['3.0.0', true],
];

test('the version check passes a CLI at or above 2.1.328, comparing each part as a number', async () => {
  const passed: [string, boolean][] = [];
  for (const [version] of VERSIONS) {
    const { checks } = await claude.createCli(recordedCli.recordedCli({ version })).doctor({ probe: false });
    passed.push([version, checks.find(({ name }) => name === 'version')?.ok === true]);
  }
  assert.deepEqual(passed, VERSIONS);
});
