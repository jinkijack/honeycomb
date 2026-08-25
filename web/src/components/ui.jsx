import React from 'react';
import { money, tokens, duration } from '../../../shared/format.mjs';

/**
 * Cell marker.
 *
 * A hexagon rather than a circle because the product's unit of work is an
 * isolated cell — a worktree — and repeating the shape is what makes the screen
 * read as a comb without needing any illustration.
 */
export function Cell({ className = '', pulse = false }) {
  return <span className={`cell shrink-0 ${pulse ? 'animate-dot' : ''} ${className}`} />;
}

/** The mark: a cell filled with honey up to the rim. */
export function Logo({ className = 'h-7 w-7' }) {
  const hex = 'M12 1 21.5 6.5 21.5 17.5 12 23 2.5 17.5 2.5 6.5Z';
  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Honeycomb">
      <defs>
        <clipPath id="hc-cell">
          <path d={hex} />
        </clipPath>
      </defs>
      <g clipPath="url(#hc-cell)">
        <rect x="0" y="0" width="24" height="24" fill="var(--color-comb-800)" />
        <rect x="0" y="9.5" width="24" height="15" fill="var(--color-honey)" />
      </g>
      <path d={hex} fill="none" stroke="var(--color-honey)" strokeWidth="1.75" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Colour per tool.
 *
 * Claude moved off amber: honey is the brand colour now, and leaving the tool on
 * the same tone would make a run look like product chrome. The coral is
 * Hiberbee's `DEFAULT_KEYWORD` and happens to be nearly Anthropic's colour.
 */
export const TOOL_META = {
  claude: { label: 'Claude Code', color: 'text-coral', bg: 'bg-coral/10', ring: 'ring-coral/30', dot: 'bg-coral' },
  kiro: { label: 'Kiro CLI', color: 'text-lavender', bg: 'bg-lavender/10', ring: 'ring-lavender/30', dot: 'bg-lavender' },
  codex: { label: 'Codex CLI', color: 'text-pollen', bg: 'bg-pollen/10', ring: 'ring-pollen/30', dot: 'bg-pollen' },
  cursor: { label: 'Cursor CLI', color: 'text-ice', bg: 'bg-ice/10', ring: 'ring-ice/30', dot: 'bg-ice' },
};

/**
 * Colour and name per STEP ROLE.
 *
 * A run answers two independent questions — which tool executed it, and what it
 * was for — and the list used to answer only the first. Reading a `cross` meant
 * decoding three near-identical rows by the `/ impl`, `/ review`, `/ qa` suffix
 * buried in the label.
 *
 * Role gets its own channel: a squared, uppercase chip, deliberately unlike the
 * rounded status pill and the hexagon that marks the tool, so the three can sit
 * in one row without being mistaken for each other.
 */
export const STEP_META = {
  impl: { label: 'implementação', cls: 'bg-honey/10 text-honey-soft ring-honey/30', dot: 'bg-honey' },
  review: { label: 'validação', cls: 'bg-orchid/10 text-orchid ring-orchid/30', dot: 'bg-orchid' },
  qa: { label: 'teste', cls: 'bg-mint/10 text-mint ring-mint/30', dot: 'bg-mint' },
  // race only, and race has no UI yet — nectar is the brand family without
  // being honey, and it never shares a flow with `impl`
  judge: { label: 'julgamento', cls: 'bg-nectar/10 text-nectar ring-nectar/30', dot: 'bg-nectar' },
};

/**
 * Step id → role.
 *
 * `race` numbers its competitors `impl_kiro`, `impl_claude_1`, so the match is on
 * the prefix; anything unrecognised has no role rather than a wrong one.
 */
export function stepRole(stepId) {
  if (!stepId) return null;
  // a standalone role run has no step id, only a role: `validator` is the same
  // job `review` does inside a flow, and it earns the same chip
  if (stepId === 'validator') return 'review';
  if (stepId === 'agent') return null;
  if (stepId === 'review' || stepId === 'qa' || stepId === 'judge') return stepId;
  if (stepId === 'impl' || stepId.startsWith('impl_')) return 'impl';
  return null;
}

/** The role chip. Falls back to the raw step id, which is still better than nothing. */
export function StepTag({ stepId, title, className = '' }) {
  const role = stepRole(stepId);
  const m = STEP_META[role];
  const cls = m ? m.cls : 'bg-wax-500/10 text-wax-500 ring-wax-500/25';
  return (
    <span
      title={title || stepId}
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[10px]
        font-semibold tracking-wider uppercase ring-1 ring-inset ${cls} ${className}`}
    >
      {m ? m.label : stepId}
    </span>
  );
}

export const STATUS_META = {
  queued: { label: 'na fila', cls: 'bg-wax-500/10 text-wax-300 ring-wax-500/30' },
  preparing: { label: 'preparando', cls: 'bg-azure/10 text-azure ring-azure/30', pulse: true },
  running: { label: 'rodando', cls: 'bg-azure/10 text-azure ring-azure/30', pulse: true },
  retrying: { label: 'repetindo', cls: 'bg-honey/10 text-honey-soft ring-honey/30', pulse: true },
  // interrupted is neither the agent's failure nor your cancellation: the
  // daemon went down
  interrupted: { label: 'interrompido', cls: 'bg-lavender/10 text-lavender ring-lavender/30' },
  blocked: { label: 'teto atingido', cls: 'bg-peach/10 text-peach ring-peach/30' },
  busy: { label: 'ocupada', cls: 'bg-azure/10 text-azure ring-azure/30', pulse: true },
  idle: { label: 'ociosa', cls: 'bg-wax-500/10 text-wax-300 ring-wax-500/30' },
  saved: { label: 'salva', cls: 'bg-wax-500/10 text-wax-500 ring-wax-500/20' },
  pending: { label: 'aguardando', cls: 'bg-wax-500/10 text-wax-500 ring-wax-500/20' },
  done: { label: 'concluído', cls: 'bg-pollen/10 text-pollen ring-pollen/30' },
  failed: { label: 'falhou', cls: 'bg-ember/10 text-ember ring-ember/30' },
  rejected: { label: 'reprovado', cls: 'bg-peach/10 text-peach ring-peach/30' },
  cancelled: { label: 'cancelado', cls: 'bg-wax-500/10 text-wax-500 ring-wax-500/20' },
  skipped: { label: 'pulado', cls: 'bg-wax-500/10 text-wax-700 ring-wax-500/20' },
};

export function Badge({ status, children }) {
  const m = STATUS_META[status] || { label: status, cls: 'bg-wax-500/10 text-wax-300 ring-wax-500/30' };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${m.cls}`}>
      {m.pulse && <Cell pulse className="h-2 w-[7px] bg-current" />}
      {children || m.label}
    </span>
  );
}

export function Card({ className = '', children, ...rest }) {
  return (
    <div
      className={`rounded-xl border border-comb-700 bg-comb-850/80 backdrop-blur-sm ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Button({ variant = 'default', className = '', ...props }) {
  const variants = {
    default: 'bg-wax-50/5 hover:bg-wax-50/10 text-wax-200 border-comb-600',
    // the primary action is the brand colour; dark text because pure honey is
    // too light for white on top
    primary: 'bg-honey hover:bg-nectar text-comb-950 border-honey',
    danger: 'bg-ember/15 hover:bg-ember/25 text-ember border-ember/30',
    ghost: 'bg-transparent hover:bg-wax-50/5 text-wax-500 border-transparent',
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm
        font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40
        ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="font-mono text-[11px] font-medium tracking-wider text-wax-600 uppercase">{label}</span>
        {hint && <span className="text-[11px] text-wax-700">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

const inputCls =
  'w-full rounded-lg border border-comb-600 bg-comb-950/60 px-3 py-2 text-sm text-wax-100 ' +
  'placeholder:text-wax-900 outline-none focus:border-honey/60 focus:ring-2 focus:ring-honey/20';

export const Input = (p) => <input {...p} className={`${inputCls} ${p.className || ''}`} />;
export const Textarea = (p) => <textarea {...p} className={`${inputCls} resize-y font-mono text-[13px] ${p.className || ''}`} />;
export const Select = (p) => (
  <select {...p} className={`${inputCls} ${p.className || ''}`}>
    {p.children}
  </select>
);

export function Empty({ icon = '⬡', title, hint }) {
  return (
    <div className="relative flex flex-col items-center justify-center py-16 text-center">
      {/* texture only where there is no data to compete with it */}
      <div className="comb-texture pointer-events-none absolute inset-0 opacity-[0.05]" aria-hidden="true" />
      <div className="relative mb-3 flex h-12 w-12 items-center justify-center">
        <span className="cell absolute inset-0 bg-comb-800" aria-hidden="true" />
        <span className="relative text-lg text-wax-800">{icon}</span>
      </div>
      <p className="relative text-sm font-medium text-wax-500">{title}</p>
      {hint && <p className="relative mt-1 max-w-sm text-xs text-wax-800">{hint}</p>}
    </div>
  );
}

export { money, tokens, duration };

/**
 * Short form on purpose: the run row is dense and `Intl.RelativeTimeFormat`
 * would spend twice the space saying the same thing.
 */
export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s atrás`;
  if (s < 3600) return `${Math.floor(s / 60)}min atrás`;
  if (s < 86400) return `${Math.floor(s / 3600)}h atrás`;
  return `${Math.floor(s / 86400)}d atrás`;
}

