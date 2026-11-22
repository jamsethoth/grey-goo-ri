import type * as events from '../events.ts';

export const HARNESS_METHODS = [
  'name',
  'capabilities',
  'protectedPaths',
  'launchProfile',
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

// A Usage count's field: every USAGE_FIELDS key.
export type CountField = Exclude<keyof events.Usage, 'costBasis'>;

// A Usage whose counts `count` gives, field by field in USAGE_FIELDS order, with no costBasis.
export const usageOf = (count: (field: CountField) => number | null): events.Usage => ({
  inputTokens: count('inputTokens'),
  cacheReadTokens: count('cacheReadTokens'),
  cacheWriteTokens: count('cacheWriteTokens'),
  outputTokens: count('outputTokens'),
  reasoningTokens: count('reasoningTokens'),
  costUsd: count('costUsd'),
  peakContextTokens: count('peakContextTokens'),
  turns: count('turns'),
  toolCalls: count('toolCalls'),
  compactions: count('compactions'),
});

export const emptyUsage = (capabilities: Record<string, unknown> | null | undefined): events.Usage =>
  usageOf((field) => {
    const capability = USAGE_CAPABILITY[field];
    return capability && !capabilities?.[capability] ? null : 0;
  });

// A call's Usage delta (request 3.7): each count its Session's total less the total before it, a count the total
// leaves null staying null; peakContextTokens, a maximum, is the call's own.
export const usageDelta = (
  _cumulative: events.Usage,
  _previous: events.Usage | null,
  _peakContextTokens: number | null,
): events.Usage => usageOf(() => 0);
