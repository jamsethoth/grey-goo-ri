// Records the Claude CLI for the Claude Harness's tests (#425). Each scenario and probe runs `claude -p` once, with the
// launch profile lib/harnesses/claude.ts builds, in a fresh temporary repository beside a local bare remote; its output
// lines, redacted, land in test/fixtures/claude/<name>.jsonl, and the command that made them, each line's arrival time
// and what the call left behind in <name>.json. Each command that is no model call (#427) runs once, and its argv, exit
// code and output, redacted, land in test/fixtures/claude/<name>.json. It calls the real CLI and spends tokens: run it
// to re-record a new Claude version, never from a test. The name `example` instead records the example's first-visit
// pass through gg (scripts/record-claude-example.ts, #486), alone.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as commandShim from '../lib/command-shim.ts';
import * as exec from '../lib/exec.ts';
import * as claude from '../lib/harnesses/claude.ts';
import * as recordClaudeExample from './record-claude-example.ts';
import { type CliCommand, COMMANDS, SCENARIOS, type Scenario } from './record-claude-scenarios.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT = join(root, 'test', 'fixtures', 'claude');
const USAGE = `usage: node scripts/record-claude.ts [name ...]
  no name: every scenario, in order (a resume scenario needs the one it resumes), then every command
  example, alone: the example's first-visit pass through gg, one call each Agent Action
  scenarios: ${SCENARIOS.map((scenario) => scenario.name).join(', ')}
  commands, none a model call: ${COMMANDS.map((command) => command.name).join(', ')}`;
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const PERSONA = 'You are a careful assistant in a throwaway test repository. Do exactly what the prompt asks.\n';
// A call that runs past this is killed, and its lines kept.
const CALL_LIMIT_MS = 900_000;
// The session's own variables, which a nested claude would read as its parent's.
const INHERITED = /^(?:CLAUDE|ANTHROPIC|CODEX)/;

interface Directories {
  base: string;
  repo: string;
  remote: string;
  run: string;
}

interface Output {
  lines: string[];
  timesMs: number[];
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  killed: string | null;
}

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

// A fixed pseudo-random text, about 120,000 tokens (30 a line), which a call reads to pass the compaction threshold.
function bigText() {
  const words = 'amber birch cedar delta ember fjord grove harbor island juniper kestrel lantern meadow nectar orchid'
    .split(' ')
    .concat('pebble quartz river saffron tundra umber valley willow xenon yarrow zephyr'.split(' '));
  const lines: string[] = [];
  for (let line = 1, seed = 7; line <= 4000; line += 1) {
    const picked: string[] = [];
    for (let word = 0; word < 10; word += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      picked.push(words[seed % words.length] ?? 'amber');
    }
    lines.push(`${line}: ${picked.join(' ')}`);
  }
  return `${lines.join('\n')}\n`;
}

// The repository a scenario runs in: a README, a slow command, repository `.claude` content for the discovery probes,
// a broken plugin, and an empty bare remote that shows whether any push landed.
function setUp(base: string, scenario: Scenario): Directories {
  const directories = { base, repo: join(base, 'repo'), remote: join(base, 'remote.git'), run: join(base, 'run') };
  const files: Record<string, string> = {
    'README.md': '# Probe\n\nThe word is heliotrope.\n',
    'slow.js': "setTimeout(() => console.log('slow done'), 20000);\n",
    '.claude/skills/probe-skill/SKILL.md':
      '---\nname: probe-skill\ndescription: A repository skill.\n---\nSay probe.\n',
    '.claude/commands/probe-command.md': '---\ndescription: A repository command.\n---\nSay probe.\n',
    '.claude/agents/probe-agent.md': '---\nname: probe-agent\ndescription: A repository agent.\n---\nSay probe.\n',
    ...(scenario.bigFile && { 'big.txt': bigText() }),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directories.repo, path)), { recursive: true });
    writeFileSync(join(directories.repo, path), text);
  }
  mkdirSync(join(base, 'broken-plugin', '.claude-plugin'), { recursive: true });
  writeFileSync(join(base, 'broken-plugin', '.claude-plugin', 'plugin.json'), '{ "name": broken');
  mkdirSync(directories.run);
  mkdirSync(join(base, 'config'));
  git(base, ['init', '-q', '--bare', 'remote.git']);
  git(directories.repo, ['init', '-q', '-b', 'main']);
  git(directories.repo, ['config', 'user.name', 'Recorder']);
  git(directories.repo, ['config', 'user.email', 'recorder@example.invalid']);
  git(directories.repo, ['add', '.']);
  git(directories.repo, ['commit', '-q', '-m', 'probe']);
  git(directories.repo, ['remote', 'add', 'origin', directories.remote]);
  return directories;
}

const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);

// The launch profile's argv, environment and files for the scenario, with its probe's changes.
function launchOf(scenario: Scenario, directories: Directories, values: Record<string, string>, resume: string | null) {
  const access = scenario.access ?? 'read-only';
  const agent = {
    harness: 'claude',
    persona: 'recorder',
    model: 'haiku',
    effort: scenario.effort ?? 'low',
    access,
    ...(scenario.contextBudget !== undefined && { contextBudget: scenario.contextBudget }),
  };
  const tools = claude.resolveTools(agent, {
    platform: scenario.platform ?? process.platform,
    commands: scenario.commands ?? {},
  });
  const { dropAllow } = scenario;
  if (dropAllow) tools.allow = tools.allow.filter((rule) => !dropAllow.test(rule));
  const persona = { name: 'recorder', bytes: PERSONA, hash: createHash('sha256').update(PERSONA).digest('hex') };
  const call = { agent, persona, schema: SCHEMA, resume, runDirectory: directories.run, access };
  const launch = claude.launchArgs(call, tools);
  const schemaAt = launch.argv.indexOf('--json-schema');
  if (scenario.noSchema) launch.argv.splice(schemaAt, 2);
  launch.argv.push(...(scenario.extraArgv ?? []).map((arg) => fill(arg, values)));
  const env = Object.fromEntries(Object.entries(scenario.env ?? {}).map(([key, value]) => [key, fill(value, values)]));
  return { ...launch, env: { ...launch.env, ...env } };
}

// One call: the prompt on stdin, each stdout line with its arrival time, killed after the init event when the
// scenario asks, or at the call limit.
function spawnCall(launch: claude.Launch, cwd: string, prompt: string, untilInit: boolean): Promise<Output> {
  const inherited = Object.entries(process.env).filter(([key]) => !INHERITED.test(key));
  const env = { ...Object.fromEntries(inherited), ...launch.env };
  const { command, args } = commandShim.argvOf('claude', launch.argv);
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const started = Date.now();
  const output: Output = { lines: [], timesMs: [], stderr: '', exitCode: null, signal: null, killed: null };
  const kill = (why: string) => {
    output.killed ??= why;
    child.kill();
  };
  const limit = setTimeout(() => kill('call limit'), CALL_LIMIT_MS);
  createInterface({ input: child.stdout }).on('line', (line) => {
    output.lines.push(line);
    output.timesMs.push(Date.now() - started);
    if (untilInit && line.includes('"subtype":"init"')) kill('after init');
  });
  child.stderr.on('data', (chunk: Buffer) => (output.stderr += chunk.toString()));
  child.stdin.end(prompt);
  return new Promise((resolve) => {
    child.on('error', (err) => (output.stderr += `spawn error: ${err.message}\n`));
    child.on('close', (code, signal) => {
      clearTimeout(limit);
      resolve({ ...output, exitCode: code, signal });
    });
  });
}

// The session id the call's result or init event names.
function sessionOf(lines: string[]): string | null {
  for (const line of lines.toReversed()) {
    try {
      const event: unknown = JSON.parse(line);
      if (typeof event === 'object' && event !== null && 'session_id' in event && typeof event.session_id === 'string')
        return event.session_id;
    } catch {
      // A line that is not JSON is kept as it came, and names no session.
    }
  }
  return null;
}

// Where the CLI wrote the session's transcript, found by its file name under the projects directory.
function transcriptOf(sessionId: string | null, configDirectory: string) {
  const projects = join(configDirectory, 'projects');
  if (sessionId === null || !existsSync(projects)) return null;
  for (const project of readdirSync(projects)) {
    const path = join(projects, project, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

// What the call left behind: the refs any push made, and the files written outside the repository or inside it.
function evidenceOf(directories: Directories) {
  return {
    remoteRefs: git(directories.remote, ['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean),
    outsideShellWritten: existsSync(join(directories.base, 'outside-shell.txt')),
    outsideWriteToolWritten: existsSync(join(directories.base, 'outside-write.txt')),
    madeInRepository: existsSync(join(directories.repo, 'made.txt')),
  };
}

// The local paths, the user's name, email addresses and keys, replaced wherever they appear. A path's segments match
// across any run of slashes or backslashes, since a tool result's JSON nested in a stream line escapes it twice, and
// its drive as written or as Git Bash writes it; its dash form is how Claude names a project directory.
function redactorOf(base: string) {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forms = (path: string) => {
    const [drive = '', ...segments] = path.split(/[\\/]+/);
    const head = `(?:${escape(drive)}|/${escape(drive.charAt(0).toLowerCase())})`;
    return [[head, ...segments.map(escape)].join('[\\\\/]+'), escape(path.replace(/[^A-Za-z0-9]/g, '-'))];
  };
  const paths: [string, string][] = [
    [base, '<recording>'],
    [homedir(), '<home>'],
    [process.env.ProgramFiles ?? 'C:\\Program Files', '<program-files>'],
  ];
  const pairs: [RegExp, string][] = [
    ...paths.flatMap(([path, label]) => forms(path).map((form): [RegExp, string] => [new RegExp(form, 'gi'), label])),
    [new RegExp(escape(userInfo().username), 'gi'), '<user>'],
    [/sk-ant-[\w-]+/g, 'sk-ant-<redacted>'],
    [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  ];
  return (text: string) =>
    pairs.reduce((redacted, [pattern, replacement]) => redacted.replace(pattern, replacement), text);
}

// A stand-in for the Messages API that answers overloaded once, then rate-limited with a one-second retry-after, so
// the CLI's own retries and their api_retry events are recorded (no real rate limit can be asked for).
async function startStub(requests: string[]) {
  const answers = { messages: 0 };
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      if (!path.includes('/messages')) {
        requests.push(`${request.method} ${path} 404`);
        response.writeHead(404).end();
        return;
      }
      answers.messages += 1;
      const [status, type] = answers.messages === 1 ? [529, 'overloaded_error'] : [429, 'rate_limit_error'];
      requests.push(`${request.method} ${path} ${status}`);
      const headers = { 'content-type': 'application/json', 'retry-after': '1', 'request-id': 'req_recording' };
      response.writeHead(status, headers).end(JSON.stringify({ type: 'error', error: { type, message: type } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

interface Recorded {
  directories: Directories;
  sessionId: string | null;
}

// The launch's files and the scenario's own under its directory, written, by path.
function writeFiles(
  scenario: Scenario,
  base: string,
  values: Record<string, string>,
  launchFiles: Record<string, string>,
) {
  const files: Record<string, string> = { ...launchFiles };
  for (const [path, text] of Object.entries(scenario.files ?? {})) files[join(base, path)] = fill(text, values);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return files;
}

async function record(scenario: Scenario, cliVersion: string, base: string, resumed: Recorded | undefined) {
  const directories = resumed?.directories ?? setUp(base, scenario);
  const requests: string[] = [];
  const stub = scenario.stub ? await startStub(requests) : undefined;
  const values = { base: directories.base, outside: directories.base.replaceAll('\\', '/'), stub: stub?.url ?? '' };
  const launch = launchOf(scenario, directories, values, resumed?.sessionId ?? null);
  const files = writeFiles(scenario, directories.base, values, launch.files);
  const prompt = fill(scenario.prompt, values);
  const output = await spawnCall(launch, directories.repo, prompt, scenario.untilInit ?? false);
  stub?.close();
  const sessionId = sessionOf(output.lines);
  const configDirectory = launch.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const meta = {
    cliVersion,
    scenario: scenario.name,
    purpose: scenario.purpose,
    command: { executable: 'claude', argv: launch.argv, env: launch.env, stdin: prompt, files },
    resumes: scenario.resumes ?? null,
    exitCode: output.exitCode,
    signal: output.signal,
    killed: output.killed,
    lineTimesMs: output.timesMs,
    stderr: output.stderr,
    evidence: { ...evidenceOf(directories), transcriptPath: transcriptOf(sessionId, configDirectory) },
    stubRequests: stub ? requests : null,
  };
  save(scenario.name, redactorOf(directories.base), output.lines, meta);
  console.log(`${scenario.name}: exit ${output.exitCode}, ${output.lines.length} lines, killed ${output.killed}`);
  return { directories, sessionId };
}

function save(name: string, redact: (text: string) => string, lines: string[], meta: object) {
  const text = lines.map(redact).join('\n');
  writeFileSync(join(OUTPUT, `${name}.jsonl`), text && `${text}\n`);
  writeFileSync(join(OUTPUT, `${name}.json`), `${redact(JSON.stringify(meta, null, 2))}\n`);
}

// The keys of auth status --json kept as the CLI printed them: every other string in its output names the account.
const ACCOUNT_KEPT = new Set(['authMethod', 'apiProvider']);
function redactAccount(stdout: string) {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const kept = (key: string, value: unknown) =>
      typeof value === 'string' && !ACCOUNT_KEPT.has(key) ? '<redacted>' : value;
    return `${JSON.stringify(parsed, kept, 2)}\n`;
  } catch {
    return stdout; // not JSON: the version and the help text
  }
}

// One command that is no model call, in a directory of its own, whose config directory is empty.
function recordCommand(command: CliCommand, cliVersion: string, base: string) {
  mkdirSync(join(base, 'config'), { recursive: true });
  const env = Object.fromEntries(Object.entries(command.env ?? {}).map(([key, value]) => [key, fill(value, { base })]));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !INHERITED.test(key)));
  const argv = commandShim.argvOf('claude', command.argv);
  const ran = spawnSync(argv.command, argv.args, { env: { ...inherited, ...env }, encoding: 'utf8', timeout: 60_000 });
  const meta = {
    cliVersion,
    command: command.name,
    purpose: command.purpose,
    argv: command.argv,
    env,
    exitCode: ran.status,
    stdout: redactAccount(ran.stdout),
    stderr: ran.stderr,
  };
  writeFileSync(join(OUTPUT, `${command.name}.json`), `${redactorOf(base)(JSON.stringify(meta, null, 2))}\n`);
  console.log(`${command.name}: exit ${ran.status}`);
}

// The example's first-visit pass through gg, its calls on the real CLI in gg's own launch, which passes on the
// environment, so the session's own variables go first.
async function recordExample(cliVersion: string) {
  for (const key of Object.keys(process.env)) if (INHERITED.test(key)) Reflect.deleteProperty(process.env, key);
  mkdirSync(OUTPUT, { recursive: true });
  const { launch } = exec.createExec();
  const passed = await recordClaudeExample.recordExample({ cliVersion, launch, save, redactorOf });
  console.log(
    passed ? `recorded the example's first-visit pass into ${OUTPUT}` : 'the example left its first-visit pass',
  );
  return passed ? 0 : 1;
}

async function main(names: string[]) {
  if (names.includes('example')) {
    if (names.length > 1) {
      console.error(`example records alone\n${USAGE}`);
      return 2;
    }
    const { command, args } = commandShim.argvOf('claude', ['--version']);
    return recordExample(execFileSync(command, args, { encoding: 'utf8' }).trim());
  }
  const named = [...SCENARIOS, ...COMMANDS].map((recorded) => recorded.name);
  const unknown = names.filter((name) => !named.includes(name));
  if (unknown.length || names.includes('--help')) {
    console.error(unknown.length ? `unknown name: ${unknown.join(', ')}\n${USAGE}` : USAGE);
    return 2;
  }
  const chosen = SCENARIOS.filter((scenario) => !names.length || names.includes(scenario.name));
  const missing = chosen.filter(
    (scenario) => scenario.resumes && !chosen.some((other) => other.name === scenario.resumes),
  );
  if (missing.length) {
    console.error(`${missing.map((scenario) => `${scenario.name} resumes ${scenario.resumes}`).join('; ')}\n${USAGE}`);
    return 2;
  }
  const { command, args } = commandShim.argvOf('claude', ['--version']);
  const cliVersion = execFileSync(command, args, { encoding: 'utf8' }).trim();
  const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), 'gg-claude-')));
  mkdirSync(OUTPUT, { recursive: true });
  const recorded = new Map<string, Recorded>();
  for (const scenario of chosen) {
    const resumed = scenario.resumes === undefined ? undefined : recorded.get(scenario.resumes);
    recorded.set(scenario.name, await record(scenario, cliVersion, join(temporary, scenario.name), resumed));
  }
  const commands = COMMANDS.filter((cliCommand) => !names.length || names.includes(cliCommand.name));
  for (const cliCommand of commands) recordCommand(cliCommand, cliVersion, join(temporary, cliCommand.name));
  console.log(
    `recorded ${chosen.length} calls and ${commands.length} commands of ${cliVersion} into ${OUTPUT}; ` +
      `repositories left in ${temporary}`,
  );
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
