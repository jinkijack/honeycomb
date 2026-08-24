import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.mjs';

/**
 * Normalized event bus.
 *
 * Every adapter, whatever the tool, emits events with the same shape. That is
 * what lets the UI render kiro, claude, codex and cursor with the same components, and
 * lets the orchestrator treat them all as one abstraction.
 *
 * type:
 *   status      run state change (running, done, failed, cancelled)
 *   text        assistant text (delta or complete block)
 *   thinking    reasoning, when the tool exposes it
 *   tool_use    the agent called a tool
 *   tool_result the tool's return value
 *   result      consolidated final result (+ cost, turns)
 *   error       failure
 *   log         raw noise, useful for debugging
 */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

const seqByRun = new Map();
const streams = new Map();

function logStream(runId) {
  if (!streams.has(runId)) {
    const file = path.join(LOG_DIR, `${runId}.ndjson`);
    streams.set(runId, fs.createWriteStream(file, { flags: 'a' }));
  }
  return streams.get(runId);
}

export function emit(runId, event) {
  const seq = (seqByRun.get(runId) || 0) + 1;
  seqByRun.set(runId, seq);

  const full = { runId, seq, ts: Date.now(), ...event };

  try {
    logStream(runId).write(JSON.stringify(full) + '\n');
  } catch {
    // losing a log line must never take down the execution
  }

  bus.emit('event', full);
  bus.emit(`run:${runId}`, full);
  return full;
}

export function closeRunLog(runId) {
  const s = streams.get(runId);
  if (s) {
    s.end();
    streams.delete(runId);
  }
  seqByRun.delete(runId);
}

export function readRunLog(runId, { fromSeq = 0 } = {}) {
  const file = path.join(LOG_DIR, `${runId}.ndjson`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.seq > fromSeq);
}
