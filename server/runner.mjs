import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { getAdapter } from './adapters/index.mjs';
import { emit, closeRunLog } from './bus.mjs';
import { runs } from './store.mjs';
import { DEFAULT_TIMEOUT_MS, MAX_CONCURRENT, TRANSIENT_RETRIES } from './config.mjs';
import { checkBudget } from './budget.mjs';
import { createWorktree, removeWorktree, worktreeDiff, commitWorktree } from './worktree.mjs';

/** Live runs, for cancellation. */
const active = new Map();

/* ------------------------------------------------------------- concurrency */

/**
 * Execution queue.
 *
 * Agents in `full` mode compile, run tests and spawn processes. Several in
 * parallel fight over CPU and disk and finish slower than they would queued —
 * besides multiplying simultaneous spend. The excess waits instead of being
 * refused: refusing would force the orchestrator to reschedule.
 */
let inFlight = 0;
const waiting = [];

function acquireSlot() {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else inFlight = Math.max(0, inFlight - 1);
}

export function queueStatus() {
  return { inFlight, waiting: waiting.length, max: MAX_CONCURRENT };
}

/* -------------------------------------------------------- transient failures */

/**
 * A transient failure is one that goes away on its own: provider capacity, rate
 * limits, network. Distinct from a failure on the merits — wrong code does not
 * improve by being re-run, and insisting on it only burns credit.
 *
 * When in doubt it is NOT transient: retrying something that will fail again
 * costs money, while not retrying something transient costs you one click.
 */
const TRANSIENT = [
  /at capacity/i,
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b50[234]\b/,
  /overloaded/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/,
  /timeout apos \d+ms/i,
];

function isTransient(result) {
  if (result?.ok) return false;
  const haystack = [result?.error, result?.stderr, result?.output].filter(Boolean).join('\n');
  return TRANSIENT.some((re) => re.test(haystack));
}


/* --------------------------------------------------------------------- run  */

export async function startRun({
  tool,
  prompt,
  repo,
  cwd,
  isolation = 'worktree',
  mode = 'ro',
  model,
  effort,
  sessionId,
  resume = false,
  label,
  taskId = null,
  stepId = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  budgetOverride = null,
}) {
  const adapter = getAdapter(tool);
  const runId = randomUUID();

  const run = {
    id: runId,
    taskId,
    stepId,
    tool,
    label: label || `${adapter.displayName}: ${String(prompt).slice(0, 60)}`,
    prompt,
    repo: repo || cwd,
    mode,
    isolation,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    worktree: null,
    sessionId: sessionId || null,
    pid: null,
    attempts: 0,
    output: null,
    cost: null,
    tokens: null,
    diff: null,
  };
  runs.put(run);

  // the ceiling is checked before spending, not after — after is just a report
  const budget = checkBudget({ taskId, override: budgetOverride });
  if (!budget.ok) {
    runs.patch(runId, { status: 'blocked', error: budget.reason, finishedAt: Date.now() });
    emit(runId, { type: 'error', tool, text: budget.reason });
    emit(runId, { type: 'status', tool, status: 'blocked', budget });
    closeRunLog(runId);
    return { runId, promise: Promise.resolve({ ok: false, blocked: true, reason: budget.reason }) };
  }

  const promise = (async () => {
    if (inFlight >= MAX_CONCURRENT) {
      emit(runId, { type: 'status', tool, status: 'queued', queue: queueStatus() });
    }
    await acquireSlot();

    let wt = null;
    let workdir = cwd || repo;

    try {
      emit(runId, { type: 'status', tool, status: 'preparing' });
      runs.patch(runId, { status: 'preparing' });

      if (isolation === 'worktree') {
        wt = await createWorktree(repo || cwd, { name: `${tool}-${label || 'task'}` });
        workdir = wt.dir;
        runs.patch(runId, { worktree: wt });
        emit(runId, { type: 'status', tool, status: 'running', worktree: wt });
      } else {
        emit(runId, { type: 'status', tool, status: 'running' });
      }
      runs.patch(runId, { status: 'running' });
    } catch (err) {
      releaseSlot();
      runs.patch(runId, { status: 'failed', error: `worktree: ${err.message}`, finishedAt: Date.now() });
      emit(runId, { type: 'error', tool, text: `falha criando worktree: ${err.message}` });
      emit(runId, { type: 'status', tool, status: 'failed' });
      closeRunLog(runId);
      return { ok: false, error: err.message, runId };
    }

    const onEvent = (ev) => emit(runId, ev);
    let result;
    let sid = sessionId;

    // only transient failures are retried; failures on the merits pass through
    for (let attempt = 1; attempt <= TRANSIENT_RETRIES + 1; attempt++) {
      const spawned = adapter.run({
        prompt, cwd: workdir, sessionId: sid, resume, mode, model, effort, onEvent, timeoutMs,
      });

      active.set(runId, spawned.child);
      // the pid is persisted so a new daemon knows what was orphaned
      runs.patch(runId, { pid: spawned.child?.pid || null, attempts: attempt });
      if (spawned.sessionId) {
        sid = spawned.sessionId;
        runs.patch(runId, { sessionId: sid });
      }

      result = await spawned.done;
      active.delete(runId);

      if (!isTransient(result) || attempt > TRANSIENT_RETRIES) break;

      const backoffMs = 2000 * 2 ** (attempt - 1);
      emit(runId, {
        type: 'log',
        tool,
        text: `falha transitória (tentativa ${attempt}/${TRANSIENT_RETRIES + 1}); repetindo em ${backoffMs / 1000}s`,
      });
      emit(runId, { type: 'status', tool, status: 'retrying', attempt });
      await sleep(backoffMs);
    }

    releaseSlot();

    let diff = null;
    if (wt) {
      try {
        diff = await worktreeDiff(wt.dir);
      } catch (err) {
        emit(runId, { type: 'log', tool, text: `falha lendo diff: ${err.message}` });
      }
    }

    const status = result.ok ? 'done' : 'failed';
    runs.patch(runId, {
      status,
      output: result.output,
      cost: result.cost ?? null,
      tokens: result.tokens ?? null,
      sessionId: result.sessionId || sid || null,
      exitCode: result.code,
      error: result.error || null,
      pid: null,
      diff: diff ? { stat: diff.stat, files: diff.files } : null,
      finishedAt: Date.now(),
    });

    emit(runId, {
      type: 'status',
      tool,
      status,
      cost: result.cost ?? null,
      tokens: result.tokens ?? null,
      diff: diff ? { stat: diff.stat, files: diff.files } : null,
    });
    closeRunLog(runId);

    return { ...result, runId, worktree: wt, diff };
  })().catch((err) => {
    releaseSlot();
    active.delete(runId);
    runs.patch(runId, { status: 'failed', error: err.message, pid: null, finishedAt: Date.now() });
    emit(runId, { type: 'error', tool, text: err.message });
    emit(runId, { type: 'status', tool, status: 'failed' });
    closeRunLog(runId);
    return { ok: false, error: err.message, runId };
  });

  return { runId, promise };
}

export function cancelRun(runId) {
  const child = active.get(runId);
  if (!child) return false;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (active.has(runId)) child.kill('SIGKILL');
  }, 5000);
  runs.patch(runId, { status: 'cancelled', pid: null, finishedAt: Date.now() });
  emit(runId, { type: 'status', tool: runs.get(runId)?.tool, status: 'cancelled' });
  return true;
}

export function isActive(runId) {
  return active.has(runId);
}

export async function getRunDiff(runId, { full = false } = {}) {
  const run = runs.get(runId);
  if (!run?.worktree) return null;
  const diff = await worktreeDiff(run.worktree.dir);
  return full ? diff : { stat: diff.stat, files: diff.files };
}

export async function commitRun(runId, message) {
  const run = runs.get(runId);
  if (!run?.worktree) throw new Error('run sem worktree');
  const res = await commitWorktree(run.worktree.dir, message || `honeycomb: ${run.label}`);
  runs.patch(runId, { commit: res });
  return res;
}

export async function discardRun(runId) {
  const run = runs.get(runId);
  if (!run?.worktree) throw new Error('run sem worktree');
  await removeWorktree(run.repo, run.worktree.dir);
  runs.patch(runId, { worktree: null, discardedAt: Date.now() });
  return true;
}
