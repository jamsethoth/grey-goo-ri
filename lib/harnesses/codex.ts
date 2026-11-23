import { homedir } from 'node:os';
import type * as exec from '../exec.ts';
import type * as model from '../model.ts';
import type * as runContext from '../run-context.ts';

// The paths that configure Codex, which gg protects from every agent (request 3.2).
export const protectedPaths: string[] = ['.codex/', 'AGENTS.md'];

export const name = 'codex';

// stub (#481): the launch profile the Config Hash pins, its name and version.
export const launchProfile: runContext.LaunchProfile | null = null;

// stub (#481): the Capabilities #479's recordings show (Q15 A).
export const capabilities = {
  skills: 'exact',
  mcp: 'exact',
  plugins: 'exact',
  access: 'exact',
  network: 'exact',
  contextBudget: 'exact',
  interactive: false,
  backgroundSessions: false,
  sessionResume: { supported: true, preconditions: [] as string[] },
  structuredOutput: false,
  sandbox: 'none',
  confinement: 'trusted-commands',
  peakContextReporting: false,
  costReporting: true,
  turnCountReporting: false,
  toolCallReporting: false,
  reasoningTokenReporting: false,
  backgroundWork: 'none',
};

// stub (#481): gg's own Codex home, under GG_HOME (Q8 A).
export const codexHome = (_environment: NodeJS.ProcessEnv = process.env, _home: string = homedir()): string => '';

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
// writes before it spawns, the file Codex writes its final message to (-o), and each listed plugin whose apps stay off.
export interface Launch {
  argv: string[];
  env: Record<string, string>;
  files: Record<string, string>;
  lastMessage: string;
  appsOff: string[];
}

export interface Validated {
  ok: boolean;
  errors: string[];
  hinted: string[];
}

// stub (#481): the installed plugins and MCP servers, listed afresh.
export function list(_runner: Pick<exec.Exec, 'launch'>, _codexHome: string): Promise<Listings> {
  return Promise.resolve({ plugins: [], mcp: [] });
}

// stub (#481)
export function resolveTools(_agent: unknown, _context: runContext.ToolsContext): CodexTools {
  return { plugins: [], mcp: [], hinted: [] };
}

// stub (#481): the Codex Harness over one Codex home.
export function createCodex({ codexHome: _home }: { codexHome: string }) {
  return {
    name,
    protectedPaths,
    launchProfile,
    capabilities,
    resolveTools,
    launchArgs: (_call: CodexCall, _tools: CodexTools, _listings: Listings): Launch => ({
      argv: [],
      env: {},
      files: {},
      lastMessage: '',
      appsOff: [],
    }),
  };
}

// stub (#481): the members built from the exec shipped.ts is given; run and doctor are #482's and #484's.
export const createCli = (_runner: Pick<exec.Exec, 'launch'>, _options: { codexHome?: string } = {}) => ({
  validate: (_agent: unknown): Promise<Validated> => Promise.resolve({ ok: true, errors: [], hinted: [] }),
});
