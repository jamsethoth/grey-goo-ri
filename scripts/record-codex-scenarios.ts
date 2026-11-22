// The calls scripts/record-codex.ts records (#479): issue decisions 2 to 5 and 7, merged where one call answers two
// items, each on the cheapest model at low effort, with approval_policy never and its answer read from -o. In a
// prompt, a -c value or a variable, {base} is the scenario's directory, {repo} its repository and {stub} the stand-in
// Responses API's URL.

export interface Scenario {
  name: string;
  purpose: string;
  prompt: string;
  // How the call starts when it does not start a new thread: the thread `from` started, resumed with --sandbox and -C
  // on exec before resume (request 3.2), resumed with -c sandbox_mode after resume, or forked.
  start?: { kind: 'resume-flags-before' | 'resume-config-after' | 'fork'; from: string };
  sandbox?: 'read-only' | 'workspace-write';
  windowsSandbox?: 'mxc' | 'unelevated';
  // Where codex is started: the repository, or the scenario's directory above it.
  cwd?: 'repo' | 'base';
  // The repository's files: the probe scripts alone, or with every sentinel of decision 3.
  repository?: 'plain' | 'sentinels';
  // Leaves out gg's two empty-start keys (project_doc_max_bytes, skills.include_instructions), so repository content
  // can load.
  repositoryContent?: boolean;
  trusted?: boolean;
  hooks?: { enabled: boolean; bypassTrust: boolean };
  mcp?: boolean;
  config?: string[];
  extraArgv?: string[];
  // gg's CODEX_HOME, or an empty one of the scenario's own that holds no login.
  home?: 'gg' | 'empty';
  env?: Record<string, string>;
  stub?: boolean;
  // A marker in a command's argv: when its command_execution starts, the job and every process naming the marker are
  // listed; killOn then terminates the job.
  watch?: string;
  killOn?: string;
  // False for a call that reaches no real model: it counts against no budget.
  modelCall?: boolean;
}

const RUN_EACH =
  'This is a probe in a throwaway repository. Run each command below exactly as written, one shell call each, in ' +
  'order, and carry on after one is refused or fails; never change a command or try another way.';
const REPORT = 'Then answer with one line per command: its number, whether it ran or was refused, and what it printed.';
const MXC_READ_ONLY = `${RUN_EACH}
1. node --version
2. Get-Content README.md
3. node write.js blocked.txt
4. Set-Content -Path made-by-shell.txt -Value made
${REPORT}`;
const MXC_WORKSPACE_WRITE = `${RUN_EACH}
1. node write.js made.txt
2. node rename-temp.js
3. node link.js
4. node child.js
5. node --test probe.test.js
6. node slow.js gg-job-marker
${REPORT}`;
const HOOK_PROMPT =
  'Run the command `node --version` once with your shell tool. Then answer with every word that begins with ' +
  'SENTINEL- that you can see anywhere in your instructions, context or tool results, or "none".';

export const SCENARIOS: Scenario[] = [
  {
    name: 'start',
    purpose:
      'a new thread, read-only, with --json, --output-schema and -o (F2): the stream, the rollout and where it lands',
    prompt: `${RUN_EACH}
1. Get-Content README.md
Then answer with the word it names.`,
  },
  {
    name: 'resume-flags-before',
    purpose:
      'the start thread resumed with --sandbox workspace-write and -C on exec before resume, as the request places ' +
      'them: does the resumed turn run under them (the rollout turn_context, and whether the write lands)?',
    start: { kind: 'resume-flags-before', from: 'start' },
    sandbox: 'workspace-write',
    prompt: `${RUN_EACH}
1. node write.js resume-flags.txt
Then answer with whether it ran, what it printed, and the word you read from README.md earlier.`,
  },
  {
    name: 'resume-config-after',
    purpose:
      'the thread, last run workspace-write, resumed with -c sandbox_mode="read-only" after resume, started from ' +
      'the directory above the repository with no -C: does the -c take effect, and which cwd does the turn run in?',
    start: { kind: 'resume-config-after', from: 'start' },
    cwd: 'base',
    config: ['sandbox_mode="read-only"'],
    // Outside a git repository, resume refuses to start without it.
    extraArgv: ['--skip-git-repo-check'],
    prompt: `${RUN_EACH}
1. Set-Content -Path resume-config.txt -Value made
2. Get-Location
${REPORT}`,
  },
  {
    name: 'fork',
    purpose:
      'the start thread forked with --sandbox read-only on exec before fork: what --json emits, whether usage is ' +
      "cumulative, whether the fork runs read-only, and whether the original thread's rollout is unchanged",
    start: { kind: 'fork', from: 'start' },
    prompt: 'Without any tool, answer with the word you read from README.md earlier in this conversation.',
  },
  {
    name: 'mxc-read-only',
    purpose: 'a read-only task under MXC, and writes the sandbox blocks under approval_policy never (F1)',
    prompt: MXC_READ_ONLY,
  },
  {
    name: 'mxc-workspace-write',
    purpose:
      'a workspace-write task under MXC (Q9: a rename in temp, links, a node child, node --test), and the job ' +
      "listed while a command runs (F7): does every process MXC starts stay inside gg's job?",
    sandbox: 'workspace-write',
    watch: 'gg-job-marker',
    prompt: MXC_WORKSPACE_WRITE,
  },
  {
    name: 'unelevated-read-only',
    purpose: 'the read-only task under windows.sandbox="unelevated" (the MXC fallback of request 3.2)',
    windowsSandbox: 'unelevated',
    prompt: MXC_READ_ONLY,
  },
  {
    name: 'unelevated-workspace-write',
    purpose: 'the workspace-write task under windows.sandbox="unelevated", with the job listed while a command runs',
    windowsSandbox: 'unelevated',
    sandbox: 'workspace-write',
    watch: 'gg-job-marker',
    prompt: MXC_WORKSPACE_WRITE,
  },
  {
    name: 'hooks-on',
    purpose:
      'SessionStart and PostToolUse hooks, given inline by -c and in CODEX_HOME/hooks.json, with features.hooks ' +
      'true and --dangerously-bypass-hook-trust (Q10): does each fire under exec, and does its text reach the model?',
    hooks: { enabled: true, bypassTrust: true },
    prompt: HOOK_PROMPT,
  },
  {
    name: 'hooks-off',
    purpose: 'the same hooks with features.hooks false and the trust bypass: does any fire?',
    hooks: { enabled: false, bypassTrust: true },
    prompt: HOOK_PROMPT,
  },
  {
    name: 'hooks-untrusted',
    purpose: 'the same hooks with features.hooks true and no trust bypass: does hook trust hold them back under exec?',
    hooks: { enabled: true, bypassTrust: false },
    prompt: HOOK_PROMPT,
  },
  {
    name: 'mcp-schema',
    purpose:
      'one config MCP server with --output-schema active: the mcp_tool_call items, whether the schema still holds ' +
      '(the request 3.2 regression fixture), and whether a message before the tool call is forced into it (#19816)',
    mcp: true,
    prompt:
      'First say in one sentence what you are about to do. Then call the probe_word tool of the probe MCP server ' +
      'once, and answer with the word it returns.',
  },
  {
    name: 'tree-kill',
    purpose:
      'a call whose job is terminated mid-turn while a command runs: the events, the exit code, what is left running',
    sandbox: 'workspace-write',
    killOn: 'gg-kill-marker',
    prompt: `${RUN_EACH}
1. node slow.js gg-kill-marker
${REPORT}`,
  },
  {
    name: 'tree-kill-resume',
    purpose: 'the killed thread resumed: is the rollout a killed call leaves resumable, and what does it hold?',
    start: { kind: 'resume-flags-before', from: 'tree-kill' },
    prompt:
      'Without any tool, answer with the command you were running when this conversation was interrupted, or ' +
      '"none".',
  },
  {
    name: 'compaction',
    purpose:
      'a low model_auto_compact_token_limit and three large outputs: does a compaction mid-exec emit anything in ' +
      '--json, and what does the rollout hold?',
    config: ['model_auto_compact_token_limit=16000'],
    prompt: `${RUN_EACH}
1. node print.js 1
2. node print.js 2
3. node print.js 3
Then answer with the last line command 3 printed.`,
  },
  {
    name: 'repository-untrusted',
    purpose:
      "every repository sentinel of decision 3 with the project untrusted and gg's empty-start keys left out: which " +
      "instruction files, skills, .codex config, hooks and rules load (a rule's allow runs outside the sandbox)",
    repository: 'sentinels',
    repositoryContent: true,
    hooks: { enabled: true, bypassTrust: true },
    prompt:
      `${RUN_EACH}
1. node outside.js
Then answer with whether it ran and what it printed, and every word that begins with SENTINEL- that you can see ` +
      'anywhere in your instructions, context or tool results.',
  },
  {
    name: 'repository-trusted',
    purpose: 'the same with the project trusted, to show what trust would load; gg never trusts a project (Q18 A)',
    repository: 'sentinels',
    repositoryContent: true,
    trusted: true,
    hooks: { enabled: true, bypassTrust: true },
    prompt:
      `${RUN_EACH}
1. node outside.js
Then answer with whether it ran and what it printed, and every word that begins with SENTINEL- that you can see ` +
      'anywhere in your instructions, context or tool results.',
  },
  {
    name: 'auth-invalid',
    purpose: 'an invalid CODEX_API_KEY against the real API, in an empty CODEX_HOME: the auth failure',
    home: 'empty',
    env: { CODEX_API_KEY: 'sk-proj-recording-invalid-key' },
    prompt: 'Without any tool, answer with the word ok.',
  },
  {
    name: 'auth-missing',
    purpose: 'an empty CODEX_HOME with no login and no key: the failure before any request',
    home: 'empty',
    modelCall: false,
    prompt: 'Without any tool, answer with the word ok.',
  },
  {
    name: 'usage-limit',
    purpose:
      'a stand-in Responses API that answers 429 usage_limit_reached, in an empty CODEX_HOME: the usage-limit ' +
      'failure (no real usage limit can be asked for)',
    home: 'empty',
    stub: true,
    modelCall: false,
    config: [
      'model_provider="stub"',
      'model_providers.stub={name="stub",base_url="{stub}/v1",wire_api="responses",env_key="GG_STUB_KEY",' +
        'request_max_retries=1,stream_max_retries=0}',
    ],
    env: { GG_STUB_KEY: 'stub-key' },
    prompt: 'Without any tool, answer with the word ok.',
  },
];

// A command that is no model call: its argv after the executable, the CODEX_HOME it runs under, the repository it
// runs in, and whether gg's empty-start keys go before its own argv.
export interface CliCommand {
  name: string;
  purpose: string;
  argv: string[];
  home?: 'gg' | 'empty' | 'plugin';
  repository?: 'plain' | 'sentinels' | `only:${string}`;
  profile?: boolean;
  trusted?: boolean;
}

const PROMPT_INPUT = ['debug', 'prompt-input'];
const PLUGIN = '"probe-plugin@gg-probe"';

export const COMMANDS: CliCommand[] = [
  { name: 'cli-version', purpose: 'the version doctor holds to the pinned minimum', argv: ['--version'] },
  { name: 'cli-login-status', purpose: "the login doctor reads, in gg's CODEX_HOME", argv: ['login', 'status'] },
  {
    name: 'cli-login-status-logged-out',
    purpose: 'the login doctor reads, in an empty CODEX_HOME',
    argv: ['login', 'status'],
    home: 'empty',
  },
  { name: 'cli-doctor', purpose: "codex's own doctor report, in gg's CODEX_HOME", argv: ['doctor', '--json'] },
  { name: 'cli-mcp-list', purpose: "the MCP servers gg's CODEX_HOME configures", argv: ['mcp', 'list', '--json'] },
  // Without --json the listing names every plugin of the remote catalog (over 1 MB); --json without --available
  // names the installed ones.
  { name: 'cli-plugin-list', purpose: "the plugins installed in gg's CODEX_HOME", argv: ['plugin', 'list', '--json'] },
  {
    name: 'cli-plugin-list-installed',
    purpose: 'the plugins installed in a CODEX_HOME holding the probe plugin, disabled in its config',
    argv: ['plugin', 'list', '--json'],
    home: 'plugin',
  },
  { name: 'cli-features', purpose: 'the feature flags and their stages', argv: ['features', 'list'] },
  { name: 'cli-exec-help', purpose: "exec's flags", argv: ['exec', '--help'] },
  { name: 'cli-exec-resume-help', purpose: "exec resume's flags", argv: ['exec', 'resume', '--help'] },
  { name: 'cli-exec-fork-help', purpose: "exec fork's flags", argv: ['exec', 'fork', '--help'] },
  {
    name: 'prompt-input-default',
    purpose: "decision 2: what reaches the model from gg's CODEX_HOME with no override (the empty start)",
    argv: [...PROMPT_INPUT, 'hi'],
  },
  {
    name: 'prompt-input-profile',
    purpose: "decision 2: what reaches the model under gg's empty-start keys",
    argv: [...PROMPT_INPUT, 'hi'],
    profile: true,
  },
  {
    name: 'prompt-input-sentinels-untrusted',
    purpose: 'decision 3: every repository sentinel, the project untrusted, no empty-start key',
    argv: [...PROMPT_INPUT, 'hi'],
    repository: 'sentinels',
  },
  {
    name: 'prompt-input-sentinels-trusted',
    purpose: 'decision 3: every repository sentinel, the project trusted, no empty-start key',
    argv: [...PROMPT_INPUT, 'hi'],
    repository: 'sentinels',
    trusted: true,
  },
  {
    name: 'prompt-input-sentinels-profile',
    purpose: "decision 3: every repository sentinel under gg's empty-start keys",
    argv: [...PROMPT_INPUT, 'hi'],
    repository: 'sentinels',
    profile: true,
  },
  ...['AGENTS.override.md', 'AGENTS.md', 'TEAM_GUIDE.md', '.agents.md'].flatMap((file): CliCommand[] => [
    {
      name: `prompt-input-only-${file.replace(/^\./, 'dot-').replaceAll('.', '-').toLowerCase()}`,
      purpose: `decision 3: ${file} alone in the repository, with no empty-start key: does it load?`,
      argv: [...PROMPT_INPUT, 'hi'],
      repository: `only:${file}`,
    },
    {
      name: `prompt-input-only-${file.replace(/^\./, 'dot-').replaceAll('.', '-').toLowerCase()}-max-bytes-0`,
      purpose: `decision 3: ${file} alone, under project_doc_max_bytes=0`,
      argv: [...PROMPT_INPUT, '-c', 'project_doc_max_bytes=0', 'hi'],
      repository: `only:${file}`,
    },
  ]),
  {
    name: 'prompt-input-skills-config-add',
    purpose: 'decision 7: can skills.config add a skill outside the skill roots (skills exact)?',
    argv: [...PROMPT_INPUT, '-c', 'skills.config=[{path="{base}/gg-skill/SKILL.md",enabled=true}]', 'hi'],
  },
  {
    name: 'prompt-input-plugin-listed',
    purpose:
      'decision 7: a plugin installed in CODEX_HOME and disabled there, enabled by -c as a table (plugins exact)',
    argv: [...PROMPT_INPUT, '-c', `plugins={${PLUGIN}={enabled=true}}`, 'hi'],
    home: 'plugin',
  },
  {
    name: 'prompt-input-plugin-unlisted',
    purpose: 'decision 7: the same plugin, left disabled by -c as a table',
    argv: [...PROMPT_INPUT, '-c', `plugins={${PLUGIN}={enabled=false}}`, 'hi'],
    home: 'plugin',
  },
  {
    name: 'prompt-input-plugin-dotted',
    purpose: 'decision 7: the same plugin enabled by -c with a dotted quoted key: is the key read?',
    argv: [...PROMPT_INPUT, '-c', `plugins.${PLUGIN}.enabled=true`, 'hi'],
    home: 'plugin',
  },
  {
    name: 'prompt-input-plugin-disabled-feature',
    purpose: 'decision 7: the same plugin enabled by -c as a table, under --disable plugins',
    argv: [...PROMPT_INPUT, '-c', `plugins={${PLUGIN}={enabled=true}}`, '--disable', 'plugins', 'hi'],
    home: 'plugin',
  },
];
