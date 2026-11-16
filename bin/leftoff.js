#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { collect } from '../src/collect.js';
import { startServer } from '../src/server.js';
import { addRoot, loadRoots, removeRoot, setNote } from '../src/store.js';
import { timeAgo } from '../src/util.js';

const HELP = `leftoff - see where you left off in every project

Usage
  leftoff [dir...]            open the board in your browser (uses saved folders; asks on first run)
  leftoff list [dir...]       print the board in the terminal   (--json for JSON, --no-ports to skip the port scan)
  leftoff note <name> <text>  leave yourself a next step for a project (empty text clears it)
  leftoff add <dir>           remember a projects folder
  leftoff remove <dir>        forget a saved folder
  leftoff roots               show saved folders

Options
  --port <n>     board port (default 4747)
  --depth <n>    how deep to look for projects (default 3)
  --no-open      do not open the browser
  -h, --help
`;

function parseArgs(argv) {
  const opts = { _: [], port: 4747, depth: 3, open: true, ports: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--depth') opts.depth = Number(argv[++i]);
    else if (a === '--no-open') opts.open = false;
    else if (a === '--no-ports') opts.ports = false;
    else if (a === '--json') opts.json = true;
    else opts._.push(a);
  }
  return opts;
}

/** Folders for terminal commands: given dirs, else saved folders, else the current folder. */
async function rootsFor(dirs) {
  if (dirs.length) return dirs.map((d) => path.resolve(d));
  const saved = await loadRoots();
  return saved.length ? saved : [process.cwd()];
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

function status(p) {
  const bits = [];
  if (p.running.length) bits.push(`running ${p.running.map((r) => ':' + r.port).join(',')}`);
  if (!p.isGit) bits.push('no git');
  else {
    if (p.dirty) bits.push(`${p.dirty} uncommitted`);
    if (p.ahead) bits.push(`${p.ahead} unpushed`);
    if (p.behind) bits.push(`${p.behind} behind`);
    if (!p.upstream) bits.push('no upstream');
  }
  return bits.join(', ') || 'clean';
}

function printTable(projects) {
  const rows = projects.map((p) => [`${p.pinned ? '* ' : ''}${p.label}`, timeAgo(p.lastTouched), p.branch || '-', status(p), p.note?.next || '']);
  const head = ['PROJECT', 'TOUCHED', 'BRANCH', 'STATE', 'NEXT STEP'];
  const widths = head.map((h, i) => Math.min(38, Math.max(h.length, ...rows.map((r) => r[i].length))));
  const fmt = (r) => r.map((c, i) => (i === r.length - 1 ? c : c.slice(0, widths[i]).padEnd(widths[i]))).join('  ');
  console.log(fmt(head));
  for (const r of rows) console.log(fmt(r));
}

async function isLeftoff(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()).app === 'leftoff';
  } catch {
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = opts._;
  if (opts.help) return console.log(HELP);

  if (cmd === 'add') {
    if (!rest[0]) return console.error('Usage: leftoff add <dir>');
    return console.log((await addRoot(rest[0])).join('\n'));
  }
  if (cmd === 'remove') {
    if (!rest[0]) return console.error('Usage: leftoff remove <dir>');
    return console.log((await removeRoot(rest[0])).join('\n') || '(no saved folders)');
  }
  if (cmd === 'roots') return console.log((await loadRoots()).join('\n') || '(no saved folders)');

  if (cmd === 'note') {
    const [name, ...words] = rest;
    if (!name) return console.error('Usage: leftoff note <project-name> <text>');
    const projects = await collect(await rootsFor([]), { depth: opts.depth, ports: false });
    const q = name.toLowerCase();
    const hits = projects.filter((p) => p.name.toLowerCase() === q || p.label.toLowerCase() === q);
    const matches = hits.length ? hits : projects.filter((p) => p.label.toLowerCase().includes(q));
    if (matches.length !== 1) {
      const roots = await rootsFor([]);
      return console.error(matches.length
        ? `"${name}" matches ${matches.length} projects: ${matches.map((m) => m.label).join(', ')}`
        : `No project named "${name}" under ${roots.join(', ')}. Save your projects folder once with: leftoff add <folder>`);
    }
    const saved = await setNote(matches[0].path, words.join(' '));
    return console.log(saved ? `${matches[0].label}: ${saved.next}` : `${matches[0].label}: note cleared`);
  }

  if (cmd === 'list') {
    const projects = await collect(await rootsFor(rest), { depth: opts.depth, ports: opts.ports });
    const visible = projects.filter((p) => !p.hidden);
    return opts.json ? console.log(JSON.stringify(visible, null, 2)) : printTable(visible);
  }

  const dirs = cmd ? [cmd, ...rest] : [];
  let handle;
  try {
    handle = await startServer({ extraRoots: dirs, port: opts.port, depth: opts.depth });
  } catch (err) {
    if (err.code === 'EADDRINUSE' && (await isLeftoff(opts.port))) {
      const url = `http://127.0.0.1:${opts.port}/`;
      console.log(`Leftoff is already running. Opening ${url}`);
      if (opts.open) openBrowser(url);
      return;
    }
    console.error(err.code === 'EADDRINUSE' ? `Port ${opts.port} is used by another program. Try: leftoff --port ${opts.port + 1}` : err.message);
    process.exit(1);
  }
  const url = `http://127.0.0.1:${handle.port}/`;
  console.log(`Leftoff is running: ${url}\nKeep this window open while you use it. Press Ctrl+C to stop.`);
  if (opts.open) openBrowser(url);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
