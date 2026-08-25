# Honeycomb

Orchestrates agent CLIs (Claude Code, Kiro, Codex, Cursor) as task executors,
with a web UI, managed sessions, and git worktree isolation.

The name describes the structure: every agent works in its own cell — an isolated
git worktree with its own branch, identical to its neighbours and with no contact
with them. What the UI shows you is the whole comb at once.

> **Heads up:** this tool spawns coding agents with write and shell access on your
> machine. Read [Security](#security) before running it.

## Dependencies

Honeycomb itself is small — Node and git. What it needs is the tools it drives,
and it does not install any of them for you: it probes what is on your machine
and shows the result in `honeycomb tools`, so an agent you never installed simply
appears unavailable instead of failing mid-run.

**Required**

- **Node 20+** — daemon, CLI and frontend.
- **git 2.20+** — isolation is built on `git worktree`.
- **At least one agent CLI**, from the table below. Nothing works without one:
  Honeycomb has no model of its own, it orchestrates other people's.

**Agent CLIs** — install the ones you want. Each authenticates on its own, once:
run it in a terminal and log in before pointing Honeycomb at it.

| tool | install | where Honeycomb looks | override |
|---|---|---|---|
| [Claude Code](https://docs.claude.com/en/docs/claude-code) | `curl -fsSL https://claude.ai/install.sh \| bash` | `~/.local/bin/claude` | `HONEYCOMB_CLAUDE_BIN` |
| [Codex CLI](https://developers.openai.com/codex/cli) | `npm i -g @openai/codex` | `codex` on `PATH` | `HONEYCOMB_CODEX_BIN` |
| [Cursor CLI](https://cursor.com/docs/agent/terminal) | `curl https://cursor.com/install -fsS \| bash` | `~/.local/bin/cursor-agent` | `HONEYCOMB_CURSOR_BIN` |
| [Kiro CLI](https://kiro.dev/docs) | see the Kiro docs | `~/.local/bin/kiro-cli` | `HONEYCOMB_KIRO_BIN` |

The install commands come from each vendor and may drift; the links are the
source of truth. What matters to Honeycomb is only the resulting binary path — if
yours lives somewhere else, set the env var and it is found.

**The agentic browser** (optional, for the QA stage)

The QA stage drives a real browser to exercise screens. The default is
[`agent-browser`](https://www.npmjs.com/package/agent-browser), driven through
its shell commands rather than an MCP server — that is the only path that works
on all four agent CLIs. It ships no browser of its own, so the install is two
steps:

```bash
npm i -g agent-browser
agent-browser install --with-deps   # downloads Chrome for Testing (+ Linux libs)
agent-browser doctor                # confirms the install
```

Skip it and the QA stage still runs — the tester covers the API and service
layers and reports explicitly what it could not exercise through the UI.
`GET /api/browsers?tool=<tester>` (and the note under the composer's selector)
tells you which of the two it is *before* you create the task.

The alternative is `chrome-devtools`, which needs nothing installed — it runs
through `npx` — but it is an MCP server with no CLI, so Kiro and Cursor cannot
use it. It does need a Chrome on the machine.

**Optional**

- **`npm link`** in the project directory puts `honeycomb`, its short alias `hc`
  and `honeycomb-mcp` on your `PATH`. Without it, invoke by path:
  `node bin/honeycomb.mjs <cmd>`.

## Running

```bash
npm run setup     # install server and frontend deps (once)
npm run build     # compile the UI
npm start         # daemon + UI at http://127.0.0.1:4317
```

## CLI

`bin/honeycomb.mjs` is the interface built to be chained in a shell — by you or by
an orchestrating agent.

```bash
honeycomb tools                              # tools and sessions
honeycomb run kiro "..." --mode full --wait  # fire and block
honeycomb cross "<spec>" --wait              # implement and validate
honeycomb cross "<spec>" --qa --wait         # ...and test it running
honeycomb restart <taskId> --wait            # redo only what did not finish
honeycomb run claude --as validator --of <runId>   # review that run's worktree
honeycomb run claude --as qa --of <runId>          # boot it and test it
honeycomb diff <runId> --full                # worktree diff
honeycomb commit <runId>                     # commit on the agent's branch
```

Events go to stderr and the result to stdout, so `honeycomb run ... --wait >
out.txt` keeps only the answer. Exit codes tell a technical failure (1) apart
from a rejection on the merits (3), so `honeycomb cross "..." --wait && git merge`
does what it looks like it does.

While working on the frontend, `npm run web` starts Vite on :5317 with a proxy to
the daemon (hot reload).

## Concepts

**Run** — one execution of one tool. It gets an isolated worktree, streams live
events, and ends with output plus a diff.

**Task** — a graph of steps. Each step runs on a tool and declares its
dependencies; steps with no pending dependency run in parallel.

**Permission modes**

| mode | read | shell | write | use |
|---|---|---|---|---|
| `ro` | ✅ | ❌ | ❌ | inspect code |
| `verify` | ✅ | ✅ | ❌ | validate by running build/lint/tests |
| `rw` | ✅ | ❌ | ✅ | edit without executing |
| `full` | ✅ | ✅ | ✅ | implement — isolated worktrees only |

**Isolation** — under `worktree`, each agent gets its own directory and branch
(`honeycomb/<id>`) branched off the current HEAD. Your working tree is never
touched, and two agents run in parallel without colliding. Dependency directories
(`node_modules`, `vendor`, `.venv`, `target`) are symlinked in so the agent can
actually build and test.

**Commits stay on the agent's branch.** Each step commits what it produced onto
its own `honeycomb/<id>` branch — one commit per attempt, so a task with two
correction rounds reads as four commits rather than one blob. Nothing reaches your
branch until you merge or cherry-pick it. That guarantee is enforced, not
requested: a commit is refused outright if the worktree is not on a `honeycomb/`
branch, which catches an agent that ran `git checkout main` against the rules.
Attribution trailers (`Co-Authored-By`, `Generated with`) are stripped from every
message, so the history says what changed and nothing else.

## Orchestration patterns

### Cross-validation — the everyday pattern

One tool implements in an isolated worktree with full autonomy; another enters
**the same worktree** in `verify` mode, is required to run typecheck/lint/tests,
report what it ran and the real result, and finish with `VEREDITO: APROVADO` or
`VEREDITO: REPROVADO` (approved / rejected). A build or test failure caused by the
implementation rejects it, regardless of how good the code looks. The step is a
`gate`, so a rejection marks the task failed and the CLI exits 3.

```bash
honeycomb cross "add batch delete to the documents screen" \
  --impl kiro --validator claude --wait
```

**No verification commands are hardcoded.** The reviewer works out how *this*
project builds, checks and tests itself — reading the CI workflow first (the one
piece of documentation that cannot be stale, because it runs), then the manifest,
the Makefile and the README. Pin them with `--verify "cmd1;cmd2"` when you want
exactly those and nothing else.

**A flow that breaks is not a flow you pay for twice.** The steps die for reasons
that have nothing to do with the code — a rate limit, a spend ceiling, the daemon
restarting — and until there was a way back, the only option was a fresh `cross`
that re-implemented work already sitting in a worktree.

```bash
honeycomb restart <taskId>          # prints the plan, then resumes
```

It keeps every step that finished and re-runs the rest, so the reviewer re-enters
the implementer's worktree rather than a new one. The plan is printed before
anything is fired — this exists to save money, and hiding which steps it is about
to pay for again would be a poor trade. It refuses outright when the work being
reused is gone: a discarded worktree would send the reviewer to the repo root and
have it issue a verdict on your checkout instead of the agent's work.

**The same steps, one at a time.** `validator` and `qa` are roles a single run can
play over work that already exists:

```bash
honeycomb run claude --as validator --of <runId>
honeycomb run claude --as qa --of <runId> --start-cmd "make run"
```

The prompt, the permission mode and the working directory come from the target
run — the same ones the flow would use — so a review fired by hand and a review
inside a `cross` are comparable. `--of` is required and its worktree must still
exist: the tester runs in `full`, which is safe in a worktree and is exactly what
you never want pointed at your own checkout.

**Correction loop.** When the reviewer rejects, it has already said exactly what
is wrong — throwing that away and reimplementing from scratch wastes the most
expensive diagnosis in the flow. So the critique goes back to the implementer,
which reworks **inside the worktree it already produced**, and the reviewer
revalidates. Up to `maxRounds` rounds (default 2), because a stubborn reviewer and
a stubborn implementer can disagree forever, and every round costs money.

Declare it in any graph with:

```json
{ "id": "review", "gate": true, "retry": { "of": "impl", "max": 2 } }
```

### QA — optional, for when passing review is not enough

The reviewer answers *is this code right*. It reads a diff and runs
typecheck/lint/tests. It does not answer *does this work when you run it* — and
plenty of changes pass the first question and fail the second.

`--qa` appends a third agent that does answer it. The chain becomes
`impl → review → qa`:

```bash
honeycomb cross "consume the invoice queue and expose GET /invoices/:id" \
  --qa --tester claude --tester-model opus \
  --start-cmd "npm run dev" --wait
```

The tester works inside the same worktree, in `full` mode, and:

1. **derives the plan from the diff.** It maps which end-to-end flows the change
   touches — entry point through to final effect — and which flows it passes near
   without changing; those are the regression surface. The plan goes to
   `.honeycomb/qa/plano.md` before anything runs, so what was tested is a file in
   the branch, not a claim in a chat log.
2. **boots the project** on ports reserved for that attempt, exposed as `PORT` and
   `HONEYCOMB_QA_PORTS`. A fixed port would collide with another agent running in
   parallel and the collision would read as a defect in the code under test.
3. **exercises it by kind of change.** New endpoint: real HTTP calls with `curl`,
   or added to the repo's Bruno collection if it has one, checking status, body
   and side effect — including unauthenticated and as another user. New consumer:
   a real message published on the project's broker, asserting the effect, plus a
   malformed message and the DLQ/retry path. Front-end: the flow driven in a
   browser, where a console error or a 5xx fired by the screen is a defect.
   Migrations: applied, schema checked, rollback checked. Then the project's own
   test suite, for regression.
4. **reports, and does not fix.** Each defect comes with reproduction, expected vs
   observed, evidence and the suspected file. "I could not boot the project" is a
   legitimate outcome that leads to `REPROVADO` with the reason — never to a case
   marked as passed.

A rejection re-enters the same correction loop, with one difference that matters:
`retry.through: ["review"]` sends the fix back past the **reviewer** before it is
retested. A fix written to close a QA defect is new code, and new code has not
been reviewed. If the reviewer rejects that fix, the round ends there and the next
round answers the reviewer's critique instead of the tester's.

| flag | what it does |
| --- | --- |
| `--qa` | turns the stage on (off by default) |
| `--tester X` / `--tester-model M` | which agent tests, and on which model |
| `--browser B` | `agent-browser` (default, via shell), `chrome-devtools` (MCP), `none` |
| `--start-cmd "<cmd>"` | how to boot the project, if you already know |
| `--base-url <url>` | where it answers once up |
| `--notes "<text>"` | what you want tested with particular attention |
| `--qa-rounds N` | correction rounds driven by QA (default 2) |

**The browser is driven through a CLI by default.** `agent-browser` is the default
choice and the tester uses its shell commands (`open`, `snapshot`, `click @eN`,
`console`, `screenshot`) rather than its MCP server. The CLI has full parity, so
the MCP path buys nothing and costs a server process, a version to match and an
injection step that only half the tools accept. Install it once with
`npm i -g agent-browser`.

`chrome-devtools` remains available as the MCP option — it needs nothing installed
(it runs through `npx`), but it has no CLI, which means it cannot be used with
Kiro or Cursor at all: neither takes an MCP server on the command line.

`GET /api/browsers?tool=<tester>` reports what each choice would actually become
(`cli` / `mcp` / `none`) plus a note when it had to be downgraded, and the composer
shows it under the selector. That check exists because a browser that is not there
is invisible from inside the prompt: the tester never sees the tools and reports
the screen as untestable, or does not mention it at all.

**Pay for this deliberately too.** It is a third agent plus the wall-clock time of
booting a project and driving a browser. Turn it on for changes where working
matters more than compiling — a new integration, a queue, a screen — and leave it
off for a refactor the test suite already covers.

### Race — situational, not the default

N agents solve the **same** spec independently and a judge picks a winner. It
exists because automatically merging the work of several agents is an unsolved
problem (semantic conflicts git cannot detect); here nothing gets merged — the
results sit side by side on separate branches and the output is a choice.

```bash
honeycomb race "<spec>" --agents kiro,claude --judge claude --wait
```

**Pay for this deliberately.** It costs N× the same task and returns a choice, not
a sum. In a real test with a well-specified task, both candidates produced
identical production code — the judge could only separate them by the work around
it (spec style, verification rigour). It only pays off when the task has genuine
design ambiguity and seeing two approaches is informative. For normal work, use
`cross`.

## Tool support

| tool | structured events | live sessions | resume | usage reporting |
|---|---|---|---|---|
| Claude Code | ✅ `stream-json` | ✅ `agents --json` | ✅ our id | ✅ cost |
| Kiro CLI | ❌ parsed text | ❌ saved only | ✅ | ✅ cost |
| Codex CLI | ✅ `exec --json` | ❌ saved only | ✅ its id | ⚠️ tokens |
| Cursor CLI | ✅ `--output-format stream-json` | ❌ saved only | ✅ its id | ⚠️ tokens |

Kiro splits its output across both streams in a non-obvious way: the answer goes
to stdout, but the cost footer, the warnings and the session listing go to stderr.
The adapter classifies lines from both. If it ever becomes worth the effort,
`kiro-cli acp` (Agent Client Protocol, JSON-RPC over stdio) would give real events
instead of that heuristic.

Codex has three quirks the adapter works around:

- **It reports tokens, not cost.** Converting to money would need a per-model
  price table that would silently go stale — so `cost` stays null and tokens show
  up instead. It does not feed the cost totals in the metrics.
- **`ro` and `verify` collapse.** Codex's `read-only` sandbox still lets commands
  run, it only blocks writes; there is no mode that forbids execution. So `ro` is
  more permissive there than on the other tools.
- **`exec resume` takes fewer flags than `exec`**: no `--sandbox`, no `-C`. On
  resume the sandbox comes from the original session and the directory from the
  process cwd. Consequence: continuing a session created in a permissive mode does
  **not** make it restricted just because you asked for `ro` now — to guarantee
  isolation, start a new run.

Saved sessions (including the desktop app's) are read from
`~/.codex/sessions/**/rollout-*.jsonl`, via the `session_meta` on the first line.

Cursor is the closest thing to a second reference adapter — real JSONL, thinking
deltas, tool calls with arguments and results — with three things of its own:

- **It reports tokens, not cost**, for the same reason Codex does, and with the
  same consequence: it does not feed the cost totals in the metrics.
- **It is the only tool that separates writing from executing.** `--mode ask`
  decides whether it may write, `--force` decides whether it may run commands,
  and the two are independent — so the four modes map onto it exactly, `verify`
  (reads, runs the build, writes nothing) included. A blocked call is not hidden
  from the model, it comes back `rejected`, which usually costs a retry before
  the agent gives up. `--mode plan` is deliberately unused: it does not restrict
  a working agent, it replaces it with a planner that executes nothing.
- **Workspace trust is per directory, and it is asked interactively.** Every run
  starts in a fresh worktree Cursor has never seen, so the adapter always passes
  `--trust`; without it the run dies on a prompt nobody can answer, printed as
  plain text before the JSON stream even starts.

Saved chats are read from `~/.cursor/chats/*/*/meta.json` — `cursor-agent ls` is
an interactive picker and never returns under a pipe.

## Model selection

Every tool exposes models differently, and Honeycomb does not hide that:

| tool | listing | multiplier |
|---|---|---|
| Kiro | real, via `chat --list-models` | ✅ 0.05× to 2.4× |
| Claude Code | curated (aliases + names) | — |
| Codex | exposes none; free-form field | — |
| Cursor | real, via `--list-models` | — |

The fact that justifies having a model selector at all is Kiro's multiplier. The
default is `auto` (1×), but models range from `qwen3-coder-next` at 0.05× to
`gpt-5.6-sol` at 2.4× — nearly 50× apart. Choosing blindly is what made a single
task cost 41 credits.

```bash
honeycomb models kiro                     # list with multiplier and context
honeycomb run kiro "..." --model glm-5
honeycomb cross "<spec>" --impl-model claude-haiku-4.5 --validator-model sonnet
```

In cross-validation you can use a different model per role — implement with a
strong model and review with a cheap one, or the other way around.

## Maintenance and data

**Metrics** (`honeycomb metrics`, Métricas tab) aggregate what Honeycomb already
records run by run: usage and duration per tool, success rate, approval rate, how
many correction rounds were needed, and spend per task broken down by step. It
exists so you can pick a tool from data instead of impressions — in a small sample
here, Kiro cost roughly 20× more per run than Claude.

**Cost and tokens do not add up.** Claude and Kiro report credit; Codex and
Cursor report tokens. Aggregating both into one number would produce a
meaningless value, so each tool appears in the unit it actually uses and the two
totals sit side by side. The comparison bar only ranks the ones measured in
credit — the ones measured in tokens get a neutral band instead of showing as
zero.

**Worktree collection** (`honeycomb gc`, button in the Métricas tab) collects only
what provably has nothing to lose: empty worktrees and already-committed ones.
Worktrees with pending changes are **never** removed automatically — they may be
the only copy of something useful. Removing those requires
`--include-dirty --force`. A conservative pass runs every 6h for worktrees older
than 24h.

**Notifications** tell you when a task finishes or enters a correction round. Turn
them on with the bell in the header — permission is only requested on click, and
the notification is suppressed if the tab is already visible.

**Continuing a conversation** (`honeycomb followup <runId> "..."`, or the field in
the transcript) resumes that agent's session in the same worktree, preserving
context — unlike firing a new run, which would start from zero. It only shows up
for tools that support resuming.

## API

```
GET    /api/tools?cwd=          tool status + sessions
GET    /api/repo?path=          root, branch and worktrees of a repo
POST   /api/runs                start a run
GET    /api/runs/:id            detail
GET    /api/runs/:id/events     replay of the normalized stream
GET    /api/runs/:id/diff?full= worktree diff
POST   /api/runs/:id/cancel     SIGTERM, SIGKILL after 5s
POST   /api/runs/:id/commit     commit the work on the agent's branch
DELETE /api/runs/:id/worktree   discard the worktree
POST   /api/runs/:id/follow-up  continue that agent's conversation
GET    /api/worktrees           worktrees on disk and their state
POST   /api/worktrees/gc        collect (dryRun by default)
GET    /api/metrics?days=       aggregated cost, time and approval
POST   /api/tasks               create a task from a graph
POST   /api/tasks/cross-validation   create from the template
POST   /api/tasks/:id/run       execute
WS     /ws                      live events from runs and tasks
```

## MCP server and skill

Honeycomb exposes itself as an MCP server (`server/mcp.mjs`, stdio), which takes
the comb outside the terminal: Claude Code, Codex, Kiro, Cursor and Claude
Desktop can start runs as a typed tool — including the very agents it
orchestrates.

```bash
npm run mcp                                                   # run in a terminal (debug)
claude mcp add --scope user honeycomb -- honeycomb-mcp        # Claude Code
kiro-cli mcp add --name honeycomb --command honeycomb-mcp --scope global
codex mcp add honeycomb -- honeycomb-mcp                      # Codex
```

Cursor has no `mcp add` subcommand — it reads `~/.cursor/mcp.json`, so add the
entry there by hand:

```json
{ "mcpServers": { "honeycomb": { "command": "honeycomb-mcp" } } }
```

Those commands assume `npm link` has been run. Inside this repository the shipped
`.mcp.json` already registers the server, no setup needed.

There are 15 tools, from read-only shortcuts (`honeycomb_tools`,
`honeycomb_models`, `honeycomb_metrics`) to execution (`honeycomb_run`,
`honeycomb_cross`, `honeycomb_race`, `honeycomb_restart`) and consolidation
(`honeycomb_diff`, `honeycomb_commit`).

**Long calls are not a problem.** A `cross` with correction rounds runs past half
an hour, and that fits the protocol for two reasons: an MCP client's default
wall-clock ceiling is around 28h, and what actually kills a long call is the *idle
timeout* — silence for 30min on stdio, 5min on HTTP. That is why every blocking
step emits `notifications/progress` on each agent event: it shows up as progress
for the caller and it is what proves the call is still alive. In Claude Code the
call also moves to the background on its own after two minutes, so it never blocks
the session.

Even so, everything accepts `wait: false`, which returns the id immediately. That
is not just a fallback: the run lives in the daemon, not in the call. If the
client dies mid-way, the agent keeps working and the worktree stays —
`honeycomb_status` finds the work again later.

The skill (`.claude/skills/honeycomb/`) is the other half: MCP says what can be
done, the skill says when it is worth doing — when to delegate instead of editing
directly, which mode to pick, and that `VEREDITO: REPROVADO` is a result, not a
failure.

## Interpolation between steps

Inside a step's prompt:

- `{{repo}}` — repository path
- `{{steps.<id>.output}}` — final text from another step
- `{{steps.<id>.diff}}` — `diff --stat` of another step's worktree
- `{{steps.<id>.patch}}` — full patch
- `{{steps.<id>.workdir}}` — worktree directory
- `{{ports}}` — free ports reserved for this attempt (needs `reservePorts: N`)

A step with `workdirFrom: "<id>"` runs inside another step's worktree instead of
creating its own — that is how the validator sees what the implementer did.

Other per-step fields worth knowing: `autoCommit` commits what the step produced
onto the worktree's branch (one commit per attempt, so correction rounds stay
legible in the history), `mcpServers` adds MCP servers to that agent's process,
`env` adds environment variables, and `reservePorts: N` allocates free TCP ports
and hands them over as `PORT` and `HONEYCOMB_QA_PORTS`.

## Robustness and limits

**Crash recovery.** The map of live processes lives in memory; run status lives on
disk. If the daemon dies mid-execution the two disagree forever — the record says
`running`, but nobody is listening. On boot those runs become `interrupted` (a
state distinct from `failed`, which is the agent's error, and from `cancelled`,
which is your request) and orphan processes are terminated. Reattaching is not
possible: the stdout carrying the events died with the old daemon.

**Concurrency queue.** At most `HONEYCOMB_MAX_CONCURRENT` agents at once (default
3). Agents in `full` mode compile and run tests; several in parallel fight over
CPU and finish slower than they would queued. The excess waits as `queued` instead
of being refused.

**Spend ceilings.** `HONEYCOMB_TASK_BUDGET` cuts off an orchestration that ran
away — the case that hurts, because correction rounds add up with nobody looking.
`HONEYCOMB_DAILY_BUDGET` is the safety net for the day. The task ceiling is checked
**between steps**, the only point where stopping avoids new spend without throwing
away what was already paid for. There is no per-run ceiling: cost is only known at
the end, and promising a limit verifiable only afterwards would be misleading. Both
are off by default — a ceiling set too low that interrupts legitimate work is
worse than none.

**Retry on transient failure.** Provider capacity, rate limits and network errors
are retried with exponential backoff (2s, 4s, …), up to
`HONEYCOMB_TRANSIENT_RETRIES`. Failures on the merits are not: wrong code does not
improve by being re-run. When in doubt a failure is **not** treated as transient —
retrying something that will fail again costs money, while not retrying something
transient costs you a click.

## Security

The daemon binds to loopback on purpose. It starts agents with write and shell
permission, so exposing it on a network would be handing out remote code
execution. Do not change `HONEYCOMB_HOST` to `0.0.0.0`, and do not put it behind a
reverse proxy without authentication in front.

Two more things worth knowing before you run it:

- **`full` mode means full.** On Claude Code it maps to `bypassPermissions`, on
  Kiro to `--trust-all-tools`, on Codex to `danger-full-access`, on Cursor to
  `--force` (its own alias is `--yolo`). That is why it is only meant to run
  inside an isolated worktree.
- **Dependencies are shared through symlinks.** Every worktree links to the main
  repository's `node_modules`. If an agent runs `npm install`, it affects the
  others and your own checkout. Acceptable for the expected flow — changing code,
  not dependencies — but worth knowing.

`data/` (prompts, agent output, your paths) and `worktrees/` are gitignored and
should never be committed.

## Environment variables

| var | default |
|---|---|
| `HONEYCOMB_PORT` | `4317` |
| `HONEYCOMB_HOST` | `127.0.0.1` |
| `HONEYCOMB_MAX_CONCURRENT` | `3` |
| `HONEYCOMB_TASK_BUDGET` | `0` (off) |
| `HONEYCOMB_DAILY_BUDGET` | `0` (off) |
| `HONEYCOMB_TRANSIENT_RETRIES` | `2` |
| `HONEYCOMB_TIMEOUT_MS` | `1200000` (20 min) |
| `HONEYCOMB_CLAUDE_BIN` | `~/.local/bin/claude` |
| `HONEYCOMB_KIRO_BIN` | `~/.local/bin/kiro-cli` |
| `HONEYCOMB_CODEX_BIN` | `codex` |
| `HONEYCOMB_CURSOR_BIN` | `~/.local/bin/cursor-agent` |
| `HONEYCOMB_URL` | `http://127.0.0.1:4317` (used by the CLI) |

## License

MIT — see [LICENSE](LICENSE).
