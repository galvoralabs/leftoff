import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homeDir } from './store.js';

const URL = 'https://registry.npmjs.org/@galvora-labs%2fleftoff/latest';
const DAY = 24 * 60 * 60 * 1000;

const parts = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);

/** True when version `a` is newer than `b` (plain x.y.z comparison). */
export function isNewer(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

/**
 * Ask the npm registry for the newest published version, at most once a day.
 * Only a GET for public package info; nothing about you or your projects is sent.
 * Returns the newer version string, or null. Never throws.
 * Turn it off with LEFTOFF_NO_UPDATE_CHECK=1.
 */
export async function newerVersion(current) {
  if (process.env.LEFTOFF_NO_UPDATE_CHECK) return null;
  const file = path.join(homeDir(), 'update.json');
  let latest = null;
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.checkedAt && Date.now() - saved.checkedAt < DAY) latest = saved.latest;
  } catch { /* no cache yet */ }
  if (!latest) {
    try {
      const res = await fetch(URL, { signal: AbortSignal.timeout(4000) });
      latest = (await res.json()).version || null;
      await mkdir(homeDir(), { recursive: true });
      await writeFile(file, JSON.stringify({ checkedAt: Date.now(), latest }));
    } catch {
      return null;
    }
  }
  return latest && isNewer(latest, current) ? latest : null;
}
