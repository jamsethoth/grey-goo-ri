import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as claude from '../../lib/harnesses/claude.ts';
import * as codex from '../../lib/harnesses/codex.ts';
import * as contract from '../../lib/harnesses/contract.ts';
import * as agentChecks from '../../lib/validate/agents.ts';
import * as exampleSource from '../support/example-source.ts';

// What the Capability matrix refuses of an Agent on a shipped Harness (request 3.2, 3.3; ADR 0026; #481).
/* eslint-disable id-denylist -- a Problem's key is at */

// The Agent keys the Capability matrix rules on, each with a value that asks for it.
const CAPABILITY_KEYS = contract.CAPABILITY_FIELDS.filter((field) => agentChecks.AGENT_KEYS.includes(field));
const ASKING: Record<string, unknown> = {
  skills: ['tdd'],
  mcp: ['playwright'],
  plugins: ['superpowers'],
  contextBudget: 100000,
  access: 'workspace-write',
  network: false,
};

// What Codex makes of each key, as #479 showed it (Q15 A): a field not shown exact is unsupported, so network (no
// recording shows a network call blocked or allowed) is refused at the key; skills are hinted, and mcp, plugins, both
// access intents and contextBudget, by the hand-off hook (#485), are enforced.
const CODEX_REFUSES: Record<string, string | null> = {
  skills: null,
  mcp: null,
  plugins: null,
  contextBudget: null,
  access: null,
  network: 'unenforceable-permission-intent',
};

// The example with its Agent `agent` on `harness` and `fields` set on it, checked with Claude and Codex registered.
function firedOn(harness: string, agent: 'implementer' | 'reviewer', fields: Record<string, unknown>) {
  const config = exampleSource.config();
  exampleSource.putAt(config.agents[agent], ['harness'], harness);
  for (const [field, value] of Object.entries(fields)) exampleSource.putAt(config.agents[agent], [field], value);
  return exampleSource.firedRules(exampleSource.checkOn(config, { fake: {}, claude, codex }).errors);
}

test('every Agent key the Capability matrix rules on has what Codex makes of it', () => {
  assert.deepEqual(Object.keys(CODEX_REFUSES).sort(), [...CAPABILITY_KEYS].sort());
  assert.deepEqual(Object.keys(ASKING).sort(), [...CAPABILITY_KEYS].sort());
});

test('an Agent listing a field Codex declares unsupported is an error at that key', () => {
  const wrong: string[] = [];
  for (const field of CAPABILITY_KEYS) {
    const code = CODEX_REFUSES[field];
    const fired = JSON.stringify(firedOn('codex', 'implementer', { [field]: ASKING[field] }));
    const expected = JSON.stringify(code ? [{ at: `agents.implementer.${field}`, code }] : []);
    if (fired !== expected) wrong.push(`${field}: ${fired}, expected ${expected}`);
  }
  assert.deepEqual(wrong, []);
});

// Each surface a Codex Agent reaches, by the Agent key that opens it: the shell and the file tools (none: every call
// has them), a listed MCP server, a listed plugin and a declared skill. Each enforces access, under the sandbox or by
// the listing as consent (D17 A), and none can enforce network (request 3.2, decision 3).
const CODEX_SURFACES: Record<string, Record<string, unknown>> = {
  'shell and file tools': {},
  mcp: { mcp: ['playwright'] },
  plugins: { plugins: ['superpowers'] },
  skills: { skills: ['tdd'] },
};
const AGENT_OF_ACCESS = { 'read-only': 'reviewer', 'workspace-write': 'implementer' } as const;

test('network false beside a network-reaching Codex surface is an error', () => {
  const wrong: string[] = [];
  for (const [surface, fields] of Object.entries(CODEX_SURFACES))
    for (const [access, agent] of Object.entries(AGENT_OF_ACCESS))
      for (const network of [undefined, false, true]) {
        const fired = JSON.stringify(firedOn('codex', agent, { ...fields, ...(network != null && { network }) }));
        const expected = JSON.stringify(
          network == null ? [] : [{ at: `agents.${agent}.network`, code: 'unenforceable-permission-intent' }],
        );
        if (fired !== expected) wrong.push(`${surface} ${access} network ${network}: ${fired}, expected ${expected}`);
      }
  assert.deepEqual(wrong, []);
});

// Claude's accepted Trusted-Command Mode limits stay as ADRs 0007 and 0025 record them (decision 3): a shell command
// writing elsewhere or reaching the network is neither prevented nor observed, and its Agents stay admissible.
test('a Claude workspace-write Agent under Trusted-Command Mode is admitted', () => {
  assert.equal(claude.capabilities.confinement, 'trusted-commands');
  const surfaces: Record<string, Record<string, unknown>> = {
    'shell and file tools': {},
    plugins: { plugins: ['superpowers'] },
    skills: { skills: ['tdd'] },
  };
  const wrong: string[] = [];
  for (const [surface, fields] of Object.entries(surfaces))
    for (const [access, agent] of Object.entries(AGENT_OF_ACCESS))
      for (const network of [undefined, false, true]) {
        const fired = firedOn('claude', agent, { ...fields, ...(network != null && { network }) });
        if (fired.length) wrong.push(`${surface} ${access} network ${network}: ${JSON.stringify(fired)}`);
      }
  assert.deepEqual(wrong, []);
});
/* eslint-enable id-denylist */
