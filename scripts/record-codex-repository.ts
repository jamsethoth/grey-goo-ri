// The temporary repository and the helper files a scripts/record-codex.ts call runs over (#479): the probe scripts a
// prompt names, the repository sentinels of issue decision 3, and, beside the repository, the hook, the MCP server
// and the skill the calls point at, so nothing a call writes or reads is the owner's.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Directories {
  base: string;
  repo: string;
  run: string;
}

// The four instruction-file names of decision 3, each with its own sentinel word.
export const INSTRUCTION_FILES = ['AGENTS.override.md', 'AGENTS.md', 'TEAM_GUIDE.md', '.agents.md'];
const sentinelOf = (file: string) =>
  `SENTINEL-${file.startsWith('.') ? 'DOT' : ''}${file.replace(/[^A-Za-z]/g, '').toUpperCase()}`;

const SCRIPTS: Record<string, string> = {
  'README.md': '# Probe\n\nThe word is heliotrope.\n',
  'write.js': `const fs = require('node:fs');
try {
  fs.writeFileSync(process.argv[2], 'made\\n');
  console.log('wrote ' + process.argv[2]);
} catch (err) {
  console.log('write failed: ' + err.code);
}
`,
  'rename-temp.js': `const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const from = path.join(os.tmpdir(), 'gg-rename-' + process.pid + '-a.txt');
try {
  fs.writeFileSync(from, 'x');
  fs.renameSync(from, from.replace('-a.txt', '-b.txt'));
  console.log('renamed in temp');
} catch (err) {
  console.log('rename in temp failed: ' + err.code);
}
`,
  'link.js': `const fs = require('node:fs');
const attempt = (what, act) => {
  try {
    act();
    console.log(what + ' made');
  } catch (err) {
    console.log(what + ' failed: ' + err.code);
  }
};
attempt('hard link', () => fs.linkSync('README.md', 'hard-link.md'));
attempt('junction', () => fs.symlinkSync(process.cwd(), 'junction-dir', 'junction'));
attempt('file symlink', () => fs.symlinkSync('README.md', 'file-link.md', 'file'));
`,
  'child.js': `const { execFileSync } = require('node:child_process');
try {
  console.log(execFileSync(process.execPath, ['-e', 'console.log("child ran")'], { encoding: 'utf8' }).trim());
} catch (err) {
  console.log('child failed: ' + err.code);
}
`,
  'probe.test.js': `const test = require('node:test');
test('probe', () => {});
`,
  'slow.js': `setTimeout(() => console.log('slow done ' + process.argv[2]), 20000);
`,
  // About 7,500 tokens a run, so three runs pass a 30,000-token auto-compact limit.
  'print.js': `const words = 'amber birch cedar delta ember fjord grove harbor island juniper kestrel lantern'.split(' ');
let seed = Number(process.argv[2]) * 7919;
for (let line = 1; line <= 400; line += 1) {
  const picked = [];
  for (let word = 0; word < 12; word += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    picked.push(words[seed % words.length]);
  }
  console.log(line + ': ' + picked.join(' '));
}
console.log('last line of print ' + process.argv[2]);
`,
  'outside.js': `const fs = require('node:fs');
try {
  fs.writeFileSync('../outside.txt', 'outside\\n');
  console.log('wrote outside the repository');
} catch (err) {
  console.log('outside write failed: ' + err.code);
}
`,
};

// A hook that logs its event and payload keys, and answers with a sentinel that names its source and event.
const HOOK = `const fs = require('node:fs');
const path = require('node:path');
const [tag, event] = process.argv.slice(2);
let input = '';
process.stdin.on('data', (data) => (input += data)).on('end', () => {
  let keys = [];
  try { keys = Object.keys(JSON.parse(input)); } catch {}
  fs.appendFileSync(path.join(__dirname, 'hook-log.txt'), tag + ' ' + event + ' ' + keys.join(',') + '\\n');
  const additionalContext = 'SENTINEL-HOOK-' + tag.toUpperCase() + '-' + event.toUpperCase();
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
});
`;

// A stdio MCP server with one tool, probe_word, that logs each request's method.
const MCP_SERVER = `const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const tool = { name: 'probe_word', description: 'Returns the probe word.', inputSchema: { type: 'object', properties: {} } };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(path.join(__dirname, 'mcp-log.txt'), request.method + '\\n');
  if (request.id === undefined) return;
  if (request.method === 'initialize')
    return send({ id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'probe', version: '1.0.0' } } });
  if (request.method === 'tools/list') return send({ id: request.id, result: { tools: [tool] } });
  if (request.method === 'tools/call')
    return send({ id: request.id, result: { content: [{ type: 'text', text: 'marigold' }] } });
  send({ id: request.id, error: { code: -32601, message: 'no such method' } });
});
`;

const SKILL = (name: string, sentinel: string) =>
  `---\nname: ${name}\ndescription: ${sentinel} a probe skill.\n---\nSay ${sentinel}.\n`;

const forward = (path: string) => path.replaceAll('\\', '/');

// The hooks of one source, tagged with it: SessionStart and a PostToolUse on every tool, each with commandWindows.
export function hooksOf(base: string, tag: string) {
  const entry = (event: string) => {
    const command = `node "${forward(base)}/hook.cjs" ${tag} ${event}`;
    return { hooks: [{ type: 'command', command, commandWindows: command, timeout: 30 }] };
  };
  return { SessionStart: [entry('SessionStart')], PostToolUse: [{ matcher: '.*', ...entry('PostToolUse') }] };
}

// A JSON value as a TOML inline value, for -c.
export function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .map(([key, item]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)}=${toml(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function sentinelFiles(base: string): Record<string, string> {
  return {
    ...Object.fromEntries(INSTRUCTION_FILES.map((file) => [file, `The sentinel word is ${sentinelOf(file)}.\n`])),
    '.agents/skills/repo-skill/SKILL.md': SKILL('repo-skill', 'SENTINEL-REPOSKILL'),
    '.codex/config.toml': 'developer_instructions = "The sentinel word is SENTINEL-PROJECTCONFIG."\n',
    '.codex/hooks.json': `${JSON.stringify({ hooks: hooksOf(base, 'project') }, null, 2)}\n`,
    '.codex/rules/probe.rules': 'prefix_rule(pattern = ["node", "outside.js"], decision = "allow")\n',
  };
}

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

// The scenario's directory: the repository (the probe scripts, and the sentinels or one instruction file when asked),
// committed, and beside it the hook, the MCP server, a skill and the output schema.
export function prepare(base: string, repository: 'plain' | 'sentinels' | `only:${string}`): Directories {
  const directories = { base, repo: join(base, 'repo'), run: join(base, 'run') };
  const only = repository.startsWith('only:') ? repository.slice('only:'.length) : null;
  write(directories.repo, {
    ...SCRIPTS,
    ...(repository === 'sentinels' && sentinelFiles(base)),
    ...(only !== null && { [only]: `The sentinel word is ${sentinelOf(only)}.\n` }),
  });
  write(base, {
    'hook.cjs': HOOK,
    'mcp-server.cjs': MCP_SERVER,
    'gg-skill/SKILL.md': SKILL('gg-skill', 'SENTINEL-GGSKILL'),
  });
  mkdirSync(directories.run);
  git(directories.repo, ['init', '-q', '-b', 'main']);
  git(directories.repo, ['config', 'user.name', 'Recorder']);
  git(directories.repo, ['config', 'user.email', 'recorder@example.invalid']);
  git(directories.repo, ['config', 'core.autocrlf', 'false']);
  git(directories.repo, ['add', '.']);
  git(directories.repo, ['commit', '-q', '-m', 'probe']);
  return directories;
}

// A marketplace beside the repository holding one plugin with a skill, for the Capability probes of decision 7.
export function writeMarketplace(base: string) {
  write(join(base, 'marketplace'), {
    '.agents/plugins/marketplace.json': JSON.stringify({
      name: 'gg-probe',
      plugins: [
        {
          name: 'probe-plugin',
          source: { source: 'local', path: './plugins/probe-plugin' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ],
    }),
    'plugins/probe-plugin/.codex-plugin/plugin.json': JSON.stringify({
      name: 'probe-plugin',
      version: '1.0.0',
      description: 'A probe plugin.',
      skills: './skills/',
    }),
    'plugins/probe-plugin/skills/plugin-skill/SKILL.md': SKILL('plugin-skill', 'SENTINEL-PLUGINSKILL'),
  });
  return join(base, 'marketplace');
}
