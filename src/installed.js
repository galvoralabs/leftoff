import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './util.js';

const HELPER_NAME = /uninstall|\breadme\b|release notes|\bhelp\b|documentation|\bwebsite\b|\blicen[sc]e\b|changelog|\bmanual\b|\brepair\b|\bupdater?\b/i;
const HELPER_EXE = /(?:^|[\\/])(?:unins\w*|uninstall\w*|setup\w*|install\w*)\.exe$/i;

/** Pure: drop helper shortcuts (uninstallers, readmes), dedupe by program file, sort by name. */
export function tidyEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries || []) {
    if (!e || !e.name || !e.exe) continue;
    const name = String(e.name).replace(/\.lnk$/i, '').trim();
    if (!name || HELPER_NAME.test(name) || HELPER_EXE.test(e.exe)) continue;
    const key = process.platform === 'win32' ? e.exe.toLowerCase() : e.exe;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, exe: e.exe });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Pure: read a Linux .desktop file. Returns { name, command } or null for hidden/non-app entries. */
export function parseDesktopEntry(text) {
  const fields = {};
  let inMain = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) { inMain = line === '[Desktop Entry]'; continue; }
    if (!inMain || !line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0 && !(line.slice(0, i) in fields)) fields[line.slice(0, i)] = line.slice(i + 1);
  }
  if (fields.Type !== 'Application' || fields.NoDisplay === 'true' || fields.Hidden === 'true' || !fields.Name || !fields.Exec) return null;
  const command = fields.Exec.replace(/%[a-zA-Z%]/g, '').trim().match(/^"([^"]+)"|^(\S+)/);
  return command ? { name: fields.Name, command: command[1] || command[2] } : null;
}

async function windowsApps() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$dirs = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")',
    '$sh = New-Object -ComObject WScript.Shell',
    '$out = foreach ($d in $dirs) { Get-ChildItem -Path $d -Filter *.lnk -Recurse -File | ForEach-Object {',
    '  $t = $sh.CreateShortcut($_.FullName).TargetPath',
    "  if ($t -and $t -like '*.exe') { [pscustomobject]@{ name = $_.BaseName; exe = $t } } } }",
    '@($out) | ConvertTo-Json -Compress',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 45000 });
  if (!out || !out.trim()) return [];
  try {
    const parsed = JSON.parse(out);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((e) => e && e.exe && existsSync(e.exe));
  } catch {
    return [];
  }
}

async function macApps() {
  const out = [];
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    try {
      for (const e of await readdir(dir)) if (e.endsWith('.app')) out.push({ name: e.slice(0, -4), exe: path.join(dir, e) });
    } catch { /* folder missing */ }
  }
  return out;
}

async function linuxApps() {
  const out = [];
  for (const dir of ['/usr/share/applications', path.join(os.homedir(), '.local/share/applications')]) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const n of names.filter((x) => x.endsWith('.desktop'))) {
      try {
        const entry = parseDesktopEntry(await readFile(path.join(dir, n), 'utf8'));
        if (!entry) continue;
        const exe = path.isAbsolute(entry.command) ? entry.command : ((await run('which', [entry.command])) || '').trim();
        if (exe && existsSync(exe)) out.push({ name: entry.name, exe });
      } catch { /* unreadable entry */ }
    }
  }
  return out;
}

let cache = { at: 0, list: [] };

/** Programs installed on this computer, for the "Choose another app" picker. Cached for 5 minutes. */
export async function installedApps(force = false) {
  if (!force && Date.now() - cache.at < 300_000 && cache.list.length) return cache.list;
  const raw = process.platform === 'win32' ? await windowsApps() : process.platform === 'darwin' ? await macApps() : await linuxApps();
  cache = { at: Date.now(), list: tidyEntries(raw) };
  return cache.list;
}
