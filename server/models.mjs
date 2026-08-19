import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BIN } from './config.mjs';

const exec = promisify(execFile);

/**
 * Model catalogue per tool.
 *
 * The three expose this in very different ways, and the catalogue does not hide
 * the difference — hiding it would make the UI promise validation that does not
 * exist:
 *
 *   kiro   a real list, via `chat --list-models`, with credit multiplier and
 *          context window. The only one that lets you choose with cost in mind.
 *   claude accepts an alias ('opus', 'sonnet') or a full name. There is no
 *          listing command, so the list here is curated and may go stale.
 *   codex  exposes no list at all. Free-form field, no invented suggestions.
 *
 * `source` says where each list came from, and the UI uses it to make clear when
 * the field accepts arbitrary text.
 */

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

let kiroCache = { at: 0, models: null };
const CACHE_MS = 5 * 60 * 1000;

async function kiroModels() {
  if (kiroCache.models && Date.now() - kiroCache.at < CACHE_MS) return kiroCache.models;

  try {
    const { stdout, stderr } = await exec(
      BIN.kiro,
      ['chat', '--list-models', '--format', 'json'],
      { timeout: 25000, maxBuffer: 4 * 1024 * 1024 }
    );
    const raw = (stdout + stderr).replace(ANSI, '');
    const start = raw.indexOf('{');
    if (start < 0) throw new Error('sem json');
    const parsed = JSON.parse(raw.slice(start));

    const models = (parsed.models || []).map((m) => ({
      id: m.model_id,
      label: m.model_name,
      description: m.description,
      // credit multiplier: the datum that lets you choose knowing the cost
      rate: m.rate_multiplier ?? null,
      contextTokens: m.context_window_tokens ?? null,
      default: m.model_id === parsed.default_model,
    }));

    kiroCache = { at: Date.now(), models };
    return models;
  } catch {
    return [];
  }
}

/**
 * Curated list. Claude Code accepts aliases that always point at the newest
 * model in that family, and full names too — the aliases are the more stable
 * choice to store in a task that will be re-run later.
 */
const CLAUDE_MODELS = [
  { id: '', label: 'padrão da sessão', description: 'Usa o modelo configurado no Claude Code', default: true },
  { id: 'opus', label: 'opus', description: 'Apelido para o Opus mais recente' },
  { id: 'sonnet', label: 'sonnet', description: 'Apelido para o Sonnet mais recente — mais barato que opus' },
  { id: 'haiku', label: 'haiku', description: 'Apelido para o Haiku mais recente — o mais barato' },
  { id: 'claude-opus-5', label: 'claude-opus-5', description: 'Nome completo, fixa a versão' },
  { id: 'claude-sonnet-5', label: 'claude-sonnet-5', description: 'Nome completo, fixa a versão' },
];

export async function listModels(tool) {
  switch (tool) {
    case 'kiro': {
      const models = await kiroModels();
      return {
        tool,
        source: models.length ? 'cli' : 'indisponivel',
        freeText: true,
        hasRates: true,
        models,
      };
    }

    case 'claude':
      return { tool, source: 'curado', freeText: true, hasRates: false, models: CLAUDE_MODELS };

    case 'codex':
      return {
        tool,
        source: 'nenhum',
        freeText: true,
        hasRates: false,
        models: [
          { id: '', label: 'padrão do Codex', description: 'Usa o modelo do config.toml', default: true },
        ],
        note: 'O Codex não expõe listagem de modelos pela CLI — digite o nome se quiser trocar.',
      };

    default:
      return { tool, source: 'nenhum', freeText: true, hasRates: false, models: [] };
  }
}

export async function listAllModels() {
  const tools = ['claude', 'kiro', 'codex'];
  const out = {};
  await Promise.all(tools.map(async (t) => { out[t] = await listModels(t); }));
  return out;
}
