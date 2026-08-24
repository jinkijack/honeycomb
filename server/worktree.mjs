import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { WORKTREE_DIR } from './config.mjs';

const exec = promisify(execFile);

async function git(repo, args) {
  const { stdout } = await exec('git', ['-C', repo, ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

export async function isGitRepo(dir) {
  try {
    await git(dir, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

export async function repoRoot(dir) {
  return (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
}

export async function currentBranch(dir) {
  return (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent';
}

/**
 * Creates an isolated worktree for an agent.
 *
 * Each agent gets its own directory and branch, based on the repo's current
 * HEAD. That way two agents run in parallel without overwriting each other, and
 * the user's working tree (which may hold uncommitted changes) is never touched.
 */
export async function createWorktree(repo, { name, baseRef, linkDeps = true } = {}) {
  const root = await repoRoot(repo);
  const base = baseRef || (await currentBranch(root));
  const id = `${slug(name)}-${Date.now().toString(36)}`;
  const dir = path.join(WORKTREE_DIR, id);
  const branch = `honeycomb/${id}`;

  await git(root, ['worktree', 'add', '-b', branch, dir, base]);

  /**
   * The commit the branch started from.
   *
   * Agents now commit their own work inside the worktree, which makes `diff HEAD`
   * useless for answering "what did the agent change?" — after the first commit it
   * returns nothing. Pinning the starting sha lets `worktreeDiff` answer that
   * question regardless of how many commits the agent made along the way.
   */
  const baseSha = (await git(dir, ['rev-parse', 'HEAD'])).trim();

  const linked = linkDeps ? linkDependencies(root, dir) : [];

  return { id, dir, branch, base, baseSha, repo: root, linked, createdAt: Date.now() };
}

/**
 * A fresh worktree has no dependencies installed, so the agent cannot run tsc,
 * lint or tests — it is limited to reading code. We symlink the main repo's
 * dependency directories in so validation can actually compile and execute.
 *
 * Symlink rather than copy because an Angular project's node_modules is hundreds
 * of MB, and copying that per agent would make running several in parallel
 * impractical. The side effect is that agents share the installed dependencies:
 * if one runs `npm install`, it affects the others. Acceptable, since the
 * expected flow is changing code, not dependencies.
 */
export const DEP_DIRS = ['node_modules', 'vendor', '.venv', 'target'];

/**
 * Which dependency directories are OUR symlinks in this worktree.
 *
 * Everything that stages files has to skip these, and for a reason that is easy
 * to miss: they enter the worktree as *symlinks*, and a `.gitignore` entry like
 * `node_modules/` matches a directory, not a link. Git sees a plain file, the
 * ignore rule does not apply, and `git add -A` stages it — a `120000` blob whose
 * content is an absolute path on this machine.
 *
 * The check is `isSymbolicLink` and not "is it in DEP_DIRS" because some
 * projects track `vendor/` as a real directory. Excluding that would erase
 * genuine agent work from the diff, and drop it from the commit.
 *
 * Shared by `worktreeDiff` and `commitWorktree` on purpose: the two must agree
 * on what counts as ours, and they did not while each carried its own copy.
 */
export function linkedDepDirs(dir) {
  return DEP_DIRS.filter((d) => {
    try {
      return fs.lstatSync(path.join(dir, d)).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

function linkDependencies(root, dir) {
  const linked = [];
  for (const dep of DEP_DIRS) {
    const src = path.join(root, dep);
    const dest = path.join(dir, dep);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest)) continue;
    try {
      fs.symlinkSync(src, dest, 'dir');
      linked.push(dep);
    } catch {
      // no permission, or a filesystem without symlinks: carry on without it
    }
  }
  return linked;
}

export async function removeWorktree(repo, dir, { force = true } = {}) {
  const root = await repoRoot(repo);

  // remove the dependency symlinks first, so no tool follows the link and
  // deletes the main repo's node_modules
  for (const dep of DEP_DIRS) {
    const link = path.join(dir, dep);
    try {
      if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    } catch {
      // does not exist, or is not a symlink
    }
  }

  const args = ['worktree', 'remove', dir];
  if (force) args.push('--force');
  await git(root, args);
}

export async function listWorktrees(repo) {
  const root = await repoRoot(repo);
  const out = await git(root, ['worktree', 'list', '--porcelain']);
  const entries = [];
  let cur = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur.path) entries.push(cur);
      cur = { path: line.slice(9) };
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace('refs/heads/', '');
    } else if (line === 'detached') {
      cur.detached = true;
    }
  }
  if (cur.path) entries.push(cur);
  return entries;
}

/**
 * Complete diff of an agent's work, including new files.
 *
 * `baseSha` decides which question is being asked. With it, the answer is "what
 * did the agent change since the worktree was created", which survives the agent
 * committing its own work. Without it, the answer is "what is uncommitted right
 * now" — which is what the garbage collector needs and the orchestrator does not.
 */
export async function worktreeDiff(dir, { baseSha = null } = {}) {
  if (!fs.existsSync(dir)) return { stat: '', patch: '', files: [] };

  /**
   * -N makes new files show up in the diff without having to commit. Without the
   * exclusion below it would also mark the dependency symlinks as new files, and
   * they would show up in EVERY agent diff as if the agent had created them.
   */
  const linked = linkedDepDirs(dir);

  // drop from the index whatever a previous run already marked with -N
  if (linked.length) {
    await exec('git', ['-C', dir, 'rm', '--cached', '-q', '--ignore-unmatch', '--', ...linked], {
      maxBuffer: 8 * 1024 * 1024,
    }).catch(() => {});
  }

  await exec(
    'git',
    ['-C', dir, 'add', '-AN', '--', '.', ...linked.map((d) => `:(exclude)${d}`)],
    { maxBuffer: 8 * 1024 * 1024 }
  ).catch(() => {});

  // a sha recorded by a previous daemon may no longer resolve (branch pruned,
  // repo re-cloned); falling back to HEAD degrades the answer without failing it
  let from = 'HEAD';
  if (baseSha) {
    const ok = await git(dir, ['cat-file', '-e', `${baseSha}^{commit}`]).then(() => true).catch(() => false);
    if (ok) from = baseSha;
  }

  const [stat, patch, nameStatus] = await Promise.all([
    git(dir, ['diff', '--stat', from]).catch(() => ''),
    git(dir, ['diff', from]).catch(() => ''),
    git(dir, ['diff', '--name-status', from]).catch(() => ''),
  ]);

  const files = nameStatus
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status, path: rest.join('\t') };
    });

  return { stat: stat.trim(), patch, files };
}

/**
 * Detects whether a worktree's content already exists committed on some branch.
 *
 * It exists because the naive classification ("does it differ from HEAD? then it
 * is pending work") produces a common false positive: you take the agent's work
 * to your branch out of band — cherry-pick, copying a file, applying a patch —
 * and the worktree still looks like it holds something irreplaceable, when it is
 * really just garbage nobody feels safe deleting.
 *
 * It compares by content hash: for each changed file, it looks for the same path
 * with the same blob on some ref. If ALL of them match, the work has landed. A
 * single unmatched file is enough to drop the conclusion — when in doubt,
 * preserve.
 */
export async function findLandedIn(worktreeDir, files, { maxRefs = 80 } = {}) {
  if (!files?.length) return null;

  // deleted files have no content to compare; the heuristic does not apply and
  // we prefer to conclude nothing
  if (files.some((f) => f.status?.startsWith('D'))) return null;

  const root = await repoRoot(worktreeDir);

  const refsOut = await git(root, [
    'for-each-ref', '--format=%(refname)', '--sort=-committerdate',
    'refs/heads', 'refs/remotes',
  ]).catch(() => '');
  const refs = refsOut.split('\n').filter(Boolean).slice(0, maxRefs);
  if (!refs.length) return null;

  // local hash of each changed file
  const wanted = [];
  for (const f of files) {
    const abs = path.join(worktreeDir, f.path);
    if (!fs.existsSync(abs)) return null;
    const hash = (await git(worktreeDir, ['hash-object', abs])).trim();
    wanted.push({ path: f.path, hash });
  }

  for (const ref of refs) {
    let all = true;
    for (const w of wanted) {
      const got = await git(root, ['rev-parse', `${ref}:${w.path}`])
        .then((s) => s.trim())
        .catch(() => null);
      if (got !== w.hash) {
        all = false;
        break;
      }
    }
    if (all) {
      const sha = (await git(root, ['rev-parse', '--short', ref])).trim();
      return { ref: ref.replace(/^refs\/(heads|remotes)\//, ''), sha };
    }
  }

  return null;
}

/**
 * Lines that must never reach a commit message.
 *
 * Attribution trailers are added by habit by every coding agent, and they end up
 * in the history of a repository that never asked for them. Stripping them here
 * rather than only asking the agent nicely means the rule holds even when the
 * message comes from the agent's own `git commit`.
 */
const BANNED_TRAILERS = [
  /^\s*co-authored-by:/i,
  /^\s*(🤖\s*)?generated with\b/i,
  /^\s*assisted-by:/i,
  /^\s*signed-off-by:\s*claude/i,
];

export function sanitizeMessage(message) {
  const clean = String(message || '')
    .split('\n')
    .filter((line) => !BANNED_TRAILERS.some((re) => re.test(line)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean || 'honeycomb: alteracoes do agente';
}

/**
 * Refuses to commit anywhere but on the agent's own branch.
 *
 * The whole isolation guarantee rests on the agent's work landing on
 * `honeycomb/<id>` and nowhere else. An agent that runs `git checkout main`
 * inside its worktree breaks that silently — the commit would look normal and
 * land on the user's branch. Checking the branch at commit time is the one place
 * that catches it regardless of how the checkout happened.
 */
export async function assertAgentBranch(dir) {
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!branch.startsWith('honeycomb/')) {
    throw new Error(
      `worktree esta na branch "${branch}", nao numa branch do honeycomb — ` +
        'recusando commit para nao escrever na branch do projeto'
    );
  }
  return branch;
}

/**
 * Consolidates the agent's work into a commit on its own branch.
 *
 * The dependency symlinks are kept out of the commit for the reason spelled out
 * on `linkedDepDirs`: a bare `git add -A` stages them, and the branch ends up
 * carrying a `120000` blob pointing at an absolute path on the machine that
 * produced it. It was invisible for a long time because `worktreeDiff` filters
 * them, so the UI showed a clean diff while the commit did not match it.
 *
 * `rm --cached` runs as well as the exclusion, and it is not redundant: the
 * agents are told to commit their own work, and they use `git add -A` too. When
 * one of them already tracked the link, excluding it from our `add` would leave
 * it in the tree forever — dropping it from the index makes this commit the one
 * that removes it. `--ignore-unmatch` keeps that a no-op in the normal case, and
 * `--cached` leaves the link itself in place, which the running agent may still
 * need.
 */
export async function commitWorktree(dir, message) {
  await assertAgentBranch(dir);

  const linked = linkedDepDirs(dir);
  if (linked.length) {
    await git(dir, ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...linked]).catch(() => {});
  }
  await git(dir, ['add', '-A', '--', '.', ...linked.map((d) => `:(exclude)${d}`)]);

  try {
    await git(dir, ['commit', '--no-gpg-sign', '-m', sanitizeMessage(message)]);
  } catch (err) {
    if (/nothing to commit/i.test(err.stdout || err.message || '')) {
      return { committed: false, reason: 'nothing to commit' };
    }
    throw err;
  }
  const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  return { committed: true, sha };
}
