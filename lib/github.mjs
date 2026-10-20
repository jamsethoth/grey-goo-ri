import { run } from './exec.mjs';
import { has, labels, STATE_LABELS, BUSY_STATES } from './labels.mjs';

const STATE_STYLE = {
  'in-progress': ['fbca04', 'An agent is working on this ticket'],
  'needs-human': ['d93f0b', 'gg stopped; a human is needed'],
  'ready-for-qa': ['0e8a16', 'Review passed; ready for human QA'],
  'needs-replan': ['5319e7', 'The ticket needs a new plan'],
};

let gh = async (args, cwd, input) => (await run('gh', args, { cwd, input })).stdout;
// Tests substitute a fake that records argv and answers canned stdout.
export const setGh = (fn) => { gh = fn; };
const ghJson = async (args, cwd) => JSON.parse(await gh(args, cwd));

// GitHub matches label names case-insensitively, and another Run may create a label between the read and the create:
// a failed create counts as done only once a fresh read shows the label.
export async function ensureLabels(cwd, { prefix = 'gg' } = {}) {
  const read = async () => new Set((await ghJson(['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/labels?per_page=100'], cwd))
    .flat().map((l) => l.name));
  let existing = await read();
  for (const name of STATE_LABELS) {
    const label = labels(prefix).state(name);
    if (has(existing, label)) continue;
    const [color, desc] = STATE_STYLE[name];
    try {
      await gh(['label', 'create', label, '--color', color, '--description', desc], cwd);
    } catch (err) {
      existing = await read().catch(() => { throw err; });
      if (!has(existing, label)) throw err;
    }
  }
}

export const viewIssue = (n, cwd) =>
  ghJson(['issue', 'view', String(n), '--json', 'number,title,body,state,labels,blockedBy,subIssues'], cwd);

export const labelNames = (issue) => issue.labels.map((l) => l.name);

// A ticket is ready when it is open, idle, and every blocker is closed.
export function readinessReason(issue, { prefix = 'gg' } = {}) {
  const busy = BUSY_STATES.map(labels(prefix).state);
  const blockers = issue.blockedBy?.nodes ?? issue.blockedBy ?? [];
  if (issue.state !== 'OPEN') return 'closed';
  const open = blockers.filter((b) => b.state !== 'CLOSED');
  if (open.length) return `blocked by ${open.map((b) => `#${b.number}`).join(', ')}`;
  const label = labelNames(issue).find((l) => has(busy, l));
  return label ? `carries State Label ${label}` : null;
}

export const isReady = (issue, opts) => readinessReason(issue, opts) === null;

export const editLabels = (n, { add = [], remove = [] }, cwd) =>
  gh(['issue', 'edit', String(n), ...add.flatMap((l) => ['--add-label', l]), ...remove.flatMap((l) => ['--remove-label', l])], cwd);

export async function createIssue({ title, body, labels = [], parent, blockedBy = [] }, cwd) {
  const out = (await gh(['issue', 'create', '--title', title, '--body-file', '-', ...labels.flatMap((l) => ['--label', l]),
    ...(parent ? ['--parent', String(parent)] : []), ...(blockedBy.length ? ['--blocked-by', blockedBy.join(',')] : [])], cwd, body)).trim();
  const m = out.match(/^https?:\/\/\S+\/issues\/(\d+)$/);
  if (!m) throw new Error(`gh issue create did not return an issue URL: ${out}`);
  return Number(m[1]);
}

export const findPr = async (branch, cwd) => (await ghJson(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,isDraft,url'], cwd))[0];

// Every open PR for a branch: several can share a head across bases, so the first one proves nothing.
export const openPrs = (branch, cwd) => ghJson(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,state,isDraft,url'], cwd);

export async function upsertPr({ branch, base, title, body }, cwd) {
  const pr = await findPr(branch, cwd);
  if (pr && pr.state === 'OPEN') {
    await gh(['pr', 'edit', String(pr.number), '--body-file', '-'], cwd, body);
    return pr;
  }
  await gh(['pr', 'create', '--draft', '--head', branch, '--base', base, '--title', title, '--body-file', '-'], cwd, body);
  return findPr(branch, cwd);
}

export const viewPr = (n, cwd) => ghJson(['pr', 'view', String(n), '--json', 'number,state,isDraft,url,body,headRefName'], cwd);

// PR conversation comments live on the issues endpoint, so one read serves both.
const comments = async (n, cwd) =>
  (await ghJson(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${n}/comments`], cwd))
    .flat().map((c) => ({ id: c.id, body: c.body, createdAt: c.created_at }));
export const prComments = comments;
export const issueComments = comments;

// `gh api --include` prints the status line and headers before the body, on an HTTP error too: a retry reads
// Retry-After and the rate-limit headers from them.
function included(text) {
  const [, head = '', body = ''] = String(text).match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/) ?? [];
  const [statusLine = '', ...lines] = head.split(/\r?\n/);
  const headers = Object.fromEntries(lines.map((l) => l.match(/^([^:]+):\s*(.*)$/)).filter(Boolean).map(([, k, v]) => [k.toLowerCase(), v]));
  return { status: Number(statusLine.match(/^HTTP\/\S+ (\d{3})/)?.[1]) || null, headers, body };
}

// A PR conversation comment is an issue comment, so one POST serves both. Returns the comment's URL.
async function postComment(n, body, cwd) {
  const args = ['api', '--include', '--method', 'POST', `repos/{owner}/{repo}/issues/${n}/comments`, '--input', '-'];
  let out;
  try {
    out = await gh(args, cwd, JSON.stringify({ body }));
  } catch (err) {
    const { status, headers } = included(err.stdout ?? '');
    if (status) err.http = { status, headers };
    throw err;
  }
  return JSON.parse(included(out).body).html_url;
}
export const comment = postComment;
export const commentIssue = postComment;
export const markReady = (prNumber, cwd) => gh(['pr', 'ready', String(prNumber)], cwd);
export const closePr = (prNumber, cwd) => gh(['pr', 'close', String(prNumber)], cwd);

// When the in-progress State Label was last added; null if the issue's events have no such entry.
export async function inProgressSince(n, cwd, { prefix = 'gg' } = {}) {
  const name = labels(prefix).state('in-progress');
  const pages = await ghJson(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${n}/events`], cwd);
  return pages.flat().filter((e) => e.event === 'labeled' && has([e.label?.name ?? ''], name)).at(-1)?.created_at ?? null;
}

// gh and git put the useful reason on the lines after "exited N", so keep a few, bounded.
export const errorExcerpt = (err) => err.message.split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 300);

// A failed label update must not vanish: it leaves the ticket looking idle or stuck on GitHub.
export async function setLabels(n, change, cwd, { log, ev, ensureLabels }) {
  try {
    if (ensureLabels) await ensureLabels();
    await editLabels(n, change, cwd);
    return true;
  } catch (err) {
    const error = errorExcerpt(err);
    log(`#${n} ERROR label update ${JSON.stringify(change)} failed: ${error}`);
    ev('label_failed', { ticket: n, change, error });
    return false;
  }
}
