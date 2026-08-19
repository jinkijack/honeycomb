#!/usr/bin/env node
/**
 * Honeycomb MCP server.
 *
 * Exposes the comb as typed tools to any MCP client — Claude Code, Codex, Kiro,
 * Claude Desktop — including to the very agents Honeycomb orchestrates.
 *
 * It is a thin shell over the daemon's HTTP API, on purpose: the worktree, queue,
 * spend-ceiling and verdict logic already lives there and is the same logic the
 * CLI and the UI use. Duplicating it here would create a third behaviour to keep
 * in sync.
 *
 * ## Long calls
 *
 * A `cross` with correction rounds runs past half an hour. That is compatible
 * with the protocol for two reasons, verified in the Claude Code documentation:
 *
 *   - the default wall-clock ceiling (`MCP_TOOL_TIMEOUT`) is around 28h, so the
 *     real duration never comes close;
 *   - what kills a long call is the *idle timeout* — total silence for 30min
 *     (stdio) or 5min (HTTP). That is why every blocking step emits
 *     `notifications/progress` on each new agent event: besides showing up as
 *     progress for the caller, it is what proves the call is alive.
 *
 * Even so, every blocking tool accepts `wait: false`, which returns the id
 * immediately. That is not just a fallback: the run lives in the daemon, not in
 * this call. If the client dies mid-way, the agent keeps working and the worktree
 * stays — `honeycomb_status` finds the work again later.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { setTimeout as sleep } from 'node:timers/promises';
import { oneLine } from '../shared/format.mjs';

const BASE = process.env.HONEYCOMB_URL || 'http://127.0.0.1:4317';

/** Text budget per response: the client warns above ~10k tokens. */
const MAX_OUTPUT = 20000;

class DaemonDown extends Error {}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new DaemonDown(
      `daemon do Honeycomb inacessível em ${BASE}. Rode "npm start" no diretório do Honeycomb.`
    );
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------------------------------------------------------- progress */

/**
 * Reports progress back to the caller.
 *
 * The protocol requires `progress` to be strictly increasing; for runs that
 * comes for free from the event's `seq`, which the bus already numbers.
 */
function reporter(extra) {
  const token = extra?._meta?.progressToken;
  let last = 0;
  return async (progress, message) => {
    if (token == null) return;
    const value = progress > last ? progress : last + 1;
    last = value;
    try {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: value, message },
      });
    } catch {
      // losing a progress notification must not take down the execution
    }
  };
}

/** Turns a bus event into a readable progress line. */
function eventLine(ev) {
  switch (ev.type) {
    case 'tool_use':
      return `${ev.tool}: ${ev.toolName} ${oneLine(
        ev.input?.command || ev.input?.file_path || ev.input?.pattern || ev.input?.description || ''
      , 70)}`;
    case 'tool_result':
      return `${ev.tool}: ${ev.isError ? 'falhou' : 'ok'} ${oneLine(ev.text, 60)}`;
    case 'status':
      return `${ev.tool}: ${ev.status}${ev.worktree ? ` em ${ev.worktree.branch}` : ''}`;
    case 'error':
      return `${ev.tool}: erro — ${oneLine(ev.text, 80)}`;
    default:
      return null;
  }
}

/** Follows a run to completion, streaming progress. */
async function followRun(runId, extra) {
  const report = reporter(extra);
  let seq = 0;
  for (;;) {
    if (extra?.signal?.aborted) {
      await call('POST', `/api/runs/${runId}/cancel`).catch(() => {});
      throw new Error('chamada cancelada; o run foi interrompido');
    }
    const events = await call('GET', `/api/runs/${runId}/events?fromSeq=${seq}`);
    for (const ev of events) {
      seq = Math.max(seq, ev.seq);
      const line = eventLine(ev);
      if (line) await report(seq, line);
    }
    const run = await call('GET', `/api/runs/${runId}`);
    if (!['running', 'preparing', 'queued'].includes(run.status)) return run;
    await sleep(2000);
  }
}

/** Follows a task, reporting every step state change. */
async function followTask(taskId, extra) {
  const report = reporter(extra);
  const seen = new Map();
  let n = 0;
  for (;;) {
    if (extra?.signal?.aborted) throw new Error('chamada cancelada; a task segue rodando no daemon');
    const task = await call('GET', `/api/tasks/${taskId}`);
    for (const step of task.steps) {
      const key = `${step.status}:${step.verdict || ''}:${step.retryRound || 0}`;
      if (seen.get(step.id) !== key) {
        seen.set(step.id, key);
        await report(
          ++n,
          `${step.id} (${step.tool}) → ${step.status}` +
            (step.verdict ? ` ${step.verdict}` : '') +
            (step.retryRound ? ` · correção ${step.retryRound}` : '')
        );
      }
    }
    if (!['running', 'pending'].includes(task.status)) return task;
    await sleep(3000);
  }
}

/* ------------------------------------------------------------------ output */

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

function clip(s) {
  const v = String(s || '');
  return v.length > MAX_OUTPUT
    ? `${v.slice(0, MAX_OUTPUT)}\n\n[…truncado. Use honeycomb_status para o texto completo]`
    : v;
}

function runSummary(run) {
  const lines = [
    `run ${run.id}`,
    `ferramenta: ${run.tool} · modo: ${run.mode} · status: ${run.status}`,
  ];
  if (run.worktree) lines.push(`worktree: ${run.worktree.dir}\nbranch: ${run.worktree.branch}`);
  if (run.diff?.files?.length) {
    lines.push(`arquivos alterados (${run.diff.files.length}):`);
    lines.push(run.diff.files.map((f) => `  ${f.status}  ${f.path}`).join('\n'));
  }
  if (run.cost != null) lines.push(`custo: ${run.cost} crédito(s)`);
  if (run.tokens != null) lines.push(`tokens: ${run.tokens}`);
  if (run.error) lines.push(`erro: ${run.error}`);
  lines.push('', '--- resposta do agente ---', clip(run.output) || '(vazio)');
  return lines.join('\n');
}

function taskSummary(task) {
  const rejected = task.steps.filter((s) => s.status === 'rejected');
  const lines = [
    `task ${task.id} — ${task.title}`,
    `status: ${task.status}${task.spent != null ? ` · gasto: ${task.spent} crédito(s)` : ''}`,
    '',
    'passos:',
  ];
  for (const s of task.steps) {
    lines.push(
      `  ${s.id} (${s.tool}) → ${s.status}` +
        (s.verdict ? ` ${s.verdict}` : '') +
        (s.rounds > 1 ? ` · ${s.rounds} rodadas` : '') +
        (s.runId ? `\n      run ${s.runId}` : '')
    );
  }
  if (task.winner) {
    lines.push('', `vencedor: ${task.winner.stepId} (branch ${task.winner.branch})`);
  }
  if (rejected.length) {
    lines.push(
      '',
      'REPROVADO na revisão. Isto é um resultado, não uma falha técnica: o revisor',
      'executou a verificação e recusou o trabalho. O worktree continua no disco',
      'com o que foi feito — leia a crítica abaixo antes de decidir o próximo passo.'
    );
  }
  const last = task.steps.filter((s) => s.runId).at(-1);
  if (last?.runId) lines.push('', `--- último passo (${last.id}) ---`);
  return { text: lines.join('\n'), lastRunId: last?.runId || null };
}

async function withTaskOutput(task) {
  const { text: head, lastRunId } = taskSummary(task);
  if (!lastRunId) return head;
  const run = await call('GET', `/api/runs/${lastRunId}`).catch(() => null);
  return run ? `${head}\n${clip(run.output)}` : head;
}

/* ---------------------------------------------------------------- server  */

const server = new McpServer(
  { name: 'honeycomb', version: '0.1.0' },
  {
    instructions:
      'Honeycomb orquestra CLIs de agentes (Claude Code, Kiro, Codex) em worktrees git ' +
      'isolados. Use honeycomb_cross para implementar algo com revisão independente, ' +
      'honeycomb_run para uma tarefa numa ferramenta só. Um VEREDITO: REPROVADO é ' +
      'resultado legítimo, não erro. Nada é commitado na sua branch sem honeycomb_commit.',
  }
);

const guard = (fn) => async (args, extra) => {
  try {
    return await fn(args, extra);
  } catch (err) {
    return fail(err instanceof DaemonDown ? err.message : `honeycomb: ${err.message}`);
  }
};

const repoArg = z
  .string()
  .optional()
  .describe('Raiz do repositório alvo. Padrão: o repositório configurado no daemon.');
const waitArg = z
  .boolean()
  .default(true)
  .describe(
    'true (padrão) bloqueia até terminar e devolve o resultado, emitindo progresso. ' +
      'false devolve o id na hora — use quando não puder bloquear (ex: chamada vinda de subagente).'
  );

/* --- read-only ------------------------------------------------------------ */

server.registerTool(
  'honeycomb_tools',
  {
    title: 'Estado das ferramentas',
    description:
      'Lista as CLIs de agente instaladas, o que cada uma sabe fazer (eventos estruturados, ' +
      'retomada, se reporta custo ou tokens) e as sessões existentes. Consulte antes de escolher ' +
      'uma ferramenta que você não sabe se está disponível.',
    inputSchema: { repo: repoArg },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ repo }) => {
    const list = await call('GET', `/api/tools?cwd=${encodeURIComponent(repo || process.cwd())}`);
    return text(
      list
        .map((t) => {
          const caps = Object.entries(t.capabilities || {})
            .filter(([, v]) => v)
            .map(([k]) => k)
            .join(', ');
          return `${t.available ? '●' : '○'} ${t.name} — ${t.displayName}\n  ${
            t.available ? `${t.sessionCount} sessão(ões)` : 'indisponível'
          }\n  capacidades: ${caps || '—'}`;
        })
        .join('\n')
    );
  })
);

server.registerTool(
  'honeycomb_models',
  {
    title: 'Modelos disponíveis',
    description:
      'Modelos por ferramenta, com multiplicador de custo quando existe. Relevante no Kiro, ' +
      'onde os modelos vão de 0,05× a 2,4× — quase 50× de diferença de preço pela mesma tarefa. ' +
      'Consulte antes de escolher modelo para trabalho caro.',
    inputSchema: { tool: z.enum(['claude', 'kiro', 'codex']).optional() },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ tool }) => {
    const data = await call('GET', `/api/models${tool ? `?tool=${tool}` : ''}`);
    const render = (info) =>
      `${info.tool} (fonte: ${info.source})${info.note ? `\n  ${info.note}` : ''}\n` +
      info.models
        .map(
          (m) =>
            `  ${m.rate != null ? `${m.rate}×`.padStart(6) : '      '} ${m.id || '(padrão)'}${
              m.default ? ' ←' : ''
            }`
        )
        .join('\n');
    return text(tool ? render(data) : Object.values(data).map(render).join('\n\n'));
  })
);

server.registerTool(
  'honeycomb_status',
  {
    title: 'Estado de um run ou task',
    description:
      'Detalhe completo de um run ou de uma task pelo id, incluindo a resposta do agente. ' +
      'É o companheiro de wait:false, e o jeito de reencontrar trabalho de uma sessão anterior: ' +
      'o run vive no daemon, não na chamada que o disparou.',
    inputSchema: {
      id: z.string().describe('runId ou taskId'),
      wait: z.boolean().default(false).describe('Bloqueia até terminar, se ainda estiver rodando.'),
    },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ id, wait }, extra) => {
    const task = await call('GET', `/api/tasks/${id}`).catch(() => null);
    if (task) {
      const done = wait && ['running', 'pending'].includes(task.status)
        ? await followTask(id, extra)
        : task;
      return text(await withTaskOutput(done));
    }
    const run = await call('GET', `/api/runs/${id}`);
    const done = wait && ['running', 'preparing', 'queued'].includes(run.status)
      ? await followRun(id, extra)
      : run;
    return text(runSummary(done));
  })
);

server.registerTool(
  'honeycomb_runs',
  {
    title: 'Runs recentes',
    description: 'Lista os runs mais recentes com estado, custo e ferramenta.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ limit }) => {
    const list = await call('GET', '/api/runs');
    if (!list.length) return text('nenhum run registrado');
    return text(
      list
        .slice(0, limit)
        .map(
          (r) =>
            `${r.id}  ${r.tool.padEnd(7)} ${String(r.status).padEnd(12)} ${oneLine(r.label, 60)}`
        )
        .join('\n')
    );
  })
);

server.registerTool(
  'honeycomb_diff',
  {
    title: 'Diff do worktree de um run',
    description:
      'O que o agente mudou no worktree dele. Sem full, devolve a lista de arquivos e o --stat; ' +
      'com full, o patch inteiro. Nada disso está na sua branch até honeycomb_commit.',
    inputSchema: {
      runId: z.string(),
      full: z.boolean().default(false).describe('Inclui o patch completo.'),
    },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ runId, full }) => {
    const d = await call('GET', `/api/runs/${runId}/diff${full ? '?full=1' : ''}`);
    const head = d.files.map((f) => `${f.status}\t${f.path}`).join('\n');
    return text(clip([head, '', d.stat, full && d.patch ? `\n${d.patch}` : ''].join('\n')));
  })
);

server.registerTool(
  'honeycomb_worktrees',
  {
    title: 'Worktrees em disco',
    description:
      'Worktrees existentes e seu estado: vazio, com trabalho pendente (dirty), commitado, ou já ' +
      'aterrissado em outra branch. Worktree dirty nunca é recolhido automaticamente.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  guard(async () => {
    const list = await call('GET', '/api/worktrees');
    if (!list.length) return text('nenhum worktree em disco');
    return text(
      list
        .map(
          (w) =>
            `${String(w.state).padEnd(10)} ${String(w.ageHours).padStart(4)}h  ${String(
              w.fileCount
            ).padStart(3)} arq.  ${w.branch || w.name}${w.landedIn ? `  (já em ${w.landedIn.ref})` : ''}`
        )
        .join('\n')
    );
  })
);

server.registerTool(
  'honeycomb_metrics',
  {
    title: 'Métricas de custo e aprovação',
    description:
      'Consumo, duração, taxa de sucesso e taxa de aprovação por ferramenta. Custo e tokens ' +
      'aparecem separados de propósito: são unidades diferentes e somá-las daria número sem sentido.',
    inputSchema: { days: z.number().int().min(1).max(365).default(30) },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ days }) => {
    const m = await call('GET', `/api/metrics?days=${days}`);
    const tools = m.tools
      .map(
        (t) =>
          `  ${t.tool.padEnd(8)} ${String(t.total).padStart(3)} runs  sucesso ${Math.round(
            (t.successRate || 0) * 100
          )}%  ${
            t.unit === 'tokens'
              ? `${t.totalTokens} tokens`
              : t.unit === 'cost'
                ? `custo ${t.totalCost} (médio ${t.avgCost})`
                : 'sem consumo reportado'
          }`
      )
      .join('\n');
    return text(
      [
        `últimos ${m.sinceDays} dias`,
        `${m.runs.total} runs · custo ${m.runs.totalCost}${
          m.runs.totalTokens ? ` · ${m.runs.totalTokens} tokens` : ''
        }`,
        `${m.tasks.total} tasks (${m.tasks.done} ok, ${m.tasks.failed} falharam)`,
        m.verdicts.approvalRate != null
          ? `aprovação ${Math.round(m.verdicts.approvalRate * 100)}%`
          : '',
        '',
        'por ferramenta:',
        tools,
      ]
        .filter(Boolean)
        .join('\n')
    );
  })
);

/* --- execution ------------------------------------------------------------ */

server.registerTool(
  'honeycomb_run',
  {
    title: 'Disparar um agente',
    description:
      'Roda uma tarefa numa ferramenta, por padrão num worktree git isolado com branch própria — ' +
      'seu working tree não é tocado. Modos: ro (só lê), verify (lê e executa build/teste, não ' +
      'escreve), rw (edita sem shell), full (autonomia total, só faz sentido isolado). ' +
      'Para trabalho que precisa ser conferido, prefira honeycomb_cross.',
    inputSchema: {
      tool: z.enum(['claude', 'kiro', 'codex']),
      prompt: z.string().describe('A tarefa, escrita para o agente que vai executá-la.'),
      repo: repoArg,
      mode: z.enum(['ro', 'verify', 'rw', 'full']).default('ro'),
      isolation: z
        .enum(['worktree', 'shared'])
        .default('worktree')
        .describe('shared roda no próprio repositório, sem isolamento — use com cuidado.'),
      model: z.string().optional().describe('Veja honeycomb_models; no Kiro muda muito o preço.'),
      wait: waitArg,
    },
  },
  guard(async ({ tool, prompt, repo, mode, isolation, model, wait }, extra) => {
    const { runId } = await call('POST', '/api/runs', {
      tool, prompt, repo, mode, isolation, model, label: oneLine(prompt, 50),
    });
    if (!wait) {
      return text(`run ${runId} disparado. Acompanhe com honeycomb_status.`);
    }
    return text(runSummary(await followRun(runId, extra)));
  })
);

server.registerTool(
  'honeycomb_cross',
  {
    title: 'Implementar com validação cruzada',
    description:
      'O padrão do dia a dia. Uma ferramenta implementa a spec num worktree isolado com autonomia ' +
      'total; outra entra no MESMO worktree em modo verify, é obrigada a rodar typecheck/lint/teste, ' +
      'relatar o que executou, e termina com VEREDITO: APROVADO ou REPROVADO. Se reprovar, a crítica ' +
      'volta ao implementador, que retrabalha no worktree que já produziu, até maxRounds rodadas. ' +
      'REPROVADO é resultado, não erro — significa que o revisor rodou a verificação e recusou.',
    inputSchema: {
      spec: z.string().describe('O que deve ser implementado. Quanto mais preciso, menos rodadas.'),
      repo: repoArg,
      implementer: z.enum(['claude', 'kiro', 'codex']).default('kiro'),
      validator: z.enum(['claude', 'kiro', 'codex']).default('claude'),
      implementerModel: z.string().optional(),
      validatorModel: z.string().optional(),
      verifyCommands: z
        .array(z.string())
        .optional()
        .describe('Comandos de verificação. Padrão: npx tsc --noEmit, npm run lint, npm test.'),
      maxRounds: z.number().int().min(0).max(5).default(2),
      budget: z.number().optional().describe('Teto de crédito só desta orquestração.'),
      wait: waitArg,
    },
  },
  guard(async (args, extra) => {
    const { wait, ...body } = args;
    const task = await call('POST', '/api/tasks/cross-validation', {
      ...body,
      title: oneLine(args.spec, 60),
      autoRun: true,
    });
    if (!wait) return text(`task ${task.id} disparada. Acompanhe com honeycomb_status.`);
    return text(await withTaskOutput(await followTask(task.id, extra)));
  })
);

server.registerTool(
  'honeycomb_race',
  {
    title: 'Competição entre agentes',
    description:
      'N agentes resolvem a MESMA spec independentemente, cada um no seu worktree, e um juiz ' +
      'escolhe um vencedor. Ninguém funde nada: os trabalhos ficam lado a lado em branches ' +
      'separadas. Custa N× a mesma tarefa e devolve uma escolha, não uma soma — só vale quando a ' +
      'tarefa tem ambiguidade real de design. Para trabalho normal use honeycomb_cross.',
    inputSchema: {
      spec: z.string(),
      repo: repoArg,
      agents: z.array(z.enum(['claude', 'kiro', 'codex'])).min(2).default(['kiro', 'claude']),
      judge: z.enum(['claude', 'kiro', 'codex']).default('claude'),
      wait: waitArg,
    },
  },
  guard(async ({ wait, ...body }, extra) => {
    const task = await call('POST', '/api/tasks/race', {
      ...body,
      title: oneLine(body.spec, 60),
      autoRun: true,
    });
    if (!wait) return text(`task ${task.id} disparada. Acompanhe com honeycomb_status.`);
    return text(await withTaskOutput(await followTask(task.id, extra)));
  })
);

server.registerTool(
  'honeycomb_followup',
  {
    title: 'Continuar a conversa com um agente',
    description:
      'Retoma a sessão daquele agente no mesmo worktree, preservando o contexto — diferente de ' +
      'disparar um run novo, que começaria do zero. Só funciona em ferramentas com retomada.',
    inputSchema: { runId: z.string(), prompt: z.string(), wait: waitArg },
  },
  guard(async ({ runId, prompt, wait }, extra) => {
    const { runId: newId } = await call('POST', `/api/runs/${runId}/follow-up`, { prompt });
    if (!wait) return text(`run ${newId} disparado. Acompanhe com honeycomb_status.`);
    return text(runSummary(await followRun(newId, extra)));
  })
);

/* --- consolidation ------------------------------------------------------- */

server.registerTool(
  'honeycomb_commit',
  {
    title: 'Commitar o trabalho de um run',
    description:
      'Consolida o que o agente fez num commit da branch dele (honeycomb/<id>). Não mexe na sua ' +
      'branch nem no seu working tree: para trazer o trabalho, faça merge ou cherry-pick da branch ' +
      'depois. Revise com honeycomb_diff antes.',
    inputSchema: { runId: z.string(), message: z.string().optional() },
  },
  guard(async ({ runId, message }) => {
    const res = await call('POST', `/api/runs/${runId}/commit`, { message });
    return text(
      res.committed
        ? `commit ${res.sha} na branch do agente. Traga com: git merge <branch> (veja honeycomb_status).`
        : `nada a commitar: ${res.reason}`
    );
  })
);

server.registerTool(
  'honeycomb_discard',
  {
    title: 'Descartar o worktree de um run',
    description:
      'Remove o worktree e o trabalho não commitado dele. Irreversível — confirme com quem pediu ' +
      'antes de usar, e prefira honeycomb_diff para ver o que se perde.',
    inputSchema: { runId: z.string() },
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  guard(async ({ runId }) => {
    await call('DELETE', `/api/runs/${runId}/worktree`);
    return text(`worktree do run ${runId} descartado`);
  })
);

server.registerTool(
  'honeycomb_cancel',
  {
    title: 'Interromper um run',
    description: 'SIGTERM no processo do agente, SIGKILL após 5s. O worktree é preservado.',
    inputSchema: { runId: z.string() },
  },
  guard(async ({ runId }) => {
    const r = await call('POST', `/api/runs/${runId}/cancel`);
    return text(r.cancelled ? `run ${runId} cancelado` : 'run não estava ativo');
  })
);

/* --------------------------------------------------------------------- go  */

const transport = new StdioServerTransport();
await server.connect(transport);
