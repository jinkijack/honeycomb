import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Empty } from './ui.jsx';

/**
 * A worktree's possible states, ordered by how much they matter to the decision
 * to delete. The distinction that carries the weight is 'committed' versus
 * 'dirty': the first means "the content exists elsewhere, it can go"; the
 * second, "this may be the only copy".
 */
const STATE = {
  dirty: {
    label: 'pendente',
    cls: 'bg-honey/10 text-honey-soft ring-honey/30',
    hint: 'Alterações que não encontrei em nenhuma branch — pode ser a única cópia.',
  },
  committed: {
    label: 'já na branch',
    cls: 'bg-pollen/10 text-pollen ring-pollen/30',
    hint: 'O conteúdo já existe commitado, o diretório é redundante.',
  },
  empty: {
    label: 'vazio',
    cls: 'bg-wax-500/10 text-wax-500 ring-wax-500/20',
    hint: 'O agente não alterou nada.',
  },
};

function Row({ wt, onDiscard, onOpenRun, busy }) {
  const [open, setOpen] = useState(false);
  const meta = STATE[wt.state] || STATE.dirty;

  return (
    <li className="rounded-lg border border-comb-700 bg-wax-50/[0.02]">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="text-[10px] text-wax-900">{open ? '▾' : '▸'}</span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${meta.cls}`}
          >
            {meta.label}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-wax-300">
            {wt.branch || wt.name}
          </span>
        </button>

        <span className="font-mono text-[10px] text-wax-900">
          {wt.fileCount > 0 && `${wt.fileCount} arq. · `}
          {wt.ageHours}h
        </span>

        <Button
          variant={wt.state === 'dirty' ? 'danger' : 'default'}
          disabled={busy}
          onClick={() => onDiscard(wt)}
        >
          descartar
        </Button>
      </div>

      {open && (
        <div className="space-y-2 border-t border-comb-700 px-3 py-2.5">
          <p className="text-[11px] text-wax-700">{meta.hint}</p>

          {wt.landed && (
            <p className="rounded-md bg-pollen/5 px-2.5 py-1.5 font-mono text-[11px] text-pollen/80 ring-1 ring-pollen/20 ring-inset">
              conteúdo idêntico em {wt.landed.ref} ({wt.landed.sha})
            </p>
          )}

          {wt.orphan && (
            <p className="text-[11px] text-wax-900">
              órfão — nenhum run registrado aponta para este diretório
            </p>
          )}

          {wt.files?.length > 0 && (
            <ul className="space-y-0.5">
              {wt.files.map((f) => (
                <li key={f} className="truncate font-mono text-[11px] text-wax-500">
                  {f}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <span className="truncate font-mono text-[10px] text-wax-900">{wt.dir}</span>
            <span className="flex-1" />
            {wt.runId && (
              <button
                onClick={() => onOpenRun(wt.runId)}
                className="text-[10px] text-wax-700 hover:text-wax-300"
              >
                ver run →
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export default function Worktrees({ onOpenRun }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = async () => {
    try {
      setList(await api.worktrees());
      setErr(null);
    } catch (e) {
      setErr(e.message);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  const discard = async (wt, force = false) => {
    // work found on no branch never goes without confirmation
    if (wt.state === 'dirty' && !force) return setConfirm(wt);
    setBusy(true);
    setConfirm(null);
    try {
      await api.discardWorktreeDir(wt.dir, force);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const gc = async () => {
    setBusy(true);
    try {
      await api.gc({ minAgeHours: 0, includeDirty: false, dryRun: false });
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (err && !list) return <Empty icon="⚠" title="Falha ao listar worktrees" hint={err} />;
  if (!list) return <Empty icon="◌" title="Consultando worktrees…" />;

  const dirty = list.filter((w) => w.state === 'dirty');
  const reclaimable = list.filter((w) => w.state !== 'dirty');
  const totalFiles = list.reduce((a, w) => a + w.fileCount, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[10px] font-semibold tracking-wider text-wax-700 uppercase">
            Worktrees
          </h2>
          <p className="mt-0.5 text-xs text-wax-500">
            {list.length} no disco · {totalFiles} arquivo(s) · {dirty.length} sem cópia conhecida
          </p>
        </div>
        <Button disabled={busy || reclaimable.length === 0} onClick={gc}>
          {busy ? 'recolhendo…' : `recolher ${reclaimable.length} seguro(s)`}
        </Button>
      </div>

      {err && (
        <p className="rounded-lg bg-ember/10 px-3 py-2 font-mono text-[11px] text-ember">{err}</p>
      )}

      {list.length === 0 ? (
        <Empty
          icon="≡"
          title="Nenhum worktree no disco"
          hint="Cada agente que escreve código ganha um aqui, e eles aparecem nesta lista até serem descartados."
        />
      ) : (
        <Card className="p-3">
          <ul className="space-y-1.5">
            {list.map((wt) => (
              <Row key={wt.dir} wt={wt} onDiscard={discard} onOpenRun={onOpenRun} busy={busy} />
            ))}
          </ul>
        </Card>
      )}

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <Card className="max-w-md p-5">
            <h3 className="text-sm font-semibold text-wax-100">Descartar trabalho não encontrado?</h3>
            <p className="mt-2 text-xs leading-relaxed text-wax-500">
              Não localizei o conteúdo de{' '}
              <span className="font-mono text-wax-300">{confirm.branch || confirm.name}</span> em
              nenhuma branch do repositório. Se ele não foi levado para outro lugar por fora, esta é
              a única cópia e a remoção é definitiva.
            </p>
            {confirm.files?.length > 0 && (
              <ul className="mt-3 max-h-40 space-y-0.5 overflow-y-auto rounded-md bg-comb-950/60 p-2">
                {confirm.files.map((f) => (
                  <li key={f} className="truncate font-mono text-[11px] text-wax-500">
                    {f}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                cancelar
              </Button>
              <Button variant="danger" onClick={() => discard(confirm, true)}>
                descartar mesmo assim
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
