# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Code, comments and commit messages in this repository are in English.
> Comments explain **why**, not what — keep that standard when editing.
>
> User-facing strings (UI labels, CLI help, agent prompts) are still in
> Portuguese. That is a known inconsistency, tracked in `ANALYSIS.md`.

## Commands

```bash
npm run setup     # install root and web/ deps (once)
npm start         # daemon + compiled UI at http://127.0.0.1:4317
npm run dev       # daemon with --watch (restarts on save)
npm run web       # Vite on :5317 proxying the daemon (frontend hot reload)
npm run build     # compile web/dist (npm start only serves the UI if dist exists)
npm run mcp       # MCP server over stdio (for debugging; clients spawn their own)
```

There is no test suite, linter or typecheck in this repository — `npm test` does
not exist. Validation is manual: `npm run dev` and exercise it through
`bin/honeycomb.mjs` or the UI. (The `npx tsc --noEmit` / `npm run lint` /
`npm test` commands that appear in the code are the **defaults injected into the
validator's prompt** for the agent's target repo, not commands for this project.)

After `npm link` the CLI is on PATH as `honeycomb` (alias `hc`), and the MCP
server as `honeycomb-mcp`. Otherwise invoke by path: `node bin/honeycomb.mjs
<cmd>`. It talks HTTP to the daemon at `HONEYCOMB_URL` (default
`http://127.0.0.1:4317`) — **the daemon must be running**.

## Architecture

A local daemon that treats Claude Code, Kiro CLI and Codex CLI as interchangeable
executors of coding tasks, each running in an isolated git worktree.

```
config.mjs → store.mjs (JSON) → bus.mjs → adapters/ → runner.mjs → orchestrator.mjs
                                                         ↓              ↓
                              index.mjs (HTTP + WS) ← bin/honeycomb.mjs / web/ / mcp.mjs
```

**`bus.mjs` is the axis of the design.** Every adapter translates its CLI's output
into the same event vocabulary (`status`, `text`, `thinking`, `tool_use`,
`tool_result`, `result`, `error`, `log`). That is what lets the orchestrator, UI
and CLI treat all three tools as one abstraction. Events are numbered by `seq` and
written to `data/logs/<runId>.ndjson`, which gives replay
(`GET /api/runs/:id/events?fromSeq=`) — the CLI and the MCP server poll that
endpoint instead of using the WebSocket.

**Adapters (`server/adapters/`)** expose `{ name, displayName, capabilities,
available(), listSessions(), run() }`. `run()` returns `{ child, sessionId, done }`
— the `child` is what makes cancellation possible, and the `pid` is persisted so a
new daemon can recognise orphans. To add a tool: write the adapter, register it in
`adapters/index.mjs`, and declare `capabilities` honestly — the UI uses
`structuredEvents`, `resume` and `cost`/`tokens` to avoid promising detail that
does not exist.

Each adapter maps the 4 permission modes (`ro`, `verify`, `rw`, `full`) onto its
CLI's flags (`PERMISSION` in claude, `TRUST` in kiro, `SANDBOX` in codex).
`verify` = reads and executes but does not write; it is the validator's mode.
`full` only makes sense inside an isolated worktree.

**`runner.mjs`** is a run's life cycle: concurrency queue (`MAX_CONCURRENT`, the
excess sits `queued`), worktree creation, retry on transient failure only (the
`TRANSIENT` regex list; when in doubt it is **not** transient), diff at the end,
persistence. States: `queued` → `preparing` → `running` →
`done`/`failed`/`cancelled`/`blocked`/`interrupted`.

**`orchestrator.mjs`** runs a DAG of steps in waves (`topoOrder` validates cycles
before persisting; everything with resolved dependencies runs in parallel). Two
mechanisms carry the project's value:

- **`gate: true`** — the step rejects the chain if it fails technically **or** if
  its output contains `VEREDITO: REPROVADO` (the `VERDICT` regex).
- **`retry: { of: '<stepId>', max: N }`** — on rejection the critique goes back to
  the target step, which reworks **inside the worktree it already produced**
  (`cwdOverride`), and the reviewer revalidates. Careful when editing: a retry runs
  as `shared` and `startRun` returns `worktree: null`; there is explicit code
  preserving the previous worktree — without it every step using `workdirFrom`
  loses its reference.
- **`workdirFrom: '<id>'`** — runs inside another step's worktree instead of
  creating its own. That is how the validator sees the implementer's work.
- Prompt interpolation: `{{repo}}`, `{{steps.<id>.output|diff|patch|workdir}}`.

The `crossValidationTemplate` and `raceTemplate` prompts are long and deliberate
(the validator is required to list what it ran; the judge must end with
`VENCEDOR: <id>`). Changing that text changes product behaviour — treat it as
code, not as commentary.

**`worktree.mjs`** — each run gets a directory under `worktrees/` and a branch
`honeycomb/<slug>-<ts>` off the current HEAD. `node_modules`/`vendor`/`.venv`/
`target` are **symlinked** (copying would kill parallelism); removal undoes the
symlinks before `git worktree remove` so it never deletes the main repo's
`node_modules`. `worktreeDiff` runs `git add -AN` so new files appear without a
commit, and explicitly excludes the dependency symlinks — without that they show
up as new files in every agent diff. `findLandedIn` compares blob hashes against
the refs to detect work already taken to another branch out of band.

**`store.mjs`** — two JSON tables (`data/runs.json`, `data/tasks.json`) rewritten
whole on every `put`/`patch` (tmp + rename). Adequate for dozens of records/day;
swappable for SQLite without touching the routes. See `ANALYSIS.md`.

**`recovery.mjs`** runs at boot before accepting work: runs left `running` by a
dead daemon become `interrupted` (a state distinct from `failed` and `cancelled`)
and orphan processes are killed. Reattaching is impossible — the stdout carrying
the events died with it.

**`budget.mjs`** — ceilings in credit, checked **between steps** (the only point
where stopping avoids new spend without discarding what was already paid for).
There is deliberately no per-run ceiling. Tokens sit outside the ceilings and
outside the cost totals: different units do not add up — that separation shows up
in `metrics.mjs`, in the CLI and in the UI, and it is intentional.

**`gc.mjs`** — collects empty and already-committed worktrees; `dirty` never goes
automatically and `includeDirty` **requires a scope** (`repo` or `dirs`), otherwise
it would sweep other repositories' worktrees. A conservative pass is scheduled
every 6h.

**`mcp.mjs`** exposes the same HTTP API as a stdio MCP server (official SDK, 14
tools). It is a thin shell on purpose — worktree, queue, ceiling and verdict logic
already live in the daemon, and reimplementing here would create a third behaviour
to keep in sync. Blocking steps emit `notifications/progress` per agent event:
that is not decoration, it is what stops the client aborting the call for
idleness (30min on stdio, 5min on HTTP). `progress` must be strictly increasing —
for runs that comes from the bus `seq`.

## Surfaces

The daemon binds to loopback on purpose: it starts agents with write and shell
permission. Do not change `HOST` to `0.0.0.0`.

Four clients consume the same HTTP/WS API (`server/index.mjs`): the CLI
(`bin/honeycomb.mjs`), the React/Vite frontend (`web/`, WebSocket at `/ws`), the
MCP server (`server/mcp.mjs`) and any orchestrating agent. When adding an
endpoint, consider exposing it in the CLI and in MCP too — the CLI is the
interface built to be chained in a shell, MCP is the one other agents see.

The CLI contract, which must be preserved: events on **stderr**, result on
**stdout**, and exit codes `0` ok / `1` technical failure / `2` bad usage /
`3` rejected on the merits / `4` daemon down. Colour is decided per stream
(`isTTY` + `NO_COLOR`), so redirecting stdout never writes escape codes into it.

`shared/format.mjs` holds the formatters used by all three surfaces. The rule that
**cost and tokens never add up** is encoded there; do not re-implement it locally.

## Environment variables

`HONEYCOMB_PORT` (4317), `HONEYCOMB_HOST` (127.0.0.1), `HONEYCOMB_MAX_CONCURRENT` (3),
`HONEYCOMB_TASK_BUDGET` / `HONEYCOMB_DAILY_BUDGET` (0 = off),
`HONEYCOMB_TRANSIENT_RETRIES` (2), `HONEYCOMB_TIMEOUT_MS` (20min),
`HONEYCOMB_DATA_DIR`, `HONEYCOMB_WORKTREE_DIR`,
`HONEYCOMB_CLAUDE_BIN` / `HONEYCOMB_KIRO_BIN` / `HONEYCOMB_CODEX_BIN`,
`HONEYCOMB_URL` (used by the CLI and the MCP server).

## Tool quirks

- **Kiro** has no structured output: the adapter strips ANSI and rebuilds events
  heuristically, splitting its reading between stdout (the answer) and stderr
  (cost, warnings, sessions). Its models carry a **cost multiplier from 0.05× to
  2.4×** — the fact that justifies the model selector existing.
- **Codex** reports **tokens, not cost** (`cost` stays null on purpose); `ro` and
  `verify` collapse into the same `read-only` sandbox; `exec resume` accepts
  neither `--sandbox` nor `-C`, so resuming a session does not make it more
  restricted. Saved sessions are read from `~/.codex/sessions/**/rollout-*.jsonl`.
- **Claude Code** is the reference adapter (NDJSON, session id imposed by us, live
  sessions via `agents --json`, real cost) — the normalized event format was
  designed from what it delivers.

## Documents

`README.md` documents the product and its design decisions in detail;
`ANALYSIS.md` is an honest audit of known issues — read it before assuming
something is broken by accident rather than by known limitation.
