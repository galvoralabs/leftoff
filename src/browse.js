import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Windows drive roots that exist (C:\, D:\, ...). */
function drives() {
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) out.push(root);
  }
  return out;
}

/**
 * List a folder for the in-page picker. With no path it lists starting points
 * (home plus drives on Windows). Dot-folders are hidden. At most 400 entries.
 */
export async function browse(target, { files = false } = {}) {
  if (!target) {
    const places = [os.homedir(), ...(process.platform === 'win32' ? drives() : ['/'])];
    return { path: '', parent: null, dirs: places.map((p) => ({ name: p, path: p })), files: [] };
  }
  const dir = path.resolve(target);
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs = [];
  const fileList = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('$') || e.name === 'System Volume Information') continue;
    if (e.isDirectory()) dirs.push({ name: e.name, path: path.join(dir, e.name) });
    else if (files && e.isFile()) fileList.push({ name: e.name, path: path.join(dir, e.name) });
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const parent = path.dirname(dir) === dir ? '' : path.dirname(dir);
  return { path: dir, parent, dirs: dirs.sort(byName).slice(0, 400), files: fileList.sort(byName).slice(0, 400) };
}
