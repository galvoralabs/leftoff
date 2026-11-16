const token = document.querySelector('meta[name="leftoff-token"]').content;
const $ = (id) => document.getElementById(id);
const STALE_DAYS = 30;

const state = {
  projects: [], apps: [],
  settings: { roots: [], apps: [], defaultApp: null, reminder: { enabled: true, hour: 18 } },
  active: 'all', needsSetup: false, editing: false,
  expanded: new Set(), sessions: new Map(),
};

/* ---------- helpers ---------- */

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-leftoff-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/** Replace a node's children, skipping null/undefined (the DOM would print them as text). */
function fill(node, ...kids) {
  node.replaceChildren(...kids.filter((k) => k != null));
}

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...kids.filter((k) => k != null));
  return node;
}

function ago(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 60) return `${Math.round(d)}d ago`;
  const mo = d / 30;
  return mo < 24 ? `${Math.round(mo)}mo ago` : `${Math.round(d / 365)}y ago`;
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const hourLabel = (h) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}`;
const appName = (id) => state.apps.find((a) => a.id === id)?.name || '';

function appFor(p) {
  const ids = new Set(state.apps.map((a) => a.id));
  return [p.app, state.settings.defaultApp].find((id) => id && ids.has(id)) || state.apps[0]?.id || null;
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* storage blocked */ }
  return null;
}

/* ---------- filters ---------- */

const FILTERS = [
  ['all', 'All', () => true],
  ['pinned', 'Pinned', (p) => p.pinned],
  ['running', 'Running', (p) => p.running.length > 0],
  ['dirty', 'Uncommitted', (p) => p.dirty > 0],
  ['unpushed', 'Unpushed', (p) => p.ahead > 0 || (p.isGit && !p.upstream && p.lastCommitAt > 0)],
  ['note', 'Has next step', (p) => !!p.note],
  ['stale', `Quiet ${STALE_DAYS}d+`, (p) => Date.now() - p.lastTouched > STALE_DAYS * 864e5],
  ['nogit', 'No git', (p) => !p.isGit],
  ['hidden', 'Hidden', (p) => p.hidden],
];
const matches = (id, test, p) => (id === 'hidden' ? p.hidden : !p.hidden && test(p));

/* ---------- cards ---------- */

function chips(p) {
  const out = [];
  const add = (text, kind = '') => out.push(el('span', { class: `chip ${kind}` }, text));
  for (const r of p.running) add(`running :${r.port}`, 'run');
  if (!p.isGit) add('no git', 'warn');
  else {
    if (p.branch) add(p.branch);
    if (p.dirty) add(`${p.dirty} uncommitted`, 'warn');
    if (p.ahead) add(`${p.ahead} unpushed`, 'bad');
    if (p.behind) add(`${p.behind} behind`, 'warn');
    if (!p.upstream && p.lastCommitAt) add('no upstream', 'warn');
    if (!p.dirty && !p.ahead && p.upstream) add('clean', 'ok');
  }
  return out;
}

function closeMenus() { document.querySelectorAll('.menu').forEach((m) => m.remove()); }
document.addEventListener('click', (e) => { if (!e.target.closest('.split')) closeMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

function openWithControl(p, status) {
  const say = (text, bad) => {
    status.textContent = text;
    status.classList.toggle('bad', !!bad);
    setTimeout(() => { status.textContent = ''; }, 2500);
  };
  const open = async (id, remember) => {
    try {
      const { app } = await api('/api/open', { path: p.path, app: id });
      say(`Opened in ${app}`);
      if (remember && p.app !== id) {
        await api('/api/meta', { path: p.path, app: id });
        p.app = id;
        render();
      }
    } catch (err) {
      say(err.message, true);
    }
  };
  const current = appFor(p);
  const main = el('button', { type: 'button', disabled: !current, onclick: () => open(current, false) },
    current ? `Open in ${appName(current)}` : 'No app found');
  const caret = el('button', { type: 'button', class: 'caret', 'aria-label': 'Choose app', 'aria-haspopup': 'menu', onclick: (e) => {
    e.stopPropagation();
    const had = wrapper.querySelector('.menu');
    closeMenus();
    if (had) return;
    const items = state.apps.map((a) => el('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenus(); open(a.id, true); } },
      `${a.id === current ? '✓ ' : ''}${a.name}`));
    const menu = el('div', { class: 'menu', role: 'menu' }, ...items, el('hr'),
      current ? el('button', { type: 'button', onclick: async () => {
        closeMenus();
        await api('/api/settings', { defaultApp: current });
        state.settings.defaultApp = current;
        render();
      } }, `Use ${appName(current)} for all projects`) : null,
      el('button', { type: 'button', onclick: () => { closeMenus(); openSettings(); } }, 'Add another app…'));
    wrapper.append(menu);
  } }, '▾');
  const wrapper = el('div', { class: 'split' }, main, caret);
  return wrapper;
}

function sessionPanel(p) {
  const box = el('div', { class: 'session', 'aria-live': 'polite' }, el('p', { class: 'muted' }, 'Looking at what you did last…'));
  const paint = (s) => {
    const files = s.files.map((f) => el('li', {}, el('span', {}, f.path, f.state ? el('span', { class: 'tag' }, f.state === 'new' ? 'new' : 'unsaved') : null), el('span', { class: 't' }, ago(f.mtime))));
    const commits = s.commits.map((c) => el('li', {}, el('span', {}, c.subject), el('span', { class: 't' }, ago(c.at))));
    fill(box, 
      el('p', {}, s.summary),
      files.length ? el('h3', {}, `Files you touched${s.fileCount > files.length ? ` (showing ${files.length} of ${s.fileCount})` : ''}`) : null,
      files.length ? el('ul', {}, ...files) : null,
      commits.length ? el('h3', {}, 'Recent commits') : null,
      commits.length ? el('ul', {}, ...commits) : null);
  };
  if (state.sessions.has(p.path)) paint(state.sessions.get(p.path));
  else {
    api(`/api/session?path=${encodeURIComponent(p.path)}`)
      .then((s) => { state.sessions.set(p.path, s); paint(s); })
      .catch((err) => fill(box, el('p', { class: 'error' }, `Could not read this project: ${err.message}`)));
  }
  return box;
}

function card(p) {
  const status = el('p', { class: 'saved', 'aria-live': 'polite' });
  const note = el('textarea', {
    class: 'next', rows: '2', maxlength: '500', 'aria-label': `Next step for ${p.label}`,
    placeholder: 'Next step: what to do when you come back',
  });
  note.value = p.note?.next || '';
  note.addEventListener('focus', () => { state.editing = true; });
  note.addEventListener('blur', async () => {
    state.editing = false;
    if (note.value.trim() === (p.note?.next || '')) return;
    try {
      const { note: saved } = await api('/api/note', { path: p.path, next: note.value });
      p.note = saved;
      status.textContent = 'Saved';
      status.classList.remove('bad');
      updateBanner();
    } catch (err) {
      status.textContent = `Could not save: ${err.message}`;
      status.classList.add('bad');
    }
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
  const toggle = async (patch) => {
    try {
      await api('/api/meta', { path: p.path, ...patch });
      Object.assign(p, patch);
      state.projects.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastTouched - a.lastTouched);
      render();
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('bad');
    }
  };
  const copy = el('button', { type: 'button', onclick: async (e) => {
    try {
      await navigator.clipboard.writeText(`cd "${p.path}"`);
      e.target.textContent = 'Copied';
    } catch {
      e.target.textContent = 'Copy failed';
    }
    setTimeout(() => { e.target.textContent = 'Copy cd'; }, 1500);
  } }, 'Copy cd');
  const expanded = state.expanded.has(p.path);
  const sessionBtn = el('button', { type: 'button', 'aria-expanded': String(expanded), onclick: () => {
    if (expanded) state.expanded.delete(p.path); else state.expanded.add(p.path);
    state.sessions.delete(p.path);
    render();
  } }, expanded ? 'Hide last session' : 'Last session');
  const links = p.running.map((r) => el('a', { href: `http://localhost:${r.port}/`, target: '_blank', rel: 'noreferrer' }, el('button', { type: 'button' }, `Open :${r.port}`)));
  return el('article', { class: `card${p.pinned ? ' pinned' : ''}` },
    el('div', { class: 'row' }, el('h2', {}, p.label), el('span', { class: 'when', title: p.lastTouched ? new Date(p.lastTouched).toLocaleString() : '' }, ago(p.lastTouched))),
    el('p', { class: 'path' }, p.path),
    el('div', { class: 'chips' }, ...chips(p)),
    p.lastCommit ? el('p', { class: 'commit' }, `Last commit: ${p.lastCommit}`) : null,
    note, status,
    el('div', { class: 'actions' }, openWithControl(p, status), copy, ...links),
    el('div', { class: 'actions' }, sessionBtn,
      el('button', { type: 'button', 'aria-pressed': String(p.pinned), onclick: () => toggle({ pinned: !p.pinned }) }, p.pinned ? 'Unpin' : 'Pin'),
      el('button', { type: 'button', onclick: () => toggle({ hidden: !p.hidden }) }, p.hidden ? 'Unhide' : 'Hide')),
    expanded ? sessionPanel(p) : null);
}

/* ---------- board ---------- */

function render() {
  $('welcome').hidden = !state.needsSetup;
  $('board').hidden = state.needsSetup;
  document.querySelector('.top #q').hidden = state.needsSetup;
  $('wrap').hidden = state.needsSetup;
  $('refresh').hidden = state.needsSetup;
  if (state.needsSetup) return;
  const test = FILTERS.find((f) => f[0] === state.active)[2];
  const q = $('q').value.trim().toLowerCase();
  const shown = state.projects.filter((p) => matches(state.active, test, p) && (!q || `${p.label} ${p.path} ${p.note?.next || ''}`.toLowerCase().includes(q)));
  $('grid').replaceChildren(...shown.map(card));
  $('empty').hidden = shown.length > 0;
  const visible = state.projects.filter((p) => !p.hidden).length;
  $('meta').textContent = `${shown.length} shown · ${visible} projects`;
  $('filters').replaceChildren(...FILTERS.map(([id, label, fn]) => {
    const count = state.projects.filter((p) => matches(id, fn, p)).length;
    return el('button', { type: 'button', 'aria-pressed': String(id === state.active), onclick: () => { state.active = id; render(); } }, `${label} ${count}`);
  }));
  updateBanner();
}

async function load(fresh) {
  $('meta').textContent = 'Scanning…';
  try {
    const s = await api('/api/state');
    state.settings = s.settings;
    state.apps = s.apps;
    state.needsSetup = s.needsSetup;
    if (!state.needsSetup) {
      const data = await api(fresh ? '/api/projects?fresh=1' : '/api/projects');
      state.projects = data.projects;
    }
    render();
    if (!state.needsSetup) $('meta').textContent += ` · scanned ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    $('meta').textContent = `Scan failed: ${err.message}`;
  }
}

/* ---------- folder / file picker ---------- */

function pick({ mode, title }) {
  return new Promise((resolve) => {
    const dlg = $('picker');
    let current = '';
    let done = false;
    const finish = (value) => { done = true; dlg.close(); resolve(value); };
    const list = el('ul', { class: 'list' });
    const pathbar = el('p', { class: 'pathbar' });
    const err = el('p', { class: 'error', role: 'alert' });
    const useBtn = el('button', { type: 'button', class: 'primary', onclick: () => finish(current) }, 'Use this folder');
    const upBtn = el('button', { type: 'button' }, 'Up');
    async function go(target) {
      try {
        const data = await api(`/api/browse?path=${encodeURIComponent(target)}${mode === 'file' ? '&files=1' : ''}`);
        current = data.path;
        err.textContent = '';
        pathbar.textContent = data.path || 'Choose a starting place';
        upBtn.disabled = data.parent === null;
        upBtn.onclick = () => go(data.parent);
        useBtn.disabled = !data.path;
        const exeOnly = navigator.userAgent.includes('Windows');
        const files = data.files.filter((f) => !exeOnly || f.name.toLowerCase().endsWith('.exe'));
        fill(list, 
          ...data.dirs.map((d) => el('li', {}, el('button', { type: 'button', onclick: () => go(d.path) }, `📁 ${d.name}`))),
          ...(mode === 'file' ? files.map((f) => el('li', {}, el('button', { type: 'button', onclick: () => finish(f.path) }, f.name))) : []));
        if (!list.children.length) list.append(el('li', { class: 'muted' }, el('button', { type: 'button', disabled: true }, 'Nothing here')));
      } catch (e) {
        err.textContent = e.message;
      }
    }
    fill(dlg, 
      el('h2', { id: 'pickerTitle' }, title),
      pathbar, list, err,
      el('div', { class: 'dlg-actions' }, upBtn, el('button', { type: 'button', onclick: () => finish(null) }, 'Cancel'), mode === 'dir' ? useBtn : null));
    dlg.addEventListener('close', () => { if (!done) resolve(null); }, { once: true });
    dlg.showModal();
    go('');
  });
}

async function addFolder(errorEl) {
  const dir = await pick({ mode: 'dir', title: 'Choose a folder that holds your projects' });
  if (!dir) return false;
  try {
    await api('/api/roots', { add: dir });
    return true;
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message;
    return false;
  }
}

/* ---------- settings ---------- */

function openSettings() {
  const dlg = $('settingsDlg');
  const draw = () => {
    const s = state.settings;
    const folders = s.roots.map((r) => el('li', {}, el('span', {}, r), el('button', { type: 'button', onclick: async () => { await api('/api/roots', { remove: r }); await refreshSettings(); } }, 'Remove')));
    const custom = s.apps.map((a) => el('li', {}, el('span', {}, `${a.name} `, el('span', { class: 'muted' }, a.exe)), el('button', { type: 'button', onclick: async () => { await api('/api/apps', { remove: a.id }); await refreshSettings(); } }, 'Remove')));
    const appSel = el('select', { 'aria-label': 'Default app', onchange: async (e) => { const r = await api('/api/settings', { defaultApp: e.target.value || null }); state.settings = r.settings; render(); } },
      el('option', { value: '' }, 'First one found'),
      ...state.apps.map((a) => el('option', { value: a.id, selected: a.id === s.defaultApp }, a.name)));
    const enabled = el('input', { type: 'checkbox', id: 'remOn', checked: s.reminder.enabled });
    const hourSel = el('select', { id: 'remHour', 'aria-label': 'Reminder time' },
      ...Array.from({ length: 24 }, (_, h) => el('option', { value: String(h), selected: h === s.reminder.hour }, hourLabel(h))));
    const saveReminder = async () => {
      const r = await api('/api/settings', { reminder: { enabled: enabled.checked, hour: Number(hourSel.value) } });
      state.settings = r.settings;
      updateBanner();
    };
    enabled.addEventListener('change', saveReminder);
    hourSel.addEventListener('change', saveReminder);
    const err = el('p', { class: 'error', role: 'alert' });
    fill(dlg, 
      el('h2', { id: 'settingsTitle' }, 'Settings'),
      el('h3', {}, 'Project folders'),
      s.roots.length ? el('ul', { class: 'items' }, ...folders) : el('p', { class: 'muted' }, 'No folders yet.'),
      el('div', { class: 'dlg-actions' }, el('button', { type: 'button', onclick: async () => { if (await addFolder(err)) await refreshSettings(); } }, 'Add folder')),
      el('h3', {}, 'Open projects with'),
      el('div', { class: 'field' }, el('label', {}, 'Default app'), appSel),
      custom.length ? el('ul', { class: 'items' }, ...custom) : null,
      el('div', { class: 'dlg-actions' }, el('button', { type: 'button', onclick: async () => {
        const exe = await pick({ mode: 'file', title: 'Choose the program to add' });
        if (!exe) return;
        const name = exe.split(/[\\/]/).pop().replace(/\.exe$/i, '');
        try { await api('/api/apps', { add: { name, exe } }); await refreshSettings(); } catch (e) { err.textContent = e.message; }
      } }, 'Add an app')),
      el('h3', {}, 'Evening reminder'),
      el('div', { class: 'field' }, enabled, el('label', { for: 'remOn' }, 'Remind me to leave next steps after'), hourSel),
      el('p', { class: 'muted' }, 'The reminder appears at the top of this page while it is open.'),
      err,
      el('div', { class: 'dlg-actions' }, el('button', { type: 'button', class: 'primary', onclick: () => dlg.close() }, 'Done')));
  };
  async function refreshSettings() {
    await load(true);
    draw();
  }
  draw();
  dlg.showModal();
}

/* ---------- evening wrap-up ---------- */

const todays = () => state.projects.filter((p) => !p.hidden && p.lastTouched >= startOfToday());
const needsNote = (p) => !p.note || p.note.updatedAt < startOfToday();

function updateBanner() {
  const banner = $('banner');
  const r = state.settings.reminder;
  const pending = todays().filter(needsNote);
  const due = !state.needsSetup && r.enabled && new Date().getHours() >= r.hour && pending.length > 0
    && store('leftoff-dismissed') !== new Date().toDateString();
  banner.hidden = !due;
  document.title = due ? `(${pending.length}) Leftoff` : 'Leftoff';
  if (!due) return;
  fill(banner, 
    el('span', {}, `You worked on ${todays().length} project${todays().length === 1 ? '' : 's'} today. Leave yourself a next step for ${pending.length === todays().length ? 'each' : `the ${pending.length} without one`}?`),
    el('button', { type: 'button', class: 'primary', onclick: openWrap }, 'Wrap up'),
    el('button', { type: 'button', onclick: () => { store('leftoff-dismissed', new Date().toDateString()); updateBanner(); } }, 'Not today'));
}

function openWrap() {
  const dlg = $('wrapDlg');
  const list = todays();
  const boxes = list.map((p) => {
    const ta = el('textarea', { class: 'next', rows: '2', id: `w-${list.indexOf(p)}`, maxlength: '500', placeholder: 'Next step…' });
    ta.value = p.note?.next || '';
    return { p, ta, item: el('div', { class: 'wrap-item' }, el('label', { for: ta.id }, p.label), el('div', { class: 'muted' }, `${chips(p).map((c) => c.textContent).join(' · ')}`), ta) };
  });
  const err = el('p', { class: 'error', role: 'alert' });
  fill(dlg, 
    el('h2', { id: 'wrapTitle' }, 'Wrap up your day'),
    list.length ? el('p', { class: 'muted' }, 'What should future-you do first in each project?') : el('p', {}, 'You have not touched any project today.'),
    ...boxes.map((b) => b.item), err,
    el('div', { class: 'dlg-actions' },
      el('button', { type: 'button', onclick: () => dlg.close() }, 'Close'),
      list.length ? el('button', { type: 'button', class: 'primary', onclick: async () => {
        try {
          for (const { p, ta } of boxes) {
            if (ta.value.trim() === (p.note?.next || '')) continue;
            const { note } = await api('/api/note', { path: p.path, next: ta.value });
            p.note = note;
          }
          dlg.close();
          render();
        } catch (e) {
          err.textContent = `Could not save: ${e.message}`;
        }
      } }, 'Save next steps') : null));
  dlg.showModal();
}

/* ---------- wire up ---------- */

$('q').addEventListener('input', render);
$('refresh').addEventListener('click', () => load(true));
$('settings').addEventListener('click', openSettings);
$('wrap').addEventListener('click', openWrap);
$('choose').addEventListener('click', async () => {
  if (await addFolder($('welcomeError'))) load(true);
});
window.addEventListener('focus', () => {
  if (!state.editing && !document.querySelector('dialog[open]')) load(true);
});
setInterval(updateBanner, 60_000);
load(false);
