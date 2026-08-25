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

/** Spawn options every adapter shares, so no adapter can forget the group. */
export const SPAWN_OPTS = {
  detached: true,
  // stdin closed: with it open these CLIs sit waiting for extra input
  stdio: ['ignore', 'pipe', 'pipe'],
};

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
