// The label Effect: labels added to and removed from the Ticket's issue. setLabels never throws, so it is not remote:
// a write that does not land is handled by one of two policies its caller chooses (keepOpen, recordAndGoOn).
import type * as github from '../github.ts';
import * as labels from '../labels.ts';
import type * as record from '../record.ts';
import * as effects from './index.ts';

export type Payload = { ticket: number; add: string[]; remove: string[] };

// The gh verb labels are written with, and where it reports a write that failed (lib/github.ts).
export interface Context {
  gh: Pick<github.Gh, 'setLabels'>;
  cwd?: string;
  log: github.LabelReport['log'];
  events: github.LabelReport['ev'];
}

type LabelEffect = effects.Effect<Payload, Context>;

// The labels the issue shows now, as Reconciliation read them.
const find: effects.FindEffect = async ({ payload }, { issueLabels }) => {
  const { add, remove } = payload as Payload;
  const shown =
    add.every((label) => labels.hasLabel(issueLabels, label)) &&
    remove.every((label) => !labels.hasLabel(issueLabels, label));
  return shown ? effects.found({ ok: true }) : effects.ABSENT;
};

// Writes the labels and reports whether the write landed; setLabels has logged a write that did not, with its Event.
const labelEffect = (failed: ((payload: Payload) => Error) | null): LabelEffect => ({
  name: 'label',
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
      labels.hasLabel((entry.payload as Payload).add, name),
  );
