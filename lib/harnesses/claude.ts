import { homedir } from 'node:os';
import { join } from 'node:path';
import type * as model from '../model.ts';
import type * as runContext from '../run-context.ts';

// The paths that configure Claude Code, which gg protects from every agent (request 3.2).
export const protectedPaths: string[] = ['.claude/', '.mcp.json', 'CLAUDE.md'];

export const name = 'claude';

// The launch profile the Config Hash pins: its name and version (request 3.2, decision 8 of #424).
export const launchProfile = { name: '', version: 0 };

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

// The Claude Harness over one Claude configuration directory, where its installed plugins are listed.
export function createClaude(_options: { configDirectory: string }) {
  return {
    name,
    protectedPaths,
    launchProfile,
    capabilities: {
      skills: 'unsupported',
      mcp: 'unsupported',
      plugins: 'unsupported',
      access: 'unsupported',
      network: 'unsupported',
      contextBudget: 'unsupported',
      interactive: false,
      backgroundSessions: false,
      sessionResume: { supported: false, preconditions: [] as string[] },
      structuredOutput: false,
      sandbox: 'none',
      confinement: 'none',
      peakContextReporting: false,
      costReporting: false,
      turnCountReporting: false,
      toolCallReporting: false,
      reasoningTokenReporting: false,
      backgroundWork: 'unobserved',
    },
    validate: (_agent: unknown): Validated => ({ ok: true, errors: [], hinted: [] }),
    resolveTools: (_agent: unknown, _context: runContext.ToolsContext): ClaudeTools => ({
      tools: [],
      allow: [],
      deny: [],
      pluginDirectories: [],
      hinted: [],
    }),
    launchArgs: (_call: ClaudeCall, _tools: ClaudeTools): Launch => ({
      argv: [],
      env: {},
      files: {},
    }),
  };
}

// Claude Code's own configuration directory, as the CLI finds it.
const defaultHarness = createClaude({
  configDirectory: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
});
export const { capabilities, validate, resolveTools, launchArgs } = defaultHarness;
