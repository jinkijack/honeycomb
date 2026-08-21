import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { HOST, PORT, ROOT } from './config.mjs';
import { toolStatus, adapters } from './adapters/index.mjs';
import { bus, readRunLog } from './bus.mjs';
import { runs, tasks } from './store.mjs';
import { startRun, cancelRun, getRunDiff, commitRun, discardRun } from './runner.mjs';
import { createTask, runTask, crossValidationTemplate, raceTemplate } from './orchestrator.mjs';
import { BROWSER_PRESETS, DEFAULT_BROWSER, resolveBrowser, probeAgentBrowser } from './qa.mjs';
import { isGitRepo, repoRoot, listWorktrees, currentBranch, removeWorktree } from './worktree.mjs';
import { inspectWorktrees, collect, scheduleGc } from './gc.mjs';
import { computeMetrics } from './metrics.mjs';
import { listModels, listAllModels } from './models.mjs';
import { reconcile } from './recovery.mjs';
import { budgetStatus } from './budget.mjs';
import { queueStatus } from './runner.mjs';

const app = express();
app.use(express.json({ limit: '4mb' }));

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    res.status(400).json({ error: err.message });
  });
};

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    pid: process.pid,
    queue: queueStatus(),
    budget: budgetStatus(),
  });
});

/* ---------------------------------------------------------------- tools --- */

app.get('/api/tools', wrap(async (req, res) => {
  res.json(await toolStatus({ cwd: req.query.cwd }));
}));

app.get('/api/models', wrap(async (req, res) => {
  res.json(req.query.tool ? await listModels(req.query.tool) : await listAllModels());
}));

/**
 * Browser automation the QA stage can be pointed at.
 *
 * Reports what each choice would actually resolve to for the given tester, not
 * what it declares — a browser configured and silently absent is worse than one
 * the operator knew they did not have.
 */
app.get('/api/browsers', wrap(async (req, res) => {
  const tool = req.query.tool || null;
  res.json({
    default: DEFAULT_BROWSER,
    agentBrowser: await probeAgentBrowser(),
    browsers: await Promise.all(
      Object.keys(BROWSER_PRESETS).map(async (id) => {
        const r = await resolveBrowser(id, { tool });
        return { id, label: r.label, transport: r.transport, note: r.note };
      })
    ),
  });
}));

/* ----------------------------------------------------------------- repo --- */

app.get('/api/repo', wrap(async (req, res) => {
  const dir = req.query.path;
  if (!dir) throw new Error('the "path" parameter is required');
  if (!fs.existsSync(dir)) throw new Error(`diretorio nao existe: ${dir}`);
  if (!(await isGitRepo(dir))) throw new Error(`nao e um repositorio git: ${dir}`);

  const root = await repoRoot(dir);
  res.json({
    root,
    branch: await currentBranch(root),
    worktrees: await listWorktrees(root),
  });
}));

/* ------------------------------------------------------------------ runs -- */

app.get('/api/runs', (req, res) => {
  const all = runs.all();
  res.json(req.query.taskId ? all.filter((r) => r.taskId === req.query.taskId) : all);
});

app.get('/api/runs/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'run nao encontrado' });
  res.json(run);
});

app.get('/api/runs/:id/events', (req, res) => {
  res.json(readRunLog(req.params.id, { fromSeq: Number(req.query.fromSeq || 0) }));
});

app.get('/api/runs/:id/diff', wrap(async (req, res) => {
  const diff = await getRunDiff(req.params.id, { full: req.query.full === '1' });
  if (!diff) return res.status(404).json({ error: 'run sem worktree' });
  res.json(diff);
}));

app.post('/api/runs', wrap(async (req, res) => {
  const { tool, prompt, repo, cwd, isolation, mode, model, effort, sessionId, resume, label } = req.body;
  if (!tool) throw new Error('the "tool" field is required');
  if (!prompt) throw new Error('the "prompt" field is required');
  if (!adapters[tool]) throw new Error(`ferramenta desconhecida: ${tool}`);

  const target = repo || cwd;
  if (!target) throw new Error('informe "repo" ou "cwd"');
  if (isolation === 'worktree' && !(await isGitRepo(target))) {
    throw new Error(`isolamento worktree exige repositorio git: ${target}`);
  }

  const { runId } = await startRun({
    tool, prompt, repo: target, cwd, isolation, mode, model, effort, sessionId, resume, label,
  });
  res.status(202).json({ runId });
}));

app.post('/api/runs/:id/cancel', (req, res) => {
  res.json({ cancelled: cancelRun(req.params.id) });
});

app.post('/api/runs/:id/commit', wrap(async (req, res) => {
  res.json(await commitRun(req.params.id, req.body?.message));
}));

app.delete('/api/runs/:id/worktree', wrap(async (req, res) => {
  res.json({ discarded: await discardRun(req.params.id) });
}));

/**
 * Continues the conversation with an agent that already ran, inside the same
 * worktree.
 *
 * Only works on tools with `resume` and a known session id — without that it
 * would be a new run with no memory, which is a different thing and should not
 * disguise itself as this one.
 */
app.post('/api/runs/:id/follow-up', wrap(async (req, res) => {
  const parent = runs.get(req.params.id);
  if (!parent) throw new Error('run nao encontrado');

  const { prompt, mode } = req.body;
  if (!prompt) throw new Error('the "prompt" field is required');

  const adapter = adapters[parent.tool];
  if (!adapter?.capabilities?.resume) {
    throw new Error(`${parent.tool} nao suporta continuar conversa`);
  }
  if (!parent.sessionId) {
    throw new Error('run sem id de sessao — nao da para retomar');
  }

  const { runId } = await startRun({
    tool: parent.tool,
    prompt,
    repo: parent.repo,
    // continues in the previous run's worktree; if it had none, in the repo
    cwd: parent.worktree?.dir || parent.repo,
    isolation: 'shared',
    mode: mode || parent.mode,
    sessionId: parent.sessionId,
    resume: true,
    label: `${parent.label} ↩`,
    taskId: parent.taskId,
  });

  runs.patch(runId, { parentRunId: parent.id, worktree: parent.worktree || null });
  res.status(202).json({ runId });
}));

/* ------------------------------------------------------ worktrees and gc --- */

app.get('/api/worktrees', wrap(async (req, res) => {
  res.json(await inspectWorktrees());
}));

/**
 * Discards a worktree by path. It exists alongside discard-by-runId because a
 * worktree can be orphaned — the run record is gone, the directory is not — and
 * in that case there is no id to ask for it by.
 */
app.delete('/api/worktrees', wrap(async (req, res) => {
  const dir = req.body?.dir || req.query.dir;
  if (!dir) throw new Error('the "dir" field is required');

  const all = await inspectWorktrees();
  const wt = all.find((w) => w.dir === dir);
  if (!wt) throw new Error(`worktree nao encontrado: ${dir}`);

  if (wt.state === 'dirty' && !req.body?.force) {
    throw new Error('worktree tem trabalho pendente — envie force para remover mesmo assim');
  }

  await removeWorktree(wt.repo || dir, dir);
  if (wt.runId) runs.patch(wt.runId, { worktree: null, discardedAt: Date.now() });
  res.json({ discarded: dir });
}));

app.post('/api/worktrees/gc', wrap(async (req, res) => {
  const { minAgeHours, includeDirty, dryRun, repo, dirs } = req.body || {};

  // removing pending work requires an explicit scope: with no repo and no list
  // of directories, includeDirty would sweep other repositories' worktrees
  if (includeDirty && !repo && !dirs?.length) {
    throw new Error('includeDirty exige "repo" ou "dirs" para delimitar o escopo');
  }

  res.json(
    await collect({
      minAgeHours: minAgeHours != null ? Number(minAgeHours) : 2,
      includeDirty: !!includeDirty,
      dryRun: dryRun !== false,
      repo: repo ? await repoRoot(repo) : null,
      dirs: Array.isArray(dirs) ? dirs : null,
    })
  );
}));

/* --------------------------------------------------------------- metrics -- */

app.get('/api/budget', (req, res) => {
  res.json({ ...budgetStatus(), queue: queueStatus() });
});

app.get('/api/metrics', (req, res) => {
  res.json(computeMetrics({ sinceDays: Number(req.query.days || 30) }));
});

/* ----------------------------------------------------------------- tasks -- */

app.get('/api/tasks', (req, res) => res.json(tasks.all()));

app.get('/api/tasks/:id', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'task nao encontrada' });
  res.json(task);
});

app.post('/api/tasks', wrap(async (req, res) => {
  res.status(201).json(createTask(req.body));
}));

app.post('/api/tasks/cross-validation', wrap(async (req, res) => {
  const { title, repo, spec, implementer, validator, verifyCommands, maxRounds,
          implementerModel, validatorModel, autoRun,
          qa, tester, testerModel, qaBrowser, qaMaxRounds, startCommand, baseUrl,
          qaNotes, autoCommit } = req.body;
  if (!repo) throw new Error('the "repo" field is required');
  if (!spec) throw new Error('the "spec" field is required');
  if (!(await isGitRepo(repo))) throw new Error(`nao e um repositorio git: ${repo}`);

  for (const [field, tool] of [['implementer', implementer], ['validator', validator], ['tester', qa ? tester : null]]) {
    if (tool && !adapters[tool]) throw new Error(`${field}: ferramenta desconhecida: ${tool}`);
  }
  if (qa && qaBrowser && !BROWSER_PRESETS[qaBrowser]) {
    throw new Error(`navegador desconhecido: ${qaBrowser} (use ${Object.keys(BROWSER_PRESETS).join(', ')})`);
  }

  const task = createTask({
    budget: req.body.budget,
    ...crossValidationTemplate({
      title: title || 'Implementacao com validacao cruzada',
      repo: await repoRoot(repo),
      spec,
      implementer,
      validator,
      verifyCommands,
      maxRounds: maxRounds != null ? Number(maxRounds) : undefined,
      implementerModel: implementerModel || null,
      validatorModel: validatorModel || null,
      qa: !!qa,
      tester: tester || undefined,
      testerModel: testerModel || null,
      qaBrowser: qa ? await resolveBrowser(qaBrowser || DEFAULT_BROWSER, { tool: tester || 'claude' }) : null,
      qaMaxRounds: qaMaxRounds != null ? Number(qaMaxRounds) : undefined,
      startCommand: startCommand || null,
      baseUrl: baseUrl || null,
      qaNotes: qaNotes || null,
      autoCommit: autoCommit !== false,
    }),
  });

  if (autoRun) runTask(task.id).catch((err) => console.error('[task]', err.message));
  res.status(201).json(task);
}));

app.post('/api/tasks/race', wrap(async (req, res) => {
  const { title, repo, spec, agents, judge, autoRun } = req.body;
  if (!repo) throw new Error('the "repo" field is required');
  if (!spec) throw new Error('the "spec" field is required');
  if (!(await isGitRepo(repo))) throw new Error(`nao e um repositorio git: ${repo}`);

  const list = Array.isArray(agents) ? agents.filter(Boolean) : ['kiro', 'claude'];
  if (list.length < 2) throw new Error('race precisa de pelo menos 2 agentes');
  for (const a of list) if (!adapters[a]) throw new Error(`ferramenta desconhecida: ${a}`);

  const task = createTask(
    raceTemplate({
      title: title || 'Competição entre agentes',
      repo: await repoRoot(repo),
      spec,
      agents: list,
      judge: judge || 'claude',
    })
  );

  if (autoRun) runTask(task.id).catch((err) => console.error('[task]', err.message));
  res.status(201).json(task);
}));

app.post('/api/tasks/:id/run', wrap(async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) throw new Error('task nao encontrada');
  runTask(task.id).catch((err) => console.error('[task]', err.message));
  res.status(202).json({ started: true, taskId: task.id });
}));

/* ----------------------------------------------------------------- static -- */

const dist = path.join(ROOT, 'web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

/* --------------------------------------------------------------------- ws -- */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const send = (payload) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  send({ kind: 'hello', ts: Date.now() });

  const onRunEvent = (ev) => send({ kind: 'run', ...ev });
  const onTaskEvent = (ev) => send({ kind: 'task', ...ev });

  bus.on('event', onRunEvent);
  bus.on('task', onTaskEvent);

  ws.on('close', () => {
    bus.off('event', onRunEvent);
    bus.off('task', onTaskEvent);
  });
});

// reconcile before accepting new work: runs left 'running' by a previous daemon
// have nobody listening, and their process became an orphan
reconcile();

// collects only what provably has nothing to lose, and nothing younger than
// 24h — a recent worktree may be work you still intend to look at
scheduleGc({ intervalHours: 6, minAgeHours: 24 });

server.listen(PORT, HOST, () => {
  console.log(`[honeycomb] daemon em http://${HOST}:${PORT}`);
  console.log(`[honeycomb] websocket em ws://${HOST}:${PORT}/ws`);
  if (!fs.existsSync(dist)) {
    console.log('[honeycomb] UI nao compilada — rode "npm run web" para o dev server');
  }
});
