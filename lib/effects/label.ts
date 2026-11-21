// The label Effect: labels added to and removed from the Ticket's issue. setLabels never throws, so it is not remote:
// a write that does not land is handled by one of two policies its caller chooses (keepOpen, recordAndGoOn).
import type * as approvalAction from '../approval-action.ts';
import type * as github from '../github.ts';
import * as labels from '../labels.ts';
import type * as record from '../record.ts';
import * as recordReadNode from '../record-read-node.ts';
import * as writeAhead from '../write-ahead.ts';
import * as effects from './index.ts';

export type Payload = { ticket: number; add: string[]; remove: string[] };
// Whether the write landed: { ok: false } proves nothing (writeAhead.evidenceOf).
export type Evidence = { ok: boolean };
// The payload a label intent saves, read from its row: its own form or a consumed Decision's, any other refused by its
// path as 'a label payload' (#384).
const { text, count, nullable, list, object, variant } = recordReadNode;
const texts = list(text);
const labelFields = (field: (key: string) => recordReadNode.Node): Payload => ({
  ticket: count(field('ticket')),
  add: texts(field('add')),
  remove: texts(field('remove')),
});
// A consumed Decision's payload, which an await-approval's consume intent saves under this Effect
// (lib/approval-action.ts).
export const readConsumption: recordReadNode.Read<approvalAction.Consumption> = object((field) => ({
  ...labelFields(field),
  decision: object((decision, has) => ({
    instance: text(decision('instance')),
    event: count(decision('event')),
    actor: has('actor') ? text(decision('actor')) : undefined,
    time: text(decision('time')),
    outcome: text(decision('outcome')),
    next: text(decision('next')),
    reply: nullable(text)(decision('reply')),
  }))(field('decision')),
}));
export const readPayload: recordReadNode.Read<Payload | approvalAction.Consumption> = variant('a label payload', [
  { required: ['ticket', 'add', 'remove'], read: object(labelFields) },
  { required: ['ticket', 'add', 'remove', 'decision'], read: readConsumption },
]);

// The gh verb labels are written with, and where it reports a write that failed (lib/github.ts).
export interface Context {
  gh: Pick<github.Gh, 'setLabels'>;
  cwd?: string;
  log: github.LabelReport['log'];
  events: github.LabelReport['ev'];
}

type LabelEffect = effects.Effect<Payload, Context, Payload | approvalAction.Consumption>;

// The labels the issue shows now, as Reconciliation read them.
const find: effects.FindEffect = async (entry, { issueLabels }) => {
  const { add, remove } = writeAhead.payloadOf(entry, readPayload);
  const shown =
    add.every((label) => labels.hasLabel(issueLabels, label)) &&
    remove.every((label) => !labels.hasLabel(issueLabels, label));
  return shown ? effects.found({ ok: true }) : effects.ABSENT;
};

// Writes the labels and reports whether the write landed; setLabels has logged a write that did not, with its Event.
const labelEffect = (failed: ((payload: Payload) => Error) | null): LabelEffect => ({
  name: 'label',
  readPayload,
  remote: null,
  find,
  perform: async ({ gh, cwd, log, events }, payload) => {
    const { ticket, add, remove } = payload;
    if (!add.length && !remove.length) return { ok: true };
    const ok = await gh.setLabels(ticket, { add, remove }, cwd, { log, ev: events });
    if (!ok && failed) throw failed(payload);
    return { ok };
  },
});

// keep open: a write that does not land throws `failed`, its intent left open for the next Run.
export const keepOpen = (failed: (payload: Payload) => Error): LabelEffect => labelEffect(failed);

// record and go on: a write that does not land saves { ok: false }, which proves nothing (writeAhead.evidenceOf).
export const recordAndGoOn: LabelEffect = labelEffect(null);

// Whether one of gg's own label intents adds `name`, as a needs-human Terminal that crashed after its label does.
export const intendsToAdd = (executionRecord: Pick<record.ExecutionRecord, 'writeAheadLog'>, name: string): boolean =>
  executionRecord.writeAheadLog.some(
    (entry) =>
      entry.step === 'intent' &&
      entry.effect === recordAndGoOn.name &&
      labels.hasLabel(writeAhead.payloadOf(entry, readPayload).add, name),
  );
