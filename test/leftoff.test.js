import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateExe } from '../src/apps.js';
import { browse } from '../src/browse.js';
import { collect } from '../src/collect.js';
import { inspect, parseBranchLine, parseStatus } from '../src/git.js';
import { parseDesktopEntry, tidyEntries } from '../src/installed.js';
import { candidatePorts, matchProject, parseLsof, parseNetstat, probe } from '../src/ports.js';
import { findProjects } from '../src/scan.js';
import { latestCluster, lastSession, summarize } from '../src/session.js';
import { startServer } from '../src/server.js';
import {
  addCustomApp, addRoot, loadMeta, loadRoots, loadSettings, removeCustomApp, removeRoot, setMeta, setNote, updateSettings,
} from '../src/store.js';
import { timeAgo } from '../src/util.js';

async function tmp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leftoff-'));
  process.env.LEFTOFF_HOME = path.join(dir, '.home');
  return dir;
}
const cleanup = (dir) => rm(dir, { recursive: true, force: true });

function gitRepo(dir) {
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  git('init', '-q', '-b', 'main');
  return git;
}

/* ---------- git / scan / ports ---------- */

test('parseBranchLine handles tracking, ahead/behind, detached and fresh repos', () => {
  assert.deepEqual(parseBranchLine('## main...origin/main [ahead 2, behind 1]'), { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
  assert.equal(parseBranchLine('## main...origin/main').ahead, 0);
  assert.equal(parseBranchLine('## feature/x').upstream, null);
  assert.equal(parseBranchLine('## HEAD (no branch)').branch, 'detached HEAD');
  assert.equal(parseBranchLine('## No commits yet on main').noCommits, true);
});

test('parseStatus lists changed files', () => {
  const s = parseStatus('## main...origin/main [ahead 1]\n M src/a.js\n?? new.txt\n');
  assert.equal(s.ahead, 1);
  assert.deepEqual(s.changed, ['src/a.js', 'new.txt']);
});

test('parseNetstat and parseLsof read listening sockets', () => {
  const net = '  TCP    127.0.0.1:5173   0.0.0.0:0   LISTENING   4242\n  TCP    [::1]:3000   [::]:0   LISTENING   99\n  TCP    10.0.0.2:51000   1.1.1.1:443   ESTABLISHED   7\n';
  assert.deepEqual(parseNetstat(net), [{ port: 5173, pid: 4242 }, { port: 3000, pid: 99 }]);
  assert.deepEqual(parseLsof('p100\ncnode\nn*:3000\np200\ncpython\nn127.0.0.1:8000\n'), [
    { port: 3000, pid: 100, name: 'node' },
    { port: 8000, pid: 200, name: 'python' },
  ]);
});

test('candidatePorts prefers explicit flags, falls back to tool defaults', () => {
  assert.deepEqual(candidatePorts('node vite.js --port 5188 --host 127.0.0.1'), [5188]);
  assert.deepEqual(candidatePorts('node x.js --port=4000'), [4000]);
  assert.deepEqual(candidatePorts('python -m http.server 9000'), [8000]);
  assert.ok(candidatePorts('node D:/p/node_modules/vite/bin/vite.js').includes(5173));
  assert.deepEqual(candidatePorts('node build-script.js'), []);
});

test('probe sees an open local port and a closed one', async () => {
  const srv = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  assert.equal(await probe(port), true);
  srv.close();
  await new Promise((r) => srv.once('close', r));
  assert.equal(await probe(port), false);
});

test('matchProject prefers the longest matching folder', () => {
  const projects = [path.resolve('/work/app'), path.resolve('/work/app-two')];
  assert.equal(matchProject(`node ${path.resolve('/work/app-two')}/node_modules/vite/bin/vite.js`, projects), projects[1]);
  assert.equal(matchProject('node unrelated.js', projects), null);
});

test('findProjects detects markers, skips node_modules, does not descend into projects', async () => {
  const root = await tmp();
  try {
    await mkdir(path.join(root, 'group', 'a', 'packages', 'inner'), { recursive: true });
    await mkdir(path.join(root, 'group', 'b', 'node_modules', 'dep'), { recursive: true });
    await mkdir(path.join(root, 'empty'), { recursive: true });
    await writeFile(path.join(root, 'group', 'a', 'package.json'), '{}');
    await writeFile(path.join(root, 'group', 'a', 'packages', 'inner', 'package.json'), '{}');
    await writeFile(path.join(root, 'group', 'b', 'go.mod'), 'module b');
    await writeFile(path.join(root, 'group', 'b', 'node_modules', 'dep', 'package.json'), '{}');
    const found = (await findProjects(root)).map((p) => path.relative(root, p).replace(/\\/g, '/')).sort();
    assert.deepEqual(found, ['group/a', 'group/b']);
  } finally {
    await cleanup(root);
  }
});

/* ---------- storage ---------- */

test('notes, folders, pins and reminder settings persist and clear', async () => {
  const root = await tmp();
  try {
    const project = path.join(root, 'p');
    assert.equal((await setNote(project, '  fix login  ')).next, 'fix login');
    assert.equal(await setNote(project, ''), null);

    assert.deepEqual(await addRoot(root), [path.resolve(root)]);
    assert.deepEqual(await addRoot(root), [path.resolve(root)], 'adding twice keeps one entry');
    assert.deepEqual(await loadRoots(), [path.resolve(root)]);
    assert.deepEqual(await removeRoot(root), []);

    assert.deepEqual(await setMeta(project, { pinned: true, app: 'vscode' }), { pinned: true, app: 'vscode' });
    assert.deepEqual(await setMeta(project, { pinned: false }), { app: 'vscode' });
    assert.deepEqual(await setMeta(project, { app: null }), {});
    assert.deepEqual(await loadMeta(), {});

    const s = await updateSettings({ reminder: { enabled: false, hour: 99 } });
    assert.equal(s.reminder.enabled, false);
    assert.equal(s.reminder.hour, 18, 'out-of-range hour keeps the old value');
    assert.equal((await updateSettings({ reminder: { enabled: true, hour: 7 } })).reminder.hour, 7);
    assert.equal((await updateSettings({ defaultApp: 'zed' })).defaultApp, 'zed');

    const app = await addCustomApp('My Editor', path.join(root, 'ed.exe'));
    assert.equal((await loadSettings()).apps.length, 1);
    await updateSettings({ defaultApp: app.id });
    await removeCustomApp(app.id);
    const after = await loadSettings();
    assert.equal(after.apps.length, 0);
    assert.equal(after.defaultApp, null, 'removing the default app clears it');
  } finally {
    await cleanup(root);
  }
});

test('rapid overlapping writes never lose an update', async () => {
  const root = await tmp();
  try {
    const projects = Array.from({ length: 25 }, (_, i) => path.join(root, `p${i}`));
    await Promise.all(projects.flatMap((p) => [setMeta(p, { pinned: true }), setNote(p, 'n')]));
    const meta = await loadMeta();
    assert.equal(Object.keys(meta).length, 25);
    // pin then unpin quickly on one project: last write wins, nothing else disturbed
    await Promise.all([setMeta(projects[0], { hidden: true }), setMeta(projects[0], { hidden: false })]);
    assert.equal(Object.keys(await loadMeta()).length, 25);
  } finally {
    await cleanup(root);
  }
});

/* ---------- collect ---------- */

test('collect reports dirty state, notes, pins; labels generic names', async () => {
  const root = await tmp();
  try {
    const repo = path.join(root, 'shop', 'mobile');
    await mkdir(repo, { recursive: true });
    const git = gitRepo(repo);
    await writeFile(path.join(repo, 'package.json'), '{}');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    await writeFile(path.join(repo, 'a.txt'), 'x');
    await setNote(repo, 'ship it');
    await setMeta(repo, { pinned: true });
    const [p] = await collect([root], { ports: false });
    assert.equal(p.label, 'shop/mobile');
    assert.equal(p.isGit, true);
    assert.equal(p.dirty, 1);
    assert.equal(p.lastCommit, 'first');
    assert.equal(p.note.next, 'ship it');
    assert.equal(p.pinned, true);
  } finally {
    await cleanup(root);
  }
});

/* ---------- pushed status ---------- */

test('remote status: local only, never pushed, tracked, and pushed-but-not-linked', async () => {
  const root = await tmp();
  try {
    const mk = async (name) => {
      const dir = path.join(root, name);
      await mkdir(dir, { recursive: true });
      const git = gitRepo(dir);
      await writeFile(path.join(dir, 'package.json'), '{}');
      git('add', '.');
      git('commit', '-q', '-m', 'first');
      return { dir, git };
    };
    const commit = async ({ dir, git }, msg) => {
      await writeFile(path.join(dir, `${msg}.txt`), msg);
      git('add', '.');
      git('commit', '-q', '-m', msg);
    };
    const bare = async (name) => {
      const p = path.join(root, `${name}.git`);
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', p]);
      return p;
    };

    // 1) no remote at all
    const local = await mk('local');
    assert.equal((await inspect(local.dir)).remoteState, 'local-only');

    // 2) a remote exists, branch never sent
    const never = await mk('never');
    never.git('remote', 'add', 'origin', await bare('never'));
    const n = await inspect(never.dir);
    assert.equal(n.remoteState, 'never-pushed');
    assert.equal(n.upstream, null);

    // 3) pushed with tracking, then two more commits -> real counts
    const tracked = await mk('tracked');
    tracked.git('remote', 'add', 'origin', await bare('tracked'));
    tracked.git('push', '-q', '-u', 'origin', 'main');
    await commit(tracked, 'a');
    await commit(tracked, 'b');
    const t = await inspect(tracked.dir);
    assert.equal(t.remoteState, 'tracking');
    assert.equal(t.ahead, 2);

    // 4) pushed once WITHOUT -u (not linked), then one more commit -> still counted, never "never pushed"
    const loose = await mk('loose');
    loose.git('remote', 'add', 'origin', await bare('loose'));
    loose.git('push', '-q', 'origin', 'main');
    assert.equal((await inspect(loose.dir)).ahead, 0);
    await commit(loose, 'c');
    const l = await inspect(loose.dir);
    assert.equal(l.remoteState, 'pushed-untracked');
    assert.equal(l.upstream, 'origin/main');
    assert.equal(l.ahead, 1);
  } finally {
    await cleanup(root);
  }
});

/* ---------- installed apps ---------- */

test('tidyEntries drops helper shortcuts, dedupes by program and sorts', () => {
  const win = process.platform === 'win32';
  const exe = (n) => (win ? `C:\\Apps\\${n}.exe` : `/apps/${n}`);
  const out = tidyEntries([
    { name: 'Zed', exe: exe('zed') },
    { name: 'Notepad++', exe: exe('npp') },
    { name: 'Uninstall Notepad++', exe: exe('uninstall') },
    { name: 'Notepad++ Readme', exe: exe('readme') },
    { name: 'Notepad++ again', exe: exe('npp') },
    { name: 'App Setup', exe: win ? 'C:\\Apps\\setup.exe' : '/apps/setup.exe' },
    { name: 'alpha', exe: exe('alpha') },
    null,
    { name: 'no program' },
  ]);
  assert.deepEqual(out.map((a) => a.name), ['alpha', 'Notepad++', 'Zed']);
});

test('parseDesktopEntry reads visible apps and skips hidden ones', () => {
  const ok = parseDesktopEntry('[Desktop Entry]\nType=Application\nName=Gedit\nExec=gedit %U\n');
  assert.deepEqual(ok, { name: 'Gedit', command: 'gedit' });
  assert.equal(parseDesktopEntry('[Desktop Entry]\nType=Application\nName=X\nExec=x\nNoDisplay=true\n'), null);
  assert.equal(parseDesktopEntry('[Desktop Entry]\nType=Link\nName=X\nExec=x\n'), null);
  assert.deepEqual(parseDesktopEntry('[Desktop Entry]\nType=Application\nName=Q\nExec="/opt/q app/q" --flag\n'), { name: 'Q', command: '/opt/q app/q' });
});

/* ---------- last session ---------- */

test('latestCluster stops at a long gap; summarize describes it in plain words', () => {
  const H = 3_600_000;
  const files = [
    { path: 'src/a.js', mtime: 100 * H },
    { path: 'src/b.js', mtime: 99.5 * H },
    { path: 'docs/c.md', mtime: 98.5 * H },
    { path: 'old/d.js', mtime: 50 * H },
  ];
  const cluster = latestCluster(files);
  assert.deepEqual(cluster.map((f) => f.path), ['src/a.js', 'src/b.js', 'docs/c.md']);
  const text = summarize({ files: cluster, commits: [{ subject: 'Add cart' }], start: 98.5 * H, end: 100 * H, now: 102 * H });
  assert.match(text, /Touched 3 files/);
  assert.match(text, /src \(2\)/);
  assert.match(text, /Last commit: "Add cart"/);
  assert.equal(summarize({ files: [], commits: [], start: 0, end: 0 }), 'No files found in this project yet.');
});

test('lastSession separates the latest burst from older work and flags modified files', async () => {
  const root = await tmp();
  try {
    const repo = path.join(root, 'proj');
    await mkdir(path.join(repo, 'src'), { recursive: true });
    const git = gitRepo(repo);
    await writeFile(path.join(repo, 'package.json'), '{}');
    await writeFile(path.join(repo, 'old.txt'), 'old');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const now = Date.now();
    await utimes(path.join(repo, 'old.txt'), (now - 10 * 86_400_000) / 1000, (now - 10 * 86_400_000) / 1000);
    await utimes(path.join(repo, 'package.json'), (now - 10 * 86_400_000) / 1000, (now - 10 * 86_400_000) / 1000);
    await writeFile(path.join(repo, 'src', 'new.js'), 'x');
    const s = await lastSession(repo);
    assert.deepEqual(s.files.map((f) => f.path), ['src/new.js']);
    assert.equal(s.files[0].state, 'new');
    assert.equal(s.commits[0].subject, 'init');
    assert.match(s.summary, /Touched 1 file,/);
  } finally {
    await cleanup(root);
  }
});

/* ---------- pickers and apps ---------- */

test('browse lists folders (and files on request), hides dot-folders, reports the parent', async () => {
  const root = await tmp();
  try {
    await mkdir(path.join(root, 'b'));
    await mkdir(path.join(root, 'a'));
    await mkdir(path.join(root, '.hidden'));
    await writeFile(path.join(root, 'f.exe'), '');
    const dirsOnly = await browse(root);
    assert.deepEqual(dirsOnly.dirs.map((d) => d.name), ['a', 'b']);
    assert.deepEqual(dirsOnly.files, []);
    assert.deepEqual((await browse(root, { files: true })).files.map((f) => f.name), ['f.exe']);
    assert.equal(dirsOnly.parent, path.dirname(root));
    assert.ok((await browse('')).dirs.length > 0, 'starting places exist');
    await assert.rejects(() => browse(path.join(root, 'missing')));
  } finally {
    await cleanup(root);
  }
});

test('validateExe rejects relative paths, missing files and (on Windows) non-exe files', async () => {
  const root = await tmp();
  try {
    const good = path.join(root, process.platform === 'win32' ? 'tool.exe' : 'tool');
    await writeFile(good, '');
    assert.equal(validateExe(good), null);
    assert.ok(validateExe('code'));
    assert.ok(validateExe(path.join(root, 'nope.exe')));
    assert.ok(validateExe(root));
    if (process.platform === 'win32') {
      await writeFile(path.join(root, 'run.cmd'), '');
      assert.match(validateExe(path.join(root, 'run.cmd')), /\.exe/);
    }
  } finally {
    await cleanup(root);
  }
});

/* ---------- server ---------- */

const post = (base, token, route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'x-leftoff-token': token }, body: JSON.stringify(body) });

test('server: first run needs setup, folders can be added through the API, then projects appear', async () => {
  const root = await tmp();
  let handle;
  try {
    await mkdir(path.join(root, 'work', 'proj'), { recursive: true });
    await writeFile(path.join(root, 'work', 'proj', 'package.json'), '{}');
    handle = await startServer({ port: 0 });
    const base = `http://127.0.0.1:${handle.port}`;
    const t = handle.token;

    assert.equal((await (await fetch(`${base}/api/ping`)).json()).app, 'leftoff');
    assert.equal((await (await fetch(`${base}/api/state`)).json()).needsSetup, true);

    assert.equal((await post(base, 'wrong', '/api/roots', { add: path.join(root, 'work') })).status, 403);
    assert.equal((await post(base, t, '/api/roots', { add: path.join(root, 'nope') })).status, 400);
    assert.equal((await post(base, t, '/api/roots', { add: path.join(root, 'work') })).status, 200);

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.needsSetup, false);
    const list = await (await fetch(`${base}/api/projects?fresh=1`)).json();
    assert.equal(list.projects.length, 1);
    const target = list.projects[0].path;

    // notes, pins, hide
    assert.equal((await post(base, t, '/api/note', { path: target, next: 'hello' })).status, 200);
    assert.equal((await post(base, t, '/api/meta', { path: target, pinned: true, hidden: true })).status, 200);
    const again = await (await fetch(`${base}/api/projects?fresh=1`)).json();
    assert.equal(again.projects[0].note.next, 'hello');
    assert.equal(again.projects[0].pinned, true);
    assert.equal(again.projects[0].hidden, true);

    // unknown project, unknown app
    assert.equal((await post(base, t, '/api/note', { path: '/etc', next: 'x' })).status, 404);
    assert.equal((await post(base, t, '/api/open', { path: target, app: 'no-such-app' })).status, 400);

    // session endpoint
    const session = await (await fetch(`${base}/api/session?path=${encodeURIComponent(target)}`)).json();
    assert.equal(session.fileCount, 1);
    assert.equal((await fetch(`${base}/api/session?path=${encodeURIComponent('/etc')}`)).status, 404);

    // reminder settings
    const set = await (await post(base, t, '/api/settings', { reminder: { enabled: true, hour: 20 } })).json();
    assert.equal(set.settings.reminder.hour, 20);

    // custom app validation, de-duplication, and the installed-apps list
    assert.equal((await post(base, t, '/api/apps', { add: { name: 'x', exe: 'relative' } })).status, 400);
    const prog = path.join(root, process.platform === 'win32' ? 'myeditor.exe' : 'myeditor');
    await writeFile(prog, '');
    const first = await (await post(base, t, '/api/apps', { add: { name: 'My Editor', exe: prog } })).json();
    const second = await (await post(base, t, '/api/apps', { add: { name: 'My Editor again', exe: prog } })).json();
    assert.equal(first.added.name, 'My Editor');
    assert.equal(second.added.id, first.added.id, 'the same program is not added twice');
    assert.equal(second.settings.apps.length, 1);
    assert.equal((await fetch(`${base}/api/installed`)).status, 403, 'installed list needs the token');
    const installed = await (await fetch(`${base}/api/installed`, { headers: { 'x-leftoff-token': t } })).json();
    assert.ok(Array.isArray(installed.apps));
  } finally {
    handle?.server.close();
    await cleanup(root);
  }
});

test('server: Host header, token, browse and path-traversal protections', async () => {
  const root = await tmp();
  let handle;
  try {
    handle = await startServer({ extraRoots: [root], port: 0 });
    const base = `http://127.0.0.1:${handle.port}`;

    assert.equal((await fetch(`${base}/api/browse?path=${encodeURIComponent(root)}`)).status, 403, 'browse needs the token');
    const ok = await fetch(`${base}/api/browse?path=${encodeURIComponent(root)}`, { headers: { 'x-leftoff-token': handle.token } });
    assert.equal(ok.status, 200);

    assert.notEqual((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 200);
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes(handle.token) && !html.includes('__TOKEN__'));
    assert.equal((await fetch(`${base}/logo.svg`)).status, 200);

    const status = await new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port: handle.port, path: '/api/projects', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    handle?.server.close();
    await cleanup(root);
  }
});

test('timeAgo is human', () => {
  const now = 1_000_000_000_000;
  assert.equal(timeAgo(now - 30_000, now), 'just now');
  assert.equal(timeAgo(now - 3 * 86_400_000, now), '3d ago');
  assert.equal(timeAgo(0, now), 'never');
});
