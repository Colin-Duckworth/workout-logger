'use strict';

/*
 * Workout Log: an offline-first set logger.
 *
 * Every set is saved to localStorage the moment it's logged; that copy on the
 * phone is the source of truth. Sets are then synced to monthly CSV files
 * (sets/YYYY-MM.csv) in a private GitHub repo through the Contents API.
 * Each set carries a UUID, so a sync merges by id: retries never duplicate
 * rows, and anything already in the file (e.g. edits made on a computer)
 * is preserved.
 */

const COLUMNS = ['id', 'timestamp', 'date', 'exercise', 'set_number', 'reps', 'weight_kg', 'rpe', 'notes'];

const DEFAULT_EXERCISES = [
  'Squat', 'Bench Press', 'Deadlift', 'Overhead Press', 'Barbell Row', 'Pull-up',
  'Chin-up', 'Romanian Deadlift', 'Incline Bench Press', 'Dip', 'Lat Pulldown',
  'Leg Press', 'Lunge', 'Hip Thrust', 'Dumbbell Curl', 'Tricep Pushdown',
  'Lateral Raise', 'Face Pull', 'Calf Raise',
];

const DEFAULT_SETTINGS = {
  owner: 'Colin-Duckworth',
  repo: 'workout-data',
  branch: 'main',
  token: '',
  repStep: 1,
  weightStep: 2.5,
};

const KEY = {
  sets: 'wl.sets',
  tombstones: 'wl.tombstones',
  exercises: 'wl.exercises',
  settings: 'wl.settings',
  current: 'wl.current',
};

// ---------- persistence ----------

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const state = {
  sets: load(KEY.sets, []),               // every set logged on (or restored to) this device
  tombstones: load(KEY.tombstones, []),   // {id, date} of deleted sets not yet removed from GitHub
  exercises: load(KEY.exercises, DEFAULT_EXERCISES.slice()),
  settings: { ...DEFAULT_SETTINGS, ...load(KEY.settings, {}) },
  current: { exercise: '', reps: 5, weight: 20, setNumber: null, ...load(KEY.current, {}) },
  syncing: false,
  syncQueued: false,
  noSignal: false,
  lastError: '',
};

// Throws if storage is full/blocked so callers can tell the user instead of silently losing a set.
function persist() {
  localStorage.setItem(KEY.sets, JSON.stringify(state.sets));
  localStorage.setItem(KEY.tombstones, JSON.stringify(state.tombstones));
  localStorage.setItem(KEY.exercises, JSON.stringify(state.exercises));
  localStorage.setItem(KEY.settings, JSON.stringify(state.settings));
  localStorage.setItem(KEY.current, JSON.stringify(state.current));
}

function saveCurrent() {
  try { localStorage.setItem(KEY.current, JSON.stringify(state.current)); } catch { /* form state only */ }
}

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ISO 8601 in the phone's local time with its UTC offset, e.g. 2026-10-24T18:05:12.345+02:00
// (milliseconds keep sets logged within the same second in the right order).
function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${String(d.getMilliseconds()).padStart(3, '0')}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const today = () => localDate();

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Accepts "82,5" too: iOS shows a comma on the decimal keypad in many locales.
function parseNum(v) {
  const n = parseFloat(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const fmtW = (n) => String(round(Number(n) || 0));

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const byTimeDesc = (a, b) => String(b.timestamp).localeCompare(String(a.timestamp));
const byTimeAsc = (a, b) => String(a.timestamp).localeCompare(String(b.timestamp));

// ---------- CSV ----------

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const lines = rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','));
  return [COLUMNS.join(','), ...lines].join('\n') + '\n';
}

// Minimal RFC 4180 parser (quoted cells, escaped quotes, newlines in quotes). Returns objects keyed by header.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }

  const [header, ...body] = rows;
  if (!header) return [];
  return body
    .filter((r) => r.length > 1 || r[0] !== '')
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const toRow = (s) => Object.fromEntries(COLUMNS.map((c) => [c, s[c]]));

function fromRow(r) {
  return {
    id: r.id,
    timestamp: r.timestamp,
    date: r.date,
    exercise: r.exercise,
    set_number: Number(r.set_number) || 1,
    reps: Number(r.reps) || 0,
    weight_kg: Number(r.weight_kg) || 0,
    rpe: r.rpe === '' || r.rpe == null ? '' : Number(r.rpe),
    notes: r.notes || '',
  };
}

// ---------- queries ----------

const setsOn = (date, exercise) =>
  state.sets.filter((s) => s.date === date && (!exercise || s.exercise === exercise));

function autoSetNumber(exercise) {
  const nums = setsOn(today(), exercise).map((s) => Number(s.set_number) || 0);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

function currentSetNumber() {
  const c = state.current;
  return c.setNumber ?? (c.exercise ? autoSetNumber(c.exercise) : 1);
}

// Most recent day before today on which this exercise was done.
function lastSession(exercise) {
  const t = today();
  let date = null;
  for (const s of state.sets) {
    if (s.exercise === exercise && s.date < t && (!date || s.date > date)) date = s.date;
  }
  if (!date) return null;
  return { date, sets: setsOn(date, exercise).sort((a, b) => a.set_number - b.set_number) };
}

function latestSetFor(exercise) {
  let latest = null;
  for (const s of state.sets) {
    if (s.exercise === exercise && (!latest || s.timestamp > latest.timestamp)) latest = s;
  }
  return latest;
}

function recentExercises(limit = 6) {
  const seen = [];
  for (const s of [...state.sets].sort(byTimeDesc)) {
    if (!seen.includes(s.exercise) && state.exercises.includes(s.exercise)) seen.push(s.exercise);
    if (seen.length >= limit) break;
  }
  return seen;
}

const pendingCount = () => state.sets.filter((s) => s.dirty).length + state.tombstones.length;

// ---------- rendering ----------

const els = {};

function renderForm() {
  const c = state.current;
  els.exerciseBtn.textContent = c.exercise || 'Choose exercise';
  els.exerciseBtn.classList.toggle('empty', !c.exercise);
  if (document.activeElement !== els.reps) els.reps.value = c.reps;
  if (document.activeElement !== els.weight) els.weight.value = fmtW(c.weight);
  if (document.activeElement !== els.setNum) els.setNum.value = currentSetNumber();
  els.saveBtn.disabled = !c.exercise;
  els.saveBtn.textContent = c.exercise ? `Log set ${currentSetNumber()}` : 'Choose an exercise first';

  const last = c.exercise && lastSession(c.exercise);
  els.lastSession.textContent = !c.exercise ? '' : last
    ? `Last time (${fmtDate(last.date)}): ${last.sets.map((s) => `${s.reps}×${fmtW(s.weight_kg)}`).join(', ')} kg`
    : 'First time logging this one.';
}

function renderToday() {
  const list = setsOn(today()).sort(byTimeDesc);
  els.today.replaceChildren();
  els.undoBtn.hidden = !list.length;
  if (!list.length) {
    els.today.append(el('p', 'empty-note', 'No sets logged today yet.'));
    return;
  }

  // Groups keep the order of their newest set, so the exercise you're on stays on top.
  const groups = new Map();
  for (const s of list) {
    if (!groups.has(s.exercise)) groups.set(s.exercise, []);
    groups.get(s.exercise).push(s);
  }

  for (const [exercise, sets] of groups) {
    const group = el('div', 'group');
    const title = el('button', 'group-title', exercise);
    title.type = 'button';
    const volume = sets.reduce((sum, s) => sum + s.reps * s.weight_kg, 0);
    title.append(el('small', null, `${sets.length} ${sets.length === 1 ? 'set' : 'sets'} · ${fmtW(volume)} kg vol`));
    title.addEventListener('click', () => chooseExercise(exercise));
    group.append(title);

    for (const s of sets) {
      const row = el('div', 'set-row');
      const meta = [s.rpe !== '' && s.rpe != null ? `RPE ${s.rpe}` : '', s.notes].filter(Boolean).join(' · ');
      const dot = el('span', s.dirty ? 'dot pending' : 'dot');
      if (s.dirty) dot.title = 'Waiting to sync';
      const del = el('button', 'del', '×');
      del.type = 'button';
      del.setAttribute('aria-label', `Delete set ${s.set_number}`);
      del.addEventListener('click', () => deleteSet(s.id, { confirm: true }));
      row.append(el('span', 'set-n', `#${s.set_number}`), el('span', 'set-main', `${s.reps} × ${fmtW(s.weight_kg)} kg`),
        el('span', 'set-meta', meta), dot, del);
      group.append(row);
    }
    els.today.append(group);
  }
}

function renderStatus() {
  const n = pendingCount();
  let text;
  let cls;
  if (!state.settings.token) { text = n ? `${n} unsynced · set up` : 'Set up sync'; cls = 'warn'; }
  else if (state.syncing) { text = 'Syncing…'; cls = 'busy'; }
  else if (state.lastError) { text = n ? `Sync failed · ${n}` : 'Sync failed'; cls = 'error'; }
  else if (n && (state.noSignal || !navigator.onLine)) { text = `No signal · ${n} pending`; cls = 'warn'; }
  else if (n) { text = `${n} pending`; cls = 'warn'; }
  else { text = '✓ Synced'; cls = 'ok'; }
  els.syncBtn.textContent = text;
  els.syncBtn.className = `pill ${cls}`;
}

function renderAll() {
  renderForm();
  renderToday();
  renderStatus();
}

let toastTimer;
function toast(msg, { error = false, action = null } = {}) {
  els.toastMsg.textContent = msg;
  els.toast.classList.toggle('error', error);
  els.toastAction.hidden = !action;
  if (action) {
    els.toastAction.textContent = action.label;
    els.toastAction.onclick = () => { hideToast(); action.run(); };
  }
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, error ? 7000 : 4000);
}

function hideToast() { els.toast.hidden = true; }

// ---------- actions ----------

let lastSaveAt = 0;

function logSet() {
  const c = state.current;
  if (!c.exercise) return;
  if (Date.now() - lastSaveAt < 400) return; // ignore accidental double taps
  readForm();

  const reps = Math.round(Number(c.reps));
  const weight = round(Number(c.weight));
  if (!Number.isFinite(reps) || reps < 0) return toast('Reps must be a number', { error: true });
  if (!Number.isFinite(weight) || weight < 0) return toast('Weight must be a number', { error: true });
  const rpe = parseNum(els.rpe.value);

  const now = new Date();
  const set = {
    id: uuid(),
    timestamp: localIso(now),
    date: localDate(now),
    exercise: c.exercise,
    set_number: currentSetNumber(),
    reps,
    weight_kg: weight,
    rpe: Number.isFinite(rpe) ? rpe : '',
    notes: els.notes.value.trim(),
    dirty: true,
  };

  state.sets.push(set);
  c.setNumber = null;
  try {
    persist();
  } catch (e) {
    state.sets.pop();
    return toast(`Could not save on this phone: ${e.message}`, { error: true });
  }

  lastSaveAt = Date.now();
  els.rpe.value = '';
  els.notes.value = '';
  renderAll();
  toast(`Set ${set.set_number} logged: ${set.reps} × ${fmtW(set.weight_kg)} kg`, {
    action: { label: 'Undo', run: () => deleteSet(set.id) },
  });
  sync();
}

function deleteSet(id, { confirm: ask = false } = {}) {
  const s = state.sets.find((x) => x.id === id);
  if (!s) return;
  if (ask && !confirm(`Delete ${s.exercise} set #${s.set_number} (${s.reps} × ${fmtW(s.weight_kg)} kg)?`)) return;
  state.sets = state.sets.filter((x) => x.id !== id);
  state.tombstones.push({ id, date: s.date });
  try { persist(); } catch (e) { return toast(`Could not save: ${e.message}`, { error: true }); }
  renderAll();
  toast('Set deleted');
  sync();
}

function undoLast() {
  const last = setsOn(today()).sort(byTimeDesc)[0];
  if (last) deleteSet(last.id, { confirm: true });
}

// Copy what's typed in the inputs into state.current.
function readForm() {
  const c = state.current;
  const reps = parseNum(els.reps.value);
  const weight = parseNum(els.weight.value);
  const setNum = parseNum(els.setNum.value);
  if (Number.isFinite(reps)) c.reps = Math.max(0, Math.round(reps));
  if (Number.isFinite(weight)) c.weight = Math.max(0, round(weight));
  if (Number.isFinite(setNum) && Math.round(setNum) !== currentSetNumber()) c.setNumber = Math.max(1, Math.round(setNum));
  saveCurrent();
}

function step(field, dir) {
  readForm();
  const c = state.current;
  if (field === 'reps') c.reps = Math.max(0, Math.round(c.reps + dir * state.settings.repStep));
  if (field === 'weight') c.weight = Math.max(0, round(c.weight + dir * state.settings.weightStep));
  if (field === 'set') c.setNumber = Math.max(1, currentSetNumber() + dir);
  saveCurrent();
  renderForm();
}

function chooseExercise(name) {
  const c = state.current;
  if (c.exercise !== name) {
    // Start from whatever you did last time on this exercise.
    const last = latestSetFor(name);
    if (last) { c.reps = Number(last.reps); c.weight = Number(last.weight_kg); }
    c.exercise = name;
    c.setNumber = null;
    saveCurrent();
  }
  if (els.picker.open) els.picker.close();
  renderForm();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function addExercise(name) {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  const existing = state.exercises.find((e) => e.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  state.exercises.push(clean);
  try { persist(); } catch (e) { toast(`Could not save: ${e.message}`, { error: true }); }
  return clean;
}

// ---------- exercise picker ----------

function pickButton(name) {
  const b = el('button', name === state.current.exercise ? 'pick current' : 'pick', name);
  b.type = 'button';
  b.addEventListener('click', () => chooseExercise(name));
  return b;
}

function renderPicker() {
  const q = els.pickerSearch.value.trim();
  const ql = q.toLowerCase();
  const list = els.pickerList;
  list.replaceChildren();

  if (q && !state.exercises.some((e) => e.toLowerCase() === ql)) {
    const add = el('button', 'pick add', `+ Add “${q}”`);
    add.type = 'button';
    add.addEventListener('click', () => chooseExercise(addExercise(q)));
    list.append(add);
  }

  const recent = q ? [] : recentExercises();
  if (recent.length) {
    list.append(el('h4', null, 'Recent'));
    recent.forEach((e) => list.append(pickButton(e)));
    list.append(el('h4', null, 'All exercises'));
  }

  [...state.exercises]
    .sort((a, b) => a.localeCompare(b))
    .filter((e) => e.toLowerCase().includes(ql))
    .forEach((e) => list.append(pickButton(e)));
}

function openPicker() {
  els.pickerSearch.value = '';
  renderPicker();
  els.picker.showModal();
  els.pickerList.scrollTop = 0;
}

function onPickerEnter() {
  const q = els.pickerSearch.value.trim();
  if (!q) return;
  const matches = state.exercises.filter((e) => e.toLowerCase().includes(q.toLowerCase()));
  const exact = state.exercises.find((e) => e.toLowerCase() === q.toLowerCase());
  chooseExercise(exact || (matches.length === 1 ? matches[0] : addExercise(q)));
}

// ---------- GitHub sync ----------

function gh(path, opts = {}) {
  const { owner, repo, token } = state.settings;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` };
  if (opts.body) headers['Content-Type'] = 'application/json';
  return fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`, {
    ...opts,
    headers,
    cache: 'no-store',
  });
}

async function apiError(res) {
  let detail = '';
  try { detail = (await res.json()).message || ''; } catch { /* no body */ }
  const hints = {
    401: 'Token is invalid or expired',
    403: 'Token lacks write access to the repo',
    404: 'Repo not found, or the token has no access to it',
  };
  return new Error(`${hints[res.status] || 'GitHub error'} (${res.status}${detail ? `: ${detail}` : ''})`);
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function getFile(path) {
  const res = await gh(`/contents/${path}?ref=${encodeURIComponent(state.settings.branch)}`);
  if (res.status === 404) return { sha: null, text: '' };
  if (!res.ok) throw await apiError(res);
  const json = await res.json();
  return { sha: json.sha, text: b64decode(json.content || '') };
}

// Merge local changes for one month into sets/YYYY-MM.csv: upsert by id, drop deleted ids.
async function syncMonth(month, upserts, deleteIds) {
  const path = `sets/${month}.csv`;
  for (let attempt = 1; ; attempt++) {
    const { sha, text } = await getFile(path);
    const byId = new Map(parseCsv(text).map((r) => [r.id, r]));
    upserts.forEach((s) => byId.set(s.id, toRow(s)));
    deleteIds.forEach((id) => byId.delete(id));
    const csv = toCsv([...byId.values()].sort(byTimeAsc));
    if (csv === text) return; // already up to date

    const parts = [upserts.length && `+${upserts.length}`, deleteIds.length && `-${deleteIds.length}`].filter(Boolean);
    const body = { message: `Sync ${month} (${parts.join(' ')} sets)`, content: b64encode(csv), branch: state.settings.branch };
    if (sha) body.sha = sha;
    const res = await gh(`/contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
    if (res.ok) return;
    // 409/422 = the file changed under us (stale sha); re-read and merge again.
    if ((res.status === 409 || res.status === 422) && attempt < 3) { await sleep(800 * attempt); continue; }
    throw await apiError(res);
  }
}

async function sync() {
  if (!state.settings.token) return renderStatus();
  if (state.syncing) { state.syncQueued = true; return; }
  const dirty = state.sets.filter((s) => s.dirty);
  const tombs = state.tombstones.slice();
  if (!dirty.length && !tombs.length) { state.lastError = ''; return renderStatus(); }

  state.syncing = true;
  state.lastError = '';
  renderStatus();

  const months = new Map();
  const bucket = (m) => { if (!months.has(m)) months.set(m, { up: [], del: [] }); return months.get(m); };
  dirty.forEach((s) => bucket(s.date.slice(0, 7)).up.push(s));
  tombs.forEach((t) => bucket(t.date.slice(0, 7)).del.push(t.id));

  try {
    for (const [month, { up, del }] of months) {
      await syncMonth(month, up, del);
      // Mark each month done as it lands, so a later failure doesn't redo it.
      const upIds = new Set(up.map((s) => s.id));
      const delIds = new Set(del);
      state.sets.forEach((s) => { if (upIds.has(s.id)) s.dirty = false; });
      state.tombstones = state.tombstones.filter((t) => !delIds.has(t.id));
      persist();
    }
    state.noSignal = false;
  } catch (e) {
    // fetch() rejects with a TypeError when there's no connection: that's expected at the gym, not an error.
    if (e instanceof TypeError) state.noSignal = true;
    else state.lastError = e.message || String(e);
  } finally {
    state.syncing = false;
    renderToday();
    renderStatus();
    if (state.syncQueued) { state.syncQueued = false; sync(); }
  }
}

// Pull every monthly CSV into this phone (new phone, cleared Safari data, or history logged elsewhere).
async function restoreFromGitHub() {
  const res = await gh(`/contents/sets?ref=${encodeURIComponent(state.settings.branch)}`);
  if (res.status === 404) return 0;
  if (!res.ok) throw await apiError(res);
  const files = (await res.json()).filter((f) => f.type === 'file' && f.name.endsWith('.csv'));

  const known = new Set(state.sets.map((s) => s.id));
  const deleted = new Set(state.tombstones.map((t) => t.id));
  let added = 0;
  for (const f of files) {
    const { text } = await getFile(f.path);
    for (const row of parseCsv(text)) {
      if (!row.id || known.has(row.id) || deleted.has(row.id)) continue;
      state.sets.push({ ...fromRow(row), dirty: false });
      known.add(row.id);
      if (row.exercise && !state.exercises.includes(row.exercise)) state.exercises.push(row.exercise);
      added++;
    }
  }
  persist();
  return added;
}

async function testConnection() {
  const res = await gh('');
  if (!res.ok) throw await apiError(res);
  const repo = await res.json();
  return `Connected to ${repo.full_name}${repo.private ? ' (private)' : ''}.`;
}

// ---------- export ----------

async function exportCsv() {
  const csv = toCsv([...state.sets].sort(byTimeAsc).map(toRow));
  const name = `workouts-${today()}.csv`;
  const file = new File([csv], name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- settings ----------

function renderSettings() {
  const s = state.settings;
  els.sOwner.value = s.owner;
  els.sRepo.value = s.repo;
  els.sToken.value = s.token;
  els.sRepStep.value = s.repStep;
  els.sWeightStep.value = s.weightStep;
  renderExerciseList();
  const days = new Set(state.sets.map((x) => x.date)).size;
  els.sStats.textContent = `${state.sets.length} sets over ${days} ${days === 1 ? 'day' : 'days'} stored on this phone · ${pendingCount()} waiting to sync.`;
}

function renderExerciseList() {
  els.sExList.replaceChildren();
  for (const name of [...state.exercises].sort((a, b) => a.localeCompare(b))) {
    const li = el('li', null, name);
    const del = el('button', 'del', '×');
    del.type = 'button';
    del.setAttribute('aria-label', `Remove ${name}`);
    del.addEventListener('click', () => {
      if (!confirm(`Remove “${name}” from the list? Logged sets are kept.`)) return;
      state.exercises = state.exercises.filter((e) => e !== name);
      persist();
      renderExerciseList();
    });
    li.append(del);
    els.sExList.append(li);
  }
}

function readSettings() {
  const s = state.settings;
  s.owner = els.sOwner.value.trim() || DEFAULT_SETTINGS.owner;
  s.repo = els.sRepo.value.trim() || DEFAULT_SETTINGS.repo;
  s.token = els.sToken.value.trim();
  const repStep = parseNum(els.sRepStep.value);
  const weightStep = parseNum(els.sWeightStep.value);
  if (repStep > 0) s.repStep = Math.round(repStep);
  if (weightStep > 0) s.weightStep = round(weightStep);
  persist();
}

function setMsg(node, text, kind = '') {
  node.textContent = text;
  node.className = `hint ${kind}`;
}

// ---------- startup ----------

function init() {
  for (const id of ['syncBtn', 'settingsBtn', 'exerciseBtn', 'lastSession', 'reps', 'weight', 'setNum', 'rpe', 'notes',
    'saveBtn', 'undoBtn', 'today', 'toast', 'toastMsg', 'toastAction', 'picker', 'pickerSearch', 'pickerList',
    'settings', 'sOwner', 'sRepo', 'sToken', 'sTest', 'sTestMsg', 'sRepStep', 'sWeightStep', 'sNewEx', 'sAddEx',
    'sExList', 'sStats', 'sExport', 'sRestore', 'sDataMsg']) {
    els[id] = $(id);
  }

  document.querySelectorAll('[data-step]').forEach((b) =>
    b.addEventListener('click', () => step(b.dataset.step, Number(b.dataset.dir))));
  for (const input of [els.reps, els.weight, els.setNum]) {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('change', () => { readForm(); renderForm(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  }

  els.saveBtn.addEventListener('click', logSet);
  els.undoBtn.addEventListener('click', undoLast);
  els.exerciseBtn.addEventListener('click', openPicker);
  els.pickerSearch.addEventListener('input', renderPicker);
  els.pickerSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onPickerEnter(); } });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  els.syncBtn.addEventListener('click', () => {
    if (!state.settings.token) return openSettings();
    if (state.lastError) toast(state.lastError, { error: true });
    sync();
  });

  els.settingsBtn.addEventListener('click', openSettings);
  els.settings.addEventListener('close', () => { readSettings(); renderAll(); sync(); });
  for (const input of [els.sOwner, els.sRepo, els.sToken, els.sRepStep, els.sWeightStep]) {
    input.addEventListener('change', readSettings);
  }
  els.sTest.addEventListener('click', async () => {
    readSettings();
    if (!state.settings.token) return setMsg(els.sTestMsg, 'Paste a token first.', 'error');
    setMsg(els.sTestMsg, 'Testing…');
    try { setMsg(els.sTestMsg, await testConnection(), 'ok'); sync(); }
    catch (e) { setMsg(els.sTestMsg, e instanceof TypeError ? 'No connection.' : e.message, 'error'); }
  });
  const addFromSettings = () => {
    if (addExercise(els.sNewEx.value)) { els.sNewEx.value = ''; renderExerciseList(); }
  };
  els.sAddEx.addEventListener('click', addFromSettings);
  els.sNewEx.addEventListener('keydown', (e) => { if (e.key === 'Enter') addFromSettings(); });
  els.sExport.addEventListener('click', exportCsv);
  els.sRestore.addEventListener('click', async () => {
    readSettings();
    if (!state.settings.token) return setMsg(els.sDataMsg, 'Set up the token first.', 'error');
    els.sRestore.disabled = true;
    setMsg(els.sDataMsg, 'Downloading…');
    try {
      const n = await restoreFromGitHub();
      setMsg(els.sDataMsg, n ? `Restored ${n} sets.` : 'Nothing new: this phone already has everything.', 'ok');
      renderSettings();
      renderAll();
    } catch (e) {
      setMsg(els.sDataMsg, e instanceof TypeError ? 'No connection.' : e.message, 'error');
    } finally {
      els.sRestore.disabled = false;
    }
  });

  // Retry sync whenever there's a chance it'll work.
  window.addEventListener('online', () => { state.noSignal = false; sync(); });
  window.addEventListener('offline', renderStatus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { renderAll(); sync(); } // also rolls "Today" over after midnight
  });
  setInterval(() => { if (pendingCount() && !state.syncing) sync(); }, 30000);

  // Ask Safari not to evict our storage; home-screen apps are normally exempt anyway.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      toast('App updated', { action: { label: 'Reload', run: () => location.reload() } });
    });
  }

  renderAll();
  sync();
}

function openSettings() {
  renderSettings();
  setMsg(els.sTestMsg, state.lastError, state.lastError ? 'error' : '');
  setMsg(els.sDataMsg, '');
  els.settings.showModal();
}

init();
