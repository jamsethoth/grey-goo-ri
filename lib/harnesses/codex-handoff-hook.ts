// The PostToolUse hook gg's Codex launch installs for an Agent with a contextBudget (#485), as Claude's is
// (lib/harnesses/claude-handoff-hook.ts): past the budget it asks the agent to end its Attempt handed off, with a note
// of what remains, once in each 40,000 tokens further. Codex runs it with the hook input on stdin.
// Stub (#485 Red): its final signatures, each returning a wrong value.

// The hook's stdout for `input`, the hook input Codex sends, or null when it has nothing to say: under the budget, or
// already said within this step. stateDirectory keeps the step each thread was last asked at.
export function respond(_input: unknown, _options: { budget: number; stateDirectory: string }): string | null {
  return JSON.stringify({});
}
