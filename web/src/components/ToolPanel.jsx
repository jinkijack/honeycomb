import React from 'react';
import { Card, Badge, TOOL_META, Empty } from './ui.jsx';

function Capabilities({ caps }) {
  const items = [
    ['eventos', caps.structuredEvents],
    ['sessões vivas', caps.liveSessions],
    ['retomar', caps.resume],
    // Codex measures usage in tokens rather than cost; striking through "custo"
    // with nothing else would suggest it reports no usage at all, which is false
    caps.cost ? ['custo', true] : ['tokens', !!caps.tokens],
  ];
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {items.map(([label, on]) => (
        <span
          key={label}
          className={`rounded px-1.5 py-0.5 text-[10px] ring-1 ring-inset ${
            on ? 'bg-wax-50/5 text-wax-300 ring-wax-50/10' : 'bg-transparent text-wax-900 ring-wax-50/5 line-through'
          }`}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

export default function ToolPanel({ tools, onUseSession }) {
  if (!tools.length) return <Empty icon="◌" title="Consultando ferramentas…" />;

  return (
    <div className="space-y-3">
      {tools.map((t) => {
        const meta = TOOL_META[t.name] || TOOL_META.claude;
        return (
          <Card key={t.name} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`cell h-2.5 w-[9px] shrink-0 ${t.available ? meta.dot : 'bg-comb-500'}`} />
                  <h3 className={`truncate text-sm font-semibold ${t.available ? meta.color : 'text-wax-900'}`}>
                    {t.displayName}
                  </h3>
                </div>
                <p className="mt-0.5 text-[11px] text-wax-700">
                  {t.available
                    ? `${t.sessionCount} ${t.sessionCount === 1 ? 'sessão' : 'sessões'}`
                    : t.stub
                      ? 'não instalado — adapter pronto'
                      : 'indisponível'}
                </p>
              </div>
            </div>

            {t.available && <Capabilities caps={t.capabilities} />}

            {t.sessions.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-comb-700 pt-3">
                {t.sessions.slice(0, 6).map((s) => (
                  <li key={s.id}>
                    <button
                      onClick={() => onUseSession?.(t.name, s)}
                      className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-wax-50/5"
                      title={`${s.id}\n${s.cwd || ''}`}
                    >
                      <Badge status={s.status} />
                      <span className="min-w-0 flex-1 truncate text-xs text-wax-500 group-hover:text-wax-200">
                        {s.name}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}
