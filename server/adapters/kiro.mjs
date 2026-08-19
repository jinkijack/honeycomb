import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BIN } from '../config.mjs';

const exec = promisify(execFile);

/**
 * Kiro CLI adapter.
 *
 * Unlike Claude Code, kiro exposes no structured output: under --no-interactive
 * it prints text formatted for a terminal. So here we strip ANSI and rebuild
 * events heuristically from the lines it prints while using tools. It is less
 * faithful than the Claude adapter, which is why `structuredEvents` is false:
 * the UI uses that flag to avoid promising detail this tool does not have.
 *
 * If it ever becomes worth the effort, `kiro-cli acp` (Agent Client Protocol,
 * JSON-RPC over stdio) would give real events and replace this heuristic.
 */

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

const NOISE = [
  /mcp server did not load correctly/i,
  /needs to be prepended with/i,
  /^-{3,}$/,
];

const TRUST = {
  ro: ['--trust-tools=fs_read'],
  verify: ['--trust-tools=fs_read,execute_bash'],
  rw: ['--trust-tools=fs_read,fs_write'],
  full: ['--trust-all-tools'],
};

// "Reading file: /path, from line 1 to 15 (using tool: read)"
const TOOL_USE = /\(using tool:\s*([\w.-]+)\)/i;
// " ✓ Successfully read 697 bytes from /path"  |  " ✗ Failed ..."
const TOOL_DONE = /^\s*[✓✗×]\s*(.+)$/;
// " ▸ Credits: 0.13 • Time: 2s"
const CREDITS = /Credits:\s*([\d.]+)/i;

export const kiro = {
  name: 'kiro',
  displayName: 'Kiro CLI',
  capabilities: {
    structuredEvents: false,
    liveSessions: false,
    resume: true,
    controlledSessionId: false,
    cost: true,
  },

  async available() {
    try {
      await exec(BIN.kiro, ['--version'], { timeout: 15000 });
      return true;
    } catch {
      return false;
    }
  },

  /**
   * kiro only lists saved sessions from the current directory, with no live
   * status. We return them as 'saved' so the UI can tell them apart from a
   * running session.
   */
  async listSessions({ cwd } = {}) {
    if (!cwd) return [];
    try {
      // kiro prints the listing on stderr, not stdout
      const { stdout, stderr } = await exec(BIN.kiro, ['chat', '-l'], { cwd, timeout: 20000 });
      const clean = (stdout + '\n' + stderr).replace(ANSI, '');
      const sessions = [];
      const lines = clean.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/Chat SessionId:\s*([0-9a-f-]{36})/i);
        if (!m) continue;
        const detail = (lines[i + 1] || '').split('|').map((s) => s.trim());
        sessions.push({
          tool: 'kiro',
          id: m[1],
          name: detail[1] ? detail[1].slice(0, 60) : m[1].slice(0, 8),
          cwd,
          status: 'saved',
          age: detail[0] || null,
          messages: detail[2] || null,
        });
      }
      return sessions;
    } catch {
      return [];
    }
  },

  run({ prompt, cwd, sessionId, resume, mode = 'ro', model, effort, onEvent, timeoutMs }) {
    const args = ['chat', '--no-interactive', ...(TRUST[mode] || TRUST.ro)];

    if (resume && sessionId) args.push('--resume-id', sessionId);
    else if (resume) args.push('--resume');
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    args.push(prompt);

    const child = spawn(BIN.kiro, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });

    const textParts = [];
    let cost = null;
    let buf = '';

    onEvent({ type: 'status', tool: 'kiro', status: 'running', sessionId: sessionId || null });

    /**
     * kiro splits its output across both streams in a non-obvious way: the
     * agent's answer goes to stdout, but the cost footer, the warnings and part
     * of the terminal noise go to stderr. So we classify lines from both, and
     * only treat what came from stdout as answer text.
     */
    const handleLine = (rawLine, stream) => {
      const line = rawLine.replace(ANSI, '').replace(/\r/g, '');
      if (!line.trim()) return;
      if (NOISE.some((re) => re.test(line))) return;

      const credits = line.match(CREDITS);
      if (credits) {
        cost = Number(credits[1]);
        return;
      }

      const use = line.match(TOOL_USE);
      if (use) {
        onEvent({
          type: 'tool_use',
          tool: 'kiro',
          toolName: use[1],
          input: { summary: line.replace(TOOL_USE, '').trim() },
        });
        return;
      }

      const doneMatch = line.match(TOOL_DONE);
      if (doneMatch) {
        onEvent({
          type: 'tool_result',
          tool: 'kiro',
          isError: /^\s*[✗×]/.test(line),
          text: doneMatch[1].trim(),
        });
        return;
      }

      if (/^\s*-\s*Completed in/.test(line)) return;

      if (stream === 'stderr') {
        onEvent({ type: 'log', tool: 'kiro', stream: 'stderr', text: line });
        return;
      }

      const text = line.replace(/^>\s?/, '');
      textParts.push(text);
      onEvent({ type: 'text', tool: 'kiro', delta: false, text: text + '\n' });
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) handleLine(l, 'stdout');
    });

    let errBuf = '';
    child.stderr.on('data', (chunk) => {
      errBuf += chunk.toString();
      const lines = errBuf.split('\n');
      errBuf = lines.pop();
      for (const l of lines) handleLine(l, 'stderr');
    });

    const done = new Promise((resolve) => {
      let timer = null;
      if (timeoutMs) {
        timer = setTimeout(() => {
          onEvent({ type: 'error', tool: 'kiro', text: `timeout apos ${timeoutMs}ms` });
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000);
        }, timeoutMs);
      }

      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        if (buf.trim()) handleLine(buf, 'stdout');
        if (errBuf.trim()) handleLine(errBuf, 'stderr');
        const output = textParts.join('\n').trim();
        onEvent({
          type: 'result',
          tool: 'kiro',
          text: output,
          isError: code !== 0,
          cost,
        });
        resolve({
          ok: code === 0,
          code,
          signal,
          sessionId: sessionId || null,
          output,
          cost,
        });
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        onEvent({ type: 'error', tool: 'kiro', text: err.message });
        resolve({ ok: false, code: -1, output: '', error: err.message });
      });
    });

    return { child, sessionId: sessionId || null, done };
  },
};
