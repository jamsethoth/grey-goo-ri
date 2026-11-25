import { homedir } from 'node:os';
import { join } from 'node:path';
import * as config from '../config.ts';
import type * as exec from '../exec.ts';
import type * as model from '../model.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as runContext from '../run-context.ts';
import * as cliDoctor from './cli-doctor.ts';
import * as codexPlugins from './codex-plugins.ts';
import * as codexSkills from './codex-skills.ts';

// The paths that configure Codex, which gg protects from every agent (request 3.2).
export const protectedPaths: string[] = ['.codex/', 'AGENTS.md'];

export const name = 'codex';

// The launch profile the Config Hash pins: its name and version (ADR 0031). A change to the argv or environment
// launchArgs builds bumps the version.
export const launchProfile: runContext.LaunchProfile = { name: 'codex-exec', version: 1 };

// The Capabilities #479's recordings show, a field not shown exact unsupported (Q15 A, ADR 0031 point 5). The call runs
// in Codex's own sandbox, which is its confinement.
export const capabilities = {
  skills: 'hint',
  mcp: 'exact',
  plugins: 'exact',
  access: 'exact',
  network: 'unsupported',
  contextBudget: 'unsupported',
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

// An installed plugin as `codex plugin list --json` lists it.
export interface InstalledPlugin {
  pluginId: string;
  name: string;
  marketplaceName: string;
  version: string;
}

// What Codex lists of its home: the installed plugins and the configured MCP servers by name.
export interface Listings {
  plugins: InstalledPlugin[];
  mcp: string[];
}

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

type Runner = Pick<exec.Exec, 'launch'>;

// What a listing printed, parsed; a failure or no JSON is an error naming the command, never an empty list, which
// would leave every plugin and server on (ported, feature-flow 89e1d67 lib/toolkit.mjs:79-96).
async function listed(runner: Runner, home: string, args: string[]): Promise<{ command: string; data: unknown }> {
  const command = ['codex', ...args].join(' ');
  // The plugin listing reads OpenAI's catalog and once took 87 s, past the cheap limit (#481 F16).
  const ran = await cliDoctor.said(runner, {
    command: 'codex',
    args,
    env: { CODEX_HOME: home },
    wallMs: cliDoctor.PROBE_WALL_MS,
  });
  const reason = cliDoctor.reasonOf(ran);
  if (reason !== null) throw new Error(`${command} failed: ${reason}`);
  try {
    return { command, data: JSON.parse(ran.lines.join('\n')) };
  } catch {
    throw new Error(`${command} printed no JSON`);
  }
}

const filled = (value: unknown, keys: string[]) =>
  referencePaths.isRecord(value) && keys.every((key) => typeof value[key] === 'string' && value[key] !== '');

const PLUGIN_KEYS = ['pluginId', 'name', 'marketplaceName', 'version'];

// The installed plugins and MCP servers, listed afresh, both at once.
export async function list(runner: Runner, home: string): Promise<Listings> {
  const [plugins, servers] = await Promise.all([
    listed(runner, home, ['plugin', 'list', '--json']),
    listed(runner, home, ['mcp', 'list', '--json']),
  ]);
  const installed = referencePaths.isRecord(plugins.data) ? plugins.data.installed : undefined;
  if (!Array.isArray(installed) || !installed.every((entry) => filled(entry, PLUGIN_KEYS)))
    throw new Error(`${plugins.command} printed an unexpected listing: expected installed plugins, each named`);
  if (!Array.isArray(servers.data) || !servers.data.every((entry) => filled(entry, ['name'])))
    throw new Error(`${servers.command} printed an unexpected listing: expected servers, each named`);
  return {
    plugins: (installed as InstalledPlugin[]).map(({ pluginId, name: plugin, marketplaceName, version }) => ({
      pluginId,
      name: plugin,
      marketplaceName,
      version,
    })),
    mcp: (servers.data as { name: string }[]).map(({ name: server }) => server),
  };
}

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

// The skills an Agent declares, each a folder of the user's skills folder, and every one not found there (D2 A).
function declaredSkills(skillsFolder: string, declared: unknown) {
  const names = isStrings(declared) ? declared : [];
  const lookedUp = names.map((name) => [name, codexSkills.skillAt(join(skillsFolder, name))] as const);
  return {
    skills: lookedUp.flatMap(([, skill]) => skill ?? []),
    errors: lookedUp.flatMap(([name, skill]) => (skill ? [] : [`skill ${name} is not in ${skillsFolder}`])),
  };
}

// The skills a call may use: Codex's bundled ones, the Agent's declared ones and each listed plugin's, named as Codex
// names a plugin's skill (D2 A).
// shortcut: a plugin's skills are read from its skills/ folder, the path each of gg's installed plugins' manifests
// names; read the manifest's path once a plugin names another.
const callSkills = (home: string, declared: codexSkills.Skill[], plugins: InstalledPlugin[]) => [
  ...codexSkills.skillsIn(join(home, 'skills', '.system')),
  ...declared,
  ...plugins.flatMap((plugin) =>
    codexSkills.skillsIn(join(pluginDirectory(home, plugin), 'skills'), `${plugin.name}:`),
  ),
];

// Codex takes a -c value as TOML: a JSON string is a TOML basic string once DEL is escaped (ported, feature-flow
// 89e1d67 lib/toolkit.mjs:139-141).
const tomlString = (text: string) => JSON.stringify(text).replace(/\u007f/g, '\\u007f');

// One inline table of `entries`, each id a quoted key, since Codex splits a -c key on every '.' (D11 A).
const table = (key: string, entries: [string, boolean][]) =>
  `${key}={${entries.map(([id, enabled]) => `${tomlString(id)}={enabled=${enabled}}`).join(',')}}`;

// Every key an empty start needs, set on every call (ADR 0031 point 2, D10 A, Q18 A).
const profileKeys = (cwd: string) => [
  'approval_policy="never"',
  'windows.sandbox="mxc"',
  `projects={${tomlString(cwd)}={trust_level="untrusted"}}`,
  'features.hooks=false',
  'features.apps=false',
  'features.tool_suggest=false',
  'check_for_update_on_startup=false',
  'project_doc_max_bytes=0',
  'skills.include_instructions=false',
  'allow_login_shell=false',
];

// The argv and environment of the launch profile (ADR 0031), and the files they name. A listing Codex lacks a tool
// in fails here, before any spawn.
function launchArgsIn(homes: Homes, call: CodexCall, tools: CodexTools, listings: Listings): Launch {
  const home = homes.codexHome;
  const { errors, plugins, appsOff } = matched(home, tools, listings);
  const declared = declaredSkills(homes.skillsHome, call.agent.skills);
  errors.push(...declared.errors);
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
    ...profileKeys(call.cwd),
    ...(enabled.size
      ? [
          table(
            'plugins',
            listings.plugins.map(({ pluginId }) => [pluginId, enabled.has(pluginId)]),
          ),
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
    // Resume takes exec's -s and -C only before it, and a resumed turn runs under them (ADR 0031 point 3).
    ...(call.resume === null ? [] : ['resume', call.resume]),
    ...overrides.flatMap((override) => ['-c', override]),
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

// An Agent Codex cannot run as asked fails at preflight: a plugin or server it lists that Codex lacks or refuses, or a
// skill it declares that the user's skills folder lacks. The listings run once, and only for an Agent that lists one
// (Q2 A).
async function validateIn(listOnce: () => Promise<Listings>, homes: Homes, agent: unknown): Promise<Validated> {
  const fields = (agent ?? {}) as Record<string, unknown>;
  const errors = (['plugins', 'mcp', 'skills'] as const).flatMap((field) =>
    fields[field] === undefined || isStrings(fields[field]) ? [] : [`${field} must be a list of names`],
  );
  const tools = resolveTools(agent);
  if (!errors.length) errors.push(...declaredSkills(homes.skillsHome, fields.skills).errors);
  if (!errors.length && (tools.plugins.length || tools.mcp.length)) {
    try {
      errors.push(...matched(homes.codexHome, tools, await listOnce()).errors);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return { ok: !errors.length, errors, hinted: tools.hinted };
}

// The members built from the exec shipped.ts is given: validate, which lists what Codex has installed once per
// preflight; run and doctor are #482's and #484's.
export const createCli = (
  runner: Runner,
  { codexHome: home = codexHome(), skillsHome: skills = skillsHome() }: Partial<Homes> = {},
) => {
  let listing: Promise<Listings> | undefined;
  const listOnce = () => (listing ??= list(runner, home));
  const homes = { codexHome: home, skillsHome: skills };
  return { validate: (agent: unknown) => validateIn(listOnce, homes, agent) };
};
