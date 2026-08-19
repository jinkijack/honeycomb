import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Transcript from './Transcript.jsx';
import DiffView from './DiffView.jsx';
import { Badge, Button, TOOL_META, timeAgo, duration, money, tokens, Empty, Textarea } from './ui.jsx';

/**
 * Continues the conversation with the run's agent.
 *
 * It resumes that agent's session in the same worktree, so it keeps the context
 * of what it already did — unlike firing a new run, which would start from zero.
 * Only shows up when the tool supports resuming and the session was recorded.
 */
function FollowUp({ run, onCreated }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { runId } = await api.followUp(run.id, text, run.mode);
      setText('');
      onCreated?.(runId);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-comb-700 p-3">
      <Textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && !busy) send();
        }}
        placeholder="Continuar com este agente… (⌘/Ctrl + Enter para enviar)"
      />
      {err && <p className="mt-1.5 font-mono text-[11px] text-ember">{err}</p>}
      <div className="mt-2 flex items-center justify-between">
        <span className="font-mono text-[10px] text-wax-900">
          retoma a sessão {run.sessionId?.slice(0, 8)} no mesmo worktree
        </span>
        <Button variant="primary" disabled={!text.trim() || busy} onClick={send}>
          {busy ? 'enviando…' : 'continuar'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Steps with 'shared' isolation (reviewer, judge) have no worktree of their own
 * — they inspect another step's work. Instead of just saying "no worktree",
 * which reads like a defect, we explain and offer the diffs that do exist in the
 * same task.
 */
function NoWorktree({ run, onOpenRun }) {
  const [siblings, setSiblings] = useState([]);

  useEffect(() => {
    if (!run.taskId) return;
    let alive = true;
    api
      .task(run.taskId)
      .then((task) => {
        if (!alive) return;
        // steps that actually wrote: neither shared, nor still running
        // dentro do worktree de outro
        setSiblings(
          task.steps.filter(
            (s) => s.runId && s.runId !== run.id && !s.workdirFrom && s.isolation !== 'shared'
          )
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [run.taskId, run.id]);

  return (
    <div className="p-4">
      <Empty
        icon="⊘"
        title="Este passo não produz diff"
        hint="Ele roda em modo compartilhado — inspeciona o trabalho de outro agente em vez de escrever o seu próprio."
      />
      {siblings.length > 0 && (
        <div className="mx-auto max-w-md">
          <p className="mb-2 text-center text-[11px] text-wax-700">Diffs disponíveis nesta task:</p>
          <div className="space-y-1.5">
            {siblings.map((s) => {
              const meta = TOOL_META[s.tool] || TOOL_META.claude;
              return (
                <button
                  key={s.id}
                  onClick={() => onOpenRun(s.runId)}
                  className="flex w-full items-center gap-2 rounded-lg border border-comb-700 bg-wax-50/[0.02] px-3 py-2 text-left hover:bg-wax-50/5"
                >
                  <span className={`cell h-2 w-[7px] shrink-0 ${meta.dot}`} />
                  <span className="font-mono text-[11px] text-wax-500">{s.id}</span>
                  <span className={`text-[11px] ${meta.color}`}>{meta.label}</span>
                  <span className="flex-1" />
                  <span className="text-[10px] text-wax-900">ver diff →</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RunDetail({ runId, events, onClose, onChanged, onOpenRun }) {
  const [run, setRun] = useState(null);
  const [tab, setTab] = useState('transcript');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    let alive = true;
    api.run(runId).then((r) => alive && setRun(r)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [runId, events.length]);

  if (!run) return <div className="p-6 text-sm text-wax-900">carregando…</div>;

  const meta = TOOL_META[run.tool] || TOOL_META.claude;
  const live = ['running', 'preparing'].includes(run.status);

  const act = async (fn, label) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fn();
      setMsg(label(res));
      onChanged?.();
    } catch (e) {
      setMsg(`erro: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-comb-700 px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`cell h-2.5 w-[9px] shrink-0 ${meta.dot}`} />
              <span className={`text-xs font-semibold ${meta.color}`}>{meta.label}</span>
              <Badge status={run.status} />
              {run.mode && (
                <span className="rounded bg-wax-50/5 px-1.5 py-0.5 font-mono text-[10px] text-wax-500">
                  {run.mode}
                </span>
              )}
            </div>
            <h2 className="mt-1.5 truncate text-sm font-medium text-wax-200">{run.label}</h2>
            <p className="mt-1 font-mono text-[11px] break-all text-wax-900">
              {timeAgo(run.createdAt)}
              {run.finishedAt && ` · ${duration(run.finishedAt - run.createdAt)}`}
              {money(run.cost) && ` · custo ${money(run.cost)}`}
              {!money(run.cost) && tokens(run.tokens) && ` · ${tokens(run.tokens)}`}
              {run.worktree && ` · ${run.worktree.branch}`}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {live && (
              <Button variant="danger" disabled={busy} onClick={() => act(() => api.cancelRun(runId), () => 'cancelado')}>
                cancelar
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>fechar</Button>
          </div>
        </div>

        {run.worktree && !live && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() => act(() => api.commitRun(runId), (r) => (r.committed ? `commit ${r.sha.slice(0, 8)}` : r.reason))}
            >
              commitar na branch
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => act(() => api.discardWorktree(runId), () => 'worktree descartado')}
            >
              descartar worktree
            </Button>
            {msg && <span className="self-center font-mono text-[11px] text-wax-500">{msg}</span>}
          </div>
        )}
      </header>

      <nav className="flex gap-1 border-b border-comb-700 px-4">
        {[
          ['transcript', 'transcrição'],
          ['diff', `diff${run.diff?.files?.length ? ` (${run.diff.files.length})` : ''}`],
          ['prompt', 'prompt'],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              tab === id
                ? 'border-azure text-wax-100'
                : 'border-transparent text-wax-700 hover:text-wax-300'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'transcript' && (
          <div className="h-full">
            {run.parentRunId && (
              <button
                onClick={() => onOpenRun?.(run.parentRunId)}
                className="mb-2 text-[11px] text-wax-700 hover:text-wax-300"
              >
                ↩ continuação — ver run anterior
              </button>
            )}
            <Transcript events={events} tool={run.tool} live={live} />
          </div>
        )}
        {tab === 'diff' &&
          (run.worktree ? <DiffView runId={runId} /> : <NoWorktree run={run} onOpenRun={onOpenRun} />)}
        {tab === 'prompt' && (
          <pre className="rounded-xl bg-comb-950/60 p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-wax-300">
            {run.prompt}
          </pre>
        )}
      </div>

      {tab === 'transcript' && !live && run.sessionId && (
        <FollowUp run={run} onCreated={(id) => onOpenRun?.(id)} />
      )}
    </div>
  );
}
