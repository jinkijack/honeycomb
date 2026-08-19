import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

/**
 * Plain JSON persistence. Runs and tasks are few (dozens per day) and fit in
 * memory comfortably; the file exists only to survive a daemon restart. If this
 * ever grows to thousands, swap in SQLite without touching the routes.
 */
class Table {
  constructor(name) {
    this.file = path.join(DATA_DIR, `${name}.json`);
    this.rows = new Map();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const row of raw) this.rows.set(row.id, row);
    } catch {
      // missing or corrupted file: start empty
    }
  }

  flush() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.rows.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }

  put(row) {
    this.rows.set(row.id, row);
    this.flush();
    return row;
  }

  patch(id, changes) {
    const row = this.rows.get(id);
    if (!row) return null;
    Object.assign(row, changes, { updatedAt: Date.now() });
    this.flush();
    return row;
  }

  get(id) {
    return this.rows.get(id) || null;
  }

  all() {
    return [...this.rows.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  remove(id) {
    const ok = this.rows.delete(id);
    if (ok) this.flush();
    return ok;
  }
}

export const runs = new Table('runs');
export const tasks = new Table('tasks');
