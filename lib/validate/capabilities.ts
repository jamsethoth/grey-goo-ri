// What a Harness's Capability matrix refuses: an Agent asking for what its Harness declares it cannot give, and a
// Vertex recovering on a Harness that cannot resume a Session (request 3.3, #429). A Harness that declares no
// Capabilities is left to the contract check, which refuses it before a run.

import * as referencePaths from '../reference-paths.ts';
import * as report from './report.ts';

type Value = Record<string, unknown>;
// What a check reads: the report it writes to and the registered Harnesses.
interface Checking {
  report: report.Report;
  harnesses: unknown;
}

function capabilitiesOf(harnesses: unknown, harness: unknown) {
  if (!report.hasOwnKey(harnesses, harness)) return undefined;
  const declared: unknown = (harnesses as Value)[harness];
  return referencePaths.isRecord(declared) && referencePaths.isRecord(declared.capabilities)
    ? declared.capabilities
    : undefined;
}

// The Agent fields the Capability matrix rules on by being listed; one counts unless absent or an empty list.
const LISTED_FIELDS = ['skills', 'mcp', 'plugins', 'contextBudget'];
const listed = (value: unknown) => value != null && !(Array.isArray(value) && !value.length);
const UNENFORCED = ['hint', 'unsupported'];

// A listed field its Harness declares unsupported, or a Permission Intent it only hints or cannot enforce, since an
// intent runs as asked or fails (ADR 0006). Access is always asked, read-only when unset; network when set. `own` is
// the object at `location`: it is checked where it sets the harness or the field, at the field where it writes it.
export function checkAgent(
  checking: Checking,
  place: { location: string; own: Value },
  agent: { harness: string; merged: Value; access: unknown; network: unknown },
) {
  const { harness, merged } = agent;
  const capabilities = capabilitiesOf(checking.harnesses, harness);
  if (!capabilities) return;
  const placeOf = (field: string) => (Object.hasOwn(place.own, field) ? `${place.location}.${field}` : place.location);
  const mine = (field: string) => Object.hasOwn(place.own, 'harness') || Object.hasOwn(place.own, field);
  for (const field of LISTED_FIELDS) {
    if (!mine(field) || !listed(merged[field]) || capabilities[field] !== 'unsupported') continue;
    const message = `harness ${harness} does not support ${field}`;
    report.error(checking.report, placeOf(field), 'unsupported-agent-field', message, { field, harness });
  }
  const intents = { access: agent.access ?? 'read-only', network: agent.network };
  for (const [field, asked] of Object.entries(intents)) {
    const capability = String(capabilities[field]);
    if (asked == null || report.isReported(asked) || !mine(field) || !UNENFORCED.includes(capability)) continue;
    const message = `harness ${harness} declares ${field} ${capability}, so cannot enforce ${JSON.stringify(asked)}`;
    report.error(checking.report, placeOf(field), 'unenforceable-permission-intent', message, {
      field,
      harness,
      capability,
    });
  }
}

// A recovery resumes its agent Action's Session, so a Vertex whose Procedure recovers needs a Harness that can resume
// one; an Attempt retry starts a fresh Session where it cannot, and is not refused.
export function checkSessionResume(
  checking: Checking,
  location: string,
  procedure: { name: string; recover: unknown } | undefined,
  agent: Value | null,
) {
  const harness = agent?.harness;
  const sessionResume = capabilitiesOf(checking.harnesses, harness)?.sessionResume;
  if (procedure?.recover == null || typeof harness !== 'string') return;
  if (!referencePaths.isRecord(sessionResume) || sessionResume.supported !== false) return;
  const message = `procedure ${procedure.name} recovers in its Session, which harness ${harness} cannot resume`;
  const params = { procedure: procedure.name, harness };
  report.error(checking.report, location, 'session-resume-unsupported', message, params);
}
