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
`bin/honeycomb.mjs` or the UI. (Commands like `npm test` that appear inside the
prompt strings are examples handed to the agent for **its** target repo — the
validator and the QA stage discover the real ones there; none of them are
commands for this project.)

After `npm link` the CLI is on PATH as `honeycomb` (alias `hc`), and the MCP
server as `honeycomb-mcp`. Otherwise invoke by path: `node bin/honeycomb.mjs
<cmd>`. It talks HTTP to the daemon at `HONEYCOMB_URL` (default
`http://127.0.0.1:4317`) — **the daemon must be running**.

## Architecture

A local daemon that treats Claude Code, Kiro CLI, Codex CLI and Cursor CLI as
interchangeable executors of coding tasks, each running in an isolated git
worktree.

```
config.mjs → store.mjs (JSON) → bus.mjs → adapters/ → runner.mjs → orchestrator.mjs
                                                         ↓              ↓
                              index.mjs (HTTP + WS) ← bin/honeycomb.mjs / web/ / mcp.mjs
```

**`bus.mjs` is the axis of the design.** Every adapter translates its CLI's output
into the same event vocabulary (`status`, `text`, `thinking`, `tool_use`,
`tool_result`, `result`, `error`, `log`). That is what lets the orchestrator, UI
and CLI treat all four tools as one abstraction. Events are numbered by `seq` and
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
CLI's flags (`PERMISSION` in claude, `TRUST` in kiro, `SANDBOX` in codex, `MODE`
in cursor).
`verify` = reads and executes but does not write; it is the validator's mode.
`full` only makes sense inside an isolated worktree.

**`runner.mjs`** is a run's life cycle: concurrency queue (`MAX_CONCURRENT`, the
excess sits `queued`), worktree creation, retry on transient failure only (the
`TRANSIENT` regex list; when in doubt it is **not** transient), diff at the end,
persistence. States: `queued` → `preparing` → `running` →
`done`/`failed`/`cancelled`/`blocked`/`interrupted`.

**`proc.mjs`** — killing an agent means killing what it spawned. Every one of
these CLIs is a launcher: `kiro-cli` forks `kiro-cli-chat`, and the grandchild is
what works. `child.kill()` reaches only the direct child, so the worker survived
every cancel and every timeout — still writing to the inherited pipe, so the
daemon kept receiving events from a run it believed it had stopped, and still
billing (a cancelled run was measured spending 4.92 credits over the 160s after
the cancel). `SPAWN_OPTS` carries `detached: true` so the child leads its own
process group, and `killTree` signals the negative pid to reach the whole group.
Neither half works alone: without `detached` the child sits in the *daemon's*
group, and signalling that group would kill the daemon. Every adapter spawns
through `SPAWN_OPTS`, so none can forget.

`runner.mjs` also keeps a `cancelled` set, because the process still has to close
before the run finishes and by then the exit is non-zero — the close handler used
to write `failed` over the `cancelled` the cancel had just set, collapsing "I
stopped it" into "it broke".

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
- **`retry.through: ['<id>', ...]`** — steps that must run again between the fix
  and the gate, in order. Empty for the reviewer (fix → review). `['review']` for
  the tester, and that ordering is the whole point: a fix written to close a QA
  defect is code nobody has reviewed. If a `through` step rejects, the round ends
  there — the gate does not run on work already refused upstream — and the next
  round answers *that* critique instead of the gate's.
- **`workdirFrom: '<id>'`** — runs inside another step's worktree instead of
  creating its own. That is how the validator sees the implementer's work.
- **`autoCommit`** — commits what the step produced onto the worktree's own
  branch, one commit per attempt, so each correction round stays legible in the
  history. Best-effort: a failed commit is reported, never turned into a step
  failure.
- **`mcpServers` / `env` / `reservePorts`** — per-step process configuration,
  added for the QA stage (a browser server, and ports it may bind).
- Prompt interpolation: `{{repo}}`, `{{steps.<id>.output|diff|patch|workdir}}`,
  `{{ports}}`.

The `crossValidationTemplate` and `raceTemplate` prompts are long and deliberate
(the validator is required to list what it ran; the judge must end with
`VENCEDOR: <id>`). Changing that text changes product behaviour — treat it as
code, not as commentary.

**Nothing in the flow assumes a stack.** There is no default verification command
list any more: the reviewer is told to find the project's own (CI workflow first —
it cannot be stale, because it runs — then the manifest, Makefile, README), and
the QA stage opens with a **Part 0** that makes the tester name the stack, the
boot command, the infrastructure and *how that stack takes a port* before it
tries anything. `STACKS` and `ENTRY_POINTS` in `qa.mjs` are the checklist it
recognises the project by; they are a starting point handed to the agent, not a
detector on Honeycomb's side. `PORT` is a Node convention, which is exactly the
trap the port question exists to close.

**`roles.mjs` + `review.mjs`** — the flow's steps, reachable one at a time.

A `cross` is three roles wired into a graph, and for a long time the graph was
the only way to reach two of them. That made the flow all-or-nothing: a QA step
that died on a rate limit took the implementation down with it, because the only
way to get a tester running again was to run the whole chain and pay for a fresh
implementation of code that already existed.

`buildRoleRun({ role, of, ... })` resolves a `validator` or `qa` run against work
that already happened: prompt, mode, directory, ports and browser all come from
the target run, never from the caller — a client that could hand us its own `env`
or `mcpServers` would be choosing what a full-autonomy agent sees, and the point
of a role is that those choices are the same ones the flow makes. `review.mjs`
exists so the reviewer's prompt has one copy: the review inside a `cross` and the
one you fire by hand at the same worktree have to ask for the same thing, or
their verdicts are not comparable. Both prompt builders take the interpolation
tokens as *defaults*, so the orchestrator fills them from step results and a
standalone run passes real values in.

`of` is required, and `resolveTarget` insists the worktree still exists. The
tester runs in `full` — it writes, opens shells, boots servers. In a worktree
that is the whole point; pointed at the user's own checkout it would be an agent
with total autonomy in their working tree, which is the one thing this product
exists to avoid.

**`runTask(id, { resume: true })`** is the same idea at the graph level. It seeds
`results` from the steps that already finished and re-runs the rest, so the
reviewer re-enters the implementer's worktree instead of a new one. `resumePlan`
answers what would be kept and what would be paid for again *without* firing —
every surface shows it first, because avoiding a second implementation is the
whole reason the feature exists. It refuses when a step that must re-run reads a
worktree that is gone: `discard` sets `worktree: null` on the run, so the seeded
result looks merely worktree-less rather than broken, and `workdirFrom` would
quietly fall back to the repo root and review the user's checkout. A resume that
reviews the wrong tree is worse than one that refuses. A `rejected` step re-runs
too — over unchanged code it will reject again, which is only worth it if you
edited the worktree yourself.

**`qa.mjs`** — the optional third stage, `crossValidationTemplate({ qa: true })`,
which turns the chain into `impl → review → qa`. The reviewer answers "is this
code right"; the tester answers "does it work when you run it". It runs in `full`
mode inside the implementer's worktree, boots the project on ports from
`reservePorts` (a fixed port would collide between parallel worktrees and read as
a defect in the code under test), derives a test plan from what the diff actually
changed, and exercises it — `curl`/Bruno for endpoints, a real message on the
broker for consumers, a browser for screens — plus the regression surface around
it. Artefacts land in `.honeycomb/qa/` inside the worktree and get committed.

The prompt is what keeps the tester from fixing what it finds; the mode cannot
express "write test files but not production code", and taking write access away
would cost the artefacts.

A browser reaches the tester one of two ways, and the default is the simpler one.
**`agent-browser` is driven through its shell CLI**, not its MCP server: the CLI
has full parity, there is no server process to start and no version to match, and
it is the only path that works on all four tools — Kiro and Cursor included,
neither of which takes MCP configuration on the command line. `chrome-devtools`
is the MCP option, kept because it needs nothing installed (it runs through
`npx`), at the cost of having no CLI and therefore reaching neither of those
two (`NO_CLI_MCP` in `qa.mjs`).

`resolveBrowser(name, { tool })` returns what the tester will *actually* have
rather than what was asked for: the MCP servers to inject (usually none), the
prompt fragment describing the real capability, and a `note` when the choice had
to be downgraded. The note reaches the operator three ways —
`/api/browsers?tool=` before the task is created, the step record, and the CLI
summary — because a browser that is not there is invisible from inside the prompt:
the tester simply never sees the tools and reports the screen as untestable.

The stage is **off by default**: it costs a third agent and the wall-clock time of
booting a project, which plenty of changes do not justify.

**`worktree.mjs`** — each run gets a directory under `worktrees/` and a branch
`honeycomb/<slug>-<ts>` off the current HEAD. Agents commit their own work there:
`commitWorktree` refuses any branch that is not `honeycomb/*` (an agent that ran
`git checkout main` would otherwise write to the user's branch with a commit that
looks perfectly normal) and strips attribution trailers — `Co-Authored-By`,
`Generated with` — from the message, because asking the agent nicely does not hold
when the agent runs `git commit` itself. `worktreeDiff(dir, { baseSha })` diffs
against the sha the worktree started from, which is what keeps "what did the agent
change" answerable after the agent commits; without `baseSha` it answers "what is
uncommitted", which is the question `gc.mjs` asks. `node_modules`/`vendor`/`.venv`/
`target` are **symlinked** (copying would kill parallelism); removal undoes the
symlinks before `git worktree remove` so it never deletes the main repo's
`node_modules`. `worktreeDiff` runs `git add -AN` so new files appear without a
commit. `findLandedIn` compares blob hashes against the refs to detect work
already taken to another branch out of band.

**`linkedDepDirs` is why anything that stages files has to ask first.** The
dependency directories enter the worktree as *symlinks*, and a `.gitignore` entry
written `node_modules/` matches a directory, not a link — git sees a plain file,
the ignore rule misses, and `git add -A` stages a `120000` blob whose content is
an absolute path on the machine that produced it. `worktreeDiff` and
`commitWorktree` both exclude what that helper reports, and it reports only what
is provably our symlink: some projects track `vendor/` as a real directory, and
excluding that would erase genuine agent work. They share the helper because they
did not share it before, and the copy that was missing from `commitWorktree` put
the symlink into every auto-commit while the diff on screen stayed clean.
`commitWorktree` also runs `git rm --cached` on those paths, which is not
redundant: agents are told to commit their own work and they use `git add -A`
too, so excluding the link from our `add` would leave one they already tracked in
the tree forever. Dropping it from the index makes the next Honeycomb commit the
one that repairs the branch.

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
`HONEYCOMB_CLAUDE_BIN` / `HONEYCOMB_KIRO_BIN` / `HONEYCOMB_CODEX_BIN` /
`HONEYCOMB_CURSOR_BIN`,
`HONEYCOMB_URL` (used by the CLI and the MCP server).

The QA stage passes `PORT` and `HONEYCOMB_QA_PORTS` **into** the tester's process;
they are reserved per attempt, not read from the environment.

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
- **Cursor** (`cursor-agent -p --output-format stream-json`) emits real JSONL and
  reports **tokens, not cost**, like Codex. Two things are specific to it. It is
  the only tool that separates "may write" from "may run commands" — `--mode ask`
  and `--force` are independent axes, and crossing them lands exactly on the four
  modes, `verify` included; `--mode plan` is deliberately unused, because it
  turns the agent into a planner that executes nothing. And **workspace trust is
  per directory and asked interactively**: every run starts in a worktree Cursor
  has never seen, so `--trust` is always passed or the run dies on a prompt
  nobody can answer. A tool call arrives as an object with one key naming the
  tool (`readToolCall`, `shellToolCall`, …), around forty of them, so the key is
  read as the name rather than enumerated. Saved chats come from
  `~/.cursor/chats/*/*/meta.json` — `cursor-agent ls` is an interactive picker
  and never returns under a pipe.

## Documents

`README.md` documents the product and its design decisions in detail;
`ANALYSIS.md` is an honest audit of known issues — read it before assuming
something is broken by accident rather than by known limitation.
