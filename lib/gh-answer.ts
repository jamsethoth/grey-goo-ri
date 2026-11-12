import type * as approval from './approval.ts';
import type * as github from './github.ts';
import * as referencePaths from './reference-paths.ts';

// A node of gh's JSON answer, with its path from the answer and the gh call that gave it. A verb reads the answer
// field by field, so a field of the wrong type fails the verb, naming it, and never reaches a typed value (#354).
export interface Answered {
  value: unknown;
  path: string;
  call: string;
}
export const answered = (value: unknown, args: string[]): Answered => ({ value, path: 'answer', call: args.join(' ') });

function wrongAnswer({ path, call }: Answered, wanted: string): never {
  throw new Error(`gh ${call} gave ${path} that is not ${wanted}`);
}
export const text = (node: Answered) => (typeof node.value === 'string' ? node.value : wrongAnswer(node, 'a string'));
export const count = (node: Answered) => (typeof node.value === 'number' ? node.value : wrongAnswer(node, 'a number'));
const flag = (node: Answered) => (typeof node.value === 'boolean' ? node.value : wrongAnswer(node, 'true or false'));
// gh leaves out a field it has no value for, or gives null.
const absent = (node: Answered) => node.value == null;

// The node's fields, each read by its key.
export function fields(node: Answered): (key: string) => Answered {
  const { value } = node;
  if (!referencePaths.isRecord(value)) return wrongAnswer(node, 'an object');
  return (key) => ({ ...node, value: value[key], path: `${node.path}.${key}` });
}
export function items(node: Answered): Answered[] {
  const { value } = node;
  if (!Array.isArray(value)) return wrongAnswer(node, 'a list');
  return value.map((item: unknown, i) => ({ ...node, value: item, path: `${node.path}[${i}]` }));
}
// A `--paginate --slurp` answer: a list of pages, each a list.
export const pagedItems = (node: Answered) => items(node).flatMap(items);

export const readLabel = (node: Answered): github.IssueLabel => ({ name: text(fields(node)('name')) });

function readLinked<Item>(node: Answered, read: (item: Answered) => Item): github.Linked<Item> {
  if (Array.isArray(node.value)) return items(node).map(read);
  const nodes = fields(node)('nodes');
  return absent(nodes) ? {} : { nodes: items(nodes).map(read) };
}
function readIssueRef(node: Answered): github.IssueRef {
  const field = fields(node);
  return { number: count(field('number')), state: text(field('state')) };
}
export function readIssue(node: Answered): github.Issue {
  const field = fields(node);
  const blockedBy = field('blockedBy');
  const subIssues = field('subIssues');
  return {
    number: count(field('number')),
    title: text(field('title')),
    body: text(field('body')),
    state: text(field('state')),
    labels: items(field('labels')).map(readLabel),
    ...(!absent(blockedBy) && { blockedBy: readLinked(blockedBy, readIssueRef) }),
    ...(!absent(subIssues) && {
      subIssues: readLinked(subIssues, (item) => ({ number: count(fields(item)('number')) })),
    }),
  };
}
export function readComment(node: Answered): github.IssueComment {
  const field = fields(node);
  const user = field('user');
  return {
    id: count(field('id')),
    author: absent(user) ? undefined : text(fields(user)('login')),
    body: text(field('body')),
    createdAt: text(field('created_at')),
  };
}
// A label or an actor GitHub gives as null stays null; one it leaves out stays out.
export function readIssueEvent(node: Answered): approval.IssueEvent {
  const field = fields(node);
  const label = field('label');
  const actor = field('actor');
  return {
    id: count(field('id')),
    event: text(field('event')),
    created_at: text(field('created_at')),
    ...(label.value !== undefined && { label: label.value === null ? null : { name: text(fields(label)('name')) } }),
    ...(actor.value !== undefined && { actor: actor.value === null ? null : { login: text(fields(actor)('login')) } }),
  };
}
export function readPullRequest(node: Answered): github.PullRequest {
  const field = fields(node);
  return {
    number: count(field('number')),
    state: text(field('state')),
    isDraft: flag(field('isDraft')),
    url: text(field('url')),
  };
}
export function readPullRequestView(node: Answered): github.PullRequestView {
  const field = fields(node);
  return {
    ...readPullRequest(node),
    body: text(field('body')),
    headRefName: text(field('headRefName')),
    headRefOid: text(field('headRefOid')),
    isCrossRepository: flag(field('isCrossRepository')),
  };
}
