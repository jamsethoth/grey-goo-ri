// The pr-upsert Effect: the Ticket branch's PR, created or its body replaced, the body carrying its Action Marker.
import type * as github from '../github.ts';
import type * as record from '../record.ts';
import type * as effects from './index.ts';

export type Payload = { branch: string; base?: string; title: string; body: string; bodyHash: string };

// The gh verb a PR is upserted with (lib/github.ts); the PR's number is kept on the record.
export interface Context {
  record: Pick<record.ExecutionRecord, 'pr'>;
  gh: Pick<github.Gh, 'upsertPr'>;
  cwd?: string;
}

export const effect: effects.Effect<Payload, Context> = {
  name: '',
  remote: null,
  perform: async () => ({}),
};
