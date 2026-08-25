---
name: honeycomb
description: Delegates coding work to another agent CLI (Kiro, Codex, Claude Code, Cursor) in an isolated git worktree, with independent review, an optional stage that boots the project and tests it, and a verdict. Use when the request is to implement something worth having checked by a second agent, when it matters that the change works when run and not only that it compiles, when you want tasks running in parallel without colliding, or when the user mentions honeycomb, the comb, cross-validation, cross, race, QA, or delegating to Kiro/Codex/Cursor.
---

# Honeycomb

Orchestrates other agent CLIs as executors. Each one works in its own cell — a
git worktree with a separate branch — so nothing touches the user's working tree
until someone says so.

The `honeycomb_*` MCP tools carry each operation's signature. This skill is about
**when** to use them and how to read what comes back.

## When to delegate, and when not to

Delegate when the task is big enough that you cannot honestly check yourself, when
two independent readings are worth more than one, or when the user explicitly asks.
Editing directly is better for small changes, for what you already understand
whole, and for anything depending on the context of this conversation — the
delegated agent starts from zero and only knows what is in the spec.

**The spec is the work.** The implementer does not see this conversation. Write
what it needs: where the files are, which pattern to follow, what counts as done.
A vague spec does not produce bad code — it produces a correction round, which
costs twice.

## Choosing the shape

| situation | tool |
|---|---|
| implement something that needs checking | `honeycomb_cross` |
| ...and it matters that it works when run | `honeycomb_cross` with `qa: true` |
| a task on one tool, no review | `honeycomb_run` |
| the task has genuine design ambiguity | `honeycomb_race` |
| a flow that broke partway | `honeycomb_restart` |
| review or test work that already exists | `honeycomb_run` with `role` |
| a question about work that already ran | `honeycomb_status` |

`cross` is the default. `race` costs N× and returns a choice, not a sum — only
propose it when seeing two approaches is genuinely informative, and state the cost
first.

## The QA stage (`qa: true`)

The reviewer answers *is this code right*: it reads the diff and runs the
project's build, checks and tests. It does not answer *does it work when you run
it* — nobody started the application. `qa: true` appends a third agent that does:
it boots the project on reserved ports, derives a test plan from what the diff
actually changed, and exercises it — HTTP calls for endpoints, a real message on
the broker for consumers, a browser for screens — plus the regression around it.

**Turn it on** for a change with a runtime surface: a new or altered endpoint, a
consumer, a screen, a migration, anything touching boot or configuration. **Leave
it off** for a refactor with tests covering it, a documentation change, or work
whose whole verification is static. It costs a third agent and the wall-clock time
of starting a project, which plenty of changes do not justify.

A QA rejection re-enters the loop through the reviewer, not straight back to the
tester — a fix written to close a defect is code nobody has read yet. So a QA
round costs implementer + reviewer + tester.

**Nothing presumes a stack.** The tester identifies the project first — manifest,
boot command, infrastructure, and how *that* stack takes a port — before trying
anything, so Maven, Django, Go and Rails work the same way Node does. Pass
`startCommand` and `baseUrl` when you already know them: it skips the discovery
and removes a way to get it wrong. `verifyCommands` likewise only pins what the
reviewer would otherwise find on its own; leave it out unless you want exactly
those commands and no others.

**The browser is a prerequisite, not a given.** The default `agent-browser` has to
be installed (`npm i -g agent-browser` plus `agent-browser install`), and
`chrome-devtools` is an MCP server that Kiro and Cursor cannot receive on the
command line. When the choice cannot be delivered the step comes back with a
`note` saying so — read it. A missing browser is invisible from inside the prompt:
the tester never sees the tools and reports the screen as untestable, which looks
exactly like a screen that is broken.

Artefacts — the plan, logs, screenshots, new Bruno requests — are committed to the
worktree branch under `.honeycomb/qa/`, so they survive the run.

**Mode** is the agent's permission: `ro` only reads; `verify` reads and runs
build/lint/tests but does not write (the reviewer's mode); `rw` edits without a
shell; `full` is total autonomy and only justifies itself in an isolated worktree.

**Model** matters on Kiro, where the multiplier runs from 0.05× to 2.4×. Before
sending long work there, check `honeycomb_models`. Cursor encodes effort and speed
in the model id itself (`-low`/`-high`/`-xhigh`, `-fast`), so the choice there is
the same knob under another name. For a cheap review of an
expensive implementation (or the reverse), `cross` accepts a model per role.

## When a flow breaks partway

Steps die for reasons that are nobody's fault — a rate limit, a spend ceiling,
the daemon restarting. `honeycomb_restart` keeps every step that finished and
re-runs the rest, so the reviewer re-enters the implementer's worktree instead of
a new one. Reach for it before proposing a fresh `cross`: re-running the flow
pays for an implementation that already exists.

Call it with `plan: true` first and show the user what would be reused and what
would be paid for again. It refuses when the work being reused was discarded —
that refusal is correct, not a bug to route around, because the alternative is a
verdict issued on the wrong tree.

A `rejected` step re-runs too. Over unchanged code it will reject again, so it is
only worth it when something actually changed — you or the user edited the
worktree by hand.

## Running one step on its own

`honeycomb_run` takes a `role`: `validator` reviews the worktree of the run named
in `of`, `qa` boots that project and exercises it. The prompt, the permission mode
and the directory come from the target, not from you — that is what makes a review
fired by hand comparable to one inside a `cross`.

Use it to get a second opinion from a different tool on work already done, or to
test something that was implemented without QA. `of` is required and its worktree
must still exist.

## Reading the result

**`VEREDITO: REPROVADO` is a result, not an error.** The reviewer ran the
verification and rejected the work. Do not report it as a technical failure and do
not re-fire by reflex: read the critique, which is usually specific, and decide
with the user whether another round is worth it, whether the spec needs adjusting,
or whether you should take it on yourself. `cross` already sends the critique back
to the implementer on its own up to `maxRounds` — if a rejection reached you, the
rounds are spent.

Read *which* step rejected. The reviewer refusing means the code is wrong on
inspection. The tester refusing means it was executed and misbehaved, or could not
be executed at all — and "I could not boot the project" is a legitimate QA
rejection that says nothing about the code. The step's report distinguishes them;
do not collapse both into "it failed".

The work stays in the worktree, **not** on the user's branch. Flow after approval:
`honeycomb_diff` to see what changed → `honeycomb_commit` to consolidate on the
agent's branch → the user merges. Never merge or touch their branch on your own.

`honeycomb_discard` is irreversible and deletes uncommitted work — always confirm
first.

## Long calls

A `cross` takes from minutes to over an hour. Leave `wait: true` (the default):
the call emits progress, and the client moves it to the background on its own
after two minutes, so you are not blocked. Use `wait: false` when running as a
subagent, because there the call really does block.

The run lives in the daemon, not in the call. If the session dies the agent keeps
working and the worktree stays — `honeycomb_status <id>` finds everything later.

## When MCP is unavailable

The daemon must be running (`npm start` in the Honeycomb directory); without it
every tool reports being unreachable. The same surface exists in the CLI as
`honeycomb <command>` (or `hc`), with events on stderr and the result on stdout —
exit code 3 means rejected on the merits, distinct from 1, which is a technical
failure.
