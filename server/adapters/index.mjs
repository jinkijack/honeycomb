import { claude } from './claude.mjs';
import { kiro } from './kiro.mjs';
import { codex } from './codex.mjs';

export const adapters = { claude, kiro, codex };

export function getAdapter(name) {
  const a = adapters[name];
  if (!a) throw new Error(`unknown tool: ${name}`);
  return a;
}

/** State of every tool, for the UI status panel. */
export async function toolStatus({ cwd } = {}) {
  return Promise.all(
    Object.values(adapters).map(async (a) => {
      const available = await a.available();
      const sessions = available ? await a.listSessions({ cwd }) : [];
      return {
        name: a.name,
        displayName: a.displayName,
        available,
        stub: !!a.stub,
        capabilities: a.capabilities,
        sessions,
        sessionCount: sessions.length,
      };
    })
  );
}
