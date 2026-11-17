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

/**
 * How a branch relates to its remote (GitHub, etc.), using only what is already on this computer:
 *  - tracking:         the branch is linked to a remote branch (counts come from git status)
 *  - pushed-untracked: the branch was pushed before but is not linked; counts use the remote copy
 *  - never-pushed:     a remote exists but this branch was never sent to it
 *  - local-only:       the project has no remote at all
 *  - n/a:              detached HEAD or no commits yet
 */
export async function remoteStatus(dir, s) {
  const same = { upstream: s.upstream, ahead: s.ahead, behind: s.behind };
  if (s.noCommits || !s.branch || s.branch === 'detached HEAD') return { remoteState: 'n/a', ...same };
  if (s.upstream) return { remoteState: 'tracking', ...same };
  const remotes = ((await run('git', ['-C', dir, 'remote'])) || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!remotes.length) return { remoteState: 'local-only', upstream: null, ahead: 0, behind: 0 };
  const ordered = [...remotes.filter((r) => r === 'origin'), ...remotes.filter((r) => r !== 'origin')];
  for (const remote of ordered) {
    const ref = `refs/remotes/${remote}/${s.branch}`;
    if ((await run('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', ref])) !== null) {
      const counts = await run('git', ['-C', dir, 'rev-list', '--left-right', '--count', `${ref}...HEAD`]);
      const [behind, ahead] = (counts || '0\t0').trim().split(/\s+/).map(Number);
      return { remoteState: 'pushed-untracked', upstream: `${remote}/${s.branch}`, ahead: ahead || 0, behind: behind || 0 };
    }
  }
  return { remoteState: 'never-pushed', upstream: null, ahead: 0, behind: 0 };
}

/** Collect state for one project folder. Never throws. */
export async function inspect(dir) {
  const base = {
    path: dir, name: path.basename(dir), isGit: false, branch: null, dirty: 0, ahead: 0, behind: 0,
    upstream: null, remoteState: null, lastCommit: null, lastCommitAt: 0, lastTouched: 0,
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
  const [changedAt, remote] = await Promise.all([mtimeOfChanged(dir, s.changed), remoteStatus(dir, s)]);
  return {
    ...base,
    isGit: true,
    branch: s.branch,
    upstream: remote.upstream,
    remoteState: remote.remoteState,
    ahead: remote.ahead,
    behind: remote.behind,
    dirty: s.changed.length,
    lastCommit,
    lastCommitAt,
    lastTouched: Math.max(lastCommitAt, changedAt),
  };
}
