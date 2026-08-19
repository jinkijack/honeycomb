import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Button, Empty } from './ui.jsx';
import { parsePatch } from './parse-patch.js';

/**
 * Revisão do trabalho de um agente.
 *
 * The whole patch is fetched at once because it *is* the screen — asking for a
 * click to see what changed inverted the tab's priority. What was expensive in
 * the previous version (one giant <pre>) goes away once it is split per file:
 * each one collapses, and a large file starts closed.
 */

const STATUS = {
  A: { label: 'novo', cls: 'bg-pollen/10 text-pollen ring-pollen/30' },
  M: { label: 'alterado', cls: 'bg-honey/10 text-honey-soft ring-honey/30' },
  D: { label: 'removido', cls: 'bg-ember/10 text-ember ring-ember/30' },
  R: { label: 'renomeado', cls: 'bg-azure/10 text-azure ring-azure/30' },
};

/** Above this a file starts closed: a lockfile diff is not what you came for. */
const BIG_FILE = 300;
/** Above this we do not even parse without the user asking. */
const HUGE_PATCH = 800_000;

/** The filename is what you scan for; the directory is context. */
function FilePath({ path, oldPath }) {
  const i = path.lastIndexOf('/');
  return (
    <span className="min-w-0 truncate font-mono text-[12px]">
      {oldPath && oldPath !== path && (
        <span className="text-wax-900">{oldPath} → </span>
      )}
      {i >= 0 && <span className="text-wax-800">{path.slice(0, i + 1)}</span>}
      <span className="text-wax-200">{path.slice(i + 1)}</span>
    </span>
  );
}

function Tally({ additions, deletions }) {
  return (
    <span className="shrink-0 font-mono text-[11px] whitespace-nowrap">
      {additions > 0 && <span className="text-pollen">+{additions}</span>}
      {additions > 0 && deletions > 0 && ' '}
      {deletions > 0 && <span className="text-ember">−{deletions}</span>}
    </span>
  );
}

const ROW = {
  add: 'bg-pollen/[0.07]',
  del: 'bg-ember/[0.07]',
  ctx: '',
  meta: 'bg-comb-800/60',
};
const SIGN = { add: '+', del: '−', ctx: ' ', meta: '\\' };
const SIGN_CLS = { add: 'text-pollen', del: 'text-ember', ctx: 'text-wax-900', meta: 'text-wax-900' };

/** One line: two pinned gutters on the left, content scrolling underneath. */
function Line({ line }) {
  return (
    <div className={`flex w-max min-w-full ${ROW[line.type]}`}>
      <span className="sticky left-0 z-10 w-10 shrink-0 border-r border-comb-700 bg-comb-900 px-1.5 text-right text-[10px] text-wax-900 select-none">
        {line.oldNo ?? ''}
      </span>
      <span className="sticky left-10 z-10 w-10 shrink-0 border-r border-comb-700 bg-comb-900 px-1.5 text-right text-[10px] text-wax-900 select-none">
        {line.newNo ?? ''}
      </span>
      <span className={`w-4 shrink-0 pl-1.5 select-none ${SIGN_CLS[line.type]}`}>{SIGN[line.type]}</span>
      <span className={`pr-4 whitespace-pre ${line.type === 'ctx' ? 'text-wax-600' : 'text-wax-200'}`}>
        {line.text || ' '}
      </span>
    </div>
  );
}

function FileCard({ file, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = STATUS[file.status] || STATUS.M;

  return (
    <div className="overflow-hidden rounded-lg border border-comb-700 bg-comb-850/60">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 bg-comb-800/50 px-3 py-2 text-left transition-colors hover:bg-comb-800"
        aria-expanded={open}
      >
        <span className={`shrink-0 text-[10px] text-wax-700 transition-transform ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${meta.cls}`}
        >
          {meta.label}
        </span>
        <FilePath path={file.path} oldPath={file.oldPath} />
        <span className="flex-1" />
        <Tally additions={file.additions} deletions={file.deletions} />
      </button>

      {open && (
        <div className="overflow-x-auto border-t border-comb-700 font-mono text-[11px] leading-[1.6]">
          {file.binary ? (
            <p className="px-3 py-2 text-[11px] text-wax-800">arquivo binário — sem diff de texto</p>
          ) : file.hunks.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-wax-800">sem alteração de conteúdo (só modo ou metadado)</p>
          ) : (
            file.hunks.map((h, i) => (
              <div key={i}>
                {/* the @@ header carries the scope (function, class): it is what
                    places the hunk without having to open the file */}
                <div className="flex w-max min-w-full border-y border-comb-700 bg-comb-800 first:border-t-0">
                  {/* opaque on purpose: a translucent pinned cell lets code show through while scrolling */}
                  <span className="sticky left-0 z-10 w-20 shrink-0 bg-comb-800 px-2 text-[10px] text-wax-900 select-none">
                    @@
                  </span>
                  <span className="pr-4 text-azure whitespace-pre">{h.context || `linha ${h.newStart}`}</span>
                </div>
                {h.lines.map((l, j) => (
                  <Line key={j} line={l} />
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function DiffView({ runId }) {
  const [diff, setDiff] = useState(null);
  const [err, setErr] = useState(null);
  const [forceParse, setForceParse] = useState(false);
  const [allOpen, setAllOpen] = useState(null);

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setErr(null);
    setForceParse(false);
    setAllOpen(null);
    api
      .runDiff(runId, true)
      .then((d) => alive && setDiff(d))
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [runId]);

  const tooBig = !!diff?.patch && diff.patch.length > HUGE_PATCH && !forceParse;
  const files = useMemo(
    () => (diff?.patch && !tooBig ? parsePatch(diff.patch) : []),
    [diff, tooBig]
  );

  const totals = useMemo(
    () =>
      files.reduce(
        (a, f) => ({ additions: a.additions + f.additions, deletions: a.deletions + f.deletions }),
        { additions: 0, deletions: 0 }
      ),
    [files]
  );

  if (err) return <Empty icon="⚠" title="Sem diff" hint={err} />;
  if (!diff) return <p className="p-4 text-xs text-wax-900">carregando diff…</p>;
  if (!diff.files?.length) {
    return <Empty icon="≡" title="Nenhum arquivo alterado" hint="O agente não modificou o worktree." />;
  }

  const count = diff.files.length;

  return (
    <div className="space-y-2 p-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
        <span className="font-mono text-[11px] text-wax-700">
          {count} {count === 1 ? 'arquivo' : 'arquivos'}
        </span>
        {(totals.additions > 0 || totals.deletions > 0) && (
          <Tally additions={totals.additions} deletions={totals.deletions} />
        )}
        <span className="flex-1" />
        {files.length > 1 && (
          <Button variant="ghost" onClick={() => setAllOpen(allOpen === false ? true : false)}>
            {allOpen === false ? 'expandir tudo' : 'recolher tudo'}
          </Button>
        )}
      </div>

      {tooBig && (
        <div className="rounded-lg border border-honey/30 bg-honey/[0.06] p-3">
          <p className="text-xs text-wax-300">
            {Math.round(diff.patch.length / 1024)} KB patch. Rendering all of it freezes the tab.
          </p>
          <Button variant="ghost" className="mt-2" onClick={() => setForceParse(true)}>
            mostrar mesmo assim
          </Button>
        </div>
      )}

      {files.map((f) => (
        <FileCard
          // allOpen forces every card's state; the key changes to recreate them
          key={`${f.path}-${allOpen}`}
          file={f}
          defaultOpen={allOpen ?? f.lineCount <= BIG_FILE}
        />
      ))}

      {/* fallback: the daemon listed files but no patch arrived (worktree gone) */}
      {!files.length && !tooBig && (
        <ul className="space-y-1">
          {diff.files.map((f) => (
            <li key={f.path} className="flex items-center gap-2 rounded-md bg-comb-850/60 px-2.5 py-1.5">
              <span className="w-16 shrink-0 font-mono text-[10px] text-wax-700">{f.status}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-wax-300">{f.path}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
