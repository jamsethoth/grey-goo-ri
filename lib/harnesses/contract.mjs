export const HARNESS_METHODS = [
  'name', 'capabilities', 'validate', 'resolveTools', 'run', 'interactiveArgs', 'metrics', 'doctor',
];

export const CAPABILITY_FIELDS = [
  'skills', 'mcp', 'plugins', 'access', 'network', 'contextBudget', 'interactive', 'background', 'resume',
  'structuredOutput', 'sandbox', 'confinement', 'peakContext', 'cost', 'turns', 'toolCalls', 'reasoningTokens',
  'backgroundWork',
];

export const USAGE_FIELDS = [
  'input', 'cached', 'cacheWrite', 'output', 'reasoning', 'costUsd', 'peakContext', 'turns', 'toolCalls', 'compactions',
];

// Usage fields that exist only when the named Capability is declared present.
const USAGE_CAPABILITY = {
  reasoning: 'reasoningTokens', costUsd: 'cost', peakContext: 'peakContext', turns: 'turns', toolCalls: 'toolCalls',
};

export function assertHarness(obj) {
  for (const method of HARNESS_METHODS) {
    if (obj?.[method] === undefined) throw new Error(`harness is missing ${method}`);
  }
  for (const field of CAPABILITY_FIELDS) {
    if (obj.capabilities[field] === undefined) throw new Error(`harness ${obj.name} capabilities are missing ${field}`);
  }
}

export function emptyUsage(capabilities) {
  return Object.fromEntries(USAGE_FIELDS.map((field) => {
    const capability = USAGE_CAPABILITY[field];
    return [field, capability && !capabilities?.[capability] ? null : 0];
  }));
}
