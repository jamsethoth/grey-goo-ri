// The comment Effect: a comment on an issue or PR whose body carries its Action Marker.
import type * as record from '../record.ts';
import * as recordReadNode from '../record-read-node.ts';
import * as writeAhead from '../write-ahead.ts';
import * as effects from './index.ts';

export type Payload = { target: { kind: string; number: number }; body: string; bodyHash: string };
// The payload an intent of this Effect saves, read from its row: its one form, any other refused by its path (#384).
const { text, count, object } = recordReadNode;
export const readPayload: recordReadNode.Read<Payload> = object((field) => ({
  target: object((target) => ({ kind: text(target('kind')), number: count(target('number')) }))(field('target')),
  body: text(field('body')),
  bodyHash: text(field('bodyHash')),
}));
export type Evidence = { id: number };

// The gh verb a comment is posted with (lib/github.ts).
export interface Context {
  gh: { comment(issue: number, body: string, cwd?: string): Promise<{ id: number }> };
  cwd?: string;
}

const perform: effects.Effect<Payload, Context>['perform'] = async ({ gh, cwd }, { target, body }) => ({
  id: (await gh.comment(target.number, body, cwd)).id,
});

const find: effects.FindEffect = async (entry, { gh, cwd }) => {
  const { actionMarker } = entry;
  const { target } = writeAhead.payloadOf(entry, readPayload);
  const posted = (await gh!.comments(target.number, cwd)).find((comment) =>
    effects.carries(comment.body, actionMarker),
  );
  return posted ? effects.found({ id: posted.id }) : effects.ABSENT;
};

export const effect: effects.Effect<Payload, Context> = {
  name: 'comment',
  readPayload,
  remote: 'GitHub',
  perform,
  find,
};

// The ids of the comments this Execution posted, as its write-ahead log recorded them.
export function postedIds(executionRecord: Pick<record.ExecutionRecord, 'writeAheadLog'>): number[] {
  const { writeAheadLog } = executionRecord;
  const comments = new Set(
    writeAheadLog.filter((entry) => entry.effect === effect.name).map((entry) => entry.actionMarker),
  );
  return writeAheadLog.flatMap(({ step, actionMarker, evidence }) =>
    step === 'evidence' && comments.has(actionMarker) && evidence && 'id' in evidence ? [evidence.id] : [],
  );
}
