import net from 'node:net';
import path from 'node:path';
import { run } from './util.js';

const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

/** Parse `netstat -ano -p TCP` (Windows) into [{port, pid}] for LISTENING sockets. */
export function parseNetstat(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue;
    const port = Number(cols[1].slice(cols[1].lastIndexOf(':') + 1));
    const pid = Number(cols[4]);
    if (port && pid) out.push({ port, pid });
  }
  return out;
}

/** Parse `lsof -F pcn` output (macOS/Linux) into [{port, pid, name}]. */
export function parseLsof(text) {
  const out = [];
  let pid = 0;
  let name = '';
  for (const line of text.split(/\r?\n/)) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') pid = Number(val);
    else if (tag === 'c') name = val;
    else if (tag === 'n') {
      const port = Number(val.slice(val.lastIndexOf(':') + 1));
      if (pid && port) out.push({ port, pid, name });
    }
  }
  return out;
}

/** Pick the project whose folder appears in `text`. Longest path wins. */
export function matchProject(text, projectPaths) {
  const hay = text.replace(/\\/g, '/').toLowerCase();
  let best = null;
  for (const p of projectPaths) {
    const n = norm(p);
    if (hay.includes(`${n}/`) || hay.endsWith(n) || hay.includes(`${n} `) || hay.includes(`${n}"`)) {
      if (!best || n.length > norm(best).length) best = p;
    }
  }
  return best;
}

/** Default dev ports by tool, tried when a command line names no port. Vite and Astro step up when busy. */
const TOOL_PORTS = [
  [/\bvite\b/i, [5173, 5174, 5175, 5176, 5177, 5178]],
  [/\bastro\b/i, [4321, 4322, 4323]],
  [/\b(next|react-scripts|nuxt|remix|nest|express)\b/i, [3000, 3001, 3002]],
  [/webpack(-dev-server)?\b/i, [8080, 8081]],
  [/\b(http-server|serve|live-server)\b/i, [8080, 5000, 3000]],
  [/http\.server/i, [8000]],
  [/\b(flask|uvicorn|gunicorn|manage\.py)\b/i, [5000, 8000]],
];

/** Ports a dev server is likely using: explicit --port/-p flags first, then the tool's defaults. */
export function candidatePorts(commandLine) {
  const ports = new Set();
  for (const m of commandLine.matchAll(/(?:--port(?:=|\s+)|\s-p\s+|\sPORT=|--listen(?:=|\s+)(?:[\w.]*:)?)(\d{2,5})\b/gi)) {
    ports.add(Number(m[1]));
  }
  if (!ports.size) {
    for (const [re, list] of TOOL_PORTS) if (re.test(commandLine)) list.forEach((p) => ports.add(p));
  }
  return [...ports].filter((p) => p > 0 && p < 65536);
}

/** True when something accepts a TCP connection on the port (IPv4 or IPv6 loopback). */
export function probe(port, timeout = 400) {
  const tryHost = (host) => new Promise((resolve) => {
    const s = net.connect({ host, port, timeout });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
  return Promise.all([tryHost('127.0.0.1'), tryHost('::1')]).then((r) => r.some(Boolean));
}

async function windowsListeners(projectPaths) {
  const netOut = await run('netstat', ['-ano', '-p', 'TCP']);
  const listeners = netOut ? parseNetstat(netOut) : [];
  const ps = await run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
  ], { timeout: 30000 });
  if (!ps) return [];
  let procs;
  try {
    procs = JSON.parse(ps);
  } catch {
    return [];
  }
  const byPid = new Map((Array.isArray(procs) ? procs : [procs]).map((p) => [p.ProcessId, p]));
  const found = listeners.map(({ port, pid }) => {
    // Command lines of the process and a few ancestors (npm/cmd wrappers hold the path).
    const texts = [];
    let cur = byPid.get(pid);
    for (let i = 0; cur && i < 4; i++) {
      if (cur.CommandLine) texts.push(cur.CommandLine);
      cur = byPid.get(cur.ParentProcessId);
    }
    return { port, pid, name: byPid.get(pid)?.Name || '', text: texts.join(' | ') };
  });
  // netstat can miss sockets on some machines (VPN/virtual network drivers), so also probe the
  // likely ports of any process whose own command line points into a project.
  const known = new Set(found.map((f) => f.port));
  const probes = [];
  for (const p of byPid.values()) {
    const text = p.CommandLine || '';
    if (!text) continue;
    const project = matchProject(text, projectPaths);
    for (const port of candidatePorts(text)) {
      if (!known.has(port) && project) probes.push({ port, pid: p.ProcessId, name: p.Name || '', text, project });
    }
  }
  // A guessed port claimed by several different projects can't be attributed, so skip it.
  const claims = new Map();
  for (const x of probes) claims.set(x.port, (claims.get(x.port) || new Set()).add(x.project));
  const seen = new Set();
  const unique = probes.filter((x) => claims.get(x.port).size === 1 && !seen.has(x.port) && seen.add(x.port));
  const open = await Promise.all(unique.map(async (x) => ((await probe(x.port)) ? x : null)));
  return [...found, ...open.filter(Boolean)];
}

async function posixListeners() {
  const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']);
  if (!out) return [];
  const listeners = parseLsof(out);
  const result = [];
  for (const l of listeners) {
    const cwd = await run('lsof', ['-nP', '-a', '-d', 'cwd', '-p', String(l.pid), '-Fn']);
    const args = await run('ps', ['-o', 'args=', '-p', String(l.pid)]);
    const cwdPath = cwd ? cwd.split('\n').find((x) => x.startsWith('n'))?.slice(1) || '' : '';
    result.push({ ...l, text: `${cwdPath}/ ${args || ''}` });
  }
  return result;
}

/** Map project path -> [{port, pid, name}] for dev servers whose command line or cwd is inside the project. */
export async function listeningByProject(projectPaths) {
  const listeners = process.platform === 'win32' ? await windowsListeners(projectPaths) : await posixListeners();
  const map = new Map();
  for (const l of listeners) {
    const project = matchProject(l.text, projectPaths);
    if (!project) continue;
    const list = map.get(project) || [];
    if (!list.some((x) => x.port === l.port)) list.push({ port: l.port, pid: l.pid, name: l.name });
    map.set(project, list);
  }
  return map;
}
