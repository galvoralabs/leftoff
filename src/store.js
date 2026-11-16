import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function homeDir() {
  return process.env.LEFTOFF_HOME || path.join(os.homedir(), '.leftoff');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

/** Stable key for a project path (case-insensitive on Windows). */
export const projectKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

const file = (name) => path.join(homeDir(), name);

let chain = Promise.resolve();
/** Run read-modify-write operations one at a time so rapid clicks cannot overwrite each other. */
function serial(fn) {
  const result = chain.then(fn);
  chain = result.catch(() => {});
  return result;
}


/* ---------- next-step notes ---------- */

export const loadNotes = () => readJson(file('notes.json'), {});

/** Save (or clear, when text is empty) the "next step" note for a project. */
export function setNote(p, text) {
  return serial(async () => {
    const notes = await readJson(file('notes.json'), {});
    const clean = String(text || '').trim().slice(0, 500);
    if (clean) notes[projectKey(p)] = { next: clean, updatedAt: Date.now() };
    else delete notes[projectKey(p)];
    await writeJson(file('notes.json'), notes);
    return notes[projectKey(p)] || null;
  });
}

/* ---------- pins, hidden projects, per-project app ---------- */

export const loadMeta = () => readJson(file('meta.json'), {});

/** patch: { pinned?: boolean, hidden?: boolean, app?: string|null }. Falsy values clear the field. */
export function setMeta(p, patch) {
  return serial(async () => {
    const meta = await readJson(file('meta.json'), {});
    const cur = { ...(meta[projectKey(p)] || {}) };
    if ('pinned' in patch) cur.pinned = patch.pinned ? true : undefined;
    if ('hidden' in patch) cur.hidden = patch.hidden ? true : undefined;
    if ('app' in patch) cur.app = patch.app ? String(patch.app).slice(0, 80) : undefined;
    for (const k of Object.keys(cur)) if (cur[k] === undefined) delete cur[k];
    if (Object.keys(cur).length) meta[projectKey(p)] = cur;
    else delete meta[projectKey(p)];
    await writeJson(file('meta.json'), meta);
    return meta[projectKey(p)] || {};
  });
}

/* ---------- settings: folders, custom apps, default app, reminder ---------- */

const DEFAULTS = { roots: [], apps: [], defaultApp: null, reminder: { enabled: true, hour: 18 } };

export async function loadSettings() {
  const raw = await readJson(file('config.json'), {});
  return {
    roots: Array.isArray(raw.roots) ? raw.roots : [],
    apps: Array.isArray(raw.apps) ? raw.apps : [],
    defaultApp: typeof raw.defaultApp === 'string' ? raw.defaultApp : null,
    reminder: { ...DEFAULTS.reminder, ...(raw.reminder || {}) },
  };
}

async function saveSettings(next) {
  await writeJson(file('config.json'), next);
  return next;
}

export function addRoot(dir) {
  return serial(async () => {
    const s = await loadSettings();
    const full = path.resolve(dir);
    if (!s.roots.some((r) => projectKey(r) === projectKey(full))) s.roots.push(full);
    return (await saveSettings(s)).roots;
  });
}

export function removeRoot(dir) {
  return serial(async () => {
    const s = await loadSettings();
    s.roots = s.roots.filter((r) => projectKey(r) !== projectKey(dir));
    return (await saveSettings(s)).roots;
  });
}

export async function loadRoots() {
  return (await loadSettings()).roots;
}

export function updateSettings(patch) {
  return serial(async () => {
    const s = await loadSettings();
    if ('defaultApp' in patch) s.defaultApp = patch.defaultApp ? String(patch.defaultApp).slice(0, 80) : null;
    if (patch.reminder) {
      const hour = Number(patch.reminder.hour);
      s.reminder = {
        enabled: patch.reminder.enabled !== false,
        hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : s.reminder.hour,
      };
    }
    return saveSettings(s);
  });
}

export function addCustomApp(name, exe) {
  return serial(async () => {
    const s = await loadSettings();
    if (s.apps.length >= 20) throw new Error('Too many custom apps');
    const app = { id: `custom-${randomBytes(4).toString('hex')}`, name: String(name).trim().slice(0, 40) || path.basename(exe), exe };
    s.apps.push(app);
    await saveSettings(s);
    return app;
  });
}

export function removeCustomApp(id) {
  return serial(async () => {
    const s = await loadSettings();
    s.apps = s.apps.filter((a) => a.id !== id);
    if (s.defaultApp === id) s.defaultApp = null;
    await saveSettings(s);
    return s.apps;
  });
}
