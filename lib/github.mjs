import { run } from './exec.mjs';
import { DEFAULT_PREFIX, has, labels, NEEDS_HUMAN, STATE_LABELS, BUSY_STATES } from './labels.mjs';
import { classifyRemoteFailure } from './outcome.mjs';

const STATE_STYLE = {
  'in-progress': ['fbca04', 'An agent is working on this ticket'],
  [NEEDS_HUMAN]: ['d93f0b', 'gg stopped; a human is needed'],
  'ready-for-qa': ['0e8a16', 'Review passed; ready for human QA'],
  'needs-replan': ['5319e7', 'The ticket needs a new plan'],
};

const defaultTransport = async (args, cwd, input) => (await run('gh', args, { cwd, input })).stdout;

export const labelNames = (issue) => issue.labels.map((l) => l.name);

// A ticket is ready when it is open, idle, and every blocker is closed.
export function readinessReason(issue, { prefix = DEFAULT_PREFIX } = {}) {
  const busy = BUSY_STATES.map(labels(prefix).state);
  const blockers = issue.blockedBy?.nodes ?? issue.blockedBy ?? [];
  if (issue.state !== 'OPEN') return 'closed';
  const open = blockers.filter((b) => b.state !== 'CLOSED');
  if (open.length) return `blocked by ${open.map((b) => `#${b.number}`).join(', ')}`;
  const label = labelNames(issue).find((l) => has(busy, l));
  return label ? `carries State Label ${label}` : null;
}

export const isReady = (issue, opts) => readinessReason(issue, opts) === null;

// `gh api --include` stdout: the status line and headers before the body.
function included(text) {
  const [, head = '', body = ''] = String(text).match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/) ?? [];
  const [statusLine = '', ...lines] = head.split(/\r?\n/);
  const headers = Object.fromEntries(
    lines
      .map((l) => l.match(/^([^:]+):\s*(.*)$/))
      .filter(Boolean)
      .map(([, k, v]) => [k.toLowerCase(), v]),
  );
  return { status: Number(statusLine.match(/^HTTP\/\S+ (\d{3})/)?.[1]) || null, headers, body };
}

// The id of the comment a comment URL names, or null.
export const commentId = (url) => Number(String(url).match(/issuecomment-(\d+)/)?.[1]) || null;

// gh and git put the useful reason on the lines after "exited N", so keep a few, bounded.
export const errorExcerpt = (err) => err.message.split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 300);

// The gh verbs over `transport`, which runs gh with argv, a working directory and stdin and returns its stdout. The
// entry point passes none, so gh itself runs; a test passes a fake that records argv and answers canned stdout.
export function createGh(transport = defaultTransport) {
  // `gh api --include` prints the status line and headers on an HTTP error too, so a retry reads Retry-After and the
  // rate-limit headers from them. A rate limit that gives no wait is read from GitHub's own quota, once (#85).
  async function gh(args, cwd, input) {
    try {
      return await transport(args, cwd, input);
    } catch (err) {
      const { status, headers } = included(err?.stdout ?? '');
      if (status) err.http = { status, headers };
      await probeRateLimit(err, args, cwd);
      throw err;
    }
  }

  // gh pr verbs spend the GraphQL quota and gh api the REST one. Only an exhausted quota's reset is a wait; a failed
  // read leaves the fallback.
  async function probeRateLimit(err, args, cwd) {
    const failure = classifyRemoteFailure(err);
    if (failure.class !== 'rate-limited' || failure.retryAfterMs !== null || failure.resetAt !== null) return;
    try {
      const { remaining, reset } = JSON.parse(await transport(['api', 'rate_limit'], cwd)).resources[
        args[0] === 'api' ? 'core' : 'graphql'
      ];
      if (remaining === 0 && Number.isFinite(reset)) err.rateLimit = { resetAt: reset * 1000 };
    } catch {}
  }
  const ghJson = async (args, cwd) => JSON.parse(await gh(args, cwd));

  // GitHub matches label names case-insensitively, and another Run may create a label between the read and the create:
  // a failed create counts as done only once a fresh read shows the label.
  async function ensureLabels(cwd, { prefix = DEFAULT_PREFIX } = {}) {
    const read = async () =>
      new Set(
        (await ghJson(['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/labels?per_page=100'], cwd))
          .flat()
          .map((l) => l.name),
      );
    let existing = await read();
    for (const name of STATE_LABELS) {
      const label = labels(prefix).state(name);
      if (has(existing, label)) continue;
      const [color, desc] = STATE_STYLE[name];
      try {
        await gh(['label', 'create', label, '--color', color, '--description', desc], cwd);
      } catch (err) {
        existing = await read().catch(() => {
          throw err;
        });
        if (!has(existing, label)) throw err;
      }
    }
  }

  const viewIssue = (n, cwd) =>
    ghJson(['issue', 'view', String(n), '--json', 'number,title,body,state,labels,blockedBy,subIssues'], cwd);

  const editLabels = (n, { add = [], remove = [] }, cwd) =>
    gh(
      [
        'issue',
        'edit',
        String(n),
        ...add.flatMap((l) => ['--add-label', l]),
        ...remove.flatMap((l) => ['--remove-label', l]),
      ],
      cwd,
    );

  async function createIssue({ title, body, labels = [], parent, blockedBy = [] }, cwd) {
    const out = (
      await gh(
        [
          'issue',
          'create',
          '--title',
          title,
          '--body-file',
          '-',
          ...labels.flatMap((l) => ['--label', l]),
          ...(parent ? ['--parent', String(parent)] : []),
          ...(blockedBy.length ? ['--blocked-by', blockedBy.join(',')] : []),
        ],
        cwd,
        body,
      )
    ).trim();
    const m = out.match(/^https?:\/\/\S+\/issues\/(\d+)$/);
    if (!m) throw new Error(`gh issue create did not return an issue URL: ${out}`);
    return Number(m[1]);
  }

  const findPr = async (branch, cwd) =>
    (await ghJson(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,isDraft,url'], cwd))[0];

  // Every open PR for a branch: several can share a head across bases, so the first one proves nothing.
  const openPrs = (branch, cwd) =>
    ghJson(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,state,isDraft,url'], cwd);

  async function upsertPr({ branch, base, title, body }, cwd) {
    const pr = await findPr(branch, cwd);
    if (pr && pr.state === 'OPEN') {
      await gh(['pr', 'edit', String(pr.number), '--body-file', '-'], cwd, body);
      return pr;
    }
    await gh(
      ['pr', 'create', '--draft', '--head', branch, '--base', base, '--title', title, '--body-file', '-'],
      cwd,
      body,
    );
    return findPr(branch, cwd);
  }

  // The head (repository, ref and commit) is what pr-ready checks before every launch (M1).
  const viewPr = (n, cwd) =>
    ghJson(
      ['pr', 'view', String(n), '--json', 'number,state,isDraft,url,body,headRefName,headRefOid,isCrossRepository'],
      cwd,
    );

  // PR conversation comments live on the issues endpoint, so one read serves an issue and a PR.
  const comments = async (n, cwd) =>
    (await ghJson(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${n}/comments`], cwd))
      .flat()
      .map((c) => ({ id: c.id, body: c.body, createdAt: c.created_at }));

  // A PR conversation comment is an issue comment, so one POST serves an issue and a PR. Returns the comment's URL.
  async function comment(n, body, cwd) {
    const args = ['api', '--include', '--method', 'POST', `repos/{owner}/{repo}/issues/${n}/comments`, '--input', '-'];
    return JSON.parse(included(await gh(args, cwd, JSON.stringify({ body }))).body).html_url;
  }

  const markReady = (prNumber, cwd) => gh(['pr', 'ready', String(prNumber)], cwd);
  const closePr = (prNumber, cwd) => gh(['pr', 'close', String(prNumber)], cwd);

  // When the in-progress State Label was last added; null if the issue's events have no such entry.
  async function inProgressSince(n, cwd, { prefix = DEFAULT_PREFIX } = {}) {
    const name = labels(prefix).state('in-progress');
    const pages = await ghJson(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${n}/events`], cwd);
    return (
      pages
        .flat()
        .filter((e) => e.event === 'labeled' && has([e.label?.name ?? ''], name))
        .at(-1)?.created_at ?? null
    );
  }

  // A failed label update must not vanish: it leaves the ticket looking idle or stuck on GitHub.
  async function setLabels(n, change, cwd, { log, ev, ensureLabels }) {
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
  return {
    ensureLabels,
    viewIssue,
    editLabels,
    createIssue,
    findPr,
    openPrs,
    upsertPr,
    viewPr,
    comments,
    comment,
    markReady,
    closePr,
    inProgressSince,
    setLabels,
    labelNames,
    readinessReason,
    isReady,
    commentId,
    errorExcerpt,
  };
}
