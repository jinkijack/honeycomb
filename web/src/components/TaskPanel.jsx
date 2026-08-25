import React from 'react';
import { Card, Badge, Button, TOOL_META, timeAgo, money, Empty } from './ui.jsx';

/** Renders the step graph as a vertical chain with its dependencies. */
function StepRow({ step, onOpenRun }) {
  const meta = TOOL_META[step.tool] || TOOL_META.claude;
  return (
    <li className="relative pl-6">
      {/* haloed cell: clip-path cuts `ring`, so the cut-out comes from a
          larger hexagon painted in the background colour */}
      <span className="absolute top-3 left-0 flex h-4 w-3.5 -translate-x-1/2 items-center justify-center">
        <span className="cell absolute inset-0 bg-comb-950" />
        <span className={`cell relative h-2.5 w-[9px] ${meta.dot}`} />
      </span>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
        <span className="font-mono text-[11px] text-wax-700">{step.id}</span>
        <span className={`text-[11px] font-medium whitespace-nowrap ${meta.color}`}>{meta.label}</span>
        <Badge status={step.status} />
        {step.verdict && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              step.verdict === 'APROVADO' ? 'bg-pollen/10 text-pollen' : 'bg-ember/10 text-ember'
            }`}
          >
            {step.verdict}
          </span>
        )}
        <span className="rounded bg-wax-50/5 px-1.5 py-0.5 font-mono text-[10px] text-wax-700">{step.mode}</span>
        {step.rounds > 1 && (
          <span
            className="rounded bg-honey/10 px-1.5 py-0.5 text-[10px] font-medium text-honey-soft"
            title="Foi reprovado e corrigido antes de passar"
          >
            {step.rounds} rodadas
          </span>
        )}
        {step.retryRound > 0 && step.status === 'running' && (
          <span className="rounded bg-azure/10 px-1.5 py-0.5 text-[10px] text-azure">
            corrigindo ({step.retryRound})
          </span>
        )}
        {step.dependsOn?.length > 0 && (
          <span className="font-mono text-[10px] whitespace-nowrap text-wax-900">
            ← {step.dependsOn.join(', ')}
          </span>
        )}
        <span className="hidden flex-1 sm:block" />
        {money(step.cost) && (
          <span
            className="font-mono text-[10px] tabular-nums text-honey-soft/80"
            title="Custo da última execução deste passo — o total da task está na aba Métricas"
          >
            {money(step.cost)}
          </span>
        )}
        {step.commit?.sha && (
          <span
            className="rounded bg-pollen/10 px-1.5 py-0.5 font-mono text-[10px] text-pollen"
            title="Commitado na branch do worktree do agente"
          >
            {step.commit.sha.slice(0, 7)}
          </span>
        )}
        {step.runId && (
          <Button variant="ghost" className="whitespace-nowrap" onClick={() => onOpenRun(step.runId)}>
            ver run
          </Button>
        )}
      </div>
      {step.skipReason && <p className="pb-2 text-[11px] text-wax-900">{step.skipReason}</p>}
      {step.note && <p className="pb-2 text-[11px] text-peach/90">{step.note}</p>}
    </li>
  );
}

/**
 * Whether a restart has anything to work with.
 *
 * Judged from the record alone — something finished, something did not — without
 * asking the daemon whether the worktrees survived. That check needs the disk,
 * and doing it per task on every render would be a request per card per refresh.
 * Offering a button the server may refuse is the cheaper mistake: the refusal
 * names the step and the reason, which is more than hiding the button ever says.
 */
function canRestart(task) {
  if (!['failed', 'interrupted', 'blocked'].includes(task.status)) return false;
  const kept = task.steps.filter((s) => s.status === 'done' && s.runId).length;
  return kept > 0 && kept < task.steps.length;
}

export default function TaskPanel({ tasks, onRunTask, onRestartTask, onOpenRun }) {
  if (!tasks.length) {
    return (
      <Empty
        icon="⚯"
        title="Nenhuma task de orquestração"
        hint="Crie uma no compositor: um agente implementa num worktree isolado, outro valida o diff e dá veredito."
      />
    );
  }

  return (
    <div className="space-y-3">
      {tasks.map((task) => (
        <Card key={task.id} className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-wax-100">{task.title}</h3>
                <Badge status={task.status} />
              </div>
              <p className="mt-0.5 truncate font-mono text-[11px] text-wax-900">
                {task.repo} · {timeAgo(task.createdAt)}
                {task.spent != null && ` · ${money(task.spent)}`}
                {task.budget ? ` / ${task.budget}` : ''}
              </p>
              {task.blockedBy && (
                <p className="mt-1 rounded bg-peach/10 px-2 py-1 text-[11px] text-peach">
                  {task.blockedBy.reason}
                </p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              {canRestart(task) && (
                <Button
                  variant="primary"
                  className="whitespace-nowrap"
                  title="Refaz só os passos que não concluíram, reaproveitando os worktrees já produzidos"
                  onClick={() => onRestartTask(task.id)}
                >
                  retomar
                </Button>
              )}
              {['pending', 'failed', 'done'].includes(task.status) && (
                <Button
                  variant={canRestart(task) ? 'default' : 'primary'}
                  className="whitespace-nowrap"
                  title={
                    task.status === 'pending'
                      ? 'Executa a task'
                      : 'Roda tudo de novo do zero, inclusive o que já tinha passado'
                  }
                  onClick={() => onRunTask(task.id)}
                >
                  {task.status === 'pending' ? 'executar' : 're-executar'}
                </Button>
              )}
            </div>
          </div>

          <ul className="relative mt-3 border-l border-comb-600 pl-0">
            {task.steps.map((s) => (
              <StepRow key={s.id} step={s} onOpenRun={onOpenRun} />
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
