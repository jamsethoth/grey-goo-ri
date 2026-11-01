import { randomBytes } from 'node:crypto';
import { sha256 } from './config.mjs';
import { DEFAULT_PREFIX, has, labels } from './labels.mjs';

// The Approval Digest of a ticket: what a Decision covers (request 3.5).
export const digest = ({ head, body, configHash }) => sha256(JSON.stringify([head, body, configHash]));

// An Approval Request's Pending Instance and Approval Digest; the nonce tells apart requests of one Visit.
export function request({ execution, vertex, visit, nonce = randomBytes(4).toString('hex'), head, body, configHash }) {
  return {
    id: `${execution}:${vertex}:${visit}:${nonce}`,
    execution,
    vertex,
    visit,
    nonce,
    digest: digest({ head, body, configHash }),
  };
}

// The REST collaborator permission field, where maintain reads as write and triage as read (L5).
const WRITE = ['admin', 'write'];

// Reads an issue's current labels and events (REST shape) for the Pending Instance's Decision: consume (exactly one),
// stale (the Approval Digest differs), ambiguous (more than one), missing (no instance or request), or waiting.
// `permissions` maps each deciding actor's login to its permission; `approvers` are logins accepted below write.
// Both match logins in any case, as GitHub does.
export function read({
  approvalRequest,
  issueLabels,
  timeline,
  digest: current,
  permissions,
  approvers = [],
  prefix = DEFAULT_PREFIX,
}) {
  if (!approvalRequest) return { kind: 'missing' };
  const permission = new Map(Object.entries(permissions).map(([login, level]) => [login.toLowerCase(), level]));
  const names = labels(prefix);
  const awaiting = names.await(approvalRequest.vertex);
  // Whether the Await Label is on comes from the issue, not from the order of a retirement and a request in one second.
  if (!has(issueLabels, awaiting)) return { kind: 'missing' };
  const label = (e) => e.label?.name ?? '';
  // GitHub documents no order for issue events and their ids do not follow time; created_at has one-second
  // resolution, so the stable sort keeps GitHub's own order within a second.
  const events = timeline.toSorted((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  // Every request first retires the earlier ones (request 3.5), so the latest Await Label event is this instance's.
  const last = events.findLastIndex((e) => e.event === 'labeled' && has([label(e)], awaiting));
  if (last < 0) return { kind: 'missing' };
  if (current !== approvalRequest.digest) return { kind: 'stale' };
  const decisions = events.slice(last + 1).flatMap((e, i, after) => {
    const parsed = e.event === 'labeled' ? names.parse(label(e)) : null;
    // A Decision survives only while its label is on the issue, whatever the order of events in one second says.
    if (parsed?.family !== 'decide' || !has([parsed.vertex], approvalRequest.vertex) || !has(issueLabels, label(e)))
      return [];
    if (after.slice(i + 1).some((u) => u.event === 'unlabeled' && has([label(u)], label(e)))) return [];
    const actor = e.actor?.login;
    if (!WRITE.includes(permission.get(actor?.toLowerCase())) && !has(approvers, actor ?? '')) return [];
    return [{ event: e.id, actor, time: e.created_at, outcome: parsed.outcome.toLowerCase() }];
  });
  if (decisions.length > 1) return { kind: 'ambiguous', decisions };
  return decisions.length ? { kind: 'consume', decision: decisions[0] } : { kind: 'waiting' };
}
