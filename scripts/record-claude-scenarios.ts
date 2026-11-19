// The calls scripts/record-claude.ts records (#425): the scenarios the Claude Harness's tests replay (issue decision
// 1, owner Q3 A) and the probes of issue decision 2. Each runs the launch profile, changed only as its probe says. In
// a prompt, an argument or a variable, {base} is the scenario's directory, {outside} the same with forward slashes
// (outside the repository the call runs in), and {stub} the stand-in Messages API's URL.

export interface Scenario {
  name: string;
  purpose: string;
  prompt: string;
  access?: 'workspace-write' | 'read-only';
  // The platform whose shell and rules the profile is built for; the running one when absent.
  platform?: NodeJS.Platform;
  commands?: Record<string, string>;
  contextBudget?: number;
  effort?: string;
  noSchema?: boolean;
  extraArgv?: string[];
  env?: Record<string, string>;
  // The allow rules a probe removes from the profile's.
  dropAllow?: RegExp;
  // The scenario whose session this one resumes, in its repository.
  resumes?: string;
  untilInit?: boolean;
  stub?: boolean;
  bigFile?: boolean;
}

const RUN_EACH =
  'This is a permission test in a throwaway repository. Run each command below exactly as written, ' +
  'one tool call each, in order, and carry on after one is refused or fails; never change a command ' +
  'or try another way.';
const REPORT = 'Then answer with one line per command: its number and whether it ran or was refused.';
// A configuration directory of the scenario's own, so a call with a fake key never reads the user's login.
const OWN_CONFIG = { CLAUDE_CONFIG_DIR: '{base}/config', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };

export const SCENARIOS: Scenario[] = [
  {
    name: 'success',
    purpose:
      'a completed call with structured output and a tool that runs 20 seconds (does stream-json emit ' +
      'while it runs?); its init event is the discovery baseline',
    access: 'workspace-write',
    commands: { slow: 'node slow.js' },
    prompt:
      'Read README.md with the Read tool. Then run the command `node slow.js` once with your shell ' +
      'tool and wait for it to finish. Answer with the word README.md names and the line slow.js ' +
      'printed.',
  },
  {
    name: 'resume',
    purpose: 'the success session resumed: is the session id kept or forked, and what does the cumulative usage hold',
    resumes: 'success',
    access: 'workspace-write',
    commands: { slow: 'node slow.js' },
    prompt: 'Without any tool, answer with the word you read from README.md earlier in this conversation.',
  },
  {
    name: 'no-schema',
    purpose: 'a completed call without --json-schema: the result event with no structured output',
    noSchema: true,
    prompt: 'Without any tool, answer with the five words: the probe has no schema.',
  },
  {
    name: 'denial-powershell',
    purpose:
      'probe 2(b): the deny rules with prompts off under PowerShell, through &, iex, Start-Process ' +
      'and cmd /c, and whether blockWritesOutsideWorkingDirectories covers a shell write (G6); ' +
      'permission denials in the result',
    access: 'workspace-write',
    platform: 'win32',
    commands: { write: 'Set-Content' },
    prompt: `${RUN_EACH}
1. git push origin HEAD:refs/heads/plain
2. & git push origin HEAD:refs/heads/amp
3. iex "git push origin HEAD:refs/heads/iex"
4. Start-Process git -ArgumentList 'push','origin','HEAD:refs/heads/start' -Wait -NoNewWindow
5. cmd /c git push origin HEAD:refs/heads/cmd
6. Set-Content -Path '{outside}/outside-shell.txt' -Value outside
7. Use the Write tool to write the text outside to {outside}/outside-write.txt
${REPORT}`,
  },
  {
    name: 'denial-bash',
    purpose: 'probe 2(c): the same evasions under Bash for comparison, and a shell write outside the working directory',
    access: 'workspace-write',
    platform: 'linux',
    commands: { write: 'tee' },
    prompt: `${RUN_EACH}
1. git push origin HEAD:refs/heads/plain
2. bash -c "git push origin HEAD:refs/heads/bashc"
3. eval "git push origin HEAD:refs/heads/eval"
4. env git push origin HEAD:refs/heads/env
5. sh -c 'git push origin HEAD:refs/heads/shc'
6. echo outside | tee {outside}/outside-shell.txt
7. Use the Write tool to write the text outside to {outside}/outside-write.txt
${REPORT}`,
  },
  {
    name: 'read-only-powershell',
    purpose:
      "probe 2(a): a read-only call on PowerShell with gg's own read-only commands removed (is there " +
      'a built-in read-only set?), and --tools under --restricted and --permission-prompts none (G18)',
    platform: 'win32',
    dropAllow: /^PowerShell\((?:Get-ChildItem|Get-Content|Select-String)/,
    prompt: `${RUN_EACH}
1. Get-ChildItem
2. Get-Content README.md
3. Get-Location
4. Test-Path README.md
5. Select-String -Path README.md -Pattern word
6. git status
7. New-Item -ItemType File made.txt
${REPORT}`,
  },
  {
    name: 'init-error',
    purpose: 'a broken plugin directory and an MCP server that cannot start: what the init event says of each',
    extraArgv: [
      '--plugin-dir',
      '{base}/broken-plugin',
      '--mcp-config',
      '{"mcpServers":{"broken":{"command":"gg-no-such-command"}}}',
    ],
    prompt: 'Without any tool, answer with the word ok.',
  },
  {
    name: 'auth-failure',
    purpose: 'an invalid API key against the real API, in a configuration directory with no login',
    env: { ...OWN_CONFIG, ANTHROPIC_API_KEY: 'sk-ant-api03-recording-invalid-key' },
    prompt: 'Without any tool, answer with the word ok.',
  },
  {
    name: 'api-retry',
    purpose:
      'api_retry events then a failure: a stand-in Messages API answers 529 overloaded, then 429 ' +
      'rate_limit with retry-after 1, under three retries',
    stub: true,
    env: {
      ...OWN_CONFIG,
      ANTHROPIC_BASE_URL: '{stub}',
      ANTHROPIC_API_KEY: 'sk-ant-api03-recording-fake-key',
      CLAUDE_CODE_MAX_RETRIES: '3',
    },
    prompt: 'Without any tool, answer with the word ok.',
  },
  {
    name: 'safe-mode',
    purpose: "--safe-mode against the repository's .claude skills, commands and agents: the init event only",
    extraArgv: ['--safe-mode'],
    untilInit: true,
    prompt: 'Without any tool, answer with the word ok.',
  },
  {
    name: 'disable-slash-commands',
    purpose:
      "--disable-slash-commands against the repository's .claude skills, commands and agents: the init event only",
    extraArgv: ['--disable-slash-commands'],
    untilInit: true,
    prompt: 'Without any tool, answer with the word ok.',
  },
  {
    name: 'partial-messages',
    purpose: '--include-partial-messages at high effort: do lines arrive while the model thinks?',
    effort: 'high',
    extraArgv: ['--include-partial-messages'],
    prompt:
      'Without any tool, work out in how many ordered ways 12 can be written as a sum of 1s, 2s and ' +
      '3s, checking your arithmetic, and answer with the number.',
  },
  {
    name: 'compaction',
    purpose:
      'one automatic compaction: a contextBudget of 50,000 gives --autocompact 100000, and the call ' +
      'reads about 120,000 tokens, each read under the Read tool limit of 25,000 tokens',
    contextBudget: 50_000,
    bigFile: true,
    prompt:
      'Read big.txt from start to end with the Read tool, 700 lines at a time: offset 1, then 701, ' +
      '1401 and so on, until you have read line 4000. Read every chunk; do not skip ahead. Then ' +
      'answer with the text of line 4000.',
  },
];
