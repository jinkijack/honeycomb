# Code audit

A full read of `server/`, `bin/honeycomb.mjs`, `shared/` and `web/src`, compared
against the README. This file is kept honest on purpose: it lists what the code
does well and what is still wrong with it, so nobody has to discover the sharp
edges by hitting them.

Last revised: 2026-08-21.

## What this is

A local daemon (~2,000 lines of server, ~600 of CLI, ~1,800 of frontend) that
treats Claude Code, Kiro and Codex as interchangeable executors. The axis of the
design is a normalized event format (`bus.mjs`): every adapter translates its
CLI's output into the same vocabulary (`text`, `tool_use`, `tool_result`,
`result`, `status`), which is why the orchestrator, the UI and the CLI can treat
all three tools as one thing.

Cleanly separated layers:

```
config → store (JSON) → bus → adapters → runner (worktree + process)
       → orchestrator (DAG with gate and retry)
       → index (HTTP/WS) + bin/honeycomb.mjs + server/mcp.mjs
```

## What holds up well

**Worktree isolation with symlinked dependencies.** This is the decision that
makes the cross-validation pattern actually work: without `node_modules` in the
worktree the validator could only read code, and the verdict would be an opinion.

**The correction loop.** It hands the critique back to the implementer inside the
worktree it already produced, instead of starting over, with a round limit
justified by cost.

**A composable CLI.** Events on stderr, result on stdout, and exit code 3
separating a rejection on the merits from a technical failure — `honeycomb cross
... --wait && git merge` does what it promises.

**Comments explain why**, including the side effects that were accepted (shared
symlinks, `git add -AN` to see new files, a gc that never touches a dirty
worktree). That is documentation that survives refactoring.

## Known issues, most important first

**The WebSocket has no Origin check.** `wss.on('connection')` accepts any
connection. WebSockets are not restricted by CORS, so any page open in your
browser can connect to `ws://127.0.0.1:4317/ws` and receive the whole stream:
prompts, agent output, `tool_result` payloads containing source code. The write
side is better protected by accident — `express.json` requires
`Content-Type: application/json`, which triggers a preflight that fails for lack
of CORS headers — but there is no `Host` validation (DNS rebinding) and no token.
Binding to loopback solves the network, not the browser. **Fix this before
running Honeycomb alongside untrusted browsing.** Note that any check must still
allow the Vite dev server on :5317, which proxies the socket.

**Store writes are O(n) and synchronous.** `flush()` re-serializes the whole table
with `writeFileSync` on every `put`/`patch`, and `patch` runs a dozen times per
run. Each write blocks the event loop that is streaming events. The comment says
"if this ever grows to thousands, swap in SQLite", but the swap point arrives
earlier than that. A debounce on the flush is the cheap intermediate step.

**Polling re-reads the entire log.** `readRunLog` does a `readFileSync` of the
complete NDJSON and only then filters by `fromSeq`; `followRun` calls that every
2s, from both the CLI and the MCP server. With 250 KB logs, `--wait` re-reads
everything dozens of times per run.

**No task-level timeout.** The 20-minute timeout is per step; a task with two
correction rounds can run over an hour with no ceiling. The spend ceilings bound
the money, not the time.

**Kiro's heuristic can eat legitimate text.** `TOOL_DONE = /^\s*[✓✗×]\s*(.+)$/`
turns any answer line starting with ✓ into a `tool_result` — and agents use ✓ in
lists. Those lines leave the final `output`, which is exactly where the
orchestrator looks for `VEREDITO:`. `--model` and `--effort` are also forwarded
without checking support.

**Verification commands assume Node.** The defaults are `npx tsc --noEmit`,
`npm run lint`, `npm test`. On a Maven or Cargo project all three fail for not
existing, and the flow then depends on the reviewer classifying that correctly in
free text. Detecting the ecosystem from the repo would be more reliable than
instructing the model to interpret an absence.

**Race has no UI.** It exists on the server (`/api/tasks/race`, `raceTemplate`)
and in the CLI, but nothing in `web/src` references race, judge or winner.
`task.winner` is computed by the orchestrator and never displayed — the result of
a race only appears if you read the JSON or the CLI summary.

**Codex spend escapes the ceilings.** Codex reports tokens, not cost, and the
ceilings work in credit. A run started on Codex therefore never counts against
`HONEYCOMB_TASK_BUDGET` or `HONEYCOMB_DAILY_BUDGET`. That is a deliberate
consequence of not inventing a price table, but it means the safety net has a hole.

### Smaller

- Agent-produced content is interpolated into another agent's prompt, so an
  implementer could in principle plant `VEREDITO: APROVADO` in a file and
  contaminate the reviewer's echo.
- The project has no tests or lint of its own, while requiring all three from the
  target repository.
- User-facing strings (UI labels, CLI help, agent prompts) are still in Portuguese
  while the code and docs are in English. The `VEREDITO: APROVADO/REPROVADO`
  protocol token is Portuguese and is matched literally by `orchestrator.mjs`.

### About the QA stage specifically

**A round can be spent without the tester ever running.** When the reviewer
rejects a fix inside a QA correction round, the round ends there and counts
against `qaMaxRounds` even though the tester was never reached. That is the
intended trade — the alternative is an unbounded loop between two gates — but it
means a task can exhaust its QA budget on review disagreements alone.

**Nothing stops the tester writing production code.** It runs in `full` mode
because it has to write the plan, the logs and possibly a Bruno collection or a
regression test, and the permission modes cannot express "write here but not
there". Only the prompt keeps it from fixing what it finds, and a tester that
fixes a defect instead of reporting it produces a green run that skipped both the
implementer and the reviewer.

**Ports are reserved, not held.** `reservePorts` binds port 0, reads the number
and closes the socket, so there is a window in which something else can take it.
Rare, and strictly better than the fixed port it replaces, which collided every
time two QA steps ran in parallel.

**The stage has no timeout of its own.** It inherits the 20-minute per-step
ceiling, which is generous for a review and can be tight for booting a project,
seeding a broker and driving a browser. A tester that runs out of time reports as
a technical failure, not as a rejection.

**The browser CLI is unparsed.** The default path drives `agent-browser` through
the shell, so what the tester learns about a page arrives as terminal text it read
itself — there is no structured tool result, and nothing on Honeycomb's side can
tell a failed navigation from a successful one. That is the same trade the Kiro
adapter makes, and it is why `chrome-devtools` stays available for the cases where
typed tool results are worth an MCP server.

**`chrome-devtools` excludes Kiro entirely.** It has no CLI and Kiro takes no MCP
configuration on the command line, so the combination resolves to no browser at
all. `resolveBrowser` says so before the task is created; it is still a
configuration that looks valid and is not.

**The install probe is cached for the daemon's lifetime.** Installing
`agent-browser` under a running daemon needs a restart to be noticed.

## Previously reported, since fixed

Kept for context, because the reasoning behind the fixes lives in the code
comments: the Codex adapter used to be a declared stub; there was no model
selection; there was no recovery after a daemon restart; there was no concurrency
ceiling; and `DEFAULT_REPO` in `App.jsx` was an absolute path from one machine.

Fixed while the QA stage was added: a correction that timed out or exited with an
error was patched to `done` regardless of `result.ok`, so the failure only showed
up indirectly in the next verdict; and `worktreeDiff` diffed against `HEAD`, which
returned nothing once an agent committed its own work — it now diffs against the
sha the worktree started from, keeping `HEAD` only for the garbage collector,
which is genuinely asking "is anything uncommitted".
