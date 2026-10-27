import { createHash, randomBytes } from 'node:crypto';
import { has, labels } from './labels.mjs';

// The Approval Digest of a ticket: what a Decision covers (request 3.5).
export const digest = ({ head, body, configHash }) =>
  createHash('sha256').update(JSON.stringify([head, body, configHash])).digest('hex');

// An Approval Request's Pending Instance and Approval Digest; the nonce tells apart requests of one Visit.
export function request({ execution, vertex, visit, nonce = randomBytes(4).toString('hex'), head, body, configHash }) {
  return { id: `${execution}:${vertex}:${visit}:${nonce}`, execution, vertex, visit, nonce, digest: digest({ head, body, configHash }) };
}

// The REST collaborator permission field, where maintain reads as write and triage as read (L5).
const WRITE = ['admin', 'write'];

// Reads an issue's events (REST shape, oldest first) for the Pending Instance's Decision: consume (exactly one),
// stale (the Approval Digest differs), ambiguous (more than one), missing (no instance or request), or waiting.
// `permissions` maps each deciding actor's login to its permission; `approvers` are logins accepted below write.
export function read({ pending, timeline, digest: current, permissions, approvers = [], prefix = 'gg' }) {
  if (!pending) return { kind: 'missing' };
  const names = labels(prefix);
  const label = (e) => e.label?.name ?? '';
  // Every request first retires the earlier ones (request 3.5), so the latest Await Label event is this instance's;
  // a removed Await Label leaves nothing to verify.
  const last = timeline.findLastIndex((e) => (e.event === 'labeled' || e.event === 'unlabeled') && has([label(e)], names.await(pending.vertex)));
  if (last < 0 || timeline[last].event !== 'labeled') return { kind: 'missing' };
  if (current !== pending.digest) return { kind: 'stale' };
  const decisions = timeline.slice(last + 1).flatMap((e, i, after) => {
    const parsed = e.event === 'labeled' ? names.parse(label(e)) : null;
    if (parsed?.family !== 'decide' || !has([parsed.vertex], pending.vertex)) return [];
    if (after.slice(i + 1).some((u) => u.event === 'unlabeled' && has([label(u)], label(e)))) return [];
    const actor = e.actor?.login;
    if (!WRITE.includes(permissions[actor]) && !has(approvers, actor ?? '')) return [];
    return [{ event: e.id, actor, time: e.created_at, outcome: parsed.outcome.toLowerCase() }];
  });
  if (decisions.length > 1) return { kind: 'ambiguous', decisions };
  return decisions.length ? { kind: 'consume', decision: decisions[0] } : { kind: 'waiting' };
}
