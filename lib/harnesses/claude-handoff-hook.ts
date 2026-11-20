// The PostToolUse hook gg's Claude settings file installs for an Agent with a contextBudget (#430, after the gg-ticket
// plugin's hooks/gg-context-cap.mjs): past the budget it asks the agent to end its Attempt handed off, with a note of
// what remains, once in each 40,000 tokens further. Claude runs it with the hook input on stdin.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as briefs from '../briefs.ts';
import * as outcome from '../outcome.ts';
import * as referencePaths from '../reference-paths.ts';

// How far past the budget the context grows before the hook asks again.
const STEP = 40_000;

// The hooks key of gg's settings file for an Agent with `budget`. Claude starts the command through a shell, so its
// paths take forward slashes, which node reads on every platform and no shell escapes.
export function settings(budget: number, stateDirectory: string) {
  const slashed = (path: string) => `"${path.replaceAll('\\', '/')}"`;
  const command = [slashed(process.execPath), slashed(fileURLToPath(import.meta.url)), budget, slashed(stateDirectory)];
  return { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: command.join(' ') }] }] };
}

// The context the latest request sent, as the API reports it on the transcript's last assistant entry.
function latestContext(transcriptPath: string): number | null {
  const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    const entry: unknown = JSON.parse(line);
    if (!referencePaths.isRecord(entry) || entry.type !== 'assistant' || !referencePaths.isRecord(entry.message))
      continue;
    const { usage } = entry.message;
    if (!referencePaths.isRecord(usage)) continue;
    const tokens = (field: string) => (typeof usage[field] === 'number' ? usage[field] : 0);
    return tokens('input_tokens') + tokens('cache_read_input_tokens') + tokens('cache_creation_input_tokens');
  }
  return null;
}

const thousands = (tokens: number) => `${Math.round(tokens / 1000)}k`;

// The hook's stdout for `input`, the hook input Claude sends, or null when it has nothing to say: under the budget, or
// already said within this step. stateDirectory keeps the step each Session was last asked at.
export function respond(input: unknown, options: { budget: number; stateDirectory: string }): string | null {
  // A hook that fails would break the tool call it follows, so whatever it cannot read leaves it silent.
  try {
    if (!referencePaths.isRecord(input) || typeof input.transcript_path !== 'string') return null;
    const context = latestContext(input.transcript_path);
    if (context === null || context <= options.budget) return null;
    const step = Math.floor((context - options.budget) / STEP);
    const statePath = join(options.stateDirectory, `${String(input.session_id).replace(/[^\w-]/g, '_')}.step`);
    if (existsSync(statePath) && Number(readFileSync(statePath, 'utf8')) >= step) return null;
    mkdirSync(options.stateDirectory, { recursive: true });
    writeFileSync(statePath, String(step));
    const additionalContext =
      `Context budget: your latest request sent ${thousands(context)} tokens, past this Agent's budget of ` +
      `${thousands(options.budget)}. Finish now: end with the Structured Response whose claim is ` +
      `${JSON.stringify(outcome.HANDED_OFF)} and whose ${JSON.stringify(briefs.HANDOFF_NOTE)} field says what ` +
      'remains to do, and a fresh Session takes the work on from your note.';
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } });
  } catch {
    return null;
  }
}

async function main() {
  const [budget, stateDirectory] = process.argv.slice(2);
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    input = undefined;
  }
  const said = respond(input, { budget: Number(budget), stateDirectory: stateDirectory! });
  if (said !== null) process.stdout.write(said);
}

if (import.meta.main) await main();
