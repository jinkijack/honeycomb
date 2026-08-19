import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, TOOL_META, Empty, duration, money, tokens as fmtTokens } from './ui.jsx';

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

function Stat({ label, value, hint, tone = 'default' }) {
  const tones = {
    default: 'text-wax-100',
    good: 'text-pollen',
    bad: 'text-ember',
    warn: 'text-honey-soft',
  };
  return (
    <div className="rounded-lg border border-comb-700 bg-wax-50/[0.02] px-3 py-2.5">
      <div className="text-[10px] tracking-wider text-wax-700 uppercase">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tones[tone]}`}>{value}</div>
      {hint && <div className="text-[10px] text-wax-900">{hint}</div>}
    </div>
  );
}

/** Barra comparativa simples — evita dependência de lib de gráfico. */
function Bar({ value, max, className = 'bg-azure/60' }) {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-wax-50/5">
      <div className={`h-full rounded-full ${className}`} style={{ width: `${w}%` }} />
    </div>
  );
}

/**
 * Spend per task, most expensive first.
 *
 * The per-tool view says which agent is expensive; this one says which *work*
 * was expensive — the question that shows up after a big bill. Each row expands
 * into a per-step breakdown, because an expensive task usually has a single step
 * accounting for nearly all of it.
 */
function CostByTask({ tasks, loose, onOpenTask }) {
  const [open, setOpen] = useState(null);
  if (!tasks.length && !loose.runs) return null;

  const max = Math.max(...tasks.map((t) => t.cost), 0.001);

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-wax-100">Gasto por task</h3>

      <ul className="space-y-2">
        {tasks.map((t) => {
          const isOpen = open === t.id;
          return (
            <li key={t.id}>
              <button
                onClick={() => setOpen(isOpen ? null : t.id)}
                className="w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-wax-50/5"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-[10px] text-wax-900">{isOpen ? '▾' : '▸'}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-wax-200">{t.title}</span>
                  {t.extraRounds > 0 && (
                    <span
                      className="rounded bg-honey/10 px-1.5 py-0.5 text-[10px] text-honey-soft"
                      title="Rodadas de correção — retrabalho que entrou na conta"
                    >
                      +{t.extraRounds} rodada{t.extraRounds > 1 ? 's' : ''}
                    </span>
                  )}
                  <span className="font-mono text-xs font-semibold tabular-nums text-honey-soft">
                    {t.cost > 0 ? money(t.cost) : fmtTokens(t.tokens) || '—'}
                  </span>
                </div>
                <div className="mt-1 pl-4">
                  <Bar value={t.cost} max={max} className="bg-honey/50" />
                </div>
                <div className="mt-1 flex gap-2 pl-4 font-mono text-[10px] text-wax-900">
                  <span>{t.runCount} runs</span>
                  {t.wallMs && <span>· {duration(t.wallMs)}</span>}
                  <span
                    className={
                      t.status === 'done'
                        ? 'text-pollen/70'
                        : t.status === 'failed'
                          ? 'text-ember/70'
                          : ''
                    }
                  >
                    · {t.status}
                  </span>
                </div>
              </button>

              {isOpen && (
                <ul className="mt-1 ml-6 space-y-1 border-l border-comb-700 pl-3">
                  {t.steps.map((s) => {
                    const meta = TOOL_META[s.tool] || TOOL_META.claude;
                    return (
                      <li key={s.stepId} className="flex items-center gap-2 py-0.5">
                        <span className={`cell h-2 w-[7px] shrink-0 ${meta.dot}`} />
                        <span className="font-mono text-[11px] text-wax-500">{s.stepId}</span>
                        <span className={`text-[10px] ${meta.color}`}>{s.tool}</span>
                        {s.runs > 1 && (
                          <span className="text-[10px] text-wax-900">{s.runs} execuções</span>
                        )}
                        <span className="flex-1" />
                        <span className="font-mono text-[11px] tabular-nums text-wax-300">
                          {s.cost > 0 ? money(s.cost) : fmtTokens(s.tokens) || '—'}
                        </span>
                        <span className="w-10 text-right text-[10px] text-wax-900">
                          {t.cost > 0 && s.cost > 0 ? `${Math.round((s.cost / t.cost) * 100)}%` : ''}
                        </span>
                      </li>
                    );
                  })}
                  {onOpenTask && (
                    <li className="pt-1">
                      <button
                        onClick={() => onOpenTask(t.id)}
                        className="text-[10px] text-wax-700 hover:text-wax-300"
                      >
                        ver task →
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {loose.runs > 0 && (
        <p className="mt-3 border-t border-comb-700 pt-2 font-mono text-[11px] text-wax-700">
          + {loose.runs} run(s) avulso(s) fora de task · {money(loose.cost)}
          {loose.tokens ? ` · ${fmtTokens(loose.tokens)}` : ''}
        </p>
      )}
    </Card>
  );
}

/** Resumo — a gestão de verdade mora na aba Worktrees. */
function WorktreeSummary({ list, onOpen }) {
  const dirty = list.filter((w) => w.state === 'dirty').length;
  const reclaimable = list.length - dirty;

  return (
    <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-wax-100">Worktrees</h3>
        <p className="mt-0.5 text-[11px] text-wax-700">
          {list.length} no disco · {reclaimable} recolhível(is) · {dirty} sem cópia conhecida
        </p>
      </div>
      <span className="flex-1" />
      <Button onClick={onOpen}>gerenciar →</Button>
    </Card>
  );
}

export default function Metrics({ onOpenTask, onOpenWorktrees }) {
  const [m, setM] = useState(null);
  const [wt, setWt] = useState([]);
  const [days, setDays] = useState(30);
  const [err, setErr] = useState(null);

  const load = async (d = days) => {
    try {
      const [metrics, worktrees] = await Promise.all([api.metrics(d), api.worktrees()]);
      setM(metrics);
      setWt(worktrees);
    } catch (e) {
      setErr(e.message);
    }
  };

  useEffect(() => {
    load(days);
  }, [days]);

  if (err) return <Empty icon="⚠" title="Falha ao carregar métricas" hint={err} />;
  if (!m) return <Empty icon="◌" title="Calculando…" />;

  const maxCost = Math.max(...m.tools.map((t) => t.totalCost), 0.001);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[10px] font-semibold tracking-wider text-wax-700 uppercase">
          Métricas
        </h2>
        <div className="flex gap-1 rounded-lg bg-comb-950/60 p-1">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                days === d ? 'bg-wax-50/10 text-wax-100' : 'text-wax-700 hover:text-wax-300'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Runs" value={m.runs.total} />
        <Stat
          label="Custo total"
          value={money(m.runs.totalCost) ?? '0'}
          hint={m.runs.totalTokens ? `+ ${fmtTokens(m.runs.totalTokens)} (não somam)` : null}
          tone="warn"
        />
        <Stat
          label="Aprovação"
          value={pct(m.verdicts.approvalRate)}
          hint={`${m.verdicts.approved} aprovados · ${m.verdicts.rejected} reprovados`}
          tone={m.verdicts.approvalRate >= 0.7 ? 'good' : m.verdicts.approvalRate == null ? 'default' : 'bad'}
        />
        <Stat
          label="Rodadas extras"
          value={m.tasks.extraRounds}
          hint={`${m.tasks.withRetry} task(s) precisaram corrigir`}
          tone={m.tasks.extraRounds > 0 ? 'warn' : 'default'}
        />
      </div>

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-wax-100">Por ferramenta</h3>
        {m.tools.length === 0 ? (
          <p className="py-4 text-center text-xs text-wax-900">sem runs no período</p>
        ) : (
          <div className="space-y-3">
            {m.tools.map((t) => {
              const meta = TOOL_META[t.tool] || TOOL_META.claude;
              return (
                <div key={t.tool}>
                  <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className={`text-xs font-medium ${meta.color}`}>{meta.label}</span>
                    <span className="text-[11px] text-wax-700">{t.total} runs</span>
                    <span className="text-[11px] text-wax-700">
                      sucesso {pct(t.successRate)}
                    </span>
                    <span className="flex-1" />
                    <span className="font-mono text-[11px] text-wax-500">
                      {t.unit === 'tokens'
                        ? `${fmtTokens(t.totalTokens)} total · ${fmtTokens(t.avgTokens)} avg`
                        : `${money(t.totalCost)} total · ${money(t.avgCost)} avg`}
                    </span>
                  </div>
                  {/* the bar compares cost; token reporters are not on the same
                      scale, so they get a neutral band */}
                  {t.unit === 'tokens' ? (
                    <div className="h-1.5 w-full rounded-full bg-wax-50/5" />
                  ) : (
                    <Bar value={t.totalCost} max={maxCost} className={meta.dot} />
                  )}
                  <div className="mt-1 flex gap-3 font-mono text-[10px] text-wax-900">
                    <span>médio {duration(t.avgDurationMs) || '—'}</span>
                    <span>p90 {duration(t.p90DurationMs) || '—'}</span>
                    {t.filesTouched > 0 && <span>{t.filesTouched} arq. tocados</span>}
                    {t.failed > 0 && <span className="text-ember/70">{t.failed} falhas</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {Object.keys(m.verdicts.byValidator).length > 0 && (
          <div className="mt-4 border-t border-comb-700 pt-3">
            <p className="mb-2 text-[10px] tracking-wider text-wax-700 uppercase">
              Rigor por validador
            </p>
            {Object.entries(m.verdicts.byValidator).map(([tool, v]) => {
              const total = v.APROVADO + v.REPROVADO;
              return (
                <div key={tool} className="flex items-center gap-2 py-0.5 text-[11px]">
                  <span className={TOOL_META[tool]?.color || 'text-wax-300'}>{tool}</span>
                  <span className="text-wax-700">
                    reprova {pct(total ? v.REPROVADO / total : null)} ({v.REPROVADO}/{total})
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <CostByTask tasks={m.byTask || []} loose={m.loose || { runs: 0, cost: 0 }} onOpenTask={onOpenTask} />

      <WorktreeSummary list={wt} onOpen={onOpenWorktrees} />
    </div>
  );
}
