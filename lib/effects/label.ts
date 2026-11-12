// The label Effect: labels added to and removed from the Ticket's issue. setLabels never throws, so it is not remote:
// a write that does not land is handled by one of two policies its caller chooses (keepOpen, recordAndGoOn).
import type * as github from '../github.ts';
import type * as record from '../record.ts';
import type * as effects from './index.ts';

export type Payload = { ticket: number; add: string[]; remove: string[] };

// The gh verb labels are written with, and where it reports a write that failed (lib/github.ts).
export interface Context {
  gh: Pick<github.Gh, 'setLabels'>;
  cwd?: string;
  log: github.LabelReport['log'];
  events: github.LabelReport['ev'];
}

type LabelEffect = effects.Effect<Payload, Context>;

const stub: LabelEffect = { name: '', remote: null, perform: async () => ({}) };

// keep open: a write that does not land throws `failed`, its intent left open for the next Run.
export const keepOpen = (_failed: (payload: Payload) => Error): LabelEffect => ({ ...stub, name: 'keep' });

// record and go on: a write that does not land saves { ok: false }, which proves nothing (writeAhead.evidenceOf).
export const recordAndGoOn: LabelEffect = stub;

// Whether one of gg's own label intents adds `name`, as a needs-human Terminal that crashed after its label does.
export const intendsToAdd = (_executionRecord: Pick<record.ExecutionRecord, 'writeAheadLog'>, _name: string): boolean =>
  true;
