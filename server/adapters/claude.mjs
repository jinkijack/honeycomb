import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { BIN } from '../config.mjs';
import { SPAWN_OPTS, killTreeHard, spawnWithPrompt } from '../proc.mjs';

const exec = promisify(execFile);

/**
 * Claude Code adapter.
 *
 * The best-equipped tool of the set: it emits structured NDJSON (text, tool
 * calls, results, cost), accepts a session id we choose, resumes conversations
 * and even lists live sessions with idle/busy status. That is why it is the
 * reference adapter: Honeycomb's normalized event format was designed from what
 * it delivers, and the others are lifted up to meet it.
 */

/**
 * ro     inspects code, executes nothing
 * verify reads and executes (build, lint, tests) but does not write — the
 *        validator's mode
 * rw     edits files, no shell
 * full   full autonomy; only makes sense inside an isolated worktree
 */
const PERMISSION = {
  ro: ['--allowed-tools', 'Read', 'Grep', 'Glob', '--permission-mode', 'dontAsk'],
  verify: ['--allowed-tools', 'Read', 'Grep', 'Glob', 'Bash', '--permission-mode', 'dontAsk'],
  rw: ['--allowed-tools', 'Read', 'Grep', 'Glob', 'Edit', 'Write', '--permission-mode', 'acceptEdits'],
  full: ['--permission-mode', 'bypassPermissions'],
};

export const claude = {
  name: 'claude',
  displayName: 'Claude Code',
  capabilities: {
    structuredEvents: true,
    liveSessions: true,
    resume: true,
    controlledSessionId: true,
    cost: true,
  },

  async available() {
    try {
      await exec(BIN.claude, ['--version'], { timeout: 15000 });
      return true;
    } catch {
      return false;
    }
  },

  /** Live sessions (interactive and background), with real-time status. */
  async listSessions() {
    try {
      const { stdout } = await exec(BIN.claude, ['agents', '--json'], { timeout: 20000 });
      const raw = JSON.parse(stdout);
      return raw.map((s) => ({
        tool: 'claude',
        id: s.sessionId,
        name: s.name,
        cwd: s.cwd,
        pid: s.pid,
        kind: s.kind,
        status: s.status,
        startedAt: s.startedAt,
      }));
    } catch {
      return [];
    }
  },

  run({ prompt, cwd, sessionId, resume, mode = 'ro', model, effort, mcpServers, env, onEvent, timeoutMs }) {
    const sid = sessionId || randomUUID();
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];

    if (resume) args.push('--resume', sid);
    else args.push('--session-id', sid);

    const permission = [...(PERMISSION[mode] || PERMISSION.ro)];

    /**
     * Extra MCP servers for this run (the browser the QA stage drives, today).
     *
     * `--mcp-config` takes JSON inline, so there is no temp file to create and
     * clean up. It is additive on purpose — `--strict-mcp-config` would hide the
     * target repo's own `.mcp.json`, and the agent may legitimately need it.
     *
     * The restricted modes work from an allow-list, and an MCP tool not named in
     * it is simply never offered — so the servers have to be added there too, or
     * injecting them would be a silent no-op.
     */
    if (mcpServers && Object.keys(mcpServers).length) {
      args.push('--mcp-config', JSON.stringify({ mcpServers }));
      const at = permission.indexOf('--allowed-tools');
      if (at >= 0) {
        permission.splice(at + 1, 0, ...Object.keys(mcpServers).map((n) => `mcp__${n}`));
      }
    }

    args.push(...permission);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    // Prompt on stdin, never argv: see `spawnWithPrompt`.
    const child = spawnWithPrompt(
      BIN.claude,
      args,
      { cwd, ...SPAWN_OPTS, env: { ...process.env, ...(env || {}), FORCE_COLOR: '0' } },
      prompt,
    );

    let finalText = '';
    let cost = null;
    let turns = null;
    let buf = '';
    const stderr = [];

    const handleLine = (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        onEvent({ type: 'log', tool: 'claude', text: line });
        return;
      }

      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            onEvent({
              type: 'status',
              tool: 'claude',
              status: 'running',
              sessionId: msg.session_id || sid,
              model: msg.model,
              tools: msg.tools,
            });
          }
          break;

        // real-time text deltas (--include-partial-messages)
        case 'stream_event': {
          const ev = msg.event;
          if (ev?.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta' && ev.delta.text) {
              onEvent({ type: 'text', tool: 'claude', delta: true, text: ev.delta.text });
            } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
              onEvent({ type: 'thinking', tool: 'claude', delta: true, text: ev.delta.thinking });
            }
          }
          break;
        }

        case 'assistant': {
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_use') {
              onEvent({
                type: 'tool_use',
                tool: 'claude',
                toolName: block.name,
                toolUseId: block.id,
                input: block.input,
              });
            }
          }
          break;
        }

        case 'user': {
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_result') {
              const content = Array.isArray(block.content)
                ? block.content.map((c) => c.text || '').join('')
                : String(block.content ?? '');
              onEvent({
                type: 'tool_result',
                tool: 'claude',
                toolUseId: block.tool_use_id,
                isError: !!block.is_error,
                text: content.slice(0, 8000),
              });
            }
          }
          break;
        }

        case 'result': {
          finalText = msg.result || '';
          cost = msg.total_cost_usd ?? null;
          turns = msg.num_turns ?? null;
          onEvent({
            type: 'result',
            tool: 'claude',
            text: finalText,
            isError: !!msg.is_error,
            cost,
            turns,
            durationMs: msg.duration_ms,
            sessionId: msg.session_id || sid,
          });
          break;
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) handleLine(l);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr.push(text);
      onEvent({ type: 'log', tool: 'claude', stream: 'stderr', text });
    });

    const done = new Promise((resolve) => {
      let timer = null;
      if (timeoutMs) {
        timer = setTimeout(() => {
          onEvent({ type: 'error', tool: 'claude', text: `timeout apos ${timeoutMs}ms` });
          killTreeHard(child);
        }, timeoutMs);
      }

      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        if (buf.trim()) handleLine(buf);
        resolve({
          ok: code === 0,
          code,
          signal,
          sessionId: sid,
          output: finalText,
          cost,
          turns,
          stderr: stderr.join('').slice(-4000),
        });
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        onEvent({ type: 'error', tool: 'claude', text: err.message });
        resolve({ ok: false, code: -1, sessionId: sid, output: '', error: err.message });
      });
    });

    return { child, sessionId: sid, done };
  },
};
