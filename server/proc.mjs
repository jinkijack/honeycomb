/**
 * Killing an agent means killing what it spawned.
 *
 * Every one of these CLIs is a launcher. `kiro-cli` execs `kiro-cli-chat`, and
 * the grandchild is what does the work:
 *
 *     PID   PPID  PGID  COMMAND
 *     7933  7930  7930  kiro-cli        ← the direct child
 *     7940  7933  7930  kiro-cli-chat   ← the one actually working
 *
 * `child.kill()` signals only the direct child. The worker survives, keeps
 * writing to the inherited pipe — so the daemon goes on receiving events from a
 * run it believes it stopped — and keeps billing. A cancelled run was observed
 * spending 4.92 credits over the 160 seconds after the cancel, and the same hole
 * made `HONEYCOMB_TIMEOUT_MS` a suggestion rather than a ceiling.
 *
 * The fix has two halves and neither works alone. `SPAWN_OPTS` carries
 * `detached: true`, which on POSIX makes the child a process-group leader so its
 * descendants inherit its group; `killTree` then signals the negative pid, which
 * means "the whole group". Without `detached` the child sits in the DAEMON's
 * group, and signalling that group would kill the daemon along with it.
 *
 * `detached` does not mean unsupervised: we never `unref()`, so the daemon still
 * owns the pipes and still waits for `close`.
 */

import { spawn } from 'node:child_process';

/** Spawn options every adapter shares, so no adapter can forget the group. */
export const SPAWN_OPTS = {
  detached: true,
  // stdin closed: with it open these CLIs sit waiting for extra input
  stdio: ['ignore', 'pipe', 'pipe'],
};

/**
 * Spawns an agent with the prompt on stdin instead of in argv.
 *
 * argv is not a place to put a prompt. Linux caps a *single* argument at
 * `MAX_ARG_STRLEN` — 32 pages, 131072 bytes — no matter how much larger
 * `ARG_MAX` is, and `execve` then refuses the whole call with `E2BIG` before any
 * process exists. That is not a hypothetical ceiling: a QA step carrying the
 * implementer's report (106 KB) and the reviewer's (40 KB) died at 65ms with
 * `attempts: 0`, after both of those had already been paid for. The failure is
 * also invisible from the outside — it reads as "the QA step failed", with
 * nothing pointing at the size of the prompt.
 *
 * Only stdin is a real fix. None of these CLIs takes a prompt file, so the
 * alternative is a prompt that *points* at a file, and an agent that is told to
 * go read its instructions may skim them, grep them, or read half — the
 * templates are product behaviour, and they have to arrive whole.
 *
 * The pipe is opened and closed in the same breath. `SPAWN_OPTS` keeps stdin on
 * `ignore` because these CLIs sit waiting for more input while it is open, and a
 * pipe we never `end()` reproduces exactly that hang.
 */
export function spawnWithPrompt(bin, args, opts, prompt) {
  const child = spawn(bin, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
  // An agent that exits before reading gives us EPIPE. That is the run failing
  // on its own terms; an unhandled 'error' here would take the daemon with it.
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  return child;
}

/**
 * Signals the child's whole process group, falling back to the child alone.
 *
 * The fallback matters on a platform where `detached` did not give us a group,
 * and after the child is already gone — `process.kill` on a dead group throws
 * ESRCH, which is not a failure worth propagating out of a cancellation.
 */
export function killTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * SIGTERM now, SIGKILL if it is still there.
 *
 * The grace period is what lets an agent flush its last output and remove its
 * own temp files; the SIGKILL is what makes the ceiling real when it does not.
 */
export function killTreeHard(child, { graceMs = 5000 } = {}) {
  killTree(child, 'SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) killTree(child, 'SIGKILL');
  }, graceMs);
  timer.unref?.();
  return timer;
}
