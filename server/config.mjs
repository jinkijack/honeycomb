import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.HONEYCOMB_DATA_DIR || path.join(ROOT, 'data');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const WORKTREE_DIR = process.env.HONEYCOMB_WORKTREE_DIR || path.join(ROOT, 'worktrees');

// Loopback by default: the daemon can start agents with write permission, so
// exposing it on a network would be handing out remote code execution.
export const HOST = process.env.HONEYCOMB_HOST || '127.0.0.1';
export const PORT = Number(process.env.HONEYCOMB_PORT || 4317);

export const BIN = {
  claude: process.env.HONEYCOMB_CLAUDE_BIN || path.join(os.homedir(), '.local/bin/claude'),
  kiro: process.env.HONEYCOMB_KIRO_BIN || path.join(os.homedir(), '.local/bin/kiro-cli'),
  codex: process.env.HONEYCOMB_CODEX_BIN || 'codex',
  cursor: process.env.HONEYCOMB_CURSOR_BIN || path.join(os.homedir(), '.local/bin/cursor-agent'),
};

// Default per-step timeout. The ceiling is not about how long an agent thinks,
// it is about how long the work takes: the QA stage boots the project, waits on
// a real build and exercises flows against it, and 20min killed one mid-run on a
// Java repo after it had already produced 79KB of test log. A stuck process is
// still worse than a slow one, so there is a ceiling — just one sized for the
// slowest stage rather than the fastest.
export const DEFAULT_TIMEOUT_MS = Number(process.env.HONEYCOMB_TIMEOUT_MS || 90 * 60 * 1000);

/**
 * How many agents may run at the same time.
 *
 * Agents in `full` mode compile, run tests and spawn processes; several in
 * parallel fight over CPU and disk and end up slower than they would queued.
 * The excess waits in line instead of being refused.
 */
export const MAX_CONCURRENT = Number(process.env.HONEYCOMB_MAX_CONCURRENT || 3);

/**
 * Spend ceilings, in credit.
 *
 * TASK_BUDGET cuts off an orchestration that ran away: that is the case that
 * hurts, because correction rounds add up with nobody looking. DAILY_BUDGET is
 * the safety net for the whole day.
 *
 * 0 disables the ceiling — that is the default, because a limit set too low that
 * interrupts legitimate work is worse than none. Set your own number.
 */
export const TASK_BUDGET = Number(process.env.HONEYCOMB_TASK_BUDGET || 0);
export const DAILY_BUDGET = Number(process.env.HONEYCOMB_DAILY_BUDGET || 0);

/**
 * Retries on transient failure (capacity, rate limit, network). Does not apply
 * to failures on the merits — wrong code does not improve by being re-run.
 */
export const TRANSIENT_RETRIES = Number(process.env.HONEYCOMB_TRANSIENT_RETRIES || 2);

for (const dir of [DATA_DIR, LOG_DIR, WORKTREE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
