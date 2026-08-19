import { runs } from './store.mjs';
import { TASK_BUDGET, DAILY_BUDGET } from './config.mjs';

/**
 * Spend ceilings.
 *
 * Two scales, because they fail in different ways:
 *
 *   task   an orchestration that enters a correction round can double in price
 *          with nobody watching — that is the 41-credit case. The ceiling is
 *          checked BETWEEN steps, the only point where stopping does not waste
 *          what has already been paid for.
 *   day    a safety net for the whole set: many small tasks add up too.
 *
 * There is no per-run ceiling: cost is only known once the run ends, so aborting
 * mid-way would throw away exactly what was already spent. Promising a limit
 * that can only be verified afterwards would be misleading.
 *
 * Tokens are deliberately left out of the ceilings: they are a different unit,
 * and converting would need a price table that would silently go stale.
 */

const DAY = 24 * 3600 * 1000;

export function taskSpend(taskId) {
  return runs
    .all()
    .filter((r) => r.taskId === taskId && typeof r.cost === 'number')
    .reduce((a, r) => a + r.cost, 0);
}

export function daySpend({ since = Date.now() - DAY } = {}) {
  return runs
    .all()
    .filter((r) => r.createdAt >= since && typeof r.cost === 'number')
    .reduce((a, r) => a + r.cost, 0);
}

/**
 * @param taskId    when given, also checks the orchestration ceiling
 * @param override  ceiling specific to that task, overriding the global one
 * @returns { ok, reason, spent, limit, scope }
 */
export function checkBudget({ taskId = null, override = null } = {}) {
  const daily = DAILY_BUDGET;
  if (daily > 0) {
    const spent = daySpend();
    if (spent >= daily) {
      return {
        ok: false,
        scope: 'daily',
        spent: round(spent),
        limit: daily,
        reason: `teto diário atingido: ${round(spent)} de ${daily} crédito(s) nas últimas 24h`,
      };
    }
  }

  const perTask = override != null ? Number(override) : TASK_BUDGET;
  if (taskId && perTask > 0) {
    const spent = taskSpend(taskId);
    if (spent >= perTask) {
      return {
        ok: false,
        scope: 'task',
        spent: round(spent),
        limit: perTask,
        reason: `teto da task atingido: ${round(spent)} de ${perTask} crédito(s)`,
      };
    }
  }

  return { ok: true };
}

export function budgetStatus() {
  return {
    daily: {
      limit: DAILY_BUDGET || null,
      spent: round(daySpend()),
    },
    task: { limit: TASK_BUDGET || null },
  };
}

const round = (n) => Math.round(n * 1000) / 1000;
