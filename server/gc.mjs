import fs from 'node:fs';
import path from 'node:path';
import { WORKTREE_DIR } from './config.mjs';
import { runs } from './store.mjs';
import { worktreeDiff, removeWorktree, findLandedIn } from './worktree.mjs';

/**
 * Collection of abandoned worktrees.
 *
 * The rule guiding everything here: never delete work nobody has seen. A
 * worktree with uncommitted changes may be the only copy of something useful, so
 * it only goes on an explicit request. What automatic collection removes is what
 * provably has nothing to lose:
 *
 *   empty      the agent changed nothing — garbage by definition
 *   committed  the work is on the branch, the directory is redundant
 *
 * Worktrees with pending changes are listed as 'dirty' and preserved, for you to
 * decide about.
 */

const HOURS = 3600 * 1000;

export async function inspectWorktrees() {
  if (!fs.existsSync(WORKTREE_DIR)) return [];

  const byDir = new Map();
  for (const run of runs.all()) {
    if (run.worktree?.dir) byDir.set(run.worktree.dir, run);
  }

  const out = [];
  for (const name of fs.readdirSync(WORKTREE_DIR)) {
    const dir = path.join(WORKTREE_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;

    const run = byDir.get(dir) || null;
    let files = [];
    try {
      files = (await worktreeDiff(dir)).files;
    } catch {
      // broken worktree, or half-removed
    }

    const ageMs = Date.now() - (run?.createdAt || fs.statSync(dir).mtimeMs);
    const committed = !!run?.commit?.committed;

    // the work may have been taken to another branch outside Honeycomb
    let landed = null;
    if (files.length && !committed) {
      try {
        landed = await findLandedIn(dir, files);
      } catch {
        // the heuristic is best-effort; failing here only means "I don't know"
      }
    }

    const state =
      files.length === 0 ? 'empty' : committed || landed ? 'committed' : 'dirty';

    out.push({
      dir,
      name,
      branch: run?.worktree?.branch || null,
      runId: run?.id || null,
      runLabel: run?.label || null,
      repo: run?.repo || null,
      orphan: !run,
      ageHours: Math.round(ageMs / HOURS),
      fileCount: files.length,
      files: files.map((f) => f.path),
      committed,
      landed,
      state,
    });
  }

  return out.sort((a, b) => b.ageHours - a.ageHours);
}

/**
 * @param minAgeHours minimum age to consider (default 2h, so it does not catch
 *                    the worktree of an agent still running)
 * @param includeDirty only on an explicit request — also removes pending work
 */
export async function collect({
  minAgeHours = 2,
  includeDirty = false,
  dryRun = true,
  repo = null,
  dirs = null,
} = {}) {
  const all = await inspectWorktrees();

  const eligible = all.filter((w) => {
    // `dirs` and `repo` exist so that "clean up my test worktrees" cannot sweep
    // another repository's worktrees along with them. Without a scope, an
    // includeDirty takes everything on disk — including work unrelated to the
    // intended cleanup.
    if (dirs?.length && !dirs.includes(w.dir)) return false;
    if (repo && w.repo !== repo) return false;
    if (w.ageHours < minAgeHours) return false;
    if (w.state === 'dirty') return includeDirty;
    return true;
  });

  if (dryRun) {
    return { dryRun: true, candidates: eligible, kept: all.length - eligible.length };
  }

  const removed = [];
  const errors = [];
  for (const w of eligible) {
    try {
      const run = w.runId ? runs.get(w.runId) : null;
      await removeWorktree(run?.repo || w.dir, w.dir);
      if (run) runs.patch(run.id, { worktree: null, discardedAt: Date.now() });
      removed.push(w.dir);
    } catch (err) {
      errors.push({ dir: w.dir, error: err.message });
    }
  }

  return { dryRun: false, removed, errors, kept: all.length - removed.length };
}

/** Conservative periodic collection, started when the daemon boots. */
export function scheduleGc({ intervalHours = 6, minAgeHours = 24 } = {}) {
  const tick = async () => {
    try {
      const res = await collect({ minAgeHours, includeDirty: false, dryRun: false });
      if (res.removed?.length) {
        console.log(`[gc] ${res.removed.length} worktree(s) recolhido(s)`);
      }
    } catch (err) {
      console.error('[gc]', err.message);
    }
  };

  const timer = setInterval(tick, intervalHours * HOURS);
  timer.unref();
  return timer;
}
