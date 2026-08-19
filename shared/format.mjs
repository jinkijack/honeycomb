/**
 * Formatters shared by the CLI, the MCP server and the frontend.
 *
 * They live here because all three surfaces show the same numbers and the copies
 * had already drifted — `oneLine` truncated at 80 in the CLI and at 110 in MCP,
 * for no reason. More importantly: the rule that **cost and tokens do not add
 * up** is encoded in these functions, and a product rule duplicated across three
 * files becomes three behaviours the first time someone edits only one.
 */

/** Single-line text, so it fits in lists and tables. */
export const oneLine = (s, n = 80) =>
  String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Cost in credit.
 *
 * The adapter hands over a raw float (0.8475130000000001); showing it whole
 * clutters the line without informing anything, and 3 decimals already tell
 * executions apart.
 */
export function money(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 0.001) return '<0,001';
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(n);
}

/** Tokens in compact form — 264900 becomes 264.9k. */
export function tokens(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const fmt = (x) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(x);
  if (n < 1000) return `${fmt(n)} tok`;
  if (n < 1_000_000) return `${fmt(n / 1000)}k tok`;
  return `${fmt(n / 1_000_000)}M tok`;
}

/** Human-readable duration from milliseconds. */
export function duration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
