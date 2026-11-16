import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pool, run, timeAgo } from './util.js';

/** Edits closer together than this belong to the same working session. */
export const SESSION_GAP_MS = 2 * 60 * 60 * 1000;
const MAX_FILES = 6000;
const NOISE = new Set(['node_modules', 'dist', 'build', '.git', 'target', 'venv', '.venv', '__pycache__', '.next', 'coverage']);

async function walk(dir, depth = 4, budget = { left: MAX_FILES }, base = dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (budget.left <= 0) break;
    if (NOISE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) await walk(full, depth - 1, budget, base, out);
    } else if (e.isFile()) {
      budget.left--;
      out.push(path.relative(base, full));
    }
  }
  return out;
}

/** Pure: split files (newest first) into the latest cluster of edits. */
export function latestCluster(filesNewestFirst, gap = SESSION_GAP_MS) {
  if (!filesNewestFirst.length) return [];
  const cluster = [filesNewestFirst[0]];
  for (let i = 1; i < filesNewestFirst.length; i++) {
    if (filesNewestFirst[i - 1].mtime - filesNewestFirst[i].mtime > gap) break;
    cluster.push(filesNewestFirst[i]);
  }
  return cluster;
}

function describeDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 10) return 'a short burst';
  if (min < 90) return `about ${min} minutes`;
  return `about ${Math.round(min / 60)} hours`;
}

/** Pure: plain-language summary of a session. */
export function summarize({ files, commits, start, end, now = Date.now() }) {
  if (!files.length) return 'No files found in this project yet.';
  const folders = new Map();
  for (const f of files) {
    const parts = f.path.split(/[\\/]/);
    const key = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '(project root)';
    folders.set(key, (folders.get(key) || 0) + 1);
  }
  const top = [...folders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} (${n})`);
  const noun = files.length === 1 ? 'file' : 'files';
  let text = `Last worked ${timeAgo(end, now)}, ${describeDuration(end - start)}. Touched ${files.length} ${noun}`;
  if (top.length) text += `, mostly in ${top.join(', ')}`;
  text += '.';
  if (commits[0]) text += ` Last commit: "${commits[0].subject}".`;
  return text;
}

/** Everything the "Last session" panel shows for one project. Never throws. */
export async function lastSession(dir, now = Date.now()) {
  const isGit = existsSync(path.join(dir, '.git'));
  let names = [];
  const status = new Map();
  let commits = [];
  if (isGit) {
    const [list, st, log] = await Promise.all([
      run('git', ['-C', dir, '-c', 'core.quotepath=off', 'ls-files', '-co', '--exclude-standard', '-z']),
      run('git', ['-C', dir, '-c', 'core.quotepath=off', 'status', '--porcelain=v1', '--untracked-files=all']),
      run('git', ['-C', dir, 'log', '-8', '--format=%ct%x09%s']),
    ]);
    names = (list || '').split('\0').filter(Boolean).slice(0, MAX_FILES);
    for (const line of (st || '').split(/\r?\n/).filter(Boolean)) {
      status.set(line.slice(3).replace(/^"|"$/g, ''), line.slice(0, 2).trim() === '??' ? 'new' : 'changed');
    }
    commits = (log || '').split(/\r?\n/).filter(Boolean).map((l) => {
      const [ts, ...rest] = l.split('\t');
      return { at: Number(ts) * 1000, subject: rest.join('\t') };
    });
  } else {
    names = await walk(dir);
  }
  const stats = await pool(names, 32, async (name) => {
    try {
      return { path: name.replace(/\\/g, '/'), mtime: (await stat(path.join(dir, name))).mtimeMs };
    } catch {
      return null;
    }
  });
  const files = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  const cluster = latestCluster(files);
  const start = cluster.length ? cluster[cluster.length - 1].mtime : 0;
  const end = cluster.length ? cluster[0].mtime : 0;
  const shown = cluster.slice(0, 15).map((f) => ({ ...f, state: status.get(f.path) || null }));
  return {
    isGit,
    start,
    end,
    fileCount: cluster.length,
    files: shown,
    commits: commits.slice(0, 5),
    summary: summarize({ files: cluster, commits, start, end, now }),
  };
}
