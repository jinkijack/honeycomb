import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, connect } from './api.js';
import ToolPanel from './components/ToolPanel.jsx';
import TaskPanel from './components/TaskPanel.jsx';
import RunDetail from './components/RunDetail.jsx';
import Composer from './components/Composer.jsx';
import Metrics from './components/Metrics.jsx';
import Worktrees from './components/Worktrees.jsx';
import * as notify from './notify.js';
import { Card, Badge, Button, Cell, Logo, TOOL_META, timeAgo, duration, money, tokens, Empty } from './components/ui.jsx';

// no built-in default: the repository is chosen in the Nova tab and kept in
// localStorage. To pre-fill it on your machine, set VITE_DEFAULT_REPO.
const DEFAULT_REPO = import.meta.env.VITE_DEFAULT_REPO || '';

function RunRow({ run, active, onClick }) {
  const meta = TOOL_META[run.tool] || TOOL_META.claude;
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        active ? 'border-honey/50 bg-honey/[0.06]' : 'border-comb-700 bg-comb-850/40 hover:bg-comb-800/60'
      }`}
    >
      <div className="flex items-center gap-2">
        <Cell className={`h-2.5 w-[9px] ${meta.dot}`} />
        <span className="min-w-0 flex-1 truncate text-xs text-wax-200">{run.label}</span>
        <Badge status={run.status} />
      </div>
      {/* whitespace-nowrap + truncate: a linha some antes de quebrar em duas */}
      <div className="mt-1 flex items-center gap-1.5 overflow-hidden pl-3.5 font-mono text-[10px] whitespace-nowrap text-wax-900">
        <span>{timeAgo(run.createdAt)}</span>
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
              <h2 className="mb-3 font-mono text-[10px] font-semibold tracking-wider text-wax-700 uppercase">
                Runs ({runs.length})
              </h2>
              {runs.length === 0 ? (
                <Empty icon="◇" title="Nenhum run ainda" hint="Dispare um pela aba Nova." />
              ) : (
                <div className="space-y-1.5">
                  {runs.map((r) => (
                    <RunRow key={r.id} run={r} active={r.id === selected} onClick={() => openRun(r.id)} />
                  ))}
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
