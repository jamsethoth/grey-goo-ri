---
status: accepted
date: 2026-11-28
---

# A push or pr-upsert of a branch with nothing to publish ends the Visit nothing-to-publish

Amends the request's engine Outcomes and the frozen Execution Record (#23, `docs/interfaces/record.md`) for
grey-goo-ri issue #490. A `commit` with nothing to commit is a no-op (U2), and red's `no-test` route goes on to green,
so a Ticket whose behaviour already exists reaches `push` and `pr-upsert` with a branch equal to its base. The push
published the base's own tip, `gh pr create` refused with "No commits between", `classOf` called the refusal `unknown`,
and the Ticket ended at needs-human as an unexpected fault (live trial A1, 2026-11-21). The owner decided Clarify's Q1
and Q2 A on 2026-11-28.

1. **Both `push` and `pr-upsert` check (Q1 A).** Each counts the commits the branch has that `origin/<baseBranch>`
   lacks, after fetching it (`git.commitsAhead`), since that is what GitHub compares and the ticket branch is cut from
   it. A `pr-upsert` asks only when gh finds no open PR, as `gh pr create` runs only then. At zero the Action makes no
   effect: no branch equal to its base is pushed and no PR is created for one. An open intent passed the check when it
   was made, so a resumed Action finishes it without asking again.
2. **A new engine Outcome, `nothing-to-publish` (Q2 A).** The Action stops the Visit through a new fixed row,
   `nothing-to-publish`, with direction `stop`. Like `failed` and the `harness-*` Outcomes, it is routable and ends at
   `end: needs-human` by default; the validator lists it among the Outcomes of every Procedure with a `push` or
   `pr-upsert` Action, and reserves the name, so no Procedure may give its own Outcome that name. It is not a fault:
   its Terminal Reason reads "Nothing to publish: the branch has no change from <base>; if no change was needed,
   `gg work done <n> --close`.", L12's end for a Ticket that needed no change.
3. **The example routes it in its Flow routes**, to `end: needs-human`, so the route reads as chosen rather than as the
   `*` fallback.
4. **`classOf` is unchanged.** Every other `gh pr create` refusal stays a final `unknown` failure; no "No commits
   between" pattern is added.
5. **`RECORD_SCHEMA_VERSION` goes to 5** under ADR 0024's rule: the fixed row `nothing-to-publish` is saved, and a
   version 4 row, which holds none, still reads. The Epic Record shares the version. `EVENT_SCHEMA_VERSION` stays at 3:
   an Action Event's `outcome` and `rule.row` are strings already.

## Considered options

- Push only (Q1 B). Rejected: a Procedure with `pr-upsert` and no `push` before it, which the validator allows and the
  example's `review` and `publish` are, would still fault.
- `pr-upsert` only. Rejected: the push would already have left a branch equal to its base on origin.
- A Check the Flow places before `push`. Rejected: a Check may not follow an effect (`check-after-effect`), so it could
  not see what the commit made, and a Flow without it would still fault.
- A "No commits between" pattern in `classOf`. Rejected: it still pushes and still ends as a failure.
- End the Execution as Held, with no new Outcome (Q2 B). Rejected: Held means gg could not decide safely, and here it
  decided; no Flow could route it.
