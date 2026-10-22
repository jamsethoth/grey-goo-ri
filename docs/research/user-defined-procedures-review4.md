# User-defined Procedures: design review round 4, merged

The last review before slicing, of a120ca6 (2026-10-22), by Astra (B1–B3) and Fable (G1–G9); the
[raw reviews](user-defined-procedures-review4-raw.md). Each finding was checked against main at bd60df9. Neither found
the design wrong; every item is a clarification a slice would otherwise have to invent.

## Should settle before slicing

- **W1. Where `recover` is declared. (Both: B3, G1.)** T4a says "a Vertex setting"; the example declares it in each
  Procedure. T4's point was scope (one recovery budget per Visit, not per Check). Recommendation: `recover` is a
  Procedure setting, like `tests` and `access`, applying per Visit; no Vertex override (U7: a variant is a second
  Procedure). Amends T4a's wording; reading-guide row.
- **W2. One reference form. (Astra B1.)** The example mixes `reviewer.review.findings` and `review.response.findings`.
  Recommendation: `<vertex>.<action id>.<field>`, where an agent Action's field is `response` (so
  `reviewer.review.response.findings`); a Vertex's own outputs drop the Vertex.
- **W3. The rescue output. (Fable G6.)** `implementer-fix.rescue` has no producing Action. Recommendation:
  `<vertex>.rescue` is the one Vertex-level output, `{ ref, diffStat, output }`, written by gg when R5a rescues.
- **W4. `pr-upsert` and draft state. (Fable G4.)** Today it always creates a draft and never changes draft state
  (`lib/github.mjs:93-101`). Recommendation: say so and drop the `draft` flag; only `pr-ready` publishes (R11d).
- **W5. The review comment's target. (Fable G3.)** Today it goes to the PR (`lib/interpreter.mjs:823`).
  Recommendation: `comment` takes `target: pr | ticket`; stop-token comments always go to the Ticket (U6).

## Small fixes

- **W6. What a stop template reads. (Fable G2, G5.)** U6 needs the Terminal Reason, which U1's context lacks, and one
  `blocked.md` over three schemas can only name shared fields; today's reads `notes`, which the review schema lacks
  (`lib/render.mjs:166-171`). Recommendation: U1's context adds the Terminal Reason and end name for stop templates;
  `blocked.md` reads `summary` and `diagnosis` (every schema has both), and the Brief tells a blocked agent to explain
  in `diagnosis`.
- **W7. `implementer-fix.previous`. (Astra B2.)** `fix.md` reads `previous`, which only `senior-dev` declares.
  Recommendation: `implementer-fix` declares it optional too (it has a producing path through `senior-red`).
- **W8. Stale text. (Fable G7.)** Add T13 to the R4b → P5a reading-guide row; the example's U1 note says `red` also
  reads `findings`.

## Questions for the owner

- **W9. The Epic's replan comment. (Fable G8.)** Today it reads `response.diagnosis` by name
  (`lib/interpreter.mjs:932-947`). Recommendation: the Epic gets the same rendered stop-token comment as the Ticket;
  no reserved field (D3).
- **W10. `green` after a retest. (Fable G9.)** `green` never sees the review's findings, so non-test findings wait
  for the next review and spend a `changes` traversal. Recommendation: `green` declares `findings` optional, as `red`
  does.

## Confirmed by both

U1–U15 landed in the decisions file and the example. Every Outcome is routed, every cycle bounded, every required
input produced on every path per Outcome (T6 lists and `with:` bindings included), publishing fenced, commits guarded,
rescue on the effective target. No further silent loss against today's Flow.
