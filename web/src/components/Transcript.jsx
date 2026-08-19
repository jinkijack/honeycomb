import React, { useEffect, useRef, useState } from 'react';
import { TOOL_META, money, tokens } from './ui.jsx';

/**
 * Renderiza o stream normalizado de eventos.
 *
 * Deltas de texto consecutivos sao fundidos num unico bloco, senao um run do
 * Claude with hundreds of `text_delta` events would become hundreds of DOM nodes.
 */
function coalesce(events) {
  const out = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if ((ev.type === 'text' || ev.type === 'thinking') && last?.type === ev.type) {
      last.text = (last.text || '') + (ev.text || '');
      last.seq = ev.seq;
      continue;
    }
    out.push({ ...ev });
  }
  return out;
}

function ToolCall({ ev }) {
  const [open, setOpen] = useState(false);
  const input = ev.input || {};
  const preview =
    input.summary ||
    input.command ||
    input.file_path ||
    input.pattern ||
    input.description ||
    Object.keys(input).slice(0, 3).join(', ');

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-comb-700 bg-comb-950/50">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-wax-50/5"
      >
        <span className="text-[10px] text-wax-900">{open ? '▾' : '▸'}</span>
        <span className="rounded bg-azure/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-azure">
          {ev.toolName}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-wax-700">{preview}</span>
      </button>
      {open && (
        <pre className="max-h-64 overflow-auto border-t border-comb-700 px-3 py-2 font-mono text-[11px] leading-relaxed text-wax-500">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResult({ ev }) {
  const [open, setOpen] = useState(false);
  const text = ev.text || '';
  const firstLine = text.split('\n')[0].slice(0, 100);
  const multi = text.includes('\n') || text.length > 100;

  return (
    <div className="my-1 flex items-start gap-2 px-1">
      <span className={`mt-0.5 text-[11px] ${ev.isError ? 'text-ember' : 'text-pollen'}`}>
        {ev.isError ? '✗' : '✓'}
      </span>
      <div className="min-w-0 flex-1">
        <button
          onClick={() => multi && setOpen(!open)}
          className={`block w-full truncate text-left font-mono text-[11px] ${
            ev.isError ? 'text-ember/80' : 'text-wax-700'
          } ${multi ? 'hover:text-wax-300' : 'cursor-default'}`}
        >
          {open ? '' : firstLine}
          {multi && !open && ' …'}
        </button>
        {open && (
          <pre className="mt-1 max-h-72 overflow-auto rounded bg-comb-950/60 p-2 font-mono text-[11px] whitespace-pre-wrap text-wax-500">
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}

export default function Transcript({ events, tool, live }) {
  const ref = useRef(null);
  const stickRef = useRef(true);

  // only auto-scrolls if the user was already at the bottom — otherwise it
  // interferes with reading
  useEffect(() => {
    const el = ref.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const items = coalesce(events);
  const meta = TOOL_META[tool] || TOOL_META.claude;

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="h-full overflow-y-auto rounded-xl border border-comb-700 bg-black/25 p-4"
    >
      {items.length === 0 && (
        <p className="py-8 text-center text-xs text-wax-900">
          {live ? 'aguardando saída do agente…' : 'sem eventos'}
        </p>
      )}

      {items.map((ev) => {
        switch (ev.type) {
          case 'text':
            return (
              <p key={ev.seq} className="my-2 text-[13px] leading-relaxed whitespace-pre-wrap text-wax-200">
                {ev.text}
              </p>
            );
          case 'thinking':
            return (
              <p key={ev.seq} className="my-2 border-l-2 border-comb-600 pl-3 text-[12px] leading-relaxed whitespace-pre-wrap text-wax-700 italic">
                {ev.text}
              </p>
            );
          case 'tool_use':
            return <ToolCall key={ev.seq} ev={ev} />;
          case 'tool_result':
            return <ToolResult key={ev.seq} ev={ev} />;
          case 'error':
            return (
              <p key={ev.seq} className="my-2 rounded-lg bg-ember/10 px-3 py-2 font-mono text-[12px] text-ember">
                {ev.text}
              </p>
            );
          case 'result':
            return (
              <div key={ev.seq} className={`my-3 rounded-lg border px-3 py-2 ${meta.bg} border-comb-700`}>
                <div className={`mb-1 text-[10px] font-semibold tracking-wider uppercase ${meta.color}`}>
                  resultado final
                </div>
                <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-wax-200">{ev.text}</p>
                {(ev.cost != null || ev.turns != null || ev.tokens != null) && (
                  <p className="mt-2 font-mono text-[10px] text-wax-700">
                    {money(ev.cost) && `custo ${money(ev.cost)}`}
                    {!money(ev.cost) && tokens(ev.tokens) && tokens(ev.tokens)}
                    {ev.turns != null && ` · ${ev.turns} turnos`}
                  </p>
                )}
              </div>
            );
          default:
            return null;
        }
      })}

      {live && (
        <div className="flex items-center gap-2 py-2 text-[11px] text-wax-900">
          <span className="animate-dot cell h-2 w-[7px] bg-azure" />
          ao vivo
        </div>
      )}
    </div>
  );
}
