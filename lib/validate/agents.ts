// The Agents checked: each declared Agent once, at agents.<name>, and the Agent each Vertex runs, the declared Agent
// under the Vertex's own Agent keys. Each check gives the value it typed, or Reported where it reported (#391).

import type * as model from '../model.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as checked from './procedures.ts';
import * as declaredFlows from './declared.ts';
import * as report from './report.ts';

// The keys an Agent may declare; any other is an unknown key (the request tables them). A Vertex takes them too.
export const AGENT_KEYS = [
  'harness',
  'model',
  'effort',
  'persona',
  'skills',
  'mcp',
  'plugins',
  'mode',
  'access',
  'network',
  'resolutionPolicy',
  'contextBudget',
  'timeouts',
];
// What an Agent asks for (Permission Intents). Integrity treats any access but read-only as a write, so a typo such as
// read-write would run as workspace-write.
const PERMISSION_INTENTS = ['read-only', 'workspace-write'];

type Value = Record<string, unknown>;
type Reported = report.Reported;
// `owner` is a declared Agent, by name, or the Vertex whose own Agent keys declare it.
type AgentOwner = { agent: string } | { vertex: string };
const ownerLabel = (owner: AgentOwner) =>
  'agent' in owner ? `agent ${owner.agent}` : `the agent of Vertex ${owner.vertex}`;

// The keys model.Agent declares, each typed by its check wherever an Agent key is written (#386).
export const AGENT_FIELDS = {
  harness: true,
  persona: true,
  model: true,
  effort: true,
  network: true,
} satisfies { [Key in keyof model.AgentFields]-?: true };

// The Agent keys one object writes, each as its check typed it, Reported where it reported, undefined where it is left
// out. A null is a null-value, which the validator reports apart, so it stays null here.
export interface AgentKeys {
  access: string | undefined | Reported;
  persona: string | null | undefined | Reported;
  model: string | null | undefined | Reported;
  effort: string | null | undefined | Reported;
  network: boolean | null | undefined | Reported;
}
// A declared Agent as written, null when it is not an object, and its harness and other keys as its checks typed
// them, or Reported when it had an error.
export type CheckedAgent =
  { declared: null; typed: Reported } | { declared: Value; typed: { harness: string; keys: AgentKeys } | Reported };
// What checking an Agent reads: the configuration's declared Agents, the registered harnesses, and each declared Agent
// as checked.
export interface AgentContext {
  report: report.Report;
  config: Value;
  harnesses: unknown;
  agents: Map<string, CheckedAgent>;
}

function checkAccess(problems: report.Report, location: string, access: unknown) {
  if (access === undefined) return undefined;
  if (typeof access === 'string' && PERMISSION_INTENTS.includes(access)) return access;
  const intents = PERMISSION_INTENTS.join(' or ');
  return report.error(
    problems,
    location,
    'unknown-permission-intent',
    `access ${JSON.stringify(access)} is not a Permission Intent: ${intents}`,
    { access },
  );
}

// The Agent keys the interpreter reads, each held to its type wherever an Agent key is written (#386). A missing key
// is the required checks', and a null only a null-value.
export function checkAgentKeys(problems: report.Report, location: string, agent: Value): AgentKeys {
  const access = checkAccess(problems, `${location}.access`, agent.access);
  const { persona, network } = agent;
  const typedPersona =
    persona == null || report.isName(persona)
      ? persona
      : report.error(problems, `${location}.persona`, 'file-not-named', 'persona must name a file', { key: 'persona' });
  const [model, effort] = (['model', 'effort'] as const).map((key) => {
    const value = agent[key];
    if (value == null || typeof value === 'string') return value;
    return report.error(problems, `${location}.${key}`, 'not-a-string', `${key} must be a string`);
  });
  const typedNetwork =
    network == null || typeof network === 'boolean'
      ? network
      : report.error(problems, `${location}.network`, 'not-a-boolean', 'network must be true or false');
  return { access, persona: typedPersona, model, effort, network: typedNetwork };
}

// A persona is required where an Agent is declared, as a harness is; a Vertex's own persona may replace it (#386, 1A).
function checkPersona(problems: report.Report, owner: AgentOwner, persona: unknown, location: string) {
  if (persona !== undefined) return undefined;
  const message = `${ownerLabel(owner)} names no persona; set one in the gg.json that declares it`;
  return report.error(problems, location, 'required-key-missing', message, { key: 'persona' });
}

function checkHarness(
  checking: Pick<AgentContext, 'report' | 'harnesses'>,
  owner: AgentOwner,
  harness: unknown,
  location: string,
): string | Reported {
  const problems = checking.report;
  const label = ownerLabel(owner);
  // Only a missing harness is unset; a null one is a null-value where it sits, and no name to look up.
  if (harness === undefined)
    return report.error(
      problems,
      location,
      'harness-unset',
      `${label} names no harness; set one in the gg.json that declares it`,
      owner,
    );
  const name = report.checkedName(problems, location, harness, { what: `${label}'s harness`, carried: false });
  if (report.isReported(name) || report.hasOwnKey(checking.harnesses, name)) return name;
  return report.error(
    problems,
    location,
    'harness-unregistered',
    `${label} names harness ${JSON.stringify(name)}, which is not registered`,
    { ...owner, harness: name },
  );
}

// One declared Agent's keys checked, typed when none reported.
function checkedAgent(problems: report.Report, checking: Pick<AgentContext, 'harnesses'>, name: string, agent: Value) {
  const location = `agents.${name}`;
  const before = problems.errors.length;
  report.unknownKeys(problems, agent, AGENT_KEYS, location);
  const harness = checkHarness(
    { report: problems, harnesses: checking.harnesses },
    { agent: name },
    agent.harness,
    location,
  );
  checkPersona(problems, { agent: name }, agent.persona, location);
  const keys = checkAgentKeys(problems, location, agent);
  if (report.isReported(harness)) return harness;
  return report.reportedSince(problems, before) ?? { harness, keys };
}

// Every declared Agent is checked once, used or not; its errors hold only the Flows that use it (H6).
export function checkAgents(problems: report.Report, config: Value, harnesses: unknown, usedAgents: Set<unknown>) {
  const failedAgents = new Set<unknown>();
  const agents = new Map<string, CheckedAgent>();
  for (const [name, agent] of report.entries(config.agents)) {
    const location = `agents.${name}`;
    const before = problems.errors.length;
    const named = report.checkedName(problems, location, name, { what: 'Agent', carried: false });
    if (!referencePaths.isRecord(agent))
      agents.set(name, {
        declared: null,
        typed: report.error(problems, location, 'not-an-object', 'an Agent must be an object'),
      });
    else {
      const typed = checkedAgent(problems, { harnesses }, name, agent);
      agents.set(name, { declared: agent, typed: report.isReported(named) ? named : typed });
    }
    if (problems.errors.length > before) failedAgents.add(name);
    if (!usedAgents.has(name))
      report.warn(problems, location, 'unused-agent', `agent ${name} is used by no Vertex`, { agent: name });
  }
  return { failedAgents, agents };
}

// The Agent a Vertex names by `use`, or null when it names none.
export function checkUse(checking: AgentContext, location: string, use: unknown): string | null | Reported {
  if (use === undefined) return null;
  if (report.hasOwnKey(checking.config.agents, use)) return use;
  return report.error(
    checking.report,
    location,
    'undeclared-agent',
    `uses agent ${JSON.stringify(use)}, which is not declared`,
    { agent: use },
  );
}

// A declared Agent, checked once at agents.<name>; every Vertex that uses it was checked to name one.
function agentOf(checking: AgentContext, name: string): CheckedAgent {
  const agent = checking.agents.get(name);
  if (!agent) throw new Error(`Agent ${JSON.stringify(name)} was not checked`);
  return agent;
}

// What vertexAgent gives: the Agent as declared, as typed, and the access it asks for as typed. The typed Agent is
// undefined where a null persona or network refused it, which is a null-value, reported apart.
export interface VertexAgent {
  declared: Value | null;
  typed: model.Agent | null | undefined | Reported;
  access: string | undefined | Reported;
}
const NO_AGENT: VertexAgent = { declared: null, typed: null, access: undefined };
// Where a Vertex is: its id, and its location in the configuration.
export interface VertexPlace {
  id: string;
  location: string;
}
// What a Vertex itself gives its Agent: its Procedure, its own Agent keys as written and as checked.
interface OwnAgentKeys {
  proc: checked.CheckedProcedure;
  overrides: Value;
  keys: AgentKeys;
}

// The Agent keys as typed, or the first a check reported.
function typedKeysOf(keys: AgentKeys) {
  const { access, persona, model, effort, network } = keys;
  if (report.isReported(access)) return access;
  if (report.isReported(persona)) return persona;
  if (report.isReported(model)) return model;
  if (report.isReported(effort)) return effort;
  if (report.isReported(network)) return network;
  return { access, persona, model, effort, network };
}

// The Agent as declared and as typed, from its merged keys and what their checks gave. Its other keys are as declared.
function agentWith(merged: Value, harness: string | Reported, keys: AgentKeys): VertexAgent {
  const declared = {
    ...merged,
    harness: merged.harness ?? null,
    model: merged.model ?? null,
    effort: merged.effort ?? null,
  };
  if (report.isReported(harness)) return { declared, typed: harness, access: undefined };
  const typedKeys = typedKeysOf(keys);
  if (report.isReported(typedKeys)) return { declared, typed: typedKeys, access: typedKeys };
  const { access, persona, network } = typedKeys;
  if (typeof persona !== 'string' || network === null) return { declared, typed: undefined, access };
  const asJson = Object.entries(declared).flatMap(([key, value]) => {
    const json = declaredFlows.declaredValue(value);
    return json === undefined ? [] : [[key, json] as const];
  });
  const model = typedKeys.model ?? null;
  const effort = typedKeys.effort ?? null;
  const typed = {
    ...Object.fromEntries(asJson),
    harness,
    persona,
    model,
    effort,
    ...(network !== undefined && { network }),
  };
  return { declared, typed, access };
}

// A Vertex's Agent from its own Agent keys alone, which name its harness and persona.
function ownAgent(checking: AgentContext, place: VertexPlace, own: OwnAgentKeys): VertexAgent {
  const { proc, overrides } = own;
  if (!Object.keys(overrides).length) {
    const message = `procedure ${proc.name} has an agent Action, so the Vertex needs an Agent`;
    const procedure = proc.name;
    return {
      ...NO_AGENT,
      typed: report.error(checking.report, place.location, 'vertex-needs-agent', message, { procedure }),
    };
  }
  const harness = checkHarness(checking, { vertex: place.id }, overrides.harness, place.location);
  const missing = checkPersona(checking.report, { vertex: place.id }, overrides.persona, place.location);
  return agentWith(overrides, missing ?? harness, own.keys);
}

// A Vertex's Agent from the Agent it uses, under its own Agent keys. A harness the Vertex does not set itself is the
// Agent's, checked at agents.<name>.
function usedAgent(checking: AgentContext, place: VertexPlace, use: string, own: OwnAgentKeys) {
  const { overrides } = own;
  const agent = agentOf(checking, use);
  // A declared Agent that is not an object is reported at agents.<name>.
  if (agent.declared === null) return { ...NO_AGENT, typed: agent.typed };
  const merged: Value = { ...agent.declared, ...overrides };
  const ownHarness = Object.hasOwn(overrides, 'harness')
    ? checkHarness(checking, { agent: use }, merged.harness, place.location)
    : undefined;
  if (report.isReported(agent.typed)) return { ...agentWith(merged, agent.typed, own.keys), access: agent.typed };
  const fromAgent = agent.typed.keys;
  const keyOf = <Key extends keyof AgentKeys>(key: Key) => (Object.hasOwn(overrides, key) ? own.keys : fromAgent)[key];
  const keys: AgentKeys = {
    access: keyOf('access'),
    persona: keyOf('persona'),
    model: keyOf('model'),
    effort: keyOf('effort'),
    network: keyOf('network'),
  };
  return agentWith(merged, ownHarness ?? agent.typed.harness, keys);
}

// The Agent a Vertex runs, the declared Agent under the Vertex's own Agent keys, or null when it takes none.
export function vertexAgent(
  checking: AgentContext,
  place: VertexPlace,
  vertex: Value,
  own: { use: string | null | Reported; keys: AgentKeys; proc?: checked.CheckedProcedure },
): VertexAgent {
  const { use, proc } = own;
  const overrides = Object.fromEntries(Object.entries(vertex).filter(([key]) => AGENT_KEYS.includes(key)));
  if (report.isReported(use)) return { ...NO_AGENT, typed: use };
  if (proc && !proc.agent && (use !== null || Object.keys(overrides).length)) {
    const message = `procedure ${proc.name} has no agent Action, so the Vertex takes no Agent`;
    const procedure = proc.name;
    return {
      ...NO_AGENT,
      typed: report.error(checking.report, place.location, 'vertex-takes-no-agent', message, { procedure }),
    };
  }
  if (!proc?.agent) return NO_AGENT;
  const keys = { proc, overrides, keys: own.keys };
  return use === null ? ownAgent(checking, place, keys) : usedAgent(checking, place, use, keys);
}
