// Records the Codex CLI for the Codex Harness's tests (#479). Each scenario runs `codex exec` once, under gg's
// CODEX_HOME (GG_HOME/codex, which the owner logged in once, Q5 A) and the overrides that start a call empty, in a
// fresh temporary repository, inside a Windows job as gg runs a launch; its --json lines, redacted, land in
// test/fixtures/codex/<name>.jsonl, the command that made them, each line's arrival time and what the call left behind
// in <name>.json, and its session file, trimmed and redacted, in <name>.rollout.jsonl. Each command that is no model
// call runs once, and its argv, exit code and output land in <name>.json. It calls the real CLI and spends the
// subscription's usage: run it to re-record a new Codex version, never from a test.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as commandShim from '../lib/command-shim.ts';
import * as containment from '../lib/containment.ts';
import * as homeGuard from './record-codex-home.ts';
import * as redaction from './record-codex-redaction.ts';
import * as repository from './record-codex-repository.ts';
import * as contained from './record-codex-run.ts';
import { type CliCommand, COMMANDS, SCENARIOS, type Scenario } from './record-codex-scenarios.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT = join(root, 'test', 'fixtures', 'codex');
// Owner Q1 A: at most 30 model calls in one recording session, retries included.
const MODEL_CALL_CAP = 30;
const USAGE = `usage: node scripts/record-codex.ts [name ...]
  no name: every scenario, in order (a resume or fork needs the one it continues), then every command
  scenarios: ${SCENARIOS.map((scenario) => scenario.name).join(', ')}
  commands, none a model call: ${COMMANDS.map((command) => command.name).join(', ')}`;
// The cheapest model the catalog lists ("Fast and affordable model for easier tasks"), at its lowest effort.
const MODEL = 'gpt-6-luna';
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const GG_CODEX_HOME = join(process.env.GG_HOME || join(homedir(), '.agents', 'gg'), 'codex');

interface Recorded {
  directories: repository.Directories;
  threadId: string | null;
  home: string;
}

// gg's overrides, every one a -c (request 3.2): the model and effort, no approval prompt (F1), the MXC sandbox, the
// project's trust set explicitly, hooks explicit, and the keys the empty-start probe found reach a call otherwise:
// repository instruction files, the skill listing (the user's ~/.agents/skills among it), apps and plugin suggestions.
function profile(
  repo: string,
  options: { windowsSandbox?: string; trusted?: boolean; hooks?: boolean; repositoryContent?: boolean },
) {
  const trust = options.trusted ? 'trusted' : 'untrusted';
  const keys = [
    `model="${MODEL}"`,
    'model_reasoning_effort="low"',
    'approval_policy="never"',
    `windows.sandbox="${options.windowsSandbox ?? 'mxc'}"`,
    `projects={${JSON.stringify(repo)}={trust_level="${trust}"}}`,
    `features.hooks=${options.hooks ?? false}`,
    'features.apps=false',
    'features.tool_suggest=false',
    'check_for_update_on_startup=false',
    ...(options.repositoryContent ? [] : ['project_doc_max_bytes=0', 'skills.include_instructions=false']),
  ];
  return keys.flatMap((key) => ['-c', key]);
}

const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);

// How the call starts: a new thread, or the thread it continues resumed or forked, with --sandbox and -C on exec
// before resume or fork (request 3.2) except for the resume that sets its sandbox by -c after resume and the fork that
// takes the thread's.
function headOf(scenario: Scenario, repo: string, threadId: string) {
  const sandbox = ['-s', scenario.sandbox ?? 'read-only', '-C', repo];
  const kind = scenario.start?.kind;
  if (kind === 'resume-config-after') return ['exec', 'resume', threadId];
  if (kind === 'resume-flags-before') return ['exec', ...sandbox, 'resume', threadId];
  if (kind === 'fork') return ['exec', ...sandbox, 'fork', threadId];
  if (kind === 'fork-unflagged') return ['exec', 'fork', threadId];
  return ['exec', ...sandbox];
}

// The call's argv: the start, resume or fork, then the profile, the scenario's own keys, and the stream, schema and
// final-message flags, with the prompt on stdin.
function argvOf(
  scenario: Scenario,
  directories: repository.Directories,
  values: Record<string, string>,
  from?: Recorded,
) {
  const hooks = scenario.hooks
    ? [
        '-c',
        `hooks=${repository.toml(repository.hooksOf(directories.base, 'inline'))}`,
        ...(scenario.hooks.bypassTrust ? ['--dangerously-bypass-hook-trust'] : []),
      ]
    : [];
  const mcp = scenario.mcp
    ? ['-c', `mcp_servers.probe={command="node",args=[${JSON.stringify(`${directories.base}/mcp-server.cjs`)}]}`]
    : [];
  return [
    ...headOf(scenario, directories.repo, from?.threadId ?? ''),
    ...profile(directories.repo, { ...scenario, hooks: scenario.hooks?.enabled }),
    ...(scenario.config ?? []).flatMap((key) => ['-c', fill(key, values)]),
    ...hooks,
    ...mcp,
    ...(scenario.extraArgv ?? []),
    '--json',
    '--output-schema',
    join(directories.run, 'schema.json'),
    '-o',
    join(directories.run, `${scenario.name}.last.txt`),
    '-',
  ];
}

// A stand-in Responses API that answers every request 429 usage_limit_reached, as the ChatGPT backend does at a limit.
async function startStub(requests: string[]) {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      if (!path.endsWith('/responses')) {
        requests.push(`${request.method} ${path} 404`);
        response.writeHead(404).end();
        return;
      }
      requests.push(`${request.method} ${path} 429`);
      const error = { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus' };
      response
        .writeHead(429, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { ...error, resets_in_seconds: 3600 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// The thread id the stream's thread.started names.
function threadOf(lines: string[]): string | null {
  for (const line of lines) {
    const found = /"type":"thread\.started","thread_id":"([^"]+)"/.exec(line);
    if (found) return found[1] ?? null;
  }
  return null;
}

// The session file of a thread, found by its id across the sessions tree.
function rolloutOf(home: string, threadId: string | null) {
  const sessions = join(home, 'sessions');
  if (threadId === null || !existsSync(sessions)) return null;
  const found = readdirSync(sessions, { recursive: true, encoding: 'utf8' }).find((path) =>
    path.endsWith(`-${threadId}.jsonl`),
  );
  return found === undefined ? null : join(sessions, found);
}

const hashOf = (path: string | null) =>
  path === null ? null : createHash('sha256').update(readFileSync(path)).digest('hex');

// The files under the scenario's directory, less the repository's .git, the run directory and an empty home.
function filesUnder(base: string) {
  return readdirSync(base, { recursive: true, encoding: 'utf8' })
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => !/^(?:repo\/\.git|run|home)(?:\/|$)/.test(path));
}

const textOf = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

// gg's CODEX_HOME, or an empty one in the call's directory that holds no login.
function homeOf(home: 'gg' | 'empty' | undefined, base: string) {
  if (home !== 'empty') return GG_CODEX_HOME;
  mkdirSync(join(base, 'home'), { recursive: true });
  return join(base, 'home');
}

// What a call left behind: files it created, the hook and MCP logs, the forked rollout's hash, the job's processes,
// the home's changes, the stub's requests, and the home's log tail when it failed.
function evidenceOf(call: {
  base: string;
  home: string;
  output: contained.Output;
  before: { files: string[]; forked: string | null };
  forkedRollout: string | null;
  homeChanges: ReturnType<ReturnType<typeof homeGuard.guard>['restore']>;
  stubRequests: string[] | null;
}) {
  const { base, output, before, forkedRollout } = call;
  return {
    created: filesUnder(base).filter((path) => !before.files.includes(path)),
    hookLog: textOf(join(base, 'hook-log.txt')),
    mcpLog: textOf(join(base, 'mcp-log.txt')),
    forkedRollout:
      forkedRollout === null ? null : { unchanged: before.forked === hashOf(forkedRollout), path: forkedRollout },
    job: output.job,
    homeChanges: call.homeChanges,
    stubRequests: call.stubRequests,
    homeLogTail: output.exitCode === 0 ? null : homeGuard.logTail(call.home),
  };
}

// The session file a fork continues, whose hash shows whether the fork left it unchanged.
const forkedOf = (scenario: Scenario, home: string, from: Recorded | undefined) =>
  scenario.start?.kind.startsWith('fork') ? rolloutOf(home, from?.threadId ?? null) : null;

// One call: its directories and home, the launch inside a job, and what it changed around it.
async function call(scenario: Scenario, base: string, from: Recorded | undefined) {
  const directories = from?.directories ?? repository.prepare(base, scenario.repository ?? 'plain');
  const home = from?.home ?? homeOf(scenario.home, directories.base);
  writeFileSync(join(directories.run, 'schema.json'), JSON.stringify(SCHEMA));
  const requests: string[] = [];
  const stub = scenario.stub ? await startStub(requests) : undefined;
  const values = { base: directories.base, repo: directories.repo, stub: stub?.url ?? '' };
  const argv = argvOf(scenario, directories, values, from);
  const env = { ...scenario.env, CODEX_HOME: home };
  const cwd = scenario.cwd === 'base' ? directories.base : directories.repo;
  const forkedRollout = forkedOf(scenario, home, from);
  const before = { files: filesUnder(directories.base), forked: hashOf(forkedRollout) };
  const guard = homeGuard.guard(home, scenario.hooks ? repository.hooksOf(directories.base, 'home') : null);
  const { prompt, watch, killOn } = scenario;
  const output = await contained.run({ argv, cwd, env, prompt, watch, killOn });
  const homeChanges = guard.restore();
  stub?.close();
  const evidence = evidenceOf({
    base: directories.base,
    home,
    output,
    before,
    forkedRollout,
    homeChanges,
    stubRequests: stub ? requests : null,
  });
  return { directories, home, argv, env, output, evidence };
}

async function record(scenario: Scenario, cliVersion: string, base: string, from: Recorded | undefined) {
  const { directories, home, argv, env, output, evidence } = await call(scenario, base, from);
  const threadId = threadOf(output.lines);
  const rollout = rolloutOf(home, threadId);
  const meta = {
    cliVersion,
    scenario: scenario.name,
    purpose: scenario.purpose,
    modelCall: scenario.modelCall ?? true,
    command: { executable: 'codex', argv, cwd: scenario.cwd ?? 'repo', env, stdin: scenario.prompt },
    start: scenario.start ?? null,
    threadId,
    exitCode: output.exitCode,
    signal: output.signal,
    killed: output.killed,
    lineTimesMs: output.timesMs,
    stderr: output.stderr,
    lastMessage: textOf(join(directories.run, `${scenario.name}.last.txt`)),
    rolloutPath: rollout,
    evidence,
  };
  const redact = redaction.redactorOf(directories.base);
  save(scenario.name, redact, output.lines, meta);
  if (rollout !== null)
    writeLines(`${scenario.name}.rollout.jsonl`, redact, readFileSync(rollout, 'utf8').split('\n').filter(Boolean));
  console.log(`${scenario.name}: exit ${output.exitCode}, ${output.lines.length} lines, killed ${output.killed}`);
  return { directories, threadId, home };
}

function writeLines(file: string, redact: (text: string) => string, lines: string[]) {
  const text = lines.map((line) => redaction.committedLine(line, redact)).join('\n');
  writeFileSync(join(OUTPUT, file), text && `${text}\n`);
}

function save(name: string, redact: (text: string) => string, lines: string[], meta: object) {
  writeLines(`${name}.jsonl`, redact, lines);
  writeFileSync(join(OUTPUT, `${name}.json`), `${redact(JSON.stringify(redaction.trimmed(meta), null, 2))}\n`);
}

const INHERITED = /^(?:CLAUDE|ANTHROPIC|CODEX|OPENAI)/;
const environmentWith = (env: Record<string, string>) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !INHERITED.test(key))),
  ...env,
});

function codexSync(argv: string[], options: { cwd?: string; env: Record<string, string> }) {
  const { command, args } = commandShim.argvOf('codex', argv);
  return spawnSync(command, args, {
    ...options,
    env: environmentWith(options.env),
    encoding: 'utf8',
    timeout: 120_000,
  });
}

// An empty CODEX_HOME with the probe plugin installed from a local marketplace, then, unless it stays enabled,
// disabled in its config, so only a -c can enable it.
function pluginHome(base: string, enabled: boolean) {
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const marketplace = repository.writeMarketplace(base);
  codexSync(['plugin', 'marketplace', 'add', marketplace], { env: { CODEX_HOME: home } });
  codexSync(['plugin', 'add', 'probe-plugin@gg-probe'], { env: { CODEX_HOME: home } });
  const config = join(home, 'config.toml');
  if (!enabled) writeFileSync(config, readFileSync(config, 'utf8').replace('enabled = true', 'enabled = false'));
  return home;
}

// What a debug prompt-input output shows before its trim: the sentinels, the skill roots and the tools.
function promptInputFacts(stdout: string) {
  const parsed: unknown = JSON.parse(stdout);
  const items = Array.isArray(parsed) ? parsed : [];
  return {
    sentinels: [...new Set(stdout.match(/SENTINEL-[A-Z-]+[A-Z]/g) ?? [])].toSorted(),
    skillRoots: [...stdout.matchAll(/`(r\d+)` = `([^`]*)`/g)].map((found) => `${found[1]} = ${found[2]}`),
    items: items.map((item: unknown) => redaction.trimmed(item)),
  };
}

// One command that is no model call, in a directory of its own.
function recordCommand(command: CliCommand, cliVersion: string, base: string) {
  const directories = repository.prepare(base, command.repository ?? 'plain');
  const home =
    command.home === 'plugin' || command.home === 'plugin-enabled'
      ? pluginHome(base, command.home === 'plugin-enabled')
      : homeOf(command.home, base);
  // The profile's -c keys go after `debug prompt-input`, which takes them, and before any other command.
  const split = command.argv[0] === 'debug' ? 2 : 0;
  const extra = command.profile || command.trusted ? profileFor(command, directories.repo) : [];
  const argv = [...command.argv.slice(0, split), ...extra, ...command.argv.slice(split)].map((arg) =>
    fill(arg, { base: directories.base.replaceAll('\\', '/') }),
  );
  const ran = codexSync(argv, { cwd: directories.repo, env: { CODEX_HOME: home } });
  const isPromptInput = split === 2 && ran.status === 0;
  const meta = {
    cliVersion,
    command: command.name,
    purpose: command.purpose,
    argv,
    home: command.home ?? 'gg',
    repository: command.repository ?? 'plain',
    exitCode: ran.status,
    stdout: isPromptInput ? null : ran.stdout,
    promptInput: isPromptInput ? promptInputFacts(ran.stdout) : null,
    stderr: ran.stderr,
  };
  const redact = redaction.redactorOf(directories.base);
  writeFileSync(join(OUTPUT, `${command.name}.json`), `${redact(JSON.stringify(meta, null, 2))}\n`);
  console.log(`${command.name}: exit ${ran.status}`);
}

function profileFor(command: CliCommand, repo: string) {
  if (command.profile) return profile(repo, { trusted: command.trusted });
  return ['-c', `projects={${JSON.stringify(repo)}={trust_level="trusted"}}`];
}

function chosenOf(names: string[]) {
  const named = [...SCENARIOS, ...COMMANDS].map((recorded) => recorded.name);
  const unknown = names.filter((name) => !named.includes(name));
  if (unknown.length || names.includes('--help'))
    return { error: unknown.length ? `unknown name: ${unknown.join(', ')}\n${USAGE}` : USAGE };
  const scenarios = SCENARIOS.filter((scenario) => !names.length || names.includes(scenario.name));
  const missing = scenarios.filter(
    (scenario) => scenario.start && !scenarios.some((other) => other.name === scenario.start?.from),
  );
  if (missing.length)
    return { error: `${missing.map((scenario) => `${scenario.name} continues ${scenario.start?.from}`).join('; ')}` };
  const calls = scenarios.filter((scenario) => scenario.modelCall ?? true).length;
  if (calls > MODEL_CALL_CAP) return { error: `${calls} model calls is over the cap of ${MODEL_CALL_CAP}` };
  const commands = COMMANDS.filter((cliCommand) => !names.length || names.includes(cliCommand.name));
  return { scenarios, commands, calls };
}

async function main(names: string[]) {
  const chosen = chosenOf(names);
  if ('error' in chosen) {
    console.error(chosen.error);
    return 2;
  }
  if (containment.openKernel32() === null) console.error('node:ffi is unavailable: calls run with no job');
  const { command, args } = commandShim.argvOf('codex', ['--version']);
  const cliVersion = execFileSync(command, args, { encoding: 'utf8' }).trim();
  const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), 'gg-codex-')));
  mkdirSync(OUTPUT, { recursive: true });
  const recorded = new Map<string, Recorded>();
  for (const scenario of chosen.scenarios) {
    const from = scenario.start === undefined ? undefined : recorded.get(scenario.start.from);
    recorded.set(scenario.name, await record(scenario, cliVersion, join(temporary, scenario.name), from));
  }
  for (const cliCommand of chosen.commands) recordCommand(cliCommand, cliVersion, join(temporary, cliCommand.name));
  console.log(
    `recorded ${chosen.scenarios.length} calls (${chosen.calls} model calls) and ${chosen.commands.length} ` +
      `commands of ${cliVersion} into ${OUTPUT}; repositories left in ${temporary}`,
  );
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
