import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BIN } from '../config.mjs';

const exec = promisify(execFile);

/**
 * Cursor CLI (`cursor-agent`) adapter.
 *
 * Second only to Claude Code in how much it hands over: `-p --output-format
 * stream-json` emits real JSONL, so there are no heuristics over terminal text
 * here either. The vocabulary:
 *
 *   system/init         start, carries session_id, model and permission mode
 *   user                the prompt echoed back
 *   thinking            reasoning, in deltas plus a `completed` marker
 *   assistant           a block of answer text
 *   tool_call           subtype started | completed, one payload key per tool
 *   result              end, with the concatenated text and token usage
 *
 * Two differences from Claude Code shape the code below.
 *
 * First, usage comes in TOKENS, not money — same call as Codex: converting would
 * need a price table per model that would silently go stale, so `cost` stays
 * null and the tokens travel honestly labelled.
 *
 * Second, a tool call arrives as an object with a single key naming the tool
 * (`readToolCall`, `shellToolCall`, `editToolCall`, …) and there are around
 * forty of them. Enumerating that list would leave us behind every release, so
 * the key itself is the tool name and the args are summarised generically.
 */

const CURSOR_DIR = process.env.CURSOR_DATA_DIR || path.join(os.homedir(), '.cursor');

/**
 * Mode-to-flag mapping.
 *
 * Cursor separates two axes that the other tools bundle into one: `--mode ask`
 * decides whether it may WRITE, `--force` decides whether it may RUN commands.
 * Crossing them lands exactly on Honeycomb's four modes — including `verify`,
 * which no other adapter gets this cleanly.
 *
 * `--mode plan` is deliberately unused: it does not restrict a working agent, it
 * turns it into a planner that answers with a plan and executes nothing. That is
 * the wrong shape for `verify`, whose whole job is to run the build and the
 * tests before issuing a verdict.
 *
 * Denial is silent from the model's side: a blocked shell call comes back
 * `rejected` and the agent usually retries once before giving up, which costs a
 * couple of turns. Worth knowing when reading a `ro` transcript.
 */
const MODE = {
  ro: ['--mode', 'ask'],
  verify: ['--mode', 'ask', '--force'],
  rw: [],
  full: ['--force'],
};

/**
 * Trust is per directory and it is asked interactively.
 *
 * Every run gets a brand new worktree, so every run starts in a directory Cursor
 * has never seen. Without `--trust` it refuses the whole run with a prompt no
 * one can answer under `-p`, printed as plain text rather than JSON — the run
 * would fail before the first token. The isolation we rely on is the worktree,
 * not Cursor's trust dialog.
 */
const TRUST = '--trust';

/** Cosmetic: the tool names the UI already knows from the other adapters. */
const TOOL_LABEL = {
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  delete: 'Delete',
  shell: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  ls: 'LS',
  semSearch: 'Search',
  webSearch: 'WebSearch',
  webFetch: 'WebFetch',
  fetch: 'Fetch',
  readLints: 'Lints',
  createPlan: 'Plan',
  updateTodos: 'Todo',
  readTodos: 'Todo',
  mcp: 'MCP',
  task: 'Task',
};

/**
 * The arg keys worth showing, renamed to the vocabulary the surfaces already
 * read.
 *
 * The rest of a Cursor tool payload is parser bookkeeping — a `shellToolCall`
 * carries the parsed command tree, the redirect list and the timeout policy
 * alongside the command itself. The CLI and the transcript both preview a tool
 * call by looking for `command`, `file_path`, `pattern`, `description` or
 * `summary`, in that order; sending Cursor's own `path` through untranslated
 * would render every file read as the literal word "path".
 */
const ARG_MAP = [
  ['command', 'command'],
  ['path', 'file_path'],
  ['pattern', 'pattern'],
  ['globPattern', 'pattern'],
  ['query', 'summary'],
  ['url', 'summary'],
  ['description', 'description'],
];

function summarizeArgs(args = {}) {
  const out = {};
  for (const [from, to] of ARG_MAP) {
    if (out[to] === undefined && args[from] !== undefined && args[from] !== '') {
      out[to] = args[from];
    }
  }
  // nothing recognisable: show the shape rather than nothing at all
  if (!Object.keys(out).length) {
    const keys = Object.keys(args).filter((k) => k !== 'toolCallId' && k !== 'conversationId');
    if (keys.length) out.summary = keys.slice(0, 6).join(', ');
  }
  return out;
}

/**
 * Turns a completed tool result into text.
 *
 * The result is a one-of. `rejected` means the mode blocked the call, and it is
 * spelled out because the agent's own narration about it is unreliable — it
 * tends to report the command's expected output as if it had run. `failure`
 * carries the same fields as `success`, so a shell command that exits non-zero
 * arrives there rather than as a success with a code.
 */
function summarizeResult(name, result, mode) {
  if (!result || typeof result !== 'object') return { isError: false, text: '' };

  if (result.rejected) {
    return {
      isError: true,
      text: `recusado pelo modo ${mode}: ${result.rejected.command || name}`,
    };
  }

  const payload = result.success ?? result.failure;
  if (!payload) {
    // a variant we have no name for; the shape itself is the useful part
    return { isError: true, text: JSON.stringify(result).slice(0, 4000) };
  }
  if (typeof payload !== 'object') return { isError: !result.success, text: String(payload) };

  const failed = !result.success || (typeof payload.exitCode === 'number' && payload.exitCode !== 0);

  /**
   * One field per family of tool: shell writes output, read writes content, edit
   * writes a message and a diff, glob writes a list. Each is tried in turn and
   * the first non-empty one wins — an empty string is a real answer here (a
   * command that printed nothing), so it must not stop the search.
   */
  const candidates = [
    payload.interleavedOutput,
    [payload.stdout, payload.stderr].filter(Boolean).join(''),
    payload.content,
    payload.message,
    Array.isArray(payload.files) ? payload.files.join('\n') : null,
    payload.diffString,
  ];
  const text = candidates.find((c) => typeof c === 'string' && c !== '');

  return { isError: failed, text: (text ?? JSON.stringify(payload)).slice(0, 8000) };
}

export const cursor = {
  name: 'cursor',
  displayName: 'Cursor CLI',
  capabilities: {
    structuredEvents: true,
    liveSessions: false,
    resume: true,
    // the chat id is minted by Cursor at init; we capture it to resume, but the
    // only way to impose one up front is a separate `create-chat` call
    controlledSessionId: false,
    cost: false,
    tokens: true,
  },

  async available() {
    try {
      await exec(BIN.cursor, ['--version'], { timeout: 15000 });
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Chats recorded on disk.
   *
   * `cursor-agent ls` is an interactive picker — it never returns under a pipe —
   * so the listing is read from `~/.cursor/chats/<project>/<chatId>/meta.json`,
   * the same trade-off the Codex adapter makes. Chats with no conversation are
   * skipped: they are the empty shells a cancelled start leaves behind.
   */
  async listSessions({ cwd, limit = 40 } = {}) {
    const root = path.join(CURSOR_DIR, 'chats');
    if (!fs.existsSync(root)) return [];

    const found = [];
    let projects;
    try {
      projects = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const project of projects) {
      if (!project.isDirectory()) continue;
      let chats;
      try {
        chats = fs.readdirSync(path.join(root, project.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const chat of chats) {
        if (!chat.isDirectory()) continue;
        let meta;
        try {
          meta = JSON.parse(
            fs.readFileSync(path.join(root, project.name, chat.name, 'meta.json'), 'utf8')
          );
        } catch {
          continue;
        }
        if (!meta.hasConversation) continue;
        if (cwd && meta.cwd && meta.cwd !== cwd) continue;

        found.push({
          tool: 'cursor',
          id: chat.name,
          name: meta.cwd ? path.basename(meta.cwd) : chat.name.slice(0, 8),
          cwd: meta.cwd || null,
          status: 'saved',
          startedAt: meta.createdAtMs || null,
          updatedAt: meta.updatedAtMs || null,
        });
      }
    }

    found.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return found.slice(0, limit);
  },

  run({ prompt, cwd, sessionId, resume, mode = 'ro', model, mcpServers, env, onEvent, timeoutMs }) {
    const args = ['-p', '--output-format', 'stream-json', TRUST, ...(MODE[mode] || MODE.ro)];

    if (resume && sessionId) args.push('--resume', sessionId);
    if (model) args.push('--model', model);
    args.push(prompt);

    /**
     * Cursor reads MCP from `.cursor/mcp.json` in the workspace or in
     * `~/.cursor` — there is no command-line equivalent of Claude's
     * `--mcp-config`. Writing the file into the worktree would work, and would
     * also show up in the diff as a change the agent never made, so we say it
     * out loud instead: the QA stage may be counting on a browser that will not
     * be there, and silence reads as the agent choosing not to use it.
     */
    if (mcpServers && Object.keys(mcpServers).length) {
      onEvent({
        type: 'log',
        tool: 'cursor',
        text:
          `cursor nao aceita configuracao de MCP por linha de comando; ` +
          `${Object.keys(mcpServers).join(', ')} nao foi injetado — use o CLI equivalente se houver`,
      });
    }

    const child = spawn(BIN.cursor, args, {
      cwd,
      // stdin closed: with it open cursor-agent waits for extra input
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(env || {}), NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    let sid = (resume && sessionId) || null;
    const textParts = [];
    let resultText = '';
    let usage = null;
    let isError = false;
    let buf = '';
    const stderr = [];

    const handleLine = (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        /**
         * Plain text on stdout means cursor bailed before the stream started —
         * the workspace-trust refusal is printed exactly like this. It goes into
         * the stderr buffer as well as the log: that buffer is what the runner
         * greps for the transient-failure patterns, and a rate limit reported
         * this way would otherwise never be retried.
         */
        stderr.push(line + '\n');
        onEvent({ type: 'log', tool: 'cursor', text: line });
        return;
      }

      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            sid = msg.session_id || sid;
            onEvent({
              type: 'status',
              tool: 'cursor',
              status: 'running',
              sessionId: sid,
              model: msg.model,
            });
          }
          break;

        case 'thinking':
          if (msg.subtype === 'delta' && msg.text) {
            onEvent({ type: 'thinking', tool: 'cursor', delta: true, text: msg.text });
          }
          break;

        case 'assistant': {
          /**
           * Text arrives as whole blocks, one per model call, already in order —
           * so there is no partial-message flag to turn on here. Every block is
           * distinct: the final one is the answer, the earlier ones are the
           * narration between tool calls, and `result.result` is just all of
           * them glued together with no separator.
           */
          for (const block of msg.message?.content || []) {
            if (block.type === 'text' && block.text) {
              textParts.push(block.text);
              onEvent({ type: 'text', tool: 'cursor', delta: false, text: block.text + '\n' });
            }
          }
          break;
        }

        case 'tool_call': {
          const payload = msg.tool_call || {};
          const key = Object.keys(payload).find((k) => k.endsWith('ToolCall'));
          if (!key) break;

          const name = key.slice(0, -'ToolCall'.length);
          const call = payload[key] || {};
          // the call id carries an embedded newline; strip whitespace so the
          // same string matches on both sides of the pair
          const toolUseId = String(msg.call_id || '').replace(/\s+/g, '');

          if (msg.subtype === 'started') {
            onEvent({
              type: 'tool_use',
              tool: 'cursor',
              toolName: TOOL_LABEL[name] || name,
              toolUseId,
              input: summarizeArgs(call.args),
            });
          } else {
            const { isError: failed, text } = summarizeResult(name, call.result, mode);
            onEvent({ type: 'tool_result', tool: 'cursor', toolUseId, isError: failed, text });
          }
          break;
        }

        case 'result':
          resultText = msg.result || '';
          usage = msg.usage || null;
          isError = !!msg.is_error;
          sid = msg.session_id || sid;
          break;
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
      onEvent({ type: 'log', tool: 'cursor', stream: 'stderr', text });
    });

    const done = new Promise((resolve) => {
      let timer = null;
      if (timeoutMs) {
        timer = setTimeout(() => {
          onEvent({ type: 'error', tool: 'cursor', text: `timeout apos ${timeoutMs}ms` });
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000);
        }, timeoutMs);
      }

      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        if (buf.trim()) handleLine(buf);

        // the blocks joined beat `result.result`, which concatenates them with
        // no separator and runs the narration into the answer
        const output = textParts.join('\n\n').trim() || resultText;
        const totalTokens = usage
          ? (usage.inputTokens || 0) + (usage.outputTokens || 0)
          : null;

        onEvent({
          type: 'result',
          tool: 'cursor',
          text: output,
          isError: isError || code !== 0,
          cost: null,
          tokens: totalTokens,
          usage,
          sessionId: sid,
        });

        resolve({
          ok: code === 0 && !isError,
          code,
          signal,
          sessionId: sid,
          output,
          cost: null,
          tokens: totalTokens,
          usage,
          stderr: stderr.join('').slice(-4000),
        });
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        onEvent({ type: 'error', tool: 'cursor', text: err.message });
        resolve({ ok: false, code: -1, sessionId: sid, output: '', error: err.message });
      });
    });

    return { child, sessionId: sid, done };
  },
};
