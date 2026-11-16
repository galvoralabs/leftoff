import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { run } from './util.js';

/** Parse the first `## ...` line of `git status --porcelain=v1 -b`. */
export function parseBranchLine(line) {
  const info = { branch: null, upstream: null, ahead: 0, behind: 0 };
  let m = /^## No commits yet on (.+)$/.exec(line);
  if (m) return { ...info, branch: m[1], noCommits: true };
  if (/^## HEAD \(no branch\)/.test(line)) return { ...info, branch: 'detached HEAD' };
  m = /^## (.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(line);
  if (!m) return info;
  info.branch = m[1];
  info.upstream = m[2] || null;
  for (const part of (m[3] || '').split(',')) {
    const a = /ahead (\d+)/.exec(part);
    const b = /behind (\d+)/.exec(part);
    if (a) info.ahead = Number(a[1]);
    if (b) info.behind = Number(b[1]);
  }
  return info;
}

export function parseStatus(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines.find((l) => l.startsWith('## ')) || '';
  const changed = lines.filter((l) => !l.startsWith('## ')).map((l) => l.slice(3).replace(/^"|"$/g, ''));
  return { ...parseBranchLine(head), changed };
}

const NOISE = new Set(['node_modules', 'dist', 'build', '.git', 'target', 'venv', '__pycache__']);

async function newestMtime(dir, depth = 2, budget = { left: 400 }) {
  let newest = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (budget.left-- <= 0) break;
    if (NOISE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        if (depth > 0) newest = Math.max(newest, await newestMtime(full, depth - 1, budget));
      } else {
        newest = Math.max(newest, (await stat(full)).mtimeMs);
      }
    } catch {
      /* unreadable entry */
    }
  }
  return newest;
}

async function mtimeOfChanged(dir, files) {
  let newest = 0;
  for (const f of files.slice(0, 200)) {
    try {
      newest = Math.max(newest, (await stat(path.join(dir, f))).mtimeMs);
    } catch {
      /* deleted file */
    }
  }
  return newest;
}

/** Collect state for one project folder. Never throws. */
export async function inspect(dir) {
  const base = {
    path: dir, name: path.basename(dir), isGit: false, branch: null, dirty: 0, ahead: 0, behind: 0,
    upstream: null, lastCommit: null, lastCommitAt: 0, lastTouched: 0,
  };
  if (!existsSync(path.join(dir, '.git'))) {
    return { ...base, lastTouched: await newestMtime(dir) };
  }
  const [status, log] = await Promise.all([
    run('git', ['-C', dir, 'status', '--porcelain=v1', '-b', '--untracked-files=normal']),
    run('git', ['-C', dir, 'log', '-1', '--format=%ct%x09%s']),
  ]);
  if (status === null) return { ...base, lastTouched: await newestMtime(dir) };
  const s = parseStatus(status);
  let lastCommitAt = 0;
  let lastCommit = null;
  if (log && log.trim()) {
    const [ts, ...rest] = log.trim().split('\t');
    lastCommitAt = Number(ts) * 1000;
    lastCommit = rest.join('\t');
  }
  const changedAt = await mtimeOfChanged(dir, s.changed);
  return {
    ...base,
    isGit: true,
    branch: s.branch,
    upstream: s.upstream,
    ahead: s.ahead,
    behind: s.behind,
    dirty: s.changed.length,
    lastCommit,
    lastCommitAt,
    lastTouched: Math.max(lastCommitAt, changedAt),
  };
}
