#!/usr/bin/env node
/**
 * Honeycomb CLI — the interface built to be driven by an orchestrating agent
 * (or by you in a terminal).
 *
 * Decisions that exist because of that:
 *   - `--wait` blocks until done, so you can chain in a shell with no poll loop
 *   - the exit code tells a technical failure (1) from a rejection on the merits
 *     (3), so `honeycomb cross ... --wait && deploy` does what it looks like
 *   - `--json` prints the raw structure, for reliable parsing
 *   - events go to stderr and the result to stdout, so
 *     `honeycomb run ... --wait > out.txt` keeps only the answer
 */

import { parseArgs as parseArgv } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { oneLine, money, tokens as fmtTokens } from '../shared/format.mjs';

const BASE = process.env.HONEYCOMB_URL || 'http://127.0.0.1:4317';

const EXIT = { OK: 0, FAILED: 1, USAGE: 2, REJECTED: 3, UNREACHABLE: 4 };

/**
 * Colour per stream, decided separately for stdout and stderr.
 *
 * The CLI's contract is result on stdout, events on stderr, so it can be chained
 * in a shell. Painting stdout without checking its destination writes escape
 * codes into the file when you redirect, breaking any grep/cut downstream — but
 * stderr, which stays in the terminal, should remain coloured. Hence two
 * palettes rather than one.
 */
const canColor = (stream) =>
  !!stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const palette = (on) => ({
  dim: (s) => (on ? `\x1b[2m${s}\x1b[0m` : String(s)),
  bold: (s) => (on ? `\x1b[1m${s}\x1b[0m` : String(s)),
  red: (s) => (on ? `\x1b[31m${s}\x1b[0m` : String(s)),
  green: (s) => (on ? `\x1b[32m${s}\x1b[0m` : String(s)),
  yellow: (s) => (on ? `\x1b[33m${s}\x1b[0m` : String(s)),
  cyan: (s) => (on ? `\x1b[36m${s}\x1b[0m` : String(s)),
  violet: (s) => (on ? `\x1b[35m${s}\x1b[0m` : String(s)),
});

/** `c` paints the result (stdout); `e` paints the events (stderr). */
const c = palette(canColor(process.stdout));
const e = palette(canColor(process.stderr));

const TOOL_COLOR = { claude: c.yellow, kiro: c.violet, codex: c.green };
const TOOL_COLOR_ERR = { claude: e.yellow, kiro: e.violet, codex: e.green };

function err(msg, code = EXIT.USAGE) {
  console.error(e.red(`erro: ${msg}`));
  process.exit(code);
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    err(`daemon inacessivel em ${BASE} — rode "npm start"`, EXIT.UNREACHABLE);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) err(data?.error || `HTTP ${res.status}`, EXIT.FAILED);
  return data;
}

/**
 * Arguments.
 *
 * Options that take a value must be declared: without that, the stdlib
 * `parseArgs` treats `--mode full` as a boolean flag and pushes `full` into the
 * positionals. In exchange, declaring them fixes `--mode=full`, which the old
 * hand-written parser read as a key literally named "mode=full" and discarded
 * silently — the mode fell back to `ro` with nobody warned.
 */
const OPTIONS = {
  // with a value
  age: { type: 'string' },
  agents: { type: 'string' },
  days: { type: 'string' },
  effort: { type: 'string' },
  impl: { type: 'string' },
  'impl-model': { type: 'string' },
  isolation: { type: 'string' },
  judge: { type: 'string' },
  label: { type: 'string' },
  limit: { type: 'string' },
  message: { type: 'string', short: 'm' },
  mode: { type: 'string' },
  model: { type: 'string' },
  prompt: { type: 'string' },
  repo: { type: 'string' },
  session: { type: 'string' },
  spec: { type: 'string' },
  title: { type: 'string' },
  tool: { type: 'string' },
  validator: { type: 'string' },
  'validator-model': { type: 'string' },
  verify: { type: 'string' },
  // booleans
  force: { type: 'boolean' },
  full: { type: 'boolean' },
  'include-dirty': { type: 'boolean' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean' },
  resume: { type: 'boolean' },
  wait: { type: 'boolean' },
};

function parseArgs(argv) {
  try {
    const { values, positionals } = parseArgv({
      args: argv,
      options: OPTIONS,
      // permissive about undeclared options, as it was before
      strict: false,
      allowPositionals: true,
    });
    return { flags: values, pos: positionals };
  } catch (e) {
    err(e.message);
  }
}

function printEvent(ev) {
  const tint = TOOL_COLOR_ERR[ev.tool] || ((s) => s);
  switch (ev.type) {
    case 'tool_use':
      console.error(`  ${tint('▸')} ${e.bold(ev.toolName)} ${e.dim(summarize(ev.input))}`);
      break;
    case 'tool_result':
      console.error(`  ${ev.isError ? e.red('✗') : e.green('✓')} ${e.dim(oneLine(ev.text, 90))}`);
      break;
    case 'error':
      console.error(`  ${e.red('!')} ${ev.text}`);
      break;
    case 'status':
      if (ev.status) console.error(e.dim(`  · ${ev.status}${ev.worktree ? ` em ${ev.worktree.branch}` : ''}`));
      break;
  }
}

function summarize(input = {}) {
  return oneLine(
    input.summary || input.command || input.file_path || input.pattern || input.description ||
      Object.keys(input).slice(0, 3).join(', '),
    70
  );
}

/** Follows a run to completion, printing events on stderr. */
async function followRun(runId, { quiet = false } = {}) {
  let seq = 0;
  for (;;) {
    const events = await call('GET', `/api/runs/${runId}/events?fromSeq=${seq}`);
    for (const ev of events) {
      seq = Math.max(seq, ev.seq);
      if (!quiet) printEvent(ev);
    }
    const run = await call('GET', `/api/runs/${runId}`);
    if (!['running', 'preparing'].includes(run.status)) return run;
    await sleep(2000);
  }
}

async function followTask(taskId, { quiet = false } = {}) {
  const seen = new Map();
  for (;;) {
    const task = await call('GET', `/api/tasks/${taskId}`);
    for (const step of task.steps) {
      if (seen.get(step.id) !== step.status) {
        seen.set(step.id, step.status);
        if (!quiet) {
          const tint = TOOL_COLOR_ERR[step.tool] || ((s) => s);
          console.error(`${tint('◆')} ${e.bold(step.id)} (${step.tool}) → ${step.status}${step.verdict ? ` ${e.bold(step.verdict)}` : ''}`);
        }
      }
    }
    if (!['running', 'pending'].includes(task.status)) return task;
    await sleep(3000);
  }
}

/* ------------------------------------------------------------------ commands */

const commands = {
  async tools({ flags }) {
    const list = await call('GET', `/api/tools?cwd=${encodeURIComponent(flags.repo || process.cwd())}`);
    if (flags.json) return console.log(JSON.stringify(list, null, 2));
    for (const t of list) {
      const tint = TOOL_COLOR[t.name] || ((s) => s);
      const mark = t.available ? c.green('●') : c.dim('○');
      console.log(`${mark} ${tint(c.bold(t.displayName))} ${c.dim(t.available ? `${t.sessionCount} sessões` : t.stub ? 'não instalado' : 'indisponível')}`);
      for (const s of t.sessions.slice(0, 5)) {
        console.log(`    ${c.dim(s.status.padEnd(8))} ${oneLine(s.name, 60)}`);
      }
    }
  },

  async run({ flags, pos }) {
    const [tool, ...rest] = pos;
    const prompt = flags.prompt || rest.join(' ');
    if (!tool || !prompt) err('uso: honeycomb run <tool> "<prompt>" [--mode ro|verify|rw|full] [--wait]');

    const { runId } = await call('POST', '/api/runs', {
      tool,
      prompt,
      repo: flags.repo || process.cwd(),
      mode: flags.mode || 'ro',
      isolation: flags.isolation || 'worktree',
      model: flags.model,
      effort: flags.effort,
      sessionId: flags.session,
      resume: !!flags.resume,
      label: flags.label || oneLine(prompt, 50),
    });

    if (!flags.wait) {
      console.log(runId);
      return;
    }

    console.error(e.dim(`run ${runId}`));
    const run = await followRun(runId, { quiet: flags.quiet });

    if (flags.json) console.log(JSON.stringify(run, null, 2));
    else {
      console.log(run.output || '');
      if (run.diff?.files?.length) {
        console.error(e.dim(`\n${run.diff.files.length} arquivo(s) em ${run.worktree?.branch}`));
      }
      if (run.cost != null) console.error(e.dim(`custo ${money(run.cost)}`));
    }
    process.exit(run.status === 'done' ? EXIT.OK : EXIT.FAILED);
  },

  async watch({ pos, flags }) {
    const [runId] = pos;
    if (!runId) err('uso: honeycomb watch <runId>');
    const run = await followRun(runId, { quiet: flags.quiet });
    console.log(run.output || '');
    process.exit(run.status === 'done' ? EXIT.OK : EXIT.FAILED);
  },

  async runs({ flags }) {
    const list = await call('GET', '/api/runs');
    if (flags.json) return console.log(JSON.stringify(list, null, 2));
    for (const r of list.slice(0, Number(flags.limit || 20))) {
      const tint = TOOL_COLOR[r.tool] || ((s) => s);
      const st = r.status === 'done' ? c.green(r.status) : r.status === 'failed' ? c.red(r.status) : c.cyan(r.status);
      console.log(`${r.id.slice(0, 8)} ${tint(r.tool.padEnd(7))} ${st.padEnd(18)} ${oneLine(r.label, 50)}`);
    }
  },

  async show({ pos, flags }) {
    const [runId] = pos;
    if (!runId) err('uso: honeycomb show <runId>');
    const run = await call('GET', `/api/runs/${runId}`);
    if (flags.json) return console.log(JSON.stringify(run, null, 2));
    console.log(c.bold(run.label));
    console.log(c.dim(`${run.tool} · ${run.status} · ${run.mode} · ${run.worktree?.branch || 'sem worktree'}`));
    console.log(`\n${run.output || ''}`);
  },

  async diff({ pos, flags }) {
    const [runId] = pos;
    if (!runId) err('uso: honeycomb diff <runId> [--full]');
    const d = await call('GET', `/api/runs/${runId}/diff${flags.full ? '?full=1' : ''}`);
    if (flags.json) return console.log(JSON.stringify(d, null, 2));
    for (const f of d.files) console.log(`${c.dim(f.status.padEnd(3))} ${f.path}`);
    if (d.stat) console.log(`\n${c.dim(d.stat)}`);
    if (flags.full && d.patch) console.log(`\n${d.patch}`);
  },

  async commit({ pos, flags }) {
    const [runId] = pos;
    if (!runId) err('uso: honeycomb commit <runId> [-m "msg"]');
    const res = await call('POST', `/api/runs/${runId}/commit`, { message: flags.m || flags.message });
    console.log(res.committed ? c.green(`commit ${res.sha.slice(0, 8)}`) : c.dim(res.reason));
  },

  async discard({ pos }) {
    const [runId] = pos;
    if (!runId) err('uso: honeycomb discard <runId>');
    await call('DELETE', `/api/runs/${runId}/worktree`);
    console.log(c.dim('worktree descartado'));
  },

  async cancel({ pos }) {
    const [runId] = pos;
    if (!runId) err('uso: honeycomb cancel <runId>');
    const r = await call('POST', `/api/runs/${runId}/cancel`);
    console.log(r.cancelled ? c.yellow('cancelado') : c.dim('run não estava ativo'));
  },

  /** Arbitrary graph from a JSON file (or stdin with "-"). */
  async task({ pos, flags }) {
    const [file] = pos;
    if (!file) err('uso: honeycomb task <arquivo.json|-> [--wait]');

    // fd 0 is stdin: readFileSync reads to EOF without wiring a handler by hand
    const raw = readFileSync(file === '-' ? 0 : file, 'utf8');

    const spec = JSON.parse(raw);
    if (!spec.repo) spec.repo = flags.repo || process.cwd();

    const task = await call('POST', '/api/tasks', spec);
    await call('POST', `/api/tasks/${task.id}/run`);

    if (!flags.wait) return console.log(task.id);

    const done = await followTask(task.id, { quiet: flags.quiet });
    if (flags.json) console.log(JSON.stringify(done, null, 2));
    else printTaskSummary(done);
    process.exit(taskExit(done));
  },

  async cross({ pos, flags }) {
    const spec = flags.spec || pos.join(' ');
    if (!spec) err('uso: honeycomb cross "<especificação>" [--impl kiro] [--validator claude] [--wait]');

    const task = await call('POST', '/api/tasks/cross-validation', {
      title: flags.title || oneLine(spec, 60),
      repo: flags.repo || process.cwd(),
      spec,
      implementer: flags.impl || 'kiro',
      validator: flags.validator || 'claude',
      implementerModel: flags['impl-model'] !== true ? flags['impl-model'] : undefined,
      validatorModel: flags['validator-model'] !== true ? flags['validator-model'] : undefined,
      // --verify "cmd1;cmd2" overrides the default verification commands
      verifyCommands: flags.verify && flags.verify !== true
        ? String(flags.verify).split(';').map((s) => s.trim()).filter(Boolean)
        : undefined,
      autoRun: true,
    });

    if (!flags.wait) return console.log(task.id);

    const done = await followTask(task.id, { quiet: flags.quiet });
    if (flags.json) console.log(JSON.stringify(done, null, 2));
    else printTaskSummary(done);
    process.exit(taskExit(done));
  },

  async race({ pos, flags }) {
    const spec = flags.spec || pos.join(' ');
    if (!spec) err('uso: honeycomb race "<especificação>" [--agents kiro,claude] [--judge claude] [--wait]');

    const task = await call('POST', '/api/tasks/race', {
      title: flags.title || oneLine(spec, 60),
      repo: flags.repo || process.cwd(),
      spec,
      agents: String(flags.agents || 'kiro,claude').split(','),
      judge: flags.judge || 'claude',
      autoRun: true,
    });

    if (!flags.wait) return console.log(task.id);

    const done = await followTask(task.id, { quiet: flags.quiet });
    if (flags.json) console.log(JSON.stringify(done, null, 2));
    else printTaskSummary(done);
    process.exit(taskExit(done));
  },

  async models({ flags, pos }) {
    const tool = pos[0] || flags.tool;
    const data = await call('GET', `/api/models${tool ? `?tool=${tool}` : ''}`);
    if (flags.json) return console.log(JSON.stringify(data, null, 2));

    const show = (info) => {
      const tint = TOOL_COLOR[info.tool] || ((s) => s);
      console.log(`\n${tint(c.bold(info.tool))} ${c.dim(`(fonte: ${info.source})`)}`);
      if (info.note) console.log(c.dim(`  ${info.note}`));
      for (const m of info.models) {
        const rate = m.rate != null ? c.yellow(`${m.rate}×`.padStart(6)) : ' '.repeat(6);
        const ctx = m.contextTokens ? c.dim(` ${Math.round(m.contextTokens / 1000)}k`) : '';
        console.log(`  ${rate} ${(m.id || '(padrão)').padEnd(22)}${m.default ? c.green(' ←') : '  '}${ctx}`);
      }
    };

    if (tool) show(data);
    else for (const info of Object.values(data)) show(info);
    console.log();
  },

  async metrics({ flags }) {
    const m = await call('GET', `/api/metrics?days=${flags.days || 30}`);
    if (flags.json) return console.log(JSON.stringify(m, null, 2));

    console.log(c.bold(`\nÚltimos ${m.sinceDays} dias`));
    console.log(
      `  ${m.runs.total} runs · custo ${m.runs.totalCost}` +
        // tokens and cost do not add up: shown side by side, never aggregated
        (m.runs.totalTokens ? ` · ${fmtTokens(m.runs.totalTokens)}` : '')
    );
    console.log(`  ${m.tasks.total} tasks (${m.tasks.done} ok, ${m.tasks.failed} falharam)`);
    if (m.verdicts.approvalRate != null) {
      console.log(`  aprovação ${Math.round(m.verdicts.approvalRate * 100)}% (${m.verdicts.approved}/${m.verdicts.approved + m.verdicts.rejected})`);
    }
    if (m.tasks.extraRounds) {
      console.log(`  ${m.tasks.extraRounds} rodada(s) de correção em ${m.tasks.withRetry} task(s)`);
    }

    console.log(c.bold('\nPor ferramenta'));
    for (const t of m.tools) {
      const tint = TOOL_COLOR[t.tool] || ((s) => s);
      // each tool reports in the unit it has; forcing a single one would show
      // zero for whoever measures in tokens
      const consumo =
        t.unit === 'tokens'
          ? `${String(fmtTokens(t.totalTokens)).padStart(10)}  médio ${fmtTokens(t.avgTokens)}`
          : t.unit === 'cost'
            ? `custo ${String(t.totalCost).padStart(7)}  médio ${t.avgCost}`
            : c.dim('sem consumo reportado');
      console.log(
        `  ${tint(t.tool.padEnd(8))} ${String(t.total).padStart(3)} runs  ` +
          `sucesso ${String(Math.round((t.successRate || 0) * 100)).padStart(3)}%  ${consumo}`
      );
    }
    console.log();
  },

  async worktrees({ flags }) {
    const list = await call('GET', '/api/worktrees');
    if (flags.json) return console.log(JSON.stringify(list, null, 2));
    if (!list.length) return console.log(c.dim('nenhum worktree no disco'));
    for (const w of list) {
      const tone = w.state === 'dirty' ? c.yellow : w.state === 'committed' ? c.green : c.dim;
      console.log(`${tone(w.state.padEnd(10))} ${String(w.ageHours).padStart(4)}h  ${String(w.fileCount).padStart(3)} arq.  ${w.branch || w.name}`);
    }
  },

  async gc({ flags }) {
    const dryRun = !flags.force;
    if (flags['include-dirty'] && !flags.repo) {
      err('--include-dirty exige --repo <caminho> — remover trabalho pendente sem delimitar escopo varreria worktrees de outros repositórios');
    }

    const res = await call('POST', '/api/worktrees/gc', {
      minAgeHours: flags.age != null && flags.age !== true ? Number(flags.age) : 0,
      includeDirty: !!flags['include-dirty'],
      repo: flags.repo && flags.repo !== true ? flags.repo : undefined,
      dryRun,
    });

    if (flags.json) return console.log(JSON.stringify(res, null, 2));

    if (res.dryRun) {
      if (!res.candidates.length) return console.log(c.dim('nada a recolher'));
      console.log(c.bold(`${res.candidates.length} worktree(s) seriam recolhidos:`));
      for (const w of res.candidates) console.log(`  ${c.dim(w.state.padEnd(10))} ${w.branch || w.name}`);
      console.log(c.dim('\nrode com --force para aplicar'));
    } else {
      console.log(c.green(`${res.removed.length} recolhido(s)`), c.dim(`· ${res.kept} mantido(s)`));
      for (const e of res.errors) console.log(c.red(`  falhou: ${e.dir} — ${e.error}`));
    }
  },

  async followup({ pos, flags }) {
    const [runId, ...rest] = pos;
    const prompt = flags.prompt || rest.join(' ');
    if (!runId || !prompt) err('uso: honeycomb followup <runId> "<pergunta>" [--wait]');

    const { runId: newId } = await call('POST', `/api/runs/${runId}/follow-up`, { prompt });
    if (!flags.wait) return console.log(newId);

    const run = await followRun(newId, { quiet: flags.quiet });
    console.log(run.output || '');
    process.exit(run.status === 'done' ? EXIT.OK : EXIT.FAILED);
  },

  async tasks({ flags }) {
    const list = await call('GET', '/api/tasks');
    if (flags.json) return console.log(JSON.stringify(list, null, 2));
    for (const t of list.slice(0, Number(flags.limit || 15))) {
      const st = t.status === 'done' ? c.green(t.status) : t.status === 'failed' ? c.red(t.status) : c.cyan(t.status);
      console.log(`${t.id.slice(0, 8)} ${st.padEnd(18)} ${oneLine(t.title, 50)}`);
      console.log(c.dim(`         ${t.steps.map((s) => `${s.id}:${s.status}${s.verdict ? `(${s.verdict})` : ''}`).join('  ')}`));
    }
  },

  async status({ pos, flags }) {
    const [taskId] = pos;
    if (!taskId) err('uso: honeycomb status <taskId> [--wait]');
    const task = flags.wait
      ? await followTask(taskId, { quiet: flags.quiet })
      : await call('GET', `/api/tasks/${taskId}`);
    if (flags.json) return console.log(JSON.stringify(task, null, 2));
    printTaskSummary(task);
    if (flags.wait) process.exit(taskExit(task));
  },

  help() {
    console.log(`
${c.bold('honeycomb')} — orquestra CLIs de agentes como executores de tarefas
${c.dim('               abreviado como')} ${c.bold('hc')}

${c.bold('ferramentas e sessões')}
  tools [--repo DIR]                    estado das ferramentas e sessões

${c.bold('runs')}
  run <tool> "<prompt>" [opções]        dispara um agente
  watch <runId>                         acompanha um run em andamento
  runs [--limit N]                      lista runs
  show <runId>                          detalhe e output
  diff <runId> [--full]                 diff do worktree
  commit <runId> [-m msg]               commita na branch do agente
  discard <runId>                       descarta o worktree
  cancel <runId>                        interrompe
  followup <runId> "<pergunta>"         continua a conversa com aquele agente

${c.bold('manutenção e dados')}
  models [tool]                         modelos disponíveis e multiplicador
  metrics [--days N]                    custo, tempo e taxa de aprovação
  worktrees                             worktrees no disco e seu estado
  gc [--age H] [--repo D] [--force]     recolhe worktrees vazios/commitados
                                        (--include-dirty exige --repo)

${c.bold('orquestração')}
  cross "<spec>" [--impl X --validator Y]   implementa e valida em ferramentas distintas
  race "<spec>" [--agents a,b --judge c]    N agentes competem, um juiz escolhe
  task <arquivo.json|->                     grafo arbitrário de passos
  tasks / status <taskId>                   lista / acompanha

${c.bold('opções comuns')}
  --wait          bloqueia até terminar (eventos em stderr, resultado em stdout)
  --json          saída estruturada
  --quiet         sem eventos intermediários
  --repo DIR      repositório alvo (padrão: diretório atual)
  --mode M        ro | verify | rw | full
  --isolation I   worktree | shared

${c.bold('códigos de saída')}
  0 sucesso   1 falha técnica   2 uso incorreto   3 reprovado no mérito   4 daemon fora
`);
  },
};

function printTaskSummary(task) {
  console.log(`\n${c.bold(task.title)} → ${task.status === 'done' ? c.green(task.status) : c.red(task.status)}`);
  for (const s of task.steps) {
    const tint = TOOL_COLOR[s.tool] || ((x) => x);
    const v = s.verdict ? (s.verdict === 'APROVADO' ? c.green(` ${s.verdict}`) : c.red(` ${s.verdict}`)) : '';
    console.log(`  ${tint('◆')} ${s.id.padEnd(10)} ${s.tool.padEnd(7)} ${s.status}${v}`);
    if (s.runId) console.log(c.dim(`    run ${s.runId}`));
  }
}

function taskExit(task) {
  if (task.steps.some((s) => s.status === 'rejected')) return EXIT.REJECTED;
  return task.status === 'done' ? EXIT.OK : EXIT.FAILED;
}

/* ---------------------------------------------------------------------- main */

const [, , cmd, ...argv] = process.argv;
const handler = commands[cmd || 'help'];

if (!handler) {
  console.error(e.red(`comando desconhecido: ${cmd}`));
  commands.help();
  process.exit(EXIT.USAGE);
}

handler(parseArgs(argv)).catch((err) => {
  console.error(e.red(`erro: ${err.message}`));
  process.exit(EXIT.FAILED);
});
