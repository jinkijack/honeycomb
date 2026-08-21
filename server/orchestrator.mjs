import { randomUUID } from 'node:crypto';
import { tasks, runs } from './store.mjs';
import { emit } from './bus.mjs';
import { startRun, getRunDiff } from './runner.mjs';
import { checkBudget, taskSpend } from './budget.mjs';
import { bus } from './bus.mjs';
import { commitWorktree } from './worktree.mjs';
import { qaPrompt, reservePorts } from './qa.mjs';

/**
 * Multi-agent orchestration engine.
 *
 * A task is a graph of steps. Each step runs on a tool (kiro, claude, codex) and
 * declares which other steps it depends on. Steps with no pending dependency run
 * in parallel; the rest wait.
 *
 * The use case that motivated this: an implementation step on kiro, and a
 * validation step on Claude Code that reads the diff kiro produced and issues a
 * verdict. The base session (the one driving Honeycomb) only orchestrates — it
 * neither writes code nor reviews directly.
 *
 * Interpolation available in each step's prompt:
 *   {{repo}}                repository path
 *   {{steps.<id>.output}}   final text produced by another step
 *   {{steps.<id>.diff}}     diff --stat of another step's worktree
 *   {{steps.<id>.patch}}    full patch of another step's worktree
 *   {{steps.<id>.workdir}}  another step's worktree directory
 *   {{ports}}               free ports reserved for this attempt (reservePorts)
 */

const VERDICT = /VEREDITO:\s*(APROVADO|REPROVADO)/i;
const WINNER = /VENCEDOR:\s*([\w-]+)/i;

const taskEvents = (taskId, event) => {
  bus.emit('task', { taskId, ts: Date.now(), ...event });
};

function topoOrder(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const seen = new Set();
  const order = [];

  const visit = (id, stack = new Set()) => {
    if (seen.has(id)) return;
    if (stack.has(id)) throw new Error(`ciclo de dependencia envolvendo "${id}"`);
    const step = byId.get(id);
    if (!step) throw new Error(`passo "${id}" nao existe (referenciado em dependsOn)`);
    stack.add(id);
    for (const dep of step.dependsOn || []) visit(dep, stack);
    stack.delete(id);
    seen.add(id);
    order.push(id);
  };

  for (const s of steps) visit(s.id);
  return order;
}

async function interpolate(text, ctx) {
  let out = String(text);

  out = out.replace(/\{\{repo\}\}/g, ctx.repo || '');

  const refs = [...out.matchAll(/\{\{steps\.([\w-]+)\.(output|diff|patch|workdir)\}\}/g)];
  for (const [token, stepId, field] of refs) {
    const result = ctx.results[stepId];
    let value = '';
    if (result) {
      if (field === 'output') {
        value = result.output || '';
      } else if (field === 'workdir') {
        value = result.worktree?.dir || '';
      } else if (field === 'diff' || field === 'patch') {
        const d = await getRunDiff(result.runId, { full: field === 'patch' });
        if (d) value = field === 'patch' ? d.patch : d.stat;
      }
    }
    out = out.split(token).join(value);
  }

  return out;
}

export function createTask({ title, repo, steps, budget = null }) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('a task precisa de pelo menos um passo');
  }

  const ids = new Set();
  for (const s of steps) {
    if (!s.id) throw new Error('todo passo precisa de um id');
    if (ids.has(s.id)) throw new Error(`id de passo duplicado: ${s.id}`);
    ids.add(s.id);
    if (!s.tool) throw new Error(`passo "${s.id}" sem ferramenta`);
  }

  topoOrder(steps); // validates cycles and references before persisting

  const task = {
    id: randomUUID(),
    title: title || 'Task sem titulo',
    repo,
    // this orchestration's own ceiling, overriding the global one
    budget: budget != null ? Number(budget) : null,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    steps: steps.map((s) => ({
      id: s.id,
      tool: s.tool,
      prompt: s.prompt,
      mode: s.mode || 'ro',
      isolation: s.isolation || 'worktree',
      workdirFrom: s.workdirFrom || null,
      dependsOn: s.dependsOn || [],
      gate: !!s.gate,
      /**
       * { of: '<stepId>', max: N, through: ['<stepId>', ...] }
       *
       * On rejection the critique goes back to `of`, and then everything in
       * `through` runs again before this step does — in order. That is what makes
       * a defect found in testing go back through review instead of straight back
       * to the tester: an implementer's fix is new code, and new code has not been
       * reviewed.
       */
      retry: s.retry?.of
        ? {
            of: s.retry.of,
            max: Number(s.retry.max || 2),
            through: Array.isArray(s.retry.through) ? s.retry.through.filter(Boolean) : [],
          }
        : null,
      model: s.model || null,
      effort: s.effort || null,
      // extra MCP servers for this step only (the browser the tester drives)
      mcpServers: s.mcpServers || null,
      env: s.env || null,
      // free TCP ports handed to the step, so two testers booting the same
      // project in parallel do not collide on its default port
      reservePorts: Number(s.reservePorts || 0),
      // commit what the step produced onto the worktree's own branch
      autoCommit: !!s.autoCommit,
      // a caveat about how this step had to be configured (e.g. the browser
      // asked for was downgraded), carried so it reaches whoever reads the task
      // and not only whoever created it
      note: s.note || null,
      status: 'pending',
      runId: null,
      verdict: null,
      rounds: null,
      retryRound: null,
      commit: null,
    })),
  };

  tasks.put(task);
  taskEvents(task.id, { type: 'task_created', task });
  return task;
}

export async function runTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) throw new Error('task nao encontrada');
  if (task.status === 'running') throw new Error('task ja esta rodando');

  task.status = 'running';
  task.startedAt = Date.now();
  tasks.put(task);
  taskEvents(taskId, { type: 'task_status', status: 'running' });

  const order = topoOrder(task.steps);
  const byId = new Map(task.steps.map((s) => [s.id, s]));
  const results = {};
  const finished = new Set();
  const failed = new Set();

  const patchStep = (stepId, changes) => {
    const step = byId.get(stepId);
    Object.assign(step, changes);
    tasks.put(task);
    taskEvents(taskId, { type: 'step_status', stepId, ...changes });
  };

  /**
   * Commits what a step produced onto the worktree's own branch.
   *
   * Best-effort on purpose: a commit that fails (a pre-commit hook, a checkout
   * the agent did against the rules) must be reported, not turn a step that
   * actually did the work into a failure. `commitWorktree` refuses anything that
   * is not a `honeycomb/` branch, which is what keeps this from ever writing to
   * the user's own branch.
   */
  const autoCommit = async (stepId, dir, runId) => {
    if (!dir) return null;
    try {
      const res = await commitWorktree(dir, `honeycomb(${stepId}): ${task.title}`);
      if (res.committed) {
        runs.patch(runId, { commit: res });
        patchStep(stepId, { commit: res });
        taskEvents(taskId, { type: 'commit', stepId, sha: res.sha });
      }
      return res;
    } catch (err) {
      taskEvents(taskId, { type: 'commit_failed', stepId, error: err.message });
      return { committed: false, error: err.message };
    }
  };

  /** Fires one attempt of a step and returns the raw result. */
  const attempt = async (stepId, { promptOverride, cwdOverride, labelSuffix = '' } = {}) => {
    const step = byId.get(stepId);

    let prompt = promptOverride;
    if (prompt == null) {
      prompt = await interpolate(step.prompt, { repo: task.repo, results });
    }

    /**
     * Ports are reserved per attempt, not per task: a task created today and run
     * again next week would otherwise carry ports that meanwhile got taken.
     */
    let env = step.env ? { ...step.env } : null;
    if (step.reservePorts > 0) {
      const ports = await reservePorts(step.reservePorts);
      prompt = prompt.split('{{ports}}').join(ports.join(', '));
      env = { ...(env || {}), PORT: String(ports[0]), HONEYCOMB_QA_PORTS: ports.join(',') };
    }

    // a step may work inside another step's worktree (e.g. reviewing what the
    // implementer produced) instead of creating its own
    let cwd = cwdOverride || task.repo;
    let isolation = cwdOverride ? 'shared' : step.isolation;
    if (!cwdOverride && step.workdirFrom) {
      const src = results[step.workdirFrom];
      if (src?.worktree?.dir) {
        cwd = src.worktree.dir;
        isolation = 'shared';
      }
    }

    patchStep(stepId, { status: 'running' });

    const { runId, promise } = await startRun({
      tool: step.tool,
      prompt,
      repo: task.repo,
      cwd,
      isolation,
      mode: step.mode,
      model: step.model,
      effort: step.effort,
      mcpServers: step.mcpServers,
      env,
      label: `${task.title} / ${stepId}${labelSuffix}`,
      taskId,
      stepId,
    });

    patchStep(stepId, { runId });

    // the retry run inherits the worktree it continues, otherwise its diff is
    // orphaned in the UI and CLI — the work is there, only the reference is lost
    const inheritedWorktree = cwdOverride ? results[stepId]?.worktree : null;
    if (inheritedWorktree) runs.patch(runId, { worktree: inheritedWorktree });

    const result = await promise;

    /**
     * A retry inside an existing worktree runs as 'shared', and in that mode
     * startRun returns worktree null — it created none. If we let that null
     * overwrite the previous result, every step pointing here via workdirFrom
     * loses the reference and ends up in the original repo, where the work is
     * not.
     */
    if (cwdOverride && !result.worktree && results[stepId]?.worktree) {
      result.worktree = results[stepId].worktree;
    }

    results[stepId] = result;

    /**
     * The work is committed as soon as the step that produced it succeeds, one
     * commit per attempt. That keeps each correction round legible in the branch
     * history instead of collapsing into one final blob, and it means a crash
     * later in the task cannot lose work that was already done.
     */
    if (step.autoCommit && result.ok) {
      await autoCommit(stepId, result.worktree?.dir || (isolation === 'shared' ? cwd : null), runId);
    }

    const verdictMatch = (result.output || '').match(VERDICT);
    const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : null;

    return { result, verdict };
  };

  const runStep = async (stepId) => {
    const step = byId.get(stepId);

    // if any dependency failed or was rejected, this step does not run
    const blocked = (step.dependsOn || []).filter((d) => failed.has(d));
    if (blocked.length) {
      patchStep(stepId, { status: 'skipped', skipReason: `dependencia falhou: ${blocked.join(', ')}` });
      failed.add(stepId);
      return;
    }

    let outcome;
    try {
      outcome = await attempt(stepId);
    } catch (err) {
      patchStep(stepId, { status: 'failed', error: err.message });
      failed.add(stepId);
      return;
    }

    let { result, verdict } = outcome;

    const winnerMatch = (result.output || '').match(WINNER);
    if (winnerMatch) {
      const winnerId = winnerMatch[1];
      const winnerRun = results[winnerId];
      task.winner = {
        stepId: winnerId,
        runId: winnerRun?.runId || null,
        worktree: winnerRun?.worktree?.dir || null,
        branch: winnerRun?.worktree?.branch || null,
      };
    }

    /**
     * Correction loop.
     *
     * When a gate step rejects, it has already said exactly what is wrong —
     * throwing that away and reimplementing from scratch wastes the most
     * expensive diagnosis in the flow. So we send the critique back to the
     * target step, which reworks INSIDE the worktree it already produced, and
     * we revalidate.
     *
     * Bounded by retry.max because a stubborn reviewer and a stubborn
     * implementer can disagree forever, each round costing money.
     */
    if (step.retry?.of && verdict === 'REPROVADO') {
      const targetId = step.retry.of;
      const max = Number(step.retry.max || 2);
      const target = byId.get(targetId);
      const targetWorktree = results[targetId]?.worktree?.dir;

      /**
       * Everything that has to run again between the fix and this step, in order.
       *
       * For the reviewer this is empty and the loop is the original one: fix, then
       * review again. For the tester it is `['review']`, and that ordering is the
       * point — a fix written to close a QA defect is code nobody has reviewed, so
       * it goes past the reviewer before it goes back to the tester.
       */
      const chain = [...(step.retry.through || []).filter((id) => byId.has(id)), stepId];

      // whose critique the implementer is answering; it stops being the gate's
      // as soon as an intermediate step rejects in the middle of a round
      let criticId = stepId;
      let critique = result.output || '';

      for (let round = 1; round <= max && verdict === 'REPROVADO'; round++) {
        if (!target || !targetWorktree) break;

        patchStep(targetId, { status: 'running', retryRound: round });
        taskEvents(taskId, { type: 'retry', stepId: targetId, round, max, from: criticId });

        const fixPrompt = [
          `Seu trabalho anterior foi REPROVADO em "${criticId}" (rodada ${round} de ${max}).`,
          '',
          '## Tarefa original',
          await interpolate(target.prompt, { repo: task.repo, results }),
          '',
          '## Por que foi reprovado',
          critique || '(sem detalhe)',
          '',
          '## O que fazer agora',
          'Corrija os problemas apontados acima, no mesmo worktree onde voce ja',
          'trabalhou — seus arquivos continuam la. Nao recomece do zero.',
          'Onde a critica contradiz o enunciado original, a critica prevalece:',
          'ela viu o resultado real da execucao, o enunciado nao.',
          'Se discordar de algum ponto, corrija o resto e explique objetivamente',
          'por que aquele ponto especifico nao procede.',
          'Rode a verificacao novamente antes de concluir, e commite a correcao',
          'nesta branch de worktree (sem trocar de branch, sem push, e sem nenhum',
          'trailer de co-autoria na mensagem).',
        ].join('\n');

        let fixOk = false;
        try {
          const fix = await attempt(targetId, {
            promptOverride: fixPrompt,
            cwdOverride: targetWorktree,
            labelSuffix: ` (correção ${round})`,
          });
          fixOk = !!fix.result.ok;
        } catch (err) {
          patchStep(targetId, { status: 'failed', error: err.message });
          break;
        }

        /**
         * A correction that timed out or exited with an error is not a
         * correction. Marking it done — as this used to — hid the failure behind
         * whatever the next verdict happened to say.
         */
        patchStep(targetId, { status: fixOk ? 'done' : 'failed', retryRound: round });
        if (!fixOk) break;

        for (const linkId of chain) {
          const link = byId.get(linkId);
          let out;
          try {
            out = await attempt(linkId, { labelSuffix: ` (rodada ${round + 1})` });
          } catch (err) {
            patchStep(linkId, { status: 'failed', error: err.message });
            failed.add(linkId);
            if (linkId === stepId) return;
            break;
          }

          const linkRejected = out.verdict === 'REPROVADO' || (link.gate && !out.result.ok);
          patchStep(linkId, {
            rounds: round + 1,
            verdict: out.verdict,
            status: linkRejected ? 'rejected' : 'done',
            cost: out.result.cost ?? null,
          });

          if (linkId === stepId) {
            result = out.result;
            verdict = out.verdict;
          }

          if (linkRejected) {
            // the round ends here: the gate downstream does not get to run on
            // work that has already been refused upstream
            criticId = linkId;
            critique = out.result.output || '';
            if (linkId !== stepId) verdict = 'REPROVADO';
            break;
          }
        }
      }
    }

    // a "gate" step rejects the chain if it fails technically OR if it returns
    // a REPROVADO verdict
    const rejected = step.gate && (!result.ok || verdict === 'REPROVADO');

    if (!result.ok || rejected) {
      patchStep(stepId, {
        status: rejected && result.ok ? 'rejected' : 'failed',
        verdict,
        cost: result.cost ?? null,
      });
      failed.add(stepId);
    } else {
      patchStep(stepId, { status: 'done', verdict, cost: result.cost ?? null });
      finished.add(stepId);
    }
  };

  // makes the winner visible in the record as soon as the judge decides
  const persistWinner = () => tasks.put(task);

  // runs in waves: everything with resolved dependencies runs in parallel
  const pending = new Set(order);
  while (pending.size) {
    const ready = [...pending].filter((id) => {
      const step = byId.get(id);
      return (step.dependsOn || []).every((d) => finished.has(d) || failed.has(d));
    });

    if (ready.length === 0) {
      for (const id of pending) patchStep(id, { status: 'skipped', skipReason: 'deadlock' });
      break;
    }

    /**
     * The ceiling is checked BETWEEN waves, not inside them: a step's cost is
     * only known when it finishes, so this is the only point where stopping
     * avoids new spend without throwing away spend already made.
     */
    const budget = checkBudget({ taskId, override: task.budget });
    if (!budget.ok) {
      for (const id of pending) {
        patchStep(id, { status: 'skipped', skipReason: budget.reason });
      }
      task.blockedBy = budget;
      taskEvents(taskId, { type: 'budget_blocked', ...budget, title: task.title });
      break;
    }

    await Promise.all(ready.map(runStep));
    for (const id of ready) pending.delete(id);
    persistWinner();
  }

  const anyFailed = task.steps.some((s) => ['failed', 'rejected'].includes(s.status));
  task.status = task.blockedBy ? 'blocked' : anyFailed ? 'failed' : 'done';
  task.spent = Math.round(taskSpend(taskId) * 1000) / 1000;
  task.finishedAt = Date.now();
  tasks.put(task);
  taskEvents(taskId, { type: 'task_status', status: task.status, title: task.title });

  return task;
}

/**
 * Template for the driving use case: implement a feature with cross-validation
 * between tools. The implementer writes in an isolated worktree; the validator
 * enters that same worktree in read-only mode, inspects the diff and issues a
 * verdict.
 *
 * With `qa: true` a third agent is appended, and the chain becomes
 * impl → review → qa. The reviewer answers "is this code right"; the tester
 * answers "does it work when you run it" — it boots the project on reserved
 * ports, derives a test plan from what the diff actually changed, and exercises
 * it through HTTP, the broker or a browser. Its rejection re-enters the same
 * correction loop, but `through: ['review']` makes the fix pass the reviewer
 * again before it is retested: a fix is new code, and new code has not been
 * reviewed.
 */
export function crossValidationTemplate({
  title,
  repo,
  spec,
  implementer = 'kiro',
  validator = 'claude',
  verifyCommands = null,
  maxRounds = 2,
  implementerModel = null,
  validatorModel = null,
  // --- optional QA stage ---------------------------------------------------
  // Off by default: it costs a third agent and real wall-clock time booting the
  // project, and plenty of changes do not justify that. When on, it is the last
  // gate — nothing is approved that was not executed.
  qa = false,
  tester = 'claude',
  testerModel = null,
  // a resolved plan from `resolveBrowser`, not a preset name — the template must
  // configure what the tester will really find, not what was asked for
  qaBrowser = null,
  qaMaxRounds = 2,
  startCommand = null,
  baseUrl = null,
  qaNotes = null,
  autoCommit = true,
}) {
  // a preset name here would silently produce a tester with no browser, which is
  // exactly the failure the resolution step exists to prevent
  if (typeof qaBrowser === 'string') {
    throw new Error('qaBrowser deve ser o resultado de resolveBrowser(), nao o nome do preset');
  }

  const commands = verifyCommands?.length
    ? verifyCommands
    : ['npx tsc --noEmit -p tsconfig.json', 'npm run lint', 'npm test'];

  return {
    title,
    repo,
    steps: [
      {
        id: 'impl',
        tool: implementer,
        model: implementerModel,
        mode: 'full',
        isolation: 'worktree',
        autoCommit,
        prompt: [
          `Implemente a seguinte tarefa no repositorio em {{repo}}:`,
          '',
          spec,
          '',
          'Regras:',
          '- Voce esta numa branch de worktree isolada, criada so para esta tarefa.',
          '  Commite seu trabalho nela ao terminar (`git add -A && git commit -m ...`).',
          '  Nunca rode `git checkout`, `git switch`, `git push`, nem crie outra branch:',
          '  o commit tem que ficar nesta branch e em nenhuma outra.',
          '- Na mensagem de commit nao inclua trailer de co-autoria, atribuicao a IA',
          '  nem "Generated with" — so a descricao do que foi feito.',
          '- Siga os padroes ja existentes no codigo (nomes, estilo, estrutura).',
          '- As dependencias estao instaladas: rode typecheck e testes para conferir',
          '  seu proprio trabalho antes de dar a tarefa por concluida.',
          '- Se alterar config do projeto para conseguir rodar algo, restaure ao final',
          '  e confirme no diff que so sobraram as mudancas pretendidas.',
          '- Ao terminar, liste os arquivos alterados, explique as decisoes e diga o',
          '  que voce executou para verificar.',
        ].join('\n'),
        dependsOn: [],
      },
      {
        id: 'review',
        // 'verify' and not 'ro': the validator must be able to run
        // build/lint/tests to check for real, but must not alter what it reviews
        mode: 'verify',
        tool: validator,
        model: validatorModel,
        workdirFrom: 'impl',
        gate: true,
        retry: { of: 'impl', max: maxRounds },
        // the reviewer runs in `verify` and writes nothing, so there is nothing
        // of its own to commit; the implementer's fixes are committed by the
        // implementer's own step
        prompt: [
          'Voce esta revisando o trabalho de outro agente, ja aplicado no worktree atual.',
          '',
          '## Tarefa original',
          spec,
          '',
          '## Relato do implementador',
          '{{steps.impl.output}}',
          '',
          '## Arquivos alterados',
          '{{steps.impl.diff}}',
          '',
          '## Parte 1 — EXECUTE, nao apenas leia',
          '',
          'As dependencias do projeto estao instaladas neste worktree. Rode, nesta ordem:',
          '',
          ...commands.map((cmd) => `    ${cmd}`),
          '',
          'Se algum comando nao existir ou falhar por motivo pre-existente (quebrado',
          'tambem na branch base), verifique isso comparando com o repo original e',
          'diga explicitamente que e pre-existente. Se voce nao conseguir executar',
          'algum passo, diga qual e por que — nunca presuma que passou.',
          '',
          'Se o typecheck ou os testes falharem POR CAUSA desta implementacao, o',
          'veredito e REPROVADO, independente da qualidade do codigo.',
          '',
          '## Parte 2 — revise o codigo',
          '',
          '1. A implementacao cumpre a tarefa?',
          '2. Ha bug, regressao ou caso de borda nao tratado?',
          '3. Segue os padroes do projeto? (verifique o padrao dominante no repo,',
          '   nao apenas o arquivo alterado)',
          '',
          '## Formato da resposta',
          '',
          'Comece com um bloco "Verificacao executada" listando cada comando que voce',
          'rodou e o resultado real (passou / falhou / nao consegui rodar e por que).',
          'Depois a revisao de codigo. Termine com a linha exata:',
          '',
          'VEREDITO: APROVADO   (ou)   VEREDITO: REPROVADO',
        ].join('\n'),
        dependsOn: ['impl'],
      },
      ...(qa
        ? [
            {
              id: 'qa',
              tool: tester,
              model: testerModel,
              /**
               * `full`, not `verify`: the tester boots the project, writes the
               * plan, records logs and screenshots, and may add requests to a
               * Bruno collection or a regression test. The prompt is what keeps
               * it from touching production code — the mode cannot express
               * "write here but not there", and taking write access away would
               * cost the artefacts, which are the durable part of the stage.
               */
              mode: 'full',
              workdirFrom: 'impl',
              gate: true,
              retry: { of: 'impl', max: qaMaxRounds, through: ['review'] },
              mcpServers: qaBrowser?.mcpServers || null,
              reservePorts: 3,
              autoCommit,
              note: qaBrowser?.note || null,
              dependsOn: ['review'],
              prompt: qaPrompt({
                spec,
                browser: qaBrowser,
                startCommand,
                baseUrl,
                notes: qaNotes,
                regressionCommands: commands,
              }),
            },
          ]
        : []),
    ],
  };
}

/**
 * "Race" template: N agents solve the SAME spec independently, each in its own
 * worktree, and a judge compares the results and picks one.
 *
 * This exists because automatically merging the work of several agents is an
 * unsolved problem — semantic conflicts git cannot detect. Here nothing is
 * merged: the results sit side by side on separate branches and the output is a
 * choice. You commit the winning worktree and discard the others.
 *
 * The cost is obvious: you pay N times for the same task. It pays off when the
 * task is ambiguous enough that different approaches are informative.
 */
export function raceTemplate({
  title,
  repo,
  spec,
  agents = ['kiro', 'claude'],
  judge = 'claude',
  autoCommit = true,
}) {
  const implSteps = agents.map((tool, i) => ({
    id: `impl_${tool}${agents.indexOf(tool) !== i ? `_${i}` : ''}`,
    tool,
    mode: 'full',
    isolation: 'worktree',
    autoCommit,
    dependsOn: [],
    prompt: [
      `Implemente a seguinte tarefa no repositorio em {{repo}}:`,
      '',
      spec,
      '',
      'Regras:',
      '- Commite seu trabalho na branch deste worktree ao terminar. Nunca rode',
      '  `git checkout`, `git switch` ou `git push`, e nao inclua trailer de',
      '  co-autoria na mensagem de commit.',
      '- Siga os padroes ja existentes no codigo.',
      '- As dependencias estao instaladas: rode typecheck/lint/teste para conferir seu proprio trabalho.',
      '- Ao terminar, explique brevemente sua abordagem e os trade-offs que escolheu.',
    ].join('\n'),
  }));

  const judgePrompt = [
    `${implSteps.length} agentes resolveram a MESMA tarefa de forma independente.`,
    'Compare as solucoes e escolha uma.',
    '',
    '## Tarefa original',
    spec,
    '',
    ...implSteps.flatMap((s) => [
      `## Candidato "${s.id}" (${s.tool})`,
      '',
      '### Relato do agente',
      `{{steps.${s.id}.output}}`,
      '',
      '### Diff',
      `{{steps.${s.id}.patch}}`,
      '',
    ]),
    '## Sua avaliacao',
    'Compare em: corretude, cobertura de casos de borda, aderencia aos padroes do',
    'projeto, e simplicidade. Seja concreto — cite linhas e aponte defeitos reais,',
    'nao preferencias de estilo.',
    '',
    'Se todos os candidatos tiverem defeitos graves, diga isso claramente em vez de',
    'escolher o menos ruim sem ressalva.',
    '',
    'Termine com a linha exata:',
    `VENCEDOR: <id do candidato>   (um de: ${implSteps.map((s) => s.id).join(', ')})`,
  ].join('\n');

  return {
    title,
    repo,
    steps: [
      ...implSteps,
      {
        id: 'judge',
        tool: judge,
        // the judge receives the patches interpolated into its prompt, so it
        // need not sit inside any worktree — it reads the original repo only for
        // context. 'verify' and not 'ro' because really comparing candidates
        // usually requires executing something (measuring behaviour, checking a
        // pattern in the repo)
        mode: 'verify',
        isolation: 'shared',
        gate: true,
        dependsOn: implSteps.map((s) => s.id),
        prompt: judgePrompt,
      },
    ],
  };
}
