import path from 'node:path';
import { inspect } from './git.js';
import { listeningByProject } from './ports.js';
import { findAll } from './scan.js';
import { loadMeta, loadNotes, projectKey } from './store.js';
import { pool } from './util.js';

/** Scan roots and return one enriched record per project, pinned first, then most recently touched. */
export async function collect(roots, { depth = 3, ports = true } = {}) {
  const paths = await findAll(roots, depth);
  const [states, notes, meta, listening] = await Promise.all([
    pool(paths, 8, inspect),
    loadNotes(),
    loadMeta(),
    ports ? listeningByProject(paths).catch(() => new Map()) : new Map(),
  ]);
  const counts = new Map();
  for (const s of states) counts.set(s.name.toLowerCase(), (counts.get(s.name.toLowerCase()) || 0) + 1);
  const projects = states.map((s) => {
    const m = meta[projectKey(s.path)] || {};
    return {
      ...s,
      label: labelFor(s, counts),
      note: notes[projectKey(s.path)] || null,
      pinned: !!m.pinned,
      hidden: !!m.hidden,
      app: m.app || null,
      running: listening.get(s.path) || [],
    };
  });
  return projects.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastTouched - a.lastTouched);
}

const GENERIC = new Set(['app', 'web', 'site', 'mobile', 'client', 'server', 'frontend', 'backend', 'api', 'ui', 'docs']);

/** Folder name, prefixed with its parent when the name is generic or appears more than once. */
function labelFor(state, counts) {
  const lower = state.name.toLowerCase();
  if (counts.get(lower) > 1 || GENERIC.has(lower)) {
    return `${path.basename(path.dirname(state.path))}/${state.name}`;
  }
  return state.name;
}
