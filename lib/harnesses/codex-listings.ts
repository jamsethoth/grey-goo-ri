// What Codex lists of gg's Codex home, for lib/harnesses/codex.ts alone: its installed plugins and its configured MCP
// servers, each listing a command of its own, read whole or failed by name.
import type * as exec from '../exec.ts';
import * as referencePaths from '../reference-paths.ts';
import * as cliDoctor from './cli-doctor.ts';

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

export type Runner = Pick<exec.Exec, 'launch' | 'childInJob'>;

// What a listing printed, parsed; a failure or no JSON is an error naming the command, never an empty list, which
// would leave every plugin and server on (ported, feature-flow 89e1d67 lib/toolkit.mjs:79-96).
async function listed(runner: Runner, home: string, args: string[], signal?: AbortSignal) {
  const command = ['codex', ...args].join(' ');
  // The plugin listing reads OpenAI's catalog and once took 87 s, past the cheap limit (#481 F16).
  const ran = await cliDoctor.said(runner, {
    command: 'codex',
    args,
    env: { CODEX_HOME: home },
    wallMs: cliDoctor.PROBE_WALL_MS,
    signal,
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

// The installed plugins and MCP servers, listed afresh, both at once. The server listing leaves out a plugin's servers,
// which Q3 C refuses and whose launch entry failed Codex's configuration load in feature-flow (#481 D9 B).
export async function list(runner: Runner, home: string, signal?: AbortSignal): Promise<Listings> {
  const [plugins, servers] = await Promise.all([
    listed(runner, home, ['plugin', 'list', '--json'], signal),
    listed(runner, home, ['mcp', 'list', '--json', '-c', 'features.plugins=false'], signal),
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
