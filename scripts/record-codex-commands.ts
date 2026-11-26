// The commands scripts/record-codex.ts records that are no model call (#479), so no budget counts them: the version,
// login, MXC sandbox command, doctor report, listings and help the Codex Harness reads, and debug prompt-input for
// issue decisions 2, 3 and 7. In an argument, {base} is the command's directory.
import * as codex from '../lib/harnesses/codex.ts';

// A command that is no model call: its argv after the executable, the CODEX_HOME it runs under, the repository it
// runs in, and whether gg's empty-start keys go before its own argv.
export interface CliCommand {
  name: string;
  purpose: string;
  argv: string[];
  home?: 'gg' | 'empty' | 'plugin' | 'plugin-enabled';
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
  {
    name: 'cli-sandbox-mxc',
    purpose:
      "#484: doctor's sandbox command, a PowerShell command under MXC in gg's CODEX_HOME that prints its marker line",
    argv: codex.SANDBOX_ARGS,
  },
  { name: 'cli-doctor', purpose: "codex's own doctor report, in gg's CODEX_HOME", argv: ['doctor', '--json'] },
  {
    name: 'cli-mcp-list',
    purpose: "the MCP servers gg's CODEX_HOME configures",
    argv: ['mcp', 'list', '--json', '-c', 'features.plugins=false'],
  },
  // Without --json the listing names the whole remote catalog; --json names the installed plugins.
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
  {
    name: 'prompt-input-plugin-enabled-default',
    purpose: 'decision 7: the same plugin, installed and left enabled in CODEX_HOME, with no -c (the control)',
    argv: [...PROMPT_INPUT, 'hi'],
    home: 'plugin-enabled',
  },
  {
    name: 'prompt-input-plugin-excluded',
    purpose: 'decision 7: the same plugin, enabled in CODEX_HOME, disabled by -c as a table: does the -c exclude it?',
    argv: [...PROMPT_INPUT, '-c', `plugins={${PLUGIN}={enabled=false}}`, 'hi'],
    home: 'plugin-enabled',
  },
];
