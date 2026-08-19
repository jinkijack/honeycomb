import { runs, tasks } from './store.mjs';

/**
 * Aggregates what Honeycomb was already recording run by run.
 *
 * The goal is to answer tool-choice questions with data instead of impressions:
 * which is cheaper to review with, which fails more, which takes longer. The
 * averages cover completed runs — including cancelled ones and ones that failed
 * at the gate would distort duration and cost.
 */

const DAY = 24 * 3600 * 1000;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

export function computeMetrics({ sinceDays = 30 } = {}) {
  const since = Date.now() - sinceDays * DAY;
  const all = runs.all().filter((r) => r.createdAt >= since);

  const byTool = {};
  for (const run of all) {
    const t = (byTool[run.tool] ||= {
      tool: run.tool,
      total: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      cost: 0,
      // tools that report usage in tokens (Codex) do not add to cost; we count
      // the runs of each kind so we never divide by non-reporters
      tokens: 0,
      runsWithCost: 0,
      runsWithTokens: 0,
      durations: [],
      filesTouched: 0,
    });

    t.total++;
    if (run.status === 'done') t.done++;
    else if (run.status === 'failed') t.failed++;
    else if (run.status === 'cancelled') t.cancelled++;

    if (typeof run.cost === 'number') {
      t.cost += run.cost;
      t.runsWithCost++;
    }
    if (typeof run.tokens === 'number') {
      t.tokens += run.tokens;
      t.runsWithTokens++;
    }
    if (run.status === 'done' && run.finishedAt) t.durations.push(run.finishedAt - run.createdAt);
    if (run.diff?.files?.length) t.filesTouched += run.diff.files.length;
  }

  const tools = Object.values(byTool).map((t) => {
    const sorted = [...t.durations].sort((a, b) => a - b);
    const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;
    return {
      tool: t.tool,
      total: t.total,
      done: t.done,
      failed: t.failed,
      cancelled: t.cancelled,
      successRate: t.total ? t.done / t.total : null,
      totalCost: Math.round(t.cost * 1000) / 1000,
      // average over reporters, not over total runs — otherwise a tool that
      // only sometimes reports would look cheaper than it is
      avgCost: t.runsWithCost ? Math.round((t.cost / t.runsWithCost) * 1000) / 1000 : null,
      totalTokens: t.tokens || null,
      avgTokens: t.runsWithTokens ? Math.round(t.tokens / t.runsWithTokens) : null,
      // which unit this tool uses to report usage
      unit: t.runsWithCost ? 'cost' : t.runsWithTokens ? 'tokens' : null,
      avgDurationMs: avg ? Math.round(avg) : null,
      p90DurationMs: percentile(sorted, 90),
      filesTouched: t.filesTouched,
    };
  });

  // approval rate: only meaningful on steps that emit a verdict
  const verdicts = { APROVADO: 0, REPROVADO: 0, byValidator: {} };
  let retryRounds = 0;
  let tasksWithRetry = 0;

  const taskList = tasks.all().filter((t) => t.createdAt >= since);
  for (const task of taskList) {
    let hadRetry = false;
    for (const step of task.steps) {
      if (step.verdict) {
        verdicts[step.verdict] = (verdicts[step.verdict] || 0) + 1;
        const v = (verdicts.byValidator[step.tool] ||= { APROVADO: 0, REPROVADO: 0 });
        v[step.verdict] = (v[step.verdict] || 0) + 1;
      }
      if (step.rounds > 1) {
        retryRounds += step.rounds - 1;
        hadRetry = true;
      }
    }
    if (hadRetry) tasksWithRetry++;
  }

  const totalVerdicts = verdicts.APROVADO + verdicts.REPROVADO;

  /**
   * Cost per task.
   *
   * The per-tool view answers "which agent is expensive"; this one answers
   * "which work was expensive", the question that shows up after a big bill. It
   * sums runs by taskId — including the correction rounds, which are precisely
   * what makes a task blow up without anyone noticing.
   */
  const runsByTask = new Map();
  for (const run of all) {
    if (!run.taskId) continue;
    if (!runsByTask.has(run.taskId)) runsByTask.set(run.taskId, []);
    runsByTask.get(run.taskId).push(run);
  }

  const byTask = taskList
    .map((task) => {
      const taskRuns = runsByTask.get(task.id) || [];
      const cost = taskRuns.reduce((a, r) => a + (typeof r.cost === 'number' ? r.cost : 0), 0);
      const tokens = taskRuns.reduce((a, r) => a + (typeof r.tokens === 'number' ? r.tokens : 0), 0);

      // group by step: one step can have several runs (corrections)
      const steps = {};
      for (const r of taskRuns) {
        const key = r.stepId || '—';
        const s = (steps[key] ||= { stepId: key, tool: r.tool, cost: 0, tokens: 0, runs: 0 });
        s.cost += typeof r.cost === 'number' ? r.cost : 0;
        s.tokens += typeof r.tokens === 'number' ? r.tokens : 0;
        s.runs++;
      }

      const durations = taskRuns.filter((r) => r.finishedAt).map((r) => r.finishedAt - r.createdAt);

      return {
        id: task.id,
        title: task.title,
        status: task.status,
        createdAt: task.createdAt,
        cost: Math.round(cost * 1000) / 1000,
        tokens: tokens || null,
        runCount: taskRuns.length,
        // extra rounds are the hidden cost: rework nobody asked for
        extraRounds: task.steps.reduce((a, s) => a + (s.rounds > 1 ? s.rounds - 1 : 0), 0),
        wallMs: durations.length ? Math.max(...durations) : null,
        steps: Object.values(steps)
          .map((s) => ({ ...s, cost: Math.round(s.cost * 1000) / 1000, tokens: s.tokens || null }))
          // sort by cost, and by tokens when the tool does not report cost
          .sort((a, b) => b.cost - a.cost || (b.tokens || 0) - (a.tokens || 0)),
      };
    })
    .sort((a, b) => b.cost - a.cost);

  // task-less runs (one-off launches) grouped so the totals add up
  const looseRuns = all.filter((r) => !r.taskId);
  const looseCost = looseRuns.reduce((a, r) => a + (typeof r.cost === 'number' ? r.cost : 0), 0);
  const looseTokens = looseRuns.reduce((a, r) => a + (typeof r.tokens === 'number' ? r.tokens : 0), 0);

  return {
    sinceDays,
    generatedAt: Date.now(),
    runs: {
      total: all.length,
      totalCost: Math.round(tools.reduce((a, t) => a + t.totalCost, 0) * 1000) / 1000,
      // kept separate: tokens and cost do not add up, and pretending they do
      // would produce a meaningless number
      totalTokens: tools.reduce((a, t) => a + (t.totalTokens || 0), 0) || null,
    },
    tasks: {
      total: taskList.length,
      done: taskList.filter((t) => t.status === 'done').length,
      failed: taskList.filter((t) => t.status === 'failed').length,
      withRetry: tasksWithRetry,
      extraRounds: retryRounds,
    },
    byTask,
    loose: {
      runs: looseRuns.length,
      cost: Math.round(looseCost * 1000) / 1000,
      tokens: looseTokens || null,
    },
    verdicts: {
      approved: verdicts.APROVADO,
      rejected: verdicts.REPROVADO,
      approvalRate: totalVerdicts ? verdicts.APROVADO / totalVerdicts : null,
      byValidator: verdicts.byValidator,
    },
    tools: tools.sort((a, b) => b.total - a.total),
  };
}
