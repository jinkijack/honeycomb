---
name: honeycomb
description: Delegates coding work to another agent CLI (Kiro, Codex, Codex) in an isolated git worktree, with independent review and a verdict. Use when the request is to implement something worth having checked by a second agent, when you want tasks running in parallel without colliding, or when the user mentions honeycomb, the comb, cross-validation, cross, race, or delegating to Kiro/Codex.
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
| a task on one tool, no review | `honeycomb_run` |
| the task has genuine design ambiguity | `honeycomb_race` |
| a question about work that already ran | `honeycomb_status` |

`cross` is the default. `race` costs N× and returns a choice, not a sum — only
propose it when seeing two approaches is genuinely informative, and state the cost
first.

**Mode** is the agent's permission: `ro` only reads; `verify` reads and runs
build/lint/tests but does not write (the reviewer's mode); `rw` edits without a
shell; `full` is total autonomy and only justifies itself in an isolated worktree.

**Model** matters on Kiro, where the multiplier runs from 0.05× to 2.4×. Before
sending long work there, check `honeycomb_models`. For a cheap review of an
expensive implementation (or the reverse), `cross` accepts a model per role.

## Reading the result

**`VEREDITO: REPROVADO` is a result, not an error.** The reviewer ran the
verification and rejected the work. Do not report it as a technical failure and do
not re-fire by reflex: read the critique, which is usually specific, and decide
with the user whether another round is worth it, whether the spec needs adjusting,
or whether you should take it on yourself. `cross` already sends the critique back
to the implementer on its own up to `maxRounds` — if a rejection reached you, the
rounds are spent.

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
