async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  health: () => req('GET', '/api/health'),
  tools: (cwd) => req('GET', `/api/tools?cwd=${encodeURIComponent(cwd || '')}`),
  repo: (p) => req('GET', `/api/repo?path=${encodeURIComponent(p)}`),
  models: (tool) => req('GET', `/api/models${tool ? `?tool=${encodeURIComponent(tool)}` : ''}`),

  runs: () => req('GET', '/api/runs'),
  run: (id) => req('GET', `/api/runs/${id}`),
  runEvents: (id, fromSeq = 0) => req('GET', `/api/runs/${id}/events?fromSeq=${fromSeq}`),
  runDiff: (id, full) => req('GET', `/api/runs/${id}/diff${full ? '?full=1' : ''}`),
  startRun: (payload) => req('POST', '/api/runs', payload),
  cancelRun: (id) => req('POST', `/api/runs/${id}/cancel`),
  commitRun: (id, message) => req('POST', `/api/runs/${id}/commit`, { message }),
  discardWorktree: (id) => req('DELETE', `/api/runs/${id}/worktree`),

  followUp: (id, prompt, mode) => req('POST', `/api/runs/${id}/follow-up`, { prompt, mode }),

  worktrees: () => req('GET', '/api/worktrees'),
  discardWorktreeDir: (dir, force) => req('DELETE', '/api/worktrees', { dir, force: !!force }),
  gc: (opts) => req('POST', '/api/worktrees/gc', opts),
  metrics: (days = 30) => req('GET', `/api/metrics?days=${days}`),

  tasks: () => req('GET', '/api/tasks'),
  task: (id) => req('GET', `/api/tasks/${id}`),
  createTask: (payload) => req('POST', '/api/tasks', payload),
  crossValidation: (payload) => req('POST', '/api/tasks/cross-validation', payload),
  runTask: (id) => req('POST', `/api/tasks/${id}/run`),
};

/** WebSocket with automatic reconnect — the daemon may restart during dev. */
export function connect({ onRun, onTask, onStatus }) {
  let ws;
  let closed = false;
  let retry = 0;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      retry = 0;
      onStatus?.('online');
    };
    ws.onclose = () => {
      onStatus?.('offline');
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(open, 400 * 2 ** retry);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.kind === 'run') onRun?.(msg);
      else if (msg.kind === 'task') onTask?.(msg);
    };
  };

  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
