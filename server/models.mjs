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
 *   cursor a real list, via `--list-models`, but plain text and without prices —
 *          the same model appears in `-low`/`-high`/`-fast` variants, which is
 *          effort and speed encoded in the id rather than a separate flag.
 *
 * `source` says where each list came from, and the UI uses it to make clear when
 * the field accepts arbitrary text.
 */

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

let kiroCache = { at: 0, models: null };
let cursorCache = { at: 0, models: null };
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
 * `cursor-agent --list-models` prints `<id> - <Label>` lines under a header, and
 * marks the account default with `(current, default)` inside the label. No JSON
 * flag exists, so the parse is on the text — but the shape is stable enough that
 * a change would produce an empty list, not a wrong one.
 */
async function cursorModels() {
  if (cursorCache.models && Date.now() - cursorCache.at < CACHE_MS) return cursorCache.models;

  try {
    const { stdout } = await exec(BIN.cursor, ['--list-models'], {
      timeout: 25000,
      maxBuffer: 1024 * 1024,
    });

    const models = [];
    for (const raw of stdout.replace(ANSI, '').split('\n')) {
      const m = raw.trim().match(/^([\w.-]+)\s+-\s+(.+)$/);
      if (!m) continue;
      const isDefault = /\(current, default\)/i.test(m[2]);
      models.push({
        id: m[1],
        label: m[2].replace(/\s*\(current, default\)\s*/i, '').trim(),
        default: isDefault,
      });
    }

    cursorCache = { at: Date.now(), models };
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

    case 'cursor': {
      const models = await cursorModels();
      return {
        tool,
        source: models.length ? 'cli' : 'indisponivel',
        freeText: true,
        hasRates: false,
        models,
        note: 'O Cursor codifica esforco e velocidade no proprio id (-low/-high/-xhigh, -fast).',
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
  const tools = ['claude', 'kiro', 'codex', 'cursor'];
  const out = {};
  await Promise.all(tools.map(async (t) => { out[t] = await listModels(t); }));
  return out;
}
