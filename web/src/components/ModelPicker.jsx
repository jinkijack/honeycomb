import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Field, Select, Input } from './ui.jsx';

/**
 * Per-tool model selector.
 *
 * The fact that justifies this component existing is Kiro's `rate`: its models
 * range from 0.05× to 2.4× in credit, and the default (`auto`) is not the
 * cheapest. Choosing blindly is what made a single task cost 41.
 *
 * When a tool publishes no list (Codex), it falls back to a free-form field
 * instead of offering invented options.
 */
export default function ModelPicker({ tool, value, onChange, label = 'Modelo', hint }) {
  const [info, setInfo] = useState(null);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    let alive = true;
    setInfo(null);
    setManual(false);
    api
      .models(tool)
      .then((r) => {
        if (!alive) return;
        setInfo(r);

        /**
         * Not every tool has an "empty" option in its list: Kiro starts at
         * `auto`, not at "". With empty state and no matching option, the select
         * displays the first option while it would submit something else — what
         * you see and what you send diverge. So we anchor to the declared
         * default.
         */
        const hasEmpty = r.models.some((m) => m.id === '');
        if (!hasEmpty && r.models.length && !r.models.some((m) => m.id === value)) {
          const fallback = r.models.find((m) => m.default) || r.models[0];
          onChange(fallback.id);
        }
      })
      .catch(() => alive && setInfo({ models: [], freeText: true, source: 'nenhum' }));
    return () => {
      alive = false;
    };
    // `value` deliberately out of the deps: we only anchor when the tool changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  if (!info) {
    return (
      <Field label={label} hint="carregando…">
        <Select disabled>
          <option>…</option>
        </Select>
      </Field>
    );
  }

  const hasList = info.models.length > 1;
  const selected = info.models.find((m) => m.id === value);

  // cost hint: only Kiro publishes a multiplier
  const rateHint =
    selected?.rate != null
      ? `${selected.rate}× crédito`
      : info.source === 'nenhum'
        ? 'sem listagem'
        : hint;

  if (manual || !hasList) {
    return (
      <Field label={label} hint={info.note ? 'campo livre' : rateHint}>
        <Input
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={info.note ? 'nome do modelo (opcional)' : 'deixe vazio para o padrão'}
        />
        {hasList && (
          <button
            onClick={() => setManual(false)}
            className="mt-1 text-[10px] text-wax-700 hover:text-wax-300"
          >
            ← escolher da lista
          </button>
        )}
        {info.note && <p className="mt-1 text-[10px] text-wax-900">{info.note}</p>}
      </Field>
    );
  }

  return (
    <Field label={label} hint={rateHint}>
      <Select value={value || ''} onChange={(e) => onChange(e.target.value)}>
        {info.models.map((m) => (
          <option key={m.id || 'default'} value={m.id}>
            {m.label}
            {m.rate != null && m.rate !== 1 ? `  (${m.rate}×)` : ''}
            {m.default ? '  — padrão' : ''}
          </option>
        ))}
      </Select>
      <div className="mt-1 flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 text-[10px] leading-snug text-wax-900">
          {selected?.description || ''}
        </span>
        {info.freeText && (
          <button
            onClick={() => setManual(true)}
            className="shrink-0 text-[10px] text-wax-700 hover:text-wax-300"
          >
            digitar →
          </button>
        )}
      </div>
    </Field>
  );
}
