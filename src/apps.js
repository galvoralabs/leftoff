import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { run } from './util.js';

const win = process.platform === 'win32';
const mac = process.platform === 'darwin';

const expand = (p) => p.replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);

/**
 * Apps Leftoff can offer. `win` are install locations to check, `mac` an /Applications name,
 * `bin` a command on PATH (Linux, and Windows executables that live on PATH).
 * `args(dir)` builds the argument list for opening a project folder.
 */
const CATALOG = [
  { id: 'vscode', name: 'VS Code', win: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe', '%ProgramFiles%\\Microsoft VS Code\\Code.exe'], mac: 'Visual Studio Code', bin: 'code' },
  { id: 'cursor', name: 'Cursor', win: ['%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe'], mac: 'Cursor', bin: 'cursor' },
  { id: 'windsurf', name: 'Windsurf', win: ['%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe'], mac: 'Windsurf', bin: 'windsurf' },
  { id: 'zed', name: 'Zed', win: ['%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe'], mac: 'Zed', bin: 'zed' },
  { id: 'sublime', name: 'Sublime Text', win: ['%ProgramFiles%\\Sublime Text\\sublime_text.exe', '%ProgramFiles%\\Sublime Text 3\\sublime_text.exe'], mac: 'Sublime Text', bin: 'subl' },
  { id: 'notepadpp', name: 'Notepad++', win: ['%ProgramFiles%\\Notepad++\\notepad++.exe', '%ProgramFiles(x86)%\\Notepad++\\notepad++.exe'] },
  { id: 'wt', name: 'Windows Terminal', winBin: 'wt.exe', args: (d) => ['-d', d] },
  { id: 'gitbash', name: 'Git Bash', win: ['%ProgramFiles%\\Git\\git-bash.exe'], args: (d) => [`--cd=${d}`] },
  { id: 'explorer', name: win ? 'File Explorer' : mac ? 'Finder' : 'File manager', always: true },
];

async function onPath(name) {
  const out = await run(win ? 'where' : 'which', [name]);
  return out ? out.split(/\r?\n/).find(Boolean) || null : null;
}

/** Work out how to launch one catalog entry on this machine, or null when it is not installed. */
async function resolve(entry) {
  if (entry.always) {
    if (win) return { cmd: 'explorer.exe', args: (d) => [d] };
    return { cmd: mac ? 'open' : 'xdg-open', args: (d) => [d] };
  }
  const args = entry.args || ((d) => [d]);
  if (win) {
    for (const candidate of entry.win || []) {
      const exe = expand(candidate);
      if (existsSync(exe)) return { cmd: exe, args };
    }
    if (entry.winBin && (await onPath(entry.winBin))) return { cmd: entry.winBin, args };
    return null;
  }
  if (mac && entry.mac && existsSync(`/Applications/${entry.mac}.app`)) {
    return { cmd: 'open', args: (d) => ['-a', entry.mac, d] };
  }
  if (entry.bin && (await onPath(entry.bin))) return { cmd: entry.bin, args };
  return null;
}

let detected = { at: 0, list: [] };

/** Apps found on this machine (cached for a minute). */
export async function detectApps(force = false) {
  if (!force && Date.now() - detected.at < 60_000) return detected.list;
  const out = [];
  for (const entry of CATALOG) {
    const launch = await resolve(entry);
    if (launch) out.push({ id: entry.id, name: entry.name, launch });
  }
  detected = { at: Date.now(), list: out };
  return out;
}

/** Public list for the UI: detected apps first, then custom ones. */
export async function listApps(settings) {
  const found = await detectApps();
  return [
    ...found.map(({ id, name }) => ({ id, name })),
    ...settings.apps.map(({ id, name }) => ({ id, name, custom: true })),
  ];
}

/** Validate a user-chosen program: must be an existing file, and on Windows an .exe (not a script). */
export function validateExe(exe) {
  if (typeof exe !== 'string' || !path.isAbsolute(exe)) return 'Choose the program file from the list.';
  let stat;
  try {
    stat = statSync(exe);
  } catch {
    return 'That file does not exist.';
  }
  if (!stat.isFile()) return 'That is not a file.';
  if (win && path.extname(exe).toLowerCase() !== '.exe') return 'Choose the program itself (an .exe file), not a script.';
  return null;
}

/** Open a project folder with the app `id`. Resolves to the app name used. */
export async function openWith(id, projectPath, settings) {
  const custom = settings.apps.find((a) => a.id === id);
  let launch;
  let name;
  if (custom) {
    if (validateExe(custom.exe)) throw new Error(`${custom.name} was moved or removed.`);
    launch = { cmd: custom.exe, args: (d) => [d] };
    name = custom.name;
  } else {
    const found = (await detectApps()).find((a) => a.id === id);
    if (!found) throw new Error('That app is not installed.');
    launch = found.launch;
    name = found.name;
  }
  await new Promise((resolve, reject) => {
    const child = spawn(launch.cmd, launch.args(projectPath), { detached: true, stdio: 'ignore', cwd: projectPath });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return name;
}

/** Pick the app to use: this project's choice, then the global default, then the first detected one. */
export async function chooseApp(settings, meta) {
  const apps = await listApps(settings);
  const ids = new Set(apps.map((a) => a.id));
  for (const id of [meta?.app, settings.defaultApp]) if (id && ids.has(id)) return id;
  return apps[0]?.id || null;
}
