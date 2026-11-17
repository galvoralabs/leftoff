import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseApp, detectApps, listApps, openWith, validateExe } from './apps.js';
import { browse } from './browse.js';
import { collect } from './collect.js';
import { installedApps } from './installed.js';
import { lastSession } from './session.js';
import {
  addCustomApp, addRoot, loadSettings, removeCustomApp, removeRoot, setMeta, setNote, updateSettings,
} from './store.js';

export const VERSION = '0.2.1';
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
};

/**
 * Start the local board on 127.0.0.1 only. Requests must carry the expected Host header
 * (blocks DNS rebinding); anything that writes, opens programs or browses folders needs a
 * per-run token that only the served page knows (blocks other websites).
 */
export function startServer({ extraRoots = [], port = 4747, depth = 3 } = {}) {
  const token = randomBytes(16).toString('hex');
  let cache = { at: 0, projects: [] };
  let current = null;

  const rootsNow = async () => {
    const saved = (await loadSettings()).roots;
    return [...new Set([...saved, ...extraRoots.map((r) => path.resolve(r))])];
  };

  async function projects(force) {
    if (!force && Date.now() - cache.at < 3000) return cache.projects;
    current ??= rootsNow().then((roots) => collect(roots, { depth })).finally(() => { current = null; });
    cache = { at: Date.now(), projects: await current };
    return cache.projects;
  }
  const invalidate = () => { cache.at = 0; };

  const server = http.createServer(async (req, res) => {
    const addr = server.address();
    const allowed = new Set([`127.0.0.1:${addr.port}`, `localhost:${addr.port}`]);
    if (!allowed.has(req.headers.host || '')) {
      res.writeHead(403).end('Forbidden host');
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const authed = () => req.headers['x-leftoff-token'] === token;
    // Validate against the last scan (even if a bit old) so writes stay instant; scan only when none exists.
    const knownProject = async (p) => (cache.projects.length ? cache.projects : await projects(false)).find((x) => x.path === p);
    const readBody = async () => {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 10_000) throw Object.assign(new Error('too large'), { status: 413 });
      }
      return JSON.parse(raw || '{}');
    };

    try {
      if (req.method === 'GET') {
        if (url.pathname === '/api/ping') return send(200, { app: 'leftoff', version: VERSION });
        if (url.pathname === '/api/state') {
          const settings = await loadSettings();
          const roots = await rootsNow();
          return send(200, { settings, roots, needsSetup: roots.length === 0, apps: await listApps(settings) });
        }
        if (url.pathname === '/api/projects') {
          const list = await projects(url.searchParams.has('fresh'));
          const settings = await loadSettings();
          return send(200, { generatedAt: Date.now(), projects: list, appChoice: await chooseApp(settings, null) });
        }
        if (url.pathname === '/api/session') {
          const known = await knownProject(url.searchParams.get('path'));
          if (!known) return send(404, { error: 'unknown project' });
          return send(200, await lastSession(known.path));
        }
        if (url.pathname === '/api/installed') {
          if (!authed()) return send(403, { error: 'bad token' });
          return send(200, { apps: await installedApps(url.searchParams.has('fresh')) });
        }
        if (url.pathname === '/api/browse') {
          if (!authed()) return send(403, { error: 'bad token' });
          try {
            return send(200, await browse(url.searchParams.get('path') || '', { files: url.searchParams.has('files') }));
          } catch {
            return send(400, { error: 'Cannot open that folder.' });
          }
        }
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const full = path.join(UI_DIR, file);
        if (!full.startsWith(UI_DIR + path.sep)) return send(404, 'Not found', 'text/plain');
        let data = await readFile(full, 'utf8');
        if (file === 'index.html') data = data.replace('__TOKEN__', token);
        return send(200, data, TYPES[path.extname(full)] || 'text/plain');
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (!authed()) return send(403, { error: 'bad token' });
        const body = await readBody();
        const settings = await loadSettings();

        if (url.pathname === '/api/roots') {
          if (body.add) {
            const err = await browse(body.add).then(() => null, () => 'That folder cannot be opened.');
            if (err) return send(400, { error: err });
            await addRoot(body.add);
          }
          if (body.remove) await removeRoot(body.remove);
          invalidate();
          return send(200, { roots: await rootsNow() });
        }
        if (url.pathname === '/api/settings') {
          const patch = {};
          if ('defaultApp' in body) patch.defaultApp = body.defaultApp;
          if (body.reminder) patch.reminder = body.reminder;
          return send(200, { settings: await updateSettings(patch) });
        }
        if (url.pathname === '/api/apps') {
          if (body.remove) await removeCustomApp(body.remove);
          let added = null;
          if (body.add) {
            const err = validateExe(body.add.exe);
            if (err) return send(400, { error: err });
            const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
            // Reuse an app Leftoff already knows (built-in or added before) instead of creating a copy.
            const builtIn = (await detectApps()).find((a) => a.launch.cmd && sameFile(a.launch.cmd, body.add.exe));
            const existing = settings.apps.find((a) => sameFile(a.exe, body.add.exe));
            const app = builtIn || existing || (await addCustomApp(body.add.name, body.add.exe));
            added = { id: app.id, name: app.name };
          }
          const fresh = await loadSettings();
          return send(200, { apps: await listApps(fresh), settings: fresh, added });
        }

        const known = await knownProject(body.path);
        if (!known) return send(404, { error: 'unknown project' });
        if (url.pathname === '/api/note') {
          const note = await setNote(known.path, body.next);
          invalidate();
          return send(200, { note });
        }
        if (url.pathname === '/api/meta') {
          const patch = {};
          for (const k of ['pinned', 'hidden', 'app']) if (k in body) patch[k] = body[k];
          const meta = await setMeta(known.path, patch);
          invalidate();
          return send(200, { meta });
        }
        if (url.pathname === '/api/open') {
          const appId = body.app || (await chooseApp(settings, known));
          if (!appId) return send(400, { error: 'No app available to open this folder.' });
          try {
            const name = await openWith(appId, known.path, settings);
            return send(200, { ok: true, app: name });
          } catch (err) {
            return send(400, { error: err.message });
          }
        }
      }
      return send(404, { error: 'not found' });
    } catch (err) {
      if (err.status) return send(err.status, { error: err.message });
      if (err instanceof SyntaxError) return send(400, { error: 'bad request' });
      return send(err.code === 'ENOENT' ? 404 : 500, { error: err.code === 'ENOENT' ? 'not found' : 'server error' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, token }));
  });
}
