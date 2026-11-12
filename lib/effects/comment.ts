// The comment Effect: a comment on an issue or PR whose body carries its Action Marker.
import type * as record from '../record.ts';
import type * as effects from './index.ts';

export type Payload = { target: { kind: string; number: number }; body: string; bodyHash: string };

// The gh verb a comment is posted with (lib/github.ts).
export interface Context {
  gh: { comment(issue: number, body: string, cwd?: string): Promise<{ id: number }> };
  cwd?: string;
}

export const effect: effects.Effect<Payload, Context> = {
  name: '',
  remote: null,
  perform: async () => ({}),
};

// The ids of the comments this Execution posted, as its write-ahead log recorded them.
export const postedIds = (_executionRecord: Pick<record.ExecutionRecord, 'writeAheadLog'>): number[] => [-1];
