// The PostToolUse hook gg's Codex launch installs for an Agent with a contextBudget (#485), as Claude's is
// (lib/harnesses/claude-handoff-hook.ts): past the budget it asks the agent to end its Attempt handed off, with a note
// of what remains, once in each 40,000 tokens further. Codex runs it with the hook input on stdin. Only
// lib/harnesses/codex.ts imports it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as briefs from '../briefs.ts';
import * as outcome from '../outcome.ts';
import * as referencePaths from '../reference-paths.ts';

// How far past the budget the context grows before the hook asks again.
const STEP = 40_000;

// The hook's command line for an Agent with `budget`, which Codex starts through a shell on every platform, so its
// paths take forward slashes, which node reads on every platform and no shell escapes. The same line serves as its
// commandWindows (request 3.2).
// unverified: the shell Codex 0.171 starts commandWindows in; the owner's gg doctor --probe run checks it (Q2 A).
export function command(budget: number, stateDirectory: string): string {
  const slashed = (path: string) => `"${path.replaceAll('\\', '/')}"`;
  const hook = slashed(fileURLToPath(import.meta.url));
  return [slashed(process.execPath), hook, budget, slashed(stateDirectory)].join(' ');
}

// With hooks on, Codex also runs the hooks of gg's Codex home, which would reach the call beside gg's own (Q8 A), so a
// hooks.json there, or a config.toml that declares hooks, fails an Agent with a contextBudget, named (Q3 A, D1 A). A
// config.toml declares them by a key path with a hooks segment: a table header, a dotted or an inline key.
// shortcut: a line match, not a TOML parse; it refuses too much (a hooks key under another table, such as
// features.hooks or mcp_servers.hooks, or in a string), never too little, short of an escaped key name; upgrade to a
// parse if a refusal ever names a file with no hook.
const HOOKS_KEY = /(^\s*|[[.{,]\s*)["']?hooks["']?\s*[.\]=]/m;
const HOME_HOOK_FILES = ['hooks.json', 'config.toml'];
function declaresHooks(path: string): boolean {
  if (!path.endsWith('config.toml')) return true;
  try {
    return HOOKS_KEY.test(readFileSync(path, 'utf8'));
  } catch {
    // A config.toml gg cannot read may declare hooks, so it is refused, named, as one that does.
    return true;
  }
}
export const homeHookErrors = (codexHome: string): string[] =>
  HOME_HOOK_FILES.map((file) => join(codexHome, file))
    .filter((path) => existsSync(path) && declaresHooks(path))
    .map((path) => `gg's Codex home holds ${path}, whose hooks would run beside an Agent's contextBudget hook`);

// The context the latest complete request sent: the input tokens, cached ones among them, of the rollout's last
// token_count event (Clarify probe P1).
function latestContext(transcriptPath: string): number | null {
  const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // A line Codex is still writing as the hook reads it.
      continue;
    }
    if (!referencePaths.isRecord(entry) || !referencePaths.isRecord(entry.payload)) continue;
    const { type, info } = entry.payload;
    if (type !== 'token_count' || !referencePaths.isRecord(info) || !referencePaths.isRecord(info.last_token_usage))
      continue;
    const tokens = info.last_token_usage.input_tokens;
    if (typeof tokens === 'number') return tokens;
  }
  return null;
}

const thousands = (tokens: number) => `${Math.round(tokens / 1000)}k`;

// The hook's stdout for `input`, the hook input Codex sends, or null when it has nothing to say: under the budget, or
// already said within this step. stateDirectory keeps the step each thread was last asked at.
export function respond(input: unknown, options: { budget: number; stateDirectory: string }): string | null {
  // A hook that fails would break the tool call it follows, so whatever it cannot read leaves it silent.
  try {
    if (!referencePaths.isRecord(input) || typeof input.transcript_path !== 'string') return null;
    const context = latestContext(input.transcript_path);
    if (context === null || context <= options.budget) return null;
    const step = Math.floor((context - options.budget) / STEP);
    // The step file only throttles the ask, so one the hook cannot name or keep never silences it (#485 F7, F8).
    const { session_id: id } = input;
    if (typeof id === 'string') {
      const statePath = join(options.stateDirectory, `${id.replace(/[^\w-]/g, '_')}.step`);
      try {
        if (existsSync(statePath) && Number(readFileSync(statePath, 'utf8')) >= step) return null;
        mkdirSync(options.stateDirectory, { recursive: true });
        writeFileSync(statePath, String(step));
      } catch {
        // Asked again at the next tool call, which beats never asking.
      }
    }
    const additionalContext =
      `Context budget: your latest request sent ${thousands(context)} tokens, past this Agent's budget of ` +
      `${thousands(options.budget)}. Finish now: end with the Structured Response whose claim is ` +
      `${JSON.stringify(outcome.HANDED_OFF)} and whose ${JSON.stringify(briefs.HANDOFF_NOTE)} field says what ` +
      'remains to do, and a fresh thread takes the work on from your note.';
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } });
  } catch {
    return null;
  }
}

// The hook process, over the arguments, stdin and stdout its command line gives it.
export async function main(
  args: string[],
  stdin: AsyncIterable<unknown> | Iterable<unknown>,
  stdout: { write(text: string): unknown },
) {
  const [budget, stateDirectory] = args;
  let text = '';
  for await (const chunk of stdin) text += String(chunk);
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    input = undefined;
  }
  const said = respond(input, { budget: Number(budget), stateDirectory: stateDirectory! });
  if (said !== null) stdout.write(said);
}

if (import.meta.main) await main(process.argv.slice(2), process.stdin, process.stdout);
