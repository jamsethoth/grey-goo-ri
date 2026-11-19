import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type * as exec from '../exec.ts';
import type * as model from '../model.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as runContext from '../run-context.ts';

// The paths that configure Claude Code, which gg protects from every agent (request 3.2).
export const protectedPaths: string[] = ['.claude/', '.mcp.json', 'CLAUDE.md'];

export const name = 'claude';

// The launch profile the Config Hash pins: its name and version (request 3.2, decision 8 of #424). A change to the
// argv, environment or settings file launchArgs builds bumps the version.
export const launchProfile = { name: 'claude-headless', version: 1 };

// Decision 1 of #424. No profile turns Claude's sandbox on, so every platform runs in Trusted-Command Mode (ADR 0025).
export const capabilities = {
  skills: 'hint',
  mcp: 'unsupported',
  plugins: 'exact',
  access: 'exact',
  network: 'exact',
  contextBudget: 'exact',
  interactive: false,
  backgroundSessions: false,
  sessionResume: { supported: true, preconditions: [] as string[] },
  structuredOutput: true,
  sandbox: 'none',
  confinement: 'trusted-commands',
  peakContextReporting: false,
  costReporting: false,
  turnCountReporting: false,
  toolCallReporting: false,
  reasoningTokenReporting: false,
  backgroundWork: 'none',
};

// What resolveTools gives a Claude Agent: the tools Claude offers it (`--tools`), the permission rules gg's settings
// file holds, each listed plugin's directory, and the Agent fields Claude only hints.
export type ClaudeTools = {
  tools: string[];
  allow: string[];
  deny: string[];
  pluginDirectories: string[];
  hinted: string[];
};

// What launchArgs reads of the call gg sends (docs/interfaces/harness.md, SentCall).
export interface ClaudeCall {
  agent: model.Agent;
  persona: { name: string; bytes: string; hash: string };
  schema: object;
  resume: string | null;
  runDirectory: string;
  access: string;
  network?: boolean;
}

// A launch: the argv after the executable, the environment gg adds, and the files it names, by path, which the
// Harness writes before it spawns.
export interface Launch {
  argv: string[];
  env: Record<string, string>;
  files: Record<string, string>;
}

export interface Validated {
  ok: boolean;
  errors: string[];
  hinted: string[];
}

// The Agent fields the Capability matrix rules on by being listed.
const LISTED_FIELDS = ['skills', 'mcp', 'plugins', 'contextBudget'] as const;

// A field counts as listed unless it is absent or an empty list.
const listed = (value: unknown) => value !== undefined && !(Array.isArray(value) && !value.length);

const hintedOf = (agent: Record<string, unknown>) =>
  LISTED_FIELDS.filter((field) => capabilities[field] === 'hint' && listed(agent[field]));

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

// An Agent Claude cannot run as asked fails, never runs degraded (request 3.1).
export function validate(agent: unknown): Validated {
  const fields = (agent ?? {}) as Record<string, unknown>;
  // A listed field Claude declares unsupported is the validator's error, from the matrix (#429).
  const errors: string[] = [];
  if (fields.plugins !== undefined && !isStrings(fields.plugins)) errors.push('plugins must be a list of plugin names');
  const budget = fields.contextBudget;
  if (budget !== undefined && !(Number.isInteger(budget) && (budget as number) > 0))
    errors.push('contextBudget must be a positive integer of tokens');
  return { ok: !errors.length, errors, hinted: hintedOf(fields) };
}

// A JSON file's object, or undefined when it is missing, unreadable or not an object.
function readObject(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return referencePaths.isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const directories = (parent: string) =>
  readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name));

// A listed plugin's directory, which a missing plugin fails before any spawn (ported, feature-flow 89e1d67
// lib/toolkit.mjs:23-40): installed (marketplace) plugins first, then account-synced ones under
// plugins/synced/<id>/[<id>/]<name>. `alpha@mkt` matches that installed key exactly; a bare `alpha` matches
// `alpha@<any>` and must be unique.
function pluginDirectory(plugin: string, configDirectory: string): string {
  const installed = readObject(join(configDirectory, 'plugins', 'installed_plugins.json'))?.plugins;
  const keys = Object.keys(referencePaths.isRecord(installed) ? installed : {}).filter((key) =>
    plugin.includes('@') ? key === plugin : key.split('@')[0] === plugin,
  );
  if (keys.length > 1) throw new Error(`plugin ${plugin} ambiguous: ${keys.join(', ')}`);
  const entry: unknown =
    keys[0] === undefined ? undefined : [(installed as Record<string, unknown>)[keys[0]]].flat()[0];
  const path = referencePaths.isRecord(entry) ? entry.installPath : undefined;
  if (typeof path === 'string' && existsSync(path)) return path;
  const synced = join(configDirectory, 'plugins', 'synced');
  if (existsSync(synced))
    for (const top of directories(synced))
      for (const candidate of [...directories(top), ...directories(top).flatMap(directories)])
        if (readObject(join(candidate, '.claude-plugin', 'plugin.json'))?.name === plugin) return candidate;
  throw new Error(`plugin ${plugin} is not installed`);
}

// One table of command rules, emitted for the shell of the platform (G5 C). Claude's built-in read-only set joins
// them under Bash; it is documented for Bash only, so on win32 gg lists its own read-only commands (G6, ADR 0025).
const READ_ONLY_GIT = ['git diff:*', 'git log:*', 'git show:*', 'git status:*'];
const READ_ONLY_POWERSHELL = ['Get-ChildItem:*', 'Get-Content:*', 'Select-String:*'];
const DENIED_COMMANDS = ['git add:*', 'git commit:*', 'git push:*', 'gh:*'];
const WEB_TOOLS = ['WebFetch', 'WebSearch'];

const shellOf = (platform: NodeJS.Platform) => (platform === 'win32' ? 'PowerShell' : 'Bash');

function resolveToolsIn(configDirectory: string, agent: unknown, context: runContext.ToolsContext): ClaudeTools {
  const fields = (agent ?? {}) as Record<string, unknown>;
  const shell = shellOf(context.platform);
  const writes = fields.access === 'workspace-write';
  const network = fields.network === true;
  const commands = Object.values(context.commands).flatMap((line) => [line, `${line}:*`]);
  const readOnly = [...READ_ONLY_GIT, ...(context.platform === 'win32' ? READ_ONLY_POWERSHELL : [])];
  const rule = (command: string) => `${shell}(${command})`;
  const plugins = isStrings(fields.plugins) ? fields.plugins : [];
  const failures: string[] = [];
  const pluginDirectories = plugins.flatMap((plugin) => {
    try {
      return [pluginDirectory(plugin, configDirectory)];
    } catch (err) {
      failures.push((err as Error).message);
      return [];
    }
  });
  // Every plugin that fails, in one error: preflight shows one line a Vertex (request section 4).
  if (failures.length) throw new Error(failures.join('; '));
  return {
    tools: [shell, 'Read', 'Grep', 'Glob', ...(writes ? ['Edit', 'Write'] : []), ...(network ? WEB_TOOLS : [])],
    allow: [...commands, ...readOnly].map(rule),
    deny: [...DENIED_COMMANDS.map(rule), ...(network ? [] : WEB_TOOLS)],
    pluginDirectories,
    hinted: hintedOf(fields),
  };
}

// Files under the Run directory, which the Run's parallel Tickets share, are named by their content's hash.
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

// The margin above contextBudget at which Claude compacts, a backstop behind gg's own hand-off (#430).
const AUTOCOMPACT_PERCENT = 125;
// The window --autocompact accepts, in tokens (Claude Code docs, model-config, read 2026-11-18); a budget above 800,000
// compacts less than 25% past it, at the 1,000,000 cap, and a budget above 1,000,000 compacts before gg's hand-off.
const AUTOCOMPACT_RANGE = { least: 100_000, most: 1_000_000 };
const autocompactAt = (budget: number) =>
  Math.min(AUTOCOMPACT_RANGE.most, Math.max(AUTOCOMPACT_RANGE.least, Math.ceil((budget * AUTOCOMPACT_PERCENT) / 100)));

// The argv and environment of the launch profile (request 3.2, bullets 1-3), and the files they name.
export function launchArgs(call: ClaudeCall, tools: ClaudeTools): Launch {
  const readOnly = call.access !== 'workspace-write';
  const settings = JSON.stringify({
    permissions: { allow: tools.allow, deny: tools.deny, blockWritesOutsideWorkingDirectories: true },
  });
  const settingsPath = join(call.runDirectory, `claude-settings-${sha256(settings)}.json`);
  const personaPath = join(call.runDirectory, `persona-${call.persona.hash}.md`);
  const { model: modelName, effort, contextBudget } = call.agent;
  const argv = [
    '-p',
    ...['--setting-sources', '', '--strict-mcp-config', '--settings', settingsPath],
    ...tools.pluginDirectories.flatMap((directory) => ['--plugin-dir', directory]),
    ...(readOnly ? ['--restricted', '--disallowedTools', 'mcp__*'] : []),
    ...['--permission-mode', readOnly ? 'manual' : 'acceptEdits', '--permission-prompts', 'none'],
    ...['--system-prompt-snapshot', 'off', '--append-system-prompt-file', personaPath],
    ...['--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(call.schema)],
    ...(modelName == null ? [] : ['--model', modelName]),
    ...(effort == null ? [] : ['--effort', effort]),
    ...['--tools', tools.tools.join(',')],
    ...(typeof contextBudget === 'number' ? ['--autocompact', String(autocompactAt(contextBudget))] : []),
    ...(call.resume === null ? [] : ['--resume', call.resume]),
  ];
  const env: Record<string, string> = {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    ...(tools.tools.includes('PowerShell') && { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' }),
  };
  return { argv, env, files: { [settingsPath]: settings, [personaPath]: call.persona.bytes } };
}

// The Claude Harness over one Claude configuration directory, where its installed plugins are listed.
export function createClaude({ configDirectory }: { configDirectory: string }) {
  return {
    name,
    protectedPaths,
    launchProfile,
    capabilities,
    validate,
    resolveTools: (agent: unknown, context: runContext.ToolsContext) => resolveToolsIn(configDirectory, agent, context),
    launchArgs,
  };
}

// Claude Code's own configuration directory, as the CLI finds it.
export const { resolveTools } = createClaude({
  configDirectory: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
});

// stub: the members that start the CLI, built from the exec shipped.ts is given (run and doctor are to come).
export const createCli = (_runner: Pick<exec.Exec, 'launch'>) => ({});
