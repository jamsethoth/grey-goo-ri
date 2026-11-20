// The PostToolUse hook gg's Claude settings file installs for an Agent with a contextBudget (#430, after the gg-ticket
// plugin's hooks/gg-context-cap.mjs): past the budget it asks the agent to end its Attempt handed off, with a note of
// what remains, once in each 40,000 tokens further. Claude runs it with the hook input on stdin.

// The hook's stdout for `input`, the hook input Claude sends, or null when it has nothing to say: under the budget, or
// already said within this step. stateDirectory keeps the step each Session was last asked at. Stub until #430's
// Green.
export function respond(input: unknown, options: { budget: number; stateDirectory: string }): string | null {
  void input;
  void options;
  return '{}';
}
