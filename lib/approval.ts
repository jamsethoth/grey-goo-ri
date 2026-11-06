import { randomBytes } from 'node:crypto';
import * as config from './config.ts';
import * as labels from './labels.ts';

// The fingerprint of what a Decision covers; when it changes the Decision is stale.
export type ApprovalDigest = string;

// The unique identity of one Approval Request, with the Approval Digest it was requested under.
export interface PendingInstance {
  id: string;
  execution: string;
  vertex: string;
  visit: number;
  nonce: string;
  digest: ApprovalDigest;
}

// What the Approval Digest covers: the head, the body and the Config Hash.
export interface DigestInput {
  head: string;
  body: string;
  configHash: string;
}

// One issue event as GitHub's REST timeline gives it, with only the fields a Decision reads.
export interface IssueEvent {
  id: number;
  event: string;
  created_at: string;
  label?: { name: string } | null;
  actor?: { login: string } | null;
}

export interface Decision {
  event: number;
  actor: string | undefined;
  time: string;
  outcome: string;
}

export type DecisionRead =
  | { kind: 'missing' | 'stale' | 'waiting' }
  | { kind: 'ambiguous'; decisions: Decision[] }
  | { kind: 'consume'; decision: Decision };

// The Approval Digest of a ticket: what a Decision covers (request 3.5).
export const digest = ({ head, body, configHash }: DigestInput): ApprovalDigest =>
  config.sha256(JSON.stringify([head, body, configHash]));

// An Approval Request's Pending Instance and Approval Digest; the nonce tells apart requests of one Visit.
export function request({
  execution,
  vertex,
  visit,
  nonce = randomBytes(4).toString('hex'),
  head,
  body,
  configHash,
}: { execution: string; vertex: string; visit: number; nonce?: string } & DigestInput): PendingInstance {
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

const labelOf = (issueEvent: IssueEvent): string => issueEvent.label?.name ?? '';
const byTime = (left: string, right: string): number => (left < right ? -1 : Number(left > right));

interface DecisionScope {
  approvalRequest: PendingInstance;
  issueLabels: string[];
  names: labels.GgLabels;
  accepts: (actor: string | undefined) => boolean;
}

// The Decisions after the Pending Instance's latest Await Label event that still count: a Decide Label for its Vertex,
// still on the issue and not removed since, from an actor with write permission or an Approver.
function decisionsAfter(
  after: IssueEvent[],
  { approvalRequest, issueLabels, names, accepts }: DecisionScope,
): Decision[] {
  return after.flatMap((issueEvent, i) => {
    const parsed = issueEvent.event === 'labeled' ? names.parse(labelOf(issueEvent)) : null;
    // A Decision survives only while its label is on the issue, whatever the order of events in one second says.
    if (
      parsed?.family !== 'decide' ||
      !labels.hasLabel([parsed.vertex], approvalRequest.vertex) ||
      !labels.hasLabel(issueLabels, labelOf(issueEvent))
    )
      return [];
    const removed = after
      .slice(i + 1)
      .some((later) => later.event === 'unlabeled' && labels.hasLabel([labelOf(later)], labelOf(issueEvent)));
    if (removed) return [];
    const actor = issueEvent.actor?.login;
    if (!accepts(actor)) return [];
    return [{ event: issueEvent.id, actor, time: issueEvent.created_at, outcome: parsed.outcome.toLowerCase() }];
  });
}

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
  prefix = labels.DEFAULT_PREFIX,
}: {
  approvalRequest: PendingInstance | null;
  issueLabels: string[];
  timeline: IssueEvent[];
  digest: ApprovalDigest;
  permissions: Record<string, string>;
  approvers?: string[];
  prefix?: string;
}): DecisionRead {
  if (!approvalRequest) return { kind: 'missing' };
  const permission = new Map(Object.entries(permissions).map(([login, level]) => [login.toLowerCase(), level]));
  const names = labels.labelsFor(prefix);
  const awaiting = names.await(approvalRequest.vertex);
  // Whether the Await Label is on comes from the issue, not from the order of a retirement and a request in one second.
  if (!labels.hasLabel(issueLabels, awaiting)) return { kind: 'missing' };
  // GitHub documents no order for issue events and their ids do not follow time; created_at has one-second
  // resolution, so the stable sort keeps GitHub's own order within a second.
  const events = timeline.toSorted((left, right) => byTime(left.created_at, right.created_at));
  // Every request first retires the earlier ones (request 3.5), so the latest Await Label event is this instance's.
  const last = events.findLastIndex(
    (issueEvent) => issueEvent.event === 'labeled' && labels.hasLabel([labelOf(issueEvent)], awaiting),
  );
  if (last < 0) return { kind: 'missing' };
  if (current !== approvalRequest.digest) return { kind: 'stale' };
  const accepts = (actor: string | undefined) =>
    WRITE.includes(permission.get(actor?.toLowerCase() as string) as string) || labels.hasLabel(approvers, actor ?? '');
  const decisions = decisionsAfter(events.slice(last + 1), { approvalRequest, issueLabels, names, accepts });
  if (decisions.length > 1) return { kind: 'ambiguous', decisions };
  return decisions.length ? { kind: 'consume', decision: decisions[0] as Decision } : { kind: 'waiting' };
}
