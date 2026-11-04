export const HARNESS_METHODS = [
  'name',
  'capabilities',
  'protectedPaths',
  'validate',
  'resolveTools',
  'run',
  'interactiveArgs',
  'metrics',
  'doctor',
];

export const CAPABILITY_FIELDS = [
  'skills',
  'mcp',
  'plugins',
  'access',
  'network',
  'contextBudget',
  'interactive',
  'backgroundSessions',
  'sessionResume',
  'structuredOutput',
  'sandbox',
  'confinement',
  'peakContextReporting',
  'costReporting',
  'turnCountReporting',
  'toolCallReporting',
  'reasoningTokenReporting',
  'backgroundWork',
];

export const USAGE_FIELDS = [
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens',
  'costUsd',
  'peakContextTokens',
  'turns',
  'toolCalls',
  'compactions',
];

// Usage fields that exist only when the named Capability is declared present.
const USAGE_CAPABILITY: Record<string, string> = {
  reasoningTokens: 'reasoningTokenReporting',
  costUsd: 'costReporting',
  peakContextTokens: 'peakContextReporting',
  turns: 'turnCountReporting',
  toolCalls: 'toolCallReporting',
};

// Throws naming the first method or Capability a Harness module lacks.
export function assertHarness(harness: unknown): void {
  const declared = (harness ?? {}) as Record<string, unknown> & { capabilities: Record<string, unknown> };
  for (const method of HARNESS_METHODS) {
    if (declared[method] === undefined) throw new Error(`harness is missing ${method}`);
  }
  for (const field of CAPABILITY_FIELDS) {
    if (declared.capabilities[field] === undefined)
      throw new Error(`harness ${String(declared.name)} capabilities are missing ${field}`);
  }
}

export function emptyUsage(capabilities: Record<string, unknown> | null | undefined): Record<string, number | null> {
  return Object.fromEntries(
    USAGE_FIELDS.map((field) => {
      const capability = USAGE_CAPABILITY[field];
      return [field, capability && !capabilities?.[capability] ? null : 0];
    }),
  );
}
