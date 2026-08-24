import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, connect } from './api.js';
import ToolPanel from './components/ToolPanel.jsx';
import TaskPanel from './components/TaskPanel.jsx';
import RunDetail from './components/RunDetail.jsx';
import Composer from './components/Composer.jsx';
import Metrics from './components/Metrics.jsx';
import Worktrees from './components/Worktrees.jsx';
import * as notify from './notify.js';
import {
  Card, Badge, Button, Cell, Logo, TOOL_META, StepTag, stepRole,
  timeAgo, duration, money, tokens, Empty,
} from './components/ui.jsx';

// no built-in default: the repository is chosen in the Nova tab and kept in
// localStorage. To pre-fill it on your machine, set VITE_DEFAULT_REPO.
const DEFAULT_REPO = import.meta.env.VITE_DEFAULT_REPO || '';

/**
 * Groups the run list by the flow that produced it.
 *
 * A `cross --qa` lands as three or more runs that only a suffix in the label
 * told apart, interleaved with everyone else's by creation time — the chain that
 * makes the product what it is was the one thing the list did not show. Runs
 * carrying a `taskId` collapse into their flow; a standalone `run` stays a row
 * of its own rather than becoming a group of one.
 *
 * Inside a group the order is chronological ASCENDING, against the newest-first
 * of the list itself: a flow is read impl → validação → teste, and a correction
 * round belongs after the critique that caused it, not before.
 */
function groupRuns(runs, tasks) {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const groups = [];
  const byTask = new Map();

  // `runs` arrives newest-first, so the first sighting of a task is its latest
  // run — which is the order the flows should appear in
  for (const run of runs) {
    if (!run.taskId) {
      groups.push({ key: run.id, single: run, runs: [run], latest: run.createdAt });
      continue;
    }
    let g = byTask.get(run.taskId);
    if (!g) {
      g = {
        key: run.taskId,
        taskId: run.taskId,
        task: taskById.get(run.taskId) || null,
        runs: [],
        latest: run.createdAt,
      };
      byTask.set(run.taskId, g);
      groups.push(g);
    }
    g.runs.push(run);
  }

  for (const g of byTask.values()) {
    g.runs.sort((a, b) => a.createdAt - b.createdAt);
  }
  return groups;
}

/** What the collapsed header has to say without being opened. */
function summarise(group) {
  let cost = 0;
  let tok = 0;
  let files = 0;
  let firstAt = Infinity;
  let lastAt = 0;
  let live = false;

  for (const r of group.runs) {
    if (r.cost) cost += r.cost;
    if (r.tokens) tok += r.tokens;
    files += r.diff?.files?.length || 0;
    firstAt = Math.min(firstAt, r.createdAt);
    if (r.finishedAt) lastAt = Math.max(lastAt, r.finishedAt);
    if (['running', 'preparing', 'queued', 'retrying'].includes(r.status)) live = true;
  }

  /**
   * The roles in the order the flow ran them, each collapsed to one chip.
   *
   * A role can repeat for two unrelated reasons, and the chip must not say the
   * same thing about both. `cross` re-runs the SAME step id when the reviewer
   * rejects — those are correction rounds, and the last one is the outcome that
   * counts, because a flow that was rejected once and approved after is an
   * approved flow. `race` runs DIFFERENT step ids of the same role in parallel
   * (`impl_kiro`, `impl_claude`) — those are competitors, none supersedes
   * another, and one of them failing is a fact the header has to keep.
   */
  const roles = [];
  for (const r of group.runs) {
    const role = stepRole(r.stepId) || r.stepId;
    if (!role) continue;
    let entry = roles.find((x) => x.role === role);
    if (!entry) {
      entry = { role, stepId: r.stepId, steps: new Map(), runs: 0 };
      roles.push(entry);
    }
    entry.runs += 1;
    entry.steps.set(r.stepId, r.status); // last run of that step id wins
  }

  /**
   * The task's own step record outranks the run's status, and the difference is
   * the whole point of the gate: a reviewer that refuses the work still exits 0,
   * so every run reads `done` while the flow reads `failed`. Only the step knows
   * it was `rejected`, and carries the `VEREDITO` that made it so.
   */
  const taskStep = new Map((group.task?.steps || []).map((st) => [st.id, st]));

  for (const entry of roles) {
    const statuses = [...entry.steps.keys()].map(
      (id) => taskStep.get(id)?.status || entry.steps.get(id)
    );
    entry.parallel = entry.steps.size > 1;
    entry.repeats = entry.parallel
      ? entry.steps.size
      : taskStep.get(entry.stepId)?.rounds || entry.runs;
    entry.status = entry.parallel
      ? statuses.find((st) => ['failed', 'rejected', 'cancelled'].includes(st)) || statuses.at(-1)
      : statuses.at(-1);
    entry.verdict = entry.parallel ? null : taskStep.get(entry.stepId)?.verdict || null;
  }

  return {
    cost: cost || null,
    tokens: tok || null,
    files,
    live,
    roles,
    elapsed: lastAt && firstAt !== Infinity ? lastAt - firstAt : null,
    status:
      group.task?.status ||
      (live ? 'running' : group.runs.some((r) => r.status === 'failed') ? 'failed' : 'done'),
  };
}

function FlowGroup({ group, selected, open, onToggle, onOpenRun }) {
  const s = summarise(group);
  const title = group.task?.title || group.runs[0]?.label || group.taskId;
  const hasSelected = group.runs.some((r) => r.id === selected);

  return (
    <div
      className={`overflow-hidden rounded-lg border transition-colors ${
        hasSelected ? 'border-honey/40 bg-honey/[0.03]' : 'border-comb-700 bg-comb-850/40'
      }`}
    >
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-2.5 py-2.5 text-left hover:bg-comb-800/60"
      >
        <span
          className={`mt-[3px] shrink-0 font-mono text-[10px] text-wax-700 transition-transform ${
            open ? 'rotate-90' : ''
          }`}
          aria-hidden="true"
        >
          ▶
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-wax-200">{title}</span>
            <Badge status={s.status} />
          </span>

          {/* the chain, in the order it ran — the point of the whole grouping */}
          <span className="mt-1.5 flex flex-wrap items-center gap-1">
            {s.roles.map((r, i) => (
              <React.Fragment key={r.role}>
                {i > 0 && <span className="font-mono text-[9px] text-wax-900">→</span>}
                <StepTag
                  stepId={r.stepId}
                  title={`${r.stepId}${r.verdict ? ` — VEREDITO: ${r.verdict}` : ''}`}
                  className={
                    ['failed', 'rejected', 'cancelled'].includes(r.status) ? 'line-through opacity-60' : ''
                  }
                />
                {r.repeats > 1 && (
                  <span
                    title={
                      r.parallel
                        ? `${r.repeats} agentes em paralelo, disputando a mesma spec`
                        : `${r.repeats} execuções — houve rodada de correção`
                    }
                    className="rounded bg-wax-50/5 px-1 font-mono text-[9px] text-wax-700"
                  >
                    {r.parallel ? '∥' : '×'}{r.repeats}
                  </span>
                )}
              </React.Fragment>
            ))}
          </span>

          <span className="mt-1 flex items-center gap-1.5 overflow-hidden font-mono text-[10px] whitespace-nowrap text-wax-900">
            <span>{group.runs.length} runs</span>
            <span>· {timeAgo(group.latest)}</span>
            {s.elapsed != null && !s.live && <span>· {duration(s.elapsed)}</span>}
            {money(s.cost) && <span>· {money(s.cost)}</span>}
            {/* cost and tokens never add up: two tools, two units, side by side */}
            {tokens(s.tokens) && <span>· {tokens(s.tokens)}</span>}
            {s.files > 0 && <span className="text-pollen/70">· {s.files} arq.</span>}
          </span>
        </span>
      </button>

      {open && (
        <div className="space-y-1 border-t border-comb-700/70 bg-comb-950/30 p-1.5">
          {group.runs.map((r) => (
            <RunRow key={r.id} run={r} active={r.id === selected} nested onClick={() => onOpenRun(r.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function nestedLabel(run) {
  if (!run.stepId) return run.label;
  const marker = `/ ${run.stepId}`;
  const at = (run.label || '').lastIndexOf(marker);
  if (at < 0) return run.label;
  // empty on the first attempt, and that is the honest answer: the chip beside
  // it already says everything this run is
  return run.label.slice(at + marker.length).trim();
}

function RunRow({ run, active, onClick, nested = false }) {
  const meta = TOOL_META[run.tool] || TOOL_META.claude;

  /**
   * Inside a group the label is nearly all redundant: the orchestrator writes it
   * `<task title> / <stepId><suffix>`, and by then the header carries the title
   * and the chip carries the step. What is left is the suffix — `(correção 2)` —
   * which is the only thing telling two rows of the same role apart, and the
   * only reason the row is there twice.
   */
  const label = nested ? nestedLabel(run) : run.label;

  return (
    <button
      onClick={onClick}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        active ? 'border-honey/50 bg-honey/[0.06]' : 'border-comb-700 bg-comb-850/40 hover:bg-comb-800/60'
      }`}
    >
      <div className="flex items-center gap-2">
        <Cell className={`h-2.5 w-[9px] ${meta.dot}`} />
        {run.stepId && <StepTag stepId={run.stepId} />}
        <span className={`min-w-0 flex-1 truncate text-xs ${nested ? 'text-wax-700' : 'text-wax-200'}`}>
          {label}
        </span>
        <Badge status={run.status} />
      </div>
      {/* whitespace-nowrap + truncate: a linha some antes de quebrar em duas */}
      <div className="mt-1 flex items-center gap-1.5 overflow-hidden pl-3.5 font-mono text-[10px] whitespace-nowrap text-wax-900">
        <span className={meta.color}>{meta.label}</span>
        <span>· {timeAgo(run.createdAt)}</span>
        {run.finishedAt && <span>· {duration(run.finishedAt - run.createdAt)}</span>}
        {money(run.cost) && <span>· {money(run.cost)}</span>}
        {!money(run.cost) && tokens(run.tokens) && <span>· {tokens(run.tokens)}</span>}
        {run.diff?.files?.length > 0 && (
          <span className="text-pollen/70">· {run.diff.files.length} arq.</span>
        )}
      </div>
    </button>
  );
}

export default function App() {
  const [conn, setConn] = useState('offline');
  const [tools, setTools] = useState([]);
  const [runs, setRuns] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [selected, setSelected] = useState(null);
  const [view, setView] = useState('runs');
  const [repo, setRepo] = useState(() => localStorage.getItem('honeycomb.repo') || DEFAULT_REPO);
  const [notifOn, setNotifOn] = useState(() => notify.isEnabled());
  const [health, setHealth] = useState(null);
  // only explicit user toggles; everything else is derived (see `isOpen`)
  const [openGroups, setOpenGroups] = useState({});

  const eventsRef = useRef(new Map());
  const [, forceRender] = useState(0);
  const bump = useCallback(() => forceRender((n) => n + 1), []);

  useEffect(() => localStorage.setItem('honeycomb.repo', repo), [repo]);

  const refresh = useCallback(async () => {
    const [t, r, k, h] = await Promise.allSettled([
      api.tools(repo), api.runs(), api.tasks(), api.health(),
    ]);
    if (t.status === 'fulfilled') setTools(t.value);
    if (r.status === 'fulfilled') setRuns(r.value);
    if (k.status === 'fulfilled') setTasks(k.value);
    if (h.status === 'fulfilled') setHealth(h.value);
  }, [repo]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [refresh]);

  // live events: accumulated per runId so the transcript renders in real time
  useEffect(() => {
    return connect({
      onStatus: setConn,
      onRun: (ev) => {
        const list = eventsRef.current.get(ev.runId) || [];
        list.push(ev);
        eventsRef.current.set(ev.runId, list);
        if (ev.type === 'status') refresh();
        bump();
      },
      onTask: (ev) => {
        refresh();
        if (ev.type === 'task_status' && ['done', 'failed'].includes(ev.status)) {
          notify.notify(
            ev.status === 'done' ? 'Task concluída' : 'Task falhou',
            { body: ev.title || 'Orquestração terminou', tag: ev.taskId, onClick: () => setView('tasks') }
          );
        }
        if (ev.type === 'retry') {
          notify.notify('Correção em andamento', {
            body: `${ev.stepId} — rodada ${ev.round} de ${ev.max}`,
            tag: `${ev.taskId}-retry`,
          });
        }
      },
    });
  }, [refresh, bump]);

  const toggleNotif = async () => {
    if (notifOn) {
      notify.disable();
      setNotifOn(false);
    } else {
      setNotifOn(await notify.enable());
    }
  };

  // when opening an old run, fetch the event history the socket never carried
  const openRun = useCallback(async (runId) => {
    setSelected(runId);
    setView('runs');
    if (!eventsRef.current.has(runId)) {
      try {
        eventsRef.current.set(runId, await api.runEvents(runId));
        bump();
      } catch {
        eventsRef.current.set(runId, []);
      }
    }
  }, [bump]);

  const events = selected ? eventsRef.current.get(selected) || [] : [];
  const activeCount = runs.filter((r) => ['running', 'preparing'].includes(r.status)).length;

  const groups = React.useMemo(() => groupRuns(runs, tasks), [runs, tasks]);
  const flowCount = groups.filter((g) => !g.single).length;

  /**
   * A group opens by itself while something is happening in it, or when the run
   * being read lives inside it — collapsing a flow you are watching would be the
   * grouping getting in the way of the thing it exists to show.
   *
   * `openGroups` only records what YOU decided, so an explicit close survives
   * the next event and is forgotten once the flow goes quiet.
   */
  const isOpen = useCallback(
    (g) => {
      if (openGroups[g.key] !== undefined) return openGroups[g.key];
      if (g.runs.some((r) => r.id === selected)) return true;
      return g.runs.some((r) => ['running', 'preparing', 'queued', 'retrying'].includes(r.status));
    },
    [openGroups, selected]
  );

  const toggleGroup = useCallback(
    (g) => setOpenGroups((prev) => ({ ...prev, [g.key]: !isOpen(g) })),
    [isOpen]
  );

  /**
   * A flow you watched run stays open after it ends.
   *
   * Without this the openness is purely derived, so the group snaps shut on the
   * last status event — exactly when there is finally something to read. Writing
   * the auto-open down as an explicit `true` the first time a group goes live
   * converts it into a decision that outlives the activity, and leaves your own
   * close (an explicit `false`) still winning over it.
   */
  useEffect(() => {
    const live = groups.filter(
      (g) =>
        !g.single &&
        openGroups[g.key] === undefined &&
        g.runs.some((r) => ['running', 'preparing', 'queued', 'retrying'].includes(r.status))
    );
    if (!live.length) return;
    setOpenGroups((prev) => {
      const next = { ...prev };
      for (const g of live) next[g.key] = true;
      return next;
    });
  }, [groups, openGroups]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-comb-700 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <Logo className="h-7 w-7" />
          <h1 className="font-mono text-sm font-semibold tracking-tight text-wax-100">honeycomb</h1>
        </div>

        <span
          className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
            conn === 'online'
              ? 'bg-pollen/10 text-pollen ring-pollen/30'
              : 'bg-ember/10 text-ember ring-ember/30'
          }`}
        >
          <Cell pulse={conn === 'online'} className="h-2 w-[7px] bg-current" />
          {conn === 'online' ? 'daemon conectado' : 'daemon offline'}
        </span>

        {activeCount > 0 && (
          <span className="hidden rounded-full bg-azure/10 px-2 py-0.5 text-[10px] text-azure ring-1 ring-azure/30 ring-inset sm:inline">
            {activeCount} {activeCount === 1 ? 'agente rodando' : 'agentes rodando'}
            {health?.queue?.max ? ` / ${health.queue.max}` : ''}
          </span>
        )}

        {health?.queue?.waiting > 0 && (
          <span className="hidden rounded-full bg-wax-500/10 px-2 py-0.5 text-[10px] text-wax-300 ring-1 ring-wax-500/30 ring-inset sm:inline">
            {health.queue.waiting} na fila
          </span>
        )}

        {health?.budget?.daily?.limit > 0 && (
          <span
            title="Gasto nas últimas 24h"
            className={`hidden rounded-full px-2 py-0.5 text-[10px] ring-1 ring-inset sm:inline ${
              health.budget.daily.spent >= health.budget.daily.limit
                ? 'bg-ember/10 text-ember ring-ember/30'
                : 'bg-honey/10 text-honey-soft ring-honey/30'
            }`}
          >
            {health.budget.daily.spent} / {health.budget.daily.limit}
          </span>
        )}

        <span className="flex-1" />

        {notify.isSupported() && (
          <button
            onClick={toggleNotif}
            title={notifOn ? 'Notificações ligadas' : 'Notificar quando uma task terminar'}
            className={`rounded-lg px-2 py-1 text-[13px] transition-colors ${
              notifOn ? 'text-honey hover:bg-wax-50/5' : 'text-wax-900 hover:text-wax-500'
            }`}
          >
            {notifOn ? '🔔' : '🔕'}
          </button>
        )}

        <nav className="flex gap-1 rounded-lg bg-comb-900 p-1 ring-1 ring-comb-700 ring-inset">
          {[
            ['runs', 'Runs'],
            ['tasks', 'Tasks'],
            ['worktrees', 'Worktrees'],
            ['metrics', 'Métricas'],
            ['new', 'Nova'],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => {
                setView(id);
                if (id !== 'runs') setSelected(null);
              }}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                view === id ? 'bg-comb-700 text-honey' : 'text-wax-700 hover:text-wax-300'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_1fr] xl:grid-cols-[280px_360px_1fr]">
        {/* ferramentas */}
        <aside className="hidden min-h-0 overflow-y-auto border-r border-comb-700 p-4 lg:block">
          <h2 className="mb-3 font-mono text-[10px] font-semibold tracking-wider text-wax-700 uppercase">
            Ferramentas
          </h2>
          <ToolPanel tools={tools} />
        </aside>

        {/* list — in Tasks and Nova it also takes the detail column, since the
            graph cards and the form need width to breathe */}
        <section
          className={`min-h-0 overflow-y-auto border-r border-comb-700 p-4 ${
            selected && view === 'runs' ? 'hidden xl:block' : 'block'
          } ${view === 'runs' ? '' : 'xl:col-span-2'}`}
        >
          {view === 'runs' && (
            <>
              <h2 className="mb-3 flex items-baseline gap-2 font-mono text-[10px] font-semibold tracking-wider text-wax-700 uppercase">
                <span>Runs ({runs.length})</span>
                {flowCount > 0 && (
                  <span className="font-normal normal-case tracking-normal text-wax-900">
                    em {flowCount} {flowCount === 1 ? 'fluxo' : 'fluxos'}
                  </span>
                )}
              </h2>
              {runs.length === 0 ? (
                <Empty icon="◇" title="Nenhum run ainda" hint="Dispare um pela aba Nova." />
              ) : (
                <div className="space-y-1.5">
                  {groups.map((g) =>
                    g.single ? (
                      <RunRow
                        key={g.key}
                        run={g.single}
                        active={g.single.id === selected}
                        onClick={() => openRun(g.single.id)}
                      />
                    ) : (
                      <FlowGroup
                        key={g.key}
                        group={g}
                        selected={selected}
                        open={isOpen(g)}
                        onToggle={() => toggleGroup(g)}
                        onOpenRun={openRun}
                      />
                    )
                  )}
                </div>
              )}
            </>
          )}

          {view === 'tasks' && (
            <TaskPanel
              tasks={tasks}
              onRunTask={async (id) => {
                await api.runTask(id);
                refresh();
              }}
              onOpenRun={openRun}
            />
          )}

          {view === 'worktrees' && (
            <div className="mx-auto max-w-4xl">
              <Worktrees onOpenRun={openRun} />
            </div>
          )}

          {view === 'metrics' && (
            <div className="mx-auto max-w-4xl">
              <Metrics
                onOpenTask={() => setView('tasks')}
                onOpenWorktrees={() => setView('worktrees')}
              />
            </div>
          )}

          {view === 'new' && (
            <div className="mx-auto max-w-2xl">
              <Composer
                repo={repo}
                setRepo={setRepo}
                tools={tools}
                onCreated={(kind, obj) => {
                  refresh();
                  if (kind === 'run') openRun(obj.id);
                  else setView('tasks');
                }}
              />
            </div>
          )}
        </section>

        {/* detail — only in the Runs view */}
        {view === 'runs' && (
          <section className="min-h-0 overflow-hidden">
            {selected ? (
              <RunDetail
                runId={selected}
                events={events}
                onClose={() => setSelected(null)}
                onChanged={refresh}
                onOpenRun={openRun}
              />
            ) : (
              <div className="hidden h-full items-center justify-center xl:flex">
                <Empty
                  icon="◈"
                  title="Selecione um run"
                  hint="A transcrição ao vivo, o diff do worktree e as ações de commit aparecem aqui."
                />
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
