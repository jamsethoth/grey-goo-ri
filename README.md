# grey-goo-ri

Grey goo, regulated intelligence. A configurable bounded workflow graph of persona Agents, each a persona, model, effort and tool set
handed to an agentic harness (Claude Code or Codex CLI), that takes GitHub tickets from plan to reviewed pull request
with deterministic gates, full tracing and usage metrics. Successor to feature-flow.

Status: under construction, and not yet usable on a real ticket.

- `gg doctor` validates the configuration and prints each Resolved Flow.
- `gg run <ticket>` would carry a Ticket through its Flow, but the Claude Code and Codex Harnesses are stubs, so its
  preflight fails with "not implemented" for every Vertex that has an Agent, before any Ticket is admitted.
- `gg init`, `plan`, `publish`, `work`, `trace` and `stats` are not implemented.

## Install

gg installs from a clone of this repository, linked into npm's global prefix. It needs Node 26.13 or later.

```
git clone https://github.com/jamsethoth/grey-goo-ri.git
cd grey-goo-ri
npm ci
npm install -g .
```

`npm ci` installs gg's dependencies in the clone, not globally. `npm install -g .` (or `npm link` in the clone) puts a
link to the clone in the global `node_modules` and a `gg` command on the path, so `gg` runs the clone's files. Check it
with `gg --help`.

To update, run `git pull` and then `npm ci` in the clone; the link stays. To remove gg, run
`npm uninstall -g grey-goo-ri`.

A copy of gg cannot start, so `npm install -g <tarball>`, `npm install -g git+https://…` and a published package all
fail with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. gg's TypeScript runs through Node's type stripping, with no
build step (ADR 0018), and Node will not strip types in a file whose real path is under `node_modules`. A linked install
keeps every real path in the clone. `package.json` is private, so `npm publish` refuses gg until
[grey-goo-ri issue #243](https://github.com/jamsethoth/grey-goo-ri/issues/243) builds it for publishing.

Behaviour is decided by `docs/requests/node-harness-dag.md`; contributors and agents start at `AGENTS.md`.

License: AGPL-3.0-or-later.
