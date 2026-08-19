import { runs, tasks } from './store.mjs';
import { emit, closeRunLog } from './bus.mjs';

/**
 * Boot-time reconciliation.
 *
 * The map of live processes lives in memory; run status lives on disk. If the
 * daemon dies mid-execution the two disagree forever: the record says `running`,
 * but nobody is listening to that process. The run stays "in progress" in the UI
 * forever and the agent process becomes an orphan, still writing to the worktree
 * with nothing collecting the result.
 *
 * Reattaching is not possible: the stdout carrying the events died with the old
 * daemon. So reconciliation is honest rather than optimistic — it kills what is
 * left and marks the run `interrupted`, a state distinct from `failed` (the
 * agent did not err) and from `cancelled` (you did not ask for it).
 */

function processAlive(pid) {
  if (!pid) return false;
  try {
    // signal 0 sends nothing, it only tests existence and permission
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function killOrphan(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }, 3000);
    return true;
  } catch {
    return false;
  }
}

export function reconcile() {
  const stale = runs.all().filter((r) => ['running', 'preparing'].includes(r.status));
  const report = { runs: 0, killed: 0, tasks: 0 };

  for (const run of stale) {
    let killed = false;
    if (processAlive(run.pid)) {
      killed = killOrphan(run.pid);
      if (killed) report.killed++;
    }

    runs.patch(run.id, {
      status: 'interrupted',
      error: 'daemon reiniciou durante a execução',
      finishedAt: Date.now(),
      orphanKilled: killed,
    });

    emit(run.id, {
      type: 'error',
      tool: run.tool,
      text: killed
        ? 'daemon reiniciou; o processo do agente ficou órfão e foi encerrado'
        : 'daemon reiniciou durante a execução',
    });
    emit(run.id, { type: 'status', tool: run.tool, status: 'interrupted' });
    closeRunLog(run.id);
    report.runs++;
  }

  // a task whose step was interrupted cannot stay "running": there is no
  // execution loop driving it any more
  for (const task of tasks.all()) {
    if (!['running', 'pending'].includes(task.status)) continue;

    let touched = false;
    for (const step of task.steps) {
      if (['running', 'pending'].includes(step.status) && task.status === 'running') {
        step.status = step.status === 'running' ? 'interrupted' : 'skipped';
        if (step.status === 'skipped') step.skipReason = 'task interrompida por reinício do daemon';
        touched = true;
      }
    }

    if (task.status === 'running') {
      task.status = 'interrupted';
      task.finishedAt = Date.now();
      touched = true;
    }

    if (touched) {
      tasks.put(task);
      report.tasks++;
    }
  }

  if (report.runs || report.tasks) {
    console.log(
      `[recovery] ${report.runs} run(s) e ${report.tasks} task(s) marcados como interrompidos` +
        (report.killed ? `, ${report.killed} processo(s) órfão(s) encerrado(s)` : '')
    );
  }

  return report;
}
