import { homedir } from 'node:os';
import { join } from 'node:path';
import * as config from '../config.ts';
import type * as model from '../model.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as runContext from '../run-context.ts';
import * as codexDoctor from './codex-doctor.ts';
import * as codexHandoffHook from './codex-handoff-hook.ts';
import * as codexListings from './codex-listings.ts';
import * as codexPlugins from './codex-plugins.ts';
import * as codexRun from './codex-run.ts';
import * as codexSkills from './codex-skills.ts';

// The doctor's sandbox command, for scripts/record-codex.ts to record as the doctor runs it (#484 D2 A).
export { SANDBOX_ARGS } from './codex-doctor.ts';
export { list } from './codex-listings.ts';
export type { InstalledPlugin, Listings } from './codex-listings.ts';
type InstalledPlugin = codexListings.InstalledPlugin;
type Listings = codexListings.Listings;

// The paths that configure Codex, which gg protects from every agent (request 3.2).
export const protectedPaths: string[] = ['.codex/', 'AGENTS.md'];

export const name = 'codex';

// The launch profile the Config Hash pins: its name and version (ADR 0031). A change to the argv or environment of a
// call this version admits bumps the version; argv added for an Agent it refused at preflight does not (ADR 0033).
export const launchProfile: runContext.LaunchProfile = { name: 'codex-exec', version: 1 };

// The Capabilities #479's recordings show, a field not shown exact unsupported (Q15 A, ADR 0031 point 5). The call runs
// in Codex's own sandbox, which is its confinement.
export const capabilities = {
  skills: 'hint',
  mcp: 'exact',
  plugins: 'exact',
  access: 'exact',
  network: 'unsupported',
  contextBudget: 'exact',
  interactive: false,
  backgroundSessions: false,
  sessionResume: { supported: true, preconditions: [] as string[] },
  structuredOutput: true,
  sandbox: process.platform === 'win32' ? 'codex-windows' : 'codex-posix',
  confinement: 'codex-sandbox',
  peakContextReporting: false,
  costReporting: false,
  turnCountReporting: false,
  toolCallReporting: true,
  reasoningTokenReporting: true,
  backgroundWork: 'none',
};

// gg's own Codex home, codex under GG_HOME, never the user's ~/.codex (Q8 A).
export const codexHome = (environment: NodeJS.ProcessEnv = process.env, home: string = homedir()): string =>
  join(config.userDirectory(environment, home), 'codex');

// The user's own skills folder, where an Agent's declared skills are found (D2 A); Codex lists it as its first skill
// root, which skills.include_instructions=false keeps out of every call.
export const skillsHome = (home: string = homedir()): string => join(home, '.agents', 'skills');

// What resolveTools gives a Codex Agent: the plugins and MCP servers it lists, and the Agent fields Codex only hints.
export type CodexTools = {
  plugins: string[];
  mcp: string[];
  hinted: string[];
};

// What launchArgs reads of the call gg sends (docs/interfaces/harness.md, SentCall).
export interface CodexCall {
  marker: string;
  agent: model.Agent;
  schema: object;
  cwd: string;
  resume: string | null;
  // gg ask-session's read-only copy of the resumed thread (#485), which leaves the thread itself unchanged.
  fork?: boolean;
  runDirectory: string;
  access: string;
}

// A launch: the argv after the executable, the environment gg adds, the files it names by path, which the Harness
// writes before it spawns, the file Codex writes its final message to (-o), each listed plugin whose apps stay off, and
// the skills list gg writes into the prompt before the Brief (D2 A).
export interface Launch {
  argv: string[];
  env: Record<string, string>;
  files: Record<string, string>;
  lastMessage: string;
  appsOff: string[];
  skills: string;
}

export interface Validated {
  ok: boolean;
  errors: string[];
  hinted: string[];
}

type Runner = codexListings.Runner;

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

// A field counts as listed unless it is absent or an empty list.
const LISTED_FIELDS = ['skills', 'mcp', 'plugins', 'contextBudget'] as const;
const isListed = (value: unknown) => value !== undefined && !(Array.isArray(value) && !value.length);
const hintedOf = (agent: Record<string, unknown>) =>
  LISTED_FIELDS.filter((field) => capabilities[field] === 'hint' && isListed(agent[field]));

export function resolveTools(agent: unknown, _context?: runContext.ToolsContext): CodexTools {
  const fields = (agent ?? {}) as Record<string, unknown>;
  return {
    plugins: isStrings(fields.plugins) ? fields.plugins : [],
    mcp: isStrings(fields.mcp) ? fields.mcp : [],
    hinted: hintedOf(fields),
  };
}

// Where Codex finds a plugin's parts (#479; Q3 C): its apps stay off under features.apps=false, so a plugin of skills
// and apps is admitted, and one bringing MCP servers, hooks or a key no recording shows is not.
const PLUGIN_LAYOUT: codexPlugins.PluginLayout = {
  manifest: join('.codex-plugin', 'plugin.json'),
  parts: {
    skills: { key: 'skills', files: [] },
    apps: { key: 'apps', files: ['.app.json'] },
    mcpServers: { key: 'mcpServers', files: ['.mcp.json'] },
    hooks: { key: 'hooks', files: ['hooks.json', join('hooks', 'hooks.json')] },
  },
  descriptive: [
    'name',
    'version',
    'description',
    'author',
    'homepage',
    'repository',
    'license',
    'keywords',
    'interface',
  ],
};
const ADMITTED_PARTS = ['skills', 'apps'];

// Where Codex keeps an installed plugin: plugins/cache/<marketplace>/<name>/<version>/ in its home.
const pluginDirectory = (home: string, plugin: InstalledPlugin) =>
  join(home, 'plugins', 'cache', plugin.marketplaceName, plugin.name, plugin.version);

// The approval key addresses a server by a dotted -c key, which Codex splits on every '.' (D17 A).
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

// The installed plugins and servers an Agent's tools name, and every reason one fails: a qualified plugin matches its
// id exactly, a bare one each id it starts, and two such ids are ambiguous (ported, feature-flow 89e1d67
// lib/toolkit.mjs:123-136); a plugin Codex holds a refused part of fails too (Q3 C).
function matched(home: string, tools: CodexTools, listings: Listings) {
  const errors: string[] = [];
  const plugins: InstalledPlugin[] = [];
  const appsOff: string[] = [];
  for (const asked of tools.plugins) {
    const found = listings.plugins.filter(({ pluginId }) =>
      asked.includes('@') ? pluginId === asked : pluginId.split('@')[0] === asked,
    );
    if (found.length !== 1) {
      const ids = found.map(({ pluginId }) => pluginId).join(', ');
      errors.push(found.length ? `plugin ${asked} ambiguous: ${ids}` : `plugin ${asked} is not installed`);
      continue;
    }
    const plugin = found[0]!;
    const { parts, refused } = codexPlugins.acceptance(pluginDirectory(home, plugin), PLUGIN_LAYOUT, ADMITTED_PARTS);
    if (refused.includes('manifest')) errors.push(`plugin ${plugin.pluginId} has no readable manifest`);
    else if (refused.length) errors.push(`plugin ${plugin.pluginId} brings ${refused.join(', ')}, which Codex refuses`);
    plugins.push(plugin);
    if (parts.includes('apps')) appsOff.push(plugin.pluginId);
  }
  for (const server of tools.mcp) {
    if (!listings.mcp.includes(server)) errors.push(`mcp server ${server} is not configured`);
    else if (!BARE_KEY.test(server)) errors.push(`mcp server ${server} has a name its approval key cannot address`);
  }
  return { errors, plugins, appsOff };
}

// The skills a call may use: Codex's bundled ones, the Agent's declared ones and each listed plugin's, named as Codex
// names a plugin's skill (D2 A).
// shortcut: a plugin's skills are read from its skills/ folder, the path each of gg's installed plugins' manifests
// names; read the manifest's path once a plugin names another.
const callSkills = (home: string, declared: codexSkills.Skill[], plugins: InstalledPlugin[]) => [
  ...codexSkills.skillsIn(join(home, 'skills', '.system')),
  ...declared,
  ...plugins.flatMap((plugin) =>
    codexSkills.skillsIn(join(pluginDirectory(home, plugin), 'skills'), `${plugin.name}:`, true),
  ),
];

// Codex takes a -c value as TOML: a JSON string is a TOML basic string once DEL is escaped (ported, feature-flow
// 89e1d67 lib/toolkit.mjs:139-141).
const tomlString = (text: string) => JSON.stringify(text).replace(/\u007f/g, '\\u007f');

// One inline table of `entries`, each id a quoted key, since Codex splits a -c key on every '.' (D11 A).
const table = (key: string, entries: [string, boolean][]) =>
  `${key}={${entries.map(([id, enabled]) => `${tomlString(id)}={enabled=${enabled}}`).join(',')}}`;

// Every key an empty start needs, set on every call (ADR 0031 point 2, D10 A, Q18 A).
const profileKeys = (cwd: string, hooks: boolean) => [
  'approval_policy="never"',
  'windows.sandbox="mxc"',
  `projects={${tomlString(cwd)}={trust_level="untrusted"}}`,
  `features.hooks=${hooks}`,
  'features.apps=false',
  'features.tool_suggest=false',
  'check_for_update_on_startup=false',
  'project_doc_max_bytes=0',
  'skills.include_instructions=false',
  'allow_login_shell=false',
];

// The keys of an Agent with a contextBudget (#485): the hand-off hook, its command its commandWindows too (request
// 3.2), which keeps each thread's last ask in the Run directory, and compaction at 125% of the budget as the backstop
// behind it (ADR 0029 point 1; #479 `compaction` shows the key compacts).
function handoffKeys(budget: number, runDirectory: string) {
  const command = tomlString(codexHandoffHook.command(budget, join(runDirectory, 'handoff-hook')));
  const handler = `{type="command",command=${command},commandWindows=${command},timeout=30}`;
  return [
    `hooks={PostToolUse=[{matcher=".*",hooks=[${handler}]}]}`,
    `model_auto_compact_token_limit=${Math.ceil(budget * 1.25)}`,
  ];
}

// The argv and environment of the launch profile (ADR 0031), and the files they name. A listing Codex lacks a tool
// in fails here, before any spawn.
function launchArgsIn(homes: Homes, call: CodexCall, tools: CodexTools, listings: Listings): Launch {
  const home = homes.codexHome;
  const { errors, plugins, appsOff } = matched(home, tools, listings);
  const declared = codexSkills.declared(homes.skillsHome, call.agent.skills);
  errors.push(...declared.errors);
  const budget = typeof call.agent.contextBudget === 'number' ? call.agent.contextBudget : null;
  // A hook file added to gg's Codex home since preflight fails the call before it spawns (Q3 A).
  if (budget !== null) errors.push(...codexHandoffHook.homeHookErrors(home));
  if (errors.length) throw new Error(errors.join('; '));
  const access = call.access === 'workspace-write' ? 'workspace-write' : 'read-only';
  const { model: modelName, effort } = call.agent;
  const schema = JSON.stringify(call.schema);
  const schemaPath = join(call.runDirectory, `codex-schema-${config.sha256(schema)}.json`);
  // The Run's Tickets share its directory, so each call's final message has a file of its own.
  const lastMessage = join(call.runDirectory, `codex-last-message-${config.sha256(call.marker)}.json`);
  const enabled = new Set(plugins.map(({ pluginId }) => pluginId));
  const overrides = [
    ...(modelName == null ? [] : [`model=${tomlString(modelName)}`]),
    ...(effort == null ? [] : [`model_reasoning_effort=${tomlString(effort)}`]),
    ...profileKeys(call.cwd, budget !== null),
    ...(budget === null ? [] : handoffKeys(budget, call.runDirectory)),
    ...(enabled.size
      ? [
          // Without `_default` a store plugin's own `enabled=true` outranks its entry here, so its tool servers load;
          // with it, only an entry saying true turns a plugin on, one installed after the listing too (#481 D6 A).
          table('plugins', [
            ['_default', false],
            ...listings.plugins.map(({ pluginId }): [string, boolean] => [pluginId, enabled.has(pluginId)]),
          ]),
        ]
      : []),
    ...(listings.mcp.length
      ? [
          table(
            'mcp_servers',
            listings.mcp.map((server) => [server, tools.mcp.includes(server)]),
          ),
        ]
      : []),
    ...tools.mcp.map((server) => `mcp_servers.${server}.default_tools_approval_mode="approve"`),
  ];
  const argv = [
    'exec',
    ...['-s', access, '-C', call.cwd],
    // Resume and fork take exec's -s and -C only before them, and their turn runs under them (ADR 0031 point 3, #479
    // D18 A).
    ...(call.resume === null ? [] : [call.fork === true ? 'fork' : 'resume', call.resume]),
    ...overrides.flatMap((override) => ['-c', override]),
    // Without it no hook fires, silently (#479 `hooks-untrusted`); the project stays untrusted, so its hooks stay out.
    ...(budget === null ? [] : ['--dangerously-bypass-hook-trust']),
    // The table cannot switch plugins off when none is listed, so none load (D11 A).
    ...(enabled.size ? [] : ['--disable', 'plugins']),
    ...['--json', '--output-schema', schemaPath, '-o', lastMessage, '-'],
  ];
  const skills = codexSkills.listed(callSkills(home, declared.skills, plugins));
  return { argv, env: { CODEX_HOME: home }, files: { [schemaPath]: schema }, lastMessage, appsOff, skills };
}

// gg's Codex home and the user's skills folder a Harness reads.
interface Homes {
  codexHome: string;
  skillsHome: string;
}

// The Codex Harness over one Codex home and one skills folder.
export function createCodex({
  codexHome: home,
  skillsHome: skills = skillsHome(),
}: Partial<Homes> & { codexHome: string }) {
  const homes = { codexHome: home, skillsHome: skills };
  return {
    name,
    protectedPaths,
    launchProfile,
    capabilities,
    resolveTools,
    launchArgs: (call: CodexCall, tools: CodexTools, listings: Listings) => launchArgsIn(homes, call, tools, listings),
  };
}

// An Agent Codex cannot run as asked fails at preflight: a plugin or server it lists that Codex lacks or refuses, a
// skill it declares that the user's skills folder lacks, or a contextBudget beside a hook file in gg's Codex home (Q3
// A). The listings run once, and only for an Agent that lists one (Q2 A).
async function validateIn(listOnce: () => Promise<Listings>, homes: Homes, agent: unknown): Promise<Validated> {
  const fields = (agent ?? {}) as Record<string, unknown>;
  const errors = (['plugins', 'mcp', 'skills'] as const).flatMap((field) =>
    fields[field] === undefined || isStrings(fields[field]) ? [] : [`${field} must be a list of names`],
  );
  const budget = fields.contextBudget;
  if (budget !== undefined && !(Number.isInteger(budget) && (budget as number) > 0))
    errors.push('contextBudget must be a positive integer of tokens');
  else if (budget !== undefined) errors.push(...codexHandoffHook.homeHookErrors(homes.codexHome));
  const tools = resolveTools(agent);
  if (!errors.length) errors.push(...codexSkills.declared(homes.skillsHome, fields.skills).errors);
  if (!errors.length && (tools.plugins.length || tools.mcp.length)) {
    try {
      errors.push(...matched(homes.codexHome, tools, await listOnce()).errors);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return { ok: !errors.length, errors, hinted: tools.hinted };
}

const notImplemented = (): never => {
  throw new Error('not implemented');
};

// The members built from the exec shipped.ts is given: run (#482, lib/harnesses/codex-run.ts), validate, which lists
// what Codex has installed once per preflight, and doctor (#484); interactiveArgs and metrics throw "not implemented"
// until their slices. Each call's launch lists afresh, so a plugin gone since preflight fails that call before it
// spawns, and a failed listing fails only its own call (ADR 0031 point 7, #481 Q2 A).
export const createCli = (
  runner: Runner,
  { codexHome: home = codexHome(), skillsHome: skills = skillsHome() }: Partial<Homes> = {},
) => {
  let listing: Promise<Listings> | undefined;
  const listOnce = () => (listing ??= codexListings.list(runner, home));
  const homes = { codexHome: home, skillsHome: skills };
  const launch = async (call: codexRun.RunCall, signal: AbortSignal) =>
    launchArgsIn(homes, call, call.tools, await codexListings.list(runner, home, signal));
  return {
    run: (call: Record<string, unknown>, hooks: runContext.HarnessHooks) =>
      codexRun.run(runner, { codexHome: home, launch }, call as unknown as codexRun.RunCall, hooks),
    interactiveArgs: notImplemented as (agent: unknown, opening: string, options?: unknown) => string[],
    metrics: notImplemented as (session: string) => null,
    validate: (agent: unknown) => validateIn(listOnce, homes, agent),
    // The probes launch over a listing like the one each Run's call takes, so a server the probe Agent does not list
    // is off (D17 A).
    doctor: (options: runContext.DoctorOptions) =>
      codexDoctor.doctor(runner, options, {
        home,
        profile: async (call) => launchArgsIn(homes, call, resolveTools(call.agent), await listOnce()),
      }),
  };
};
