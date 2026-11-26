// Claude's doctor warns of each Agent's listed plugin whose hook can rewrite a shell command before it runs (Q13' A,
// #484 Q5 A): a PreToolUse or PermissionRequest hook, declared in the plugin's hooks/hooks.json or its plugin.json's
// `hooks` field, whose tool filter matches the platform's shell as Claude matches one. Each case calls the Claude
// Harness's doctor, its CLI answering as recorded, over a Claude configuration directory of the case's own.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as claude from '../../lib/harnesses/claude.ts';
import * as claudePluginHome from '../support/claude-plugin-home.ts';
import * as recordedCli from '../support/recorded-cli.ts';

type HookEvents = claudePluginHome.HookEvents;
type HookedPlugin = claudePluginHome.HookedPlugin;

// The shell tool gg gives an Agent on this platform, and the one it gives elsewhere.
const SHELL = process.platform === 'win32' ? 'PowerShell' : 'Bash';
const OTHER_SHELL = SHELL === 'PowerShell' ? 'Bash' : 'PowerShell';

// Each event a hook may name with a tool filter, and whether its hook runs before the tool and can change its input.
const EVENTS: [string, boolean][] = [
  ['PreToolUse', true],
  ['PermissionRequest', true],
  ['PostToolUse', false],
  ['PostToolUseFailure', false],
];

// Each place a plugin declares its hooks: hooks/hooks.json, and plugin.json's `hooks` as a path, inline, or either in a
// list beside another source of hooks.
const PLACES: [string, (events: HookEvents) => HookedPlugin][] = [
  ['hooks/hooks.json', (events) => ({ hooksJson: events })],
  [
    'a path in plugin.json',
    (events) => ({ manifestHooks: './extra/hooks.json', hookFiles: { 'extra/hooks.json': events } }),
  ],
  ['inline in plugin.json', (events) => ({ manifestHooks: events })],
  [
    'a path in a list in plugin.json',
    (events) => ({
      manifestHooks: [claudePluginHome.hookOn('Stop'), './extra/hooks.json'],
      hookFiles: { 'extra/hooks.json': events },
    }),
  ],
  [
    'inline in a list in plugin.json',
    (events) => ({ manifestHooks: ['./extra/none.json', events], hookFiles: { 'extra/none.json': {} } }),
  ],
];

// Each form of tool filter, and whether Claude fires it on the shell: left out, empty or `*` (every tool), names
// separated by `|` or `,` (exact names), or else an unanchored regular expression.
const MATCHERS: [string | undefined, boolean][] = [
  [SHELL, true],
  [`Edit|${SHELL}`, true],
  [`Edit, ${SHELL}`, true],
  ['*', true],
  ['', true],
  [undefined, true],
  ['.*', true],
  [`^${SHELL.slice(0, 3)}`, true],
  [OTHER_SHELL, false],
  ['Edit|Write', false],
  ['Shell', false],
  [`${SHELL}s`, false],
  ['^Edit', false],
];

// A Claude Agent on its own, listing `plugins`.
const agentListing = (plugins: string[]) => ({
  harness: 'claude',
  persona: 'implementer.md',
  model: 'opus',
  effort: 'high',
  access: 'workspace-write',
  plugins,
});

// Claude's doctor's warnings that a plugin can rewrite shell commands, each as `<Agent> <plugin>` when it names one
// Agent and one plugin of those given, else as its message whole; each is a warning, not an error.
async function rewriteWarnings(
  t: TestContext,
  plugins: Record<string, HookedPlugin>,
  agents: Record<string, string[]>,
): Promise<string[]> {
  const configDirectory = claudePluginHome.claudePluginHome(t, plugins);
  const { checks } = await claude.createCli(recordedCli.recordedCli(), { configDirectory }).doctor({
    probe: false,
    agents: Object.fromEntries(Object.entries(agents).map(([name, listed]) => [name, agentListing(listed)])),
  });
  const warned = checks.filter(({ ok, message }) => !ok && message.includes('can rewrite'));
  assert.deepEqual(
    warned.filter(({ severity }) => severity !== 'warning'),
    [],
  );
  return warned
    .map(({ message }) => {
      const agentNames = Object.keys(agents).filter((name) => message.includes(name));
      const pluginNames = Object.keys(plugins).filter((name) => message.includes(name));
      return agentNames.length === 1 && pluginNames.length === 1 ? `${agentNames[0]} ${pluginNames[0]}` : message;
    })
    .sort();
}

// One plugin for each event, place and tool filter given, each listed by an Agent of its own, and the `<Agent>
// <plugin>` pairs whose hook can rewrite the shell's commands. Names share a length, so none holds another.
function corpus(events: typeof EVENTS, places: typeof PLACES, matchers: typeof MATCHERS) {
  const plugins: Record<string, HookedPlugin> = {};
  const agents: Record<string, string[]> = {};
  const expected: string[] = [];
  events.forEach(([event, rewrites], eventIndex) =>
    places.forEach(([, place], placeIndex) =>
      matchers.forEach(([matcher, matches], matcherIndex) => {
        const id = `${eventIndex}-${placeIndex}-${String(matcherIndex).padStart(2, '0')}`;
        plugins[`hooked-${id}@mkt`] = place(claudePluginHome.hookOn(event, matcher));
        agents[`agent-${id}`] = [`hooked-${id}@mkt`];
        if (rewrites && matches) expected.push(`agent-${id} hooked-${id}@mkt`);
      }),
    ),
  );
  return { plugins, agents, expected: expected.sort() };
}

const eventsThatRewrite = (rewrites: boolean) => EVENTS.filter(([, can]) => can === rewrites);
const HOOKS_JSON = PLACES.slice(0, 1);
const ON_SHELL = MATCHERS.slice(0, 1);

// A case that expects no warning lists beside its plugins one that warns, so a doctor that warns of nothing fails it.
const CONTROL_WARNING = 'control control@mkt';
const withControl = ({ plugins, agents }: ReturnType<typeof corpus>) => ({
  plugins: { ...plugins, 'control@mkt': { hooksJson: claudePluginHome.hookOn('PreToolUse', SHELL) } },
  agents: { ...agents, control: ['control@mkt'] },
});

test('each hook event that can rewrite a shell command before it runs is a warning', async (t) => {
  const { plugins, agents, expected } = corpus(eventsThatRewrite(true), HOOKS_JSON, ON_SHELL);
  assert.equal(expected.length, 2);
  assert.deepEqual(await rewriteWarnings(t, plugins, agents), expected);
});

test('a hook that runs after the shell command is no warning', async (t) => {
  const { plugins, agents } = withControl(corpus(eventsThatRewrite(false), HOOKS_JSON, ON_SHELL));
  assert.deepEqual(await rewriteWarnings(t, plugins, agents), [CONTROL_WARNING]);
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('a hook plugin.json declares is a warning, by a path, inline or in a list, as one in hooks/hooks.json is', async (t) => {
  const { plugins, agents, expected } = corpus(eventsThatRewrite(true).slice(0, 1), PLACES, ON_SHELL);
  assert.equal(expected.length, PLACES.length);
  assert.deepEqual(await rewriteWarnings(t, plugins, agents), expected);
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('a hook whose tool filter is the shell, a list holding it, a pattern matching it or every tool is a warning', async (t) => {
  const matching = MATCHERS.filter(([, matches]) => matches);
  const { plugins, agents, expected } = corpus(eventsThatRewrite(true).slice(0, 1), HOOKS_JSON, matching);
  assert.equal(expected.length, matching.length);
  assert.deepEqual(await rewriteWarnings(t, plugins, agents), expected);
});

test('a hook whose tool filter matches only other tools is no warning', async (t) => {
  const others = MATCHERS.filter(([, matches]) => !matches);
  const { plugins, agents } = withControl(corpus(eventsThatRewrite(true), HOOKS_JSON, others));
  assert.deepEqual(await rewriteWarnings(t, plugins, agents), [CONTROL_WARNING]);
});

test('a plugin is one warning for each Agent that lists it, however many shell hooks it declares', async (t) => {
  const plugins = {
    'twice@mkt': {
      hooksJson: { ...claudePluginHome.hookOn('PreToolUse', SHELL), ...claudePluginHome.hookOn('PermissionRequest') },
      manifestHooks: claudePluginHome.hookOn('PreToolUse', '*'),
    },
    'quiet@mkt': {},
  };
  const agents = { writer: ['twice@mkt'], reviewer: ['quiet@mkt', 'twice@mkt'], idle: ['quiet@mkt'] };
  assert.deepEqual(await rewriteWarnings(t, plugins, agents), ['reviewer twice@mkt', 'writer twice@mkt']);
});

// The rule over every site (DoD 4): every event, every place a hook is declared and every form of tool filter.
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('every listed plugin with a rewriting shell hook, on every Claude Agent, is one warning naming both, and no other is', async (t) => {
  const { plugins, agents, expected } = corpus(EVENTS, PLACES, MATCHERS);
  assert.ok(expected.length > 0 && expected.length < Object.keys(plugins).length);
  assert.deepEqual(await rewriteWarnings(t, plugins, agents), expected);
});
