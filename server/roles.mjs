import fs from 'node:fs';
import { runs } from './store.mjs';
import { getRunDiff } from './runner.mjs';
import { reviewPrompt } from './review.mjs';
import { qaPrompt, resolveBrowser, reservePorts, DEFAULT_BROWSER } from './qa.mjs';

/**
 * Run roles.
 *
 * A `cross` is the three roles wired into a graph, and until now that graph was
 * the only way to reach two of them. That made the flow all-or-nothing: a QA
 * step that died on a rate limit took the implementation with it, because the
 * only way to get a tester running again was to run the whole chain again and
 * pay for a fresh implementation of code that already existed.
 *
 * A role is the same prompt, the same mode and the same worktree as the step
 * inside the flow — just addressed directly, at work that already happened.
 * `restart` is built on this too, so the standalone run and the resumed step
 * cannot drift apart.
 */
export const RUN_ROLES = ['agent', 'validator', 'qa'];

/**
 * Roles other than `agent` need somewhere to look, and it has to be a worktree
 * Honeycomb made.
 *
 * The tester runs in `full` — it writes, it opens shells, it boots servers. In a
 * worktree that is the whole point and the isolation holds. Pointed at the
 * user's own checkout it would be an agent with total autonomy in the working
 * tree, which is the one thing this product exists to avoid. So the target is
 * required, and it is required to still be on disk: a discarded worktree that
 * silently falls back to the repo root is the same failure wearing a disguise.
 */
export function resolveTarget(runId) {
  const target = runs.get(runId);
  if (!target) throw new Error(`run alvo nao encontrado: ${runId}`);

  const dir = target.worktree?.dir;
  if (!dir) {
    throw new Error(
      `o run ${runId} nao tem worktree (rodou em modo shared) — ` +
        'nao ha o que revisar ou testar isoladamente'
    );
  }
  if (!fs.existsSync(dir)) {
    throw new Error(
      `o worktree do run ${runId} nao existe mais em ${dir} — ` +
        'foi descartado, e o codigo que seria revisado nao esta la'
    );
  }
  return { target, dir };
}

/**
 * Everything a role run needs, resolved against work that already exists.
 *
 * Returns the shape `startRun` takes, so the route stays a thin translation and
 * every decision that matters — which mode, which directory, which prompt, which
 * ports — is made in one place.
 */
export async function buildRoleRun({
  role,
  of,
  tool,
  spec = null,
  model = null,
  verifyCommands = null,
  browser = DEFAULT_BROWSER,
  startCommand = null,
  baseUrl = null,
  notes = null,
}) {
  if (!RUN_ROLES.includes(role)) throw new Error(`papel desconhecido: ${role}`);
  if (!of) throw new Error(`o papel "${role}" precisa de um run alvo (of)`);

  const { target, dir } = resolveTarget(of);

  // the diff is the reviewer's primary evidence; `baseSha` asks "what did the
  // agent change", which survives the agent having committed its own work
  const diff = await getRunDiff(target.id).catch(() => null);
  const spectext = spec || target.prompt || '(sem especificacao registrada)';

  const common = {
    tool,
    model,
    repo: target.repo,
    cwd: dir,
    // never a new worktree: the work being judged is in the target's
    isolation: 'shared',
    targetRunId: target.id,
  };

  if (role === 'validator') {
    return {
      ...common,
      // `verify` and not `ro`: it must run the build and the tests for real,
      // and must not alter what it is judging
      mode: 'verify',
      label: `validação de ${target.label || target.id.slice(0, 8)}`,
      prompt: reviewPrompt({
        spec: spectext,
        commands: verifyCommands,
        implOutput: target.output || '(o run alvo nao registrou saida)',
        implDiff: diff?.stat || '(sem diff — nada mudou no worktree)',
      }),
    };
  }

  // --- qa -----------------------------------------------------------------
  const resolved = await resolveBrowser(browser, { tool });
  const ports = await reservePorts(3);

  const prompt = qaPrompt({
    spec: spectext,
    browser: resolved,
    startCommand,
    baseUrl,
    notes,
    regressionCommands: verifyCommands,
    implOutput: target.output || '(o run alvo nao registrou saida)',
    /**
     * Said out loud rather than left blank. The prompt asks the tester to weigh
     * the reviewer's opinion, and a silent empty section invites it to invent
     * one — while knowing nobody reviewed this is itself useful to the tester.
     */
    reviewOutput:
      target.stepId === 'impl' || !target.stepId
        ? '(nenhuma revisao anterior: este QA foi disparado sozinho, sobre o worktree do implementador)'
        : '(nenhuma revisao anterior registrada para este alvo)',
    implDiff: diff?.stat || '(sem diff — nada mudou no worktree)',
  }).split('{{ports}}').join(ports.join(', '));

  return {
    ...common,
    mode: 'full',
    label: `qa de ${target.label || target.id.slice(0, 8)}`,
    prompt,
    mcpServers: resolved.mcpServers,
    env: { PORT: String(ports[0]), HONEYCOMB_QA_PORTS: ports.join(',') },
    note: resolved.note || null,
  };
}
