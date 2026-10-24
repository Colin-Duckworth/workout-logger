'use strict';

/*
 * Workout Log: an offline-first logger for weight training sets and cardio.
 *
 * Every entry is saved to localStorage the moment it's logged; that copy on the
 * phone is the source of truth. Entries are then synced to monthly CSV files in a
 * private GitHub repo through the Contents API:
 *   sets/YYYY-MM.csv    one row per weight-training set
 *   cardio/YYYY-MM.csv  one row per cardio session
 * Each entry carries a UUID, so a sync merges by id: retries never duplicate
 * rows, and anything already in the file (e.g. edits made on a computer)
 * is preserved.
 */

const SET_COLUMNS = ['id', 'timestamp', 'date', 'exercise', 'variation', 'set_number', 'reps', 'weight_kg', 'rpe', 'notes'];
const CARDIO_COLUMNS = ['id', 'timestamp', 'date', 'activity', 'duration_min', 'distance_km', 'floors', 'level', 'notes'];

const CATEGORIES = ['Push', 'Pull', 'Legs', 'Arms', 'Core', 'Custom'];

const PRESS = ['Barbell', 'Dumbbell', 'Smith Machine', 'Machine'];
const BODYWEIGHT = ['Bodyweight', 'Weighted', 'Assisted'];

// [name, category, variations]
const DEFAULT_EXERCISES = [
  ['Bench Press', 'Push', PRESS],
  ['Incline Bench Press', 'Push', PRESS],
  ['Decline Bench Press', 'Push', ['Barbell', 'Dumbbell', 'Machine']],
  ['Close-Grip Bench Press', 'Push', ['Barbell', 'Smith Machine']],
  ['Floor Press', 'Push', ['Barbell', 'Dumbbell']],
  ['Overhead Press', 'Push', ['Barbell', 'Dumbbell', 'Seated Dumbbell', 'Smith Machine', 'Machine']],
  ['Push Press', 'Push', ['Barbell', 'Dumbbell']],
  ['Landmine Press', 'Push', ['Two-Arm', 'Single-Arm']],
  ['Dip', 'Push', BODYWEIGHT],
  ['Push-up', 'Push', ['Bodyweight', 'Weighted']],
  ['Chest Fly', 'Push', ['Dumbbell', 'Cable', 'Machine']],
  ['Lateral Raise', 'Push', ['Dumbbell', 'Cable', 'Machine']],
  ['Front Raise', 'Push', ['Dumbbell', 'Cable', 'Plate']],
  ['Pull-up', 'Pull', BODYWEIGHT],
  ['Chin-up', 'Pull', BODYWEIGHT],
  ['Lat Pulldown', 'Pull', ['Wide Grip', 'Close Grip', 'Neutral Grip', 'Single-Arm']],
  ['Row', 'Pull', ['Barbell', 'Dumbbell', 'Seated Cable', 'Machine', 'T-Bar', 'Chest-Supported']],
  ['Face Pull', 'Pull', []],
  ['Rear Delt Fly', 'Pull', ['Dumbbell', 'Cable', 'Machine']],
  ['Shrug', 'Pull', ['Barbell', 'Dumbbell', 'Trap Bar']],
  ['Straight-Arm Pulldown', 'Pull', []],
  ['Squat', 'Legs', ['Back', 'Front', 'Goblet', 'Smith Machine']],
  ['Deadlift', 'Legs', ['Conventional', 'Sumo', 'Trap Bar']],
  ['Romanian Deadlift', 'Legs', ['Barbell', 'Dumbbell']],
  ['Single-Leg RDL', 'Legs', ['Dumbbell', 'Kettlebell', 'Barbell', 'Bodyweight']],
  ['Bulgarian Split Squat', 'Legs', ['Dumbbell', 'Barbell', 'Smith Machine', 'Bodyweight']],
  ['Lunge', 'Legs', ['Dumbbell', 'Barbell', 'Bodyweight']],
  ['Step-up', 'Legs', ['Dumbbell', 'Barbell', 'Bodyweight']],
  ['Leg Press', 'Legs', []],
  ['Hack Squat', 'Legs', []],
  ['Leg Extension', 'Legs', []],
  ['Leg Curl', 'Legs', ['Lying', 'Seated']],
  ['Hip Thrust', 'Legs', ['Barbell', 'Machine', 'Smith Machine']],
  ['Good Morning', 'Legs', []],
  ['Hip Abduction', 'Legs', []],
  ['Calf Raise', 'Legs', ['Standing', 'Seated', 'Leg Press']],
  ['Bicep Curl', 'Arms', ['Dumbbell', 'Barbell', 'EZ Bar', 'Cable']],
  ['Hammer Curl', 'Arms', ['Dumbbell', 'Cable']],
  ['Preacher Curl', 'Arms', ['EZ Bar', 'Dumbbell', 'Machine']],
  ['Tricep Pushdown', 'Arms', ['Rope', 'Straight Bar', 'V-Bar']],
  ['Skull Crusher', 'Arms', ['EZ Bar', 'Barbell', 'Dumbbell']],
  ['Overhead Tricep Extension', 'Arms', ['Dumbbell', 'Cable']],
  ['Hanging Leg Raise', 'Core', []],
  ['Cable Crunch', 'Core', []],
  ['Ab Wheel', 'Core', []],
].map(([name, category, variations]) => ({ name, category, variations }));

// Names from the first exercise list that are now variations (Row → Barbell, Bicep Curl → Dumbbell).
const RETIRED_EXERCISES = ['Barbell Row', 'Dumbbell Curl'];

const CARDIO_TYPES = { running: 'Running', stairmaster: 'Stairmaster' };
const DEFAULT_ACTIVITIES = ['Basketball', 'Swimming', 'Padel', 'Soccer', 'Cycling', 'Tennis', 'Hiking', 'Rowing', 'Climbing', 'Yoga'];

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
  cardio: 'wl.cardio',
  tombstones: 'wl.tombstones',
  exercises: 'wl.exercises.v2',
  legacyExercises: 'wl.exercises',
  activities: 'wl.activities',
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

// First run on v2: start from the new catalogue and keep any exercises you added yourself.
function loadExercises() {
  const saved = load(KEY.exercises, null);
  if (saved) return saved;
  const list = DEFAULT_EXERCISES.map((e) => ({ ...e, variations: [...e.variations] }));
  for (const name of load(KEY.legacyExercises, [])) {
    if (typeof name === 'string' && !RETIRED_EXERCISES.includes(name) && !list.some((e) => e.name === name)) {
      list.push({ name, category: 'Custom', variations: [] });
    }
  }
  return list;
}

const state = {
  sets: load(KEY.sets, []),               // weight-training sets on (or restored to) this device
  cardio: load(KEY.cardio, []),           // cardio sessions
  tombstones: load(KEY.tombstones, []).map((t) => ({ kind: 'strength', ...t })), // deleted, not yet removed from GitHub
  exercises: loadExercises(),             // [{name, category, variations}]
  activities: load(KEY.activities, DEFAULT_ACTIVITIES.slice()), // "Other" cardio activities
  settings: { ...DEFAULT_SETTINGS, ...load(KEY.settings, {}) },
  current: {
    mode: 'weights',
    exercise: '',
    variation: '',
    reps: 5,
    weight: 20,
    setNumber: null,
    cardioType: 'running',
    activity: 'Basketball',
    duration: 30,
    distance: 5,
    floors: 100,
    level: 8,
    ...load(KEY.current, {}),
  },
  syncing: false,
  syncQueued: false,
  noSignal: false,
  lastError: '',
};

// The two record types and where each one syncs to.
const TABLES = {
  strength: { key: 'sets', dir: 'sets', columns: SET_COLUMNS },
  cardio: { key: 'cardio', dir: 'cardio', columns: CARDIO_COLUMNS },
};
const entries = (kind) => state[TABLES[kind].key];

// Throws if storage is full/blocked so callers can tell the user instead of silently losing an entry.
function persist() {
  localStorage.setItem(KEY.sets, JSON.stringify(state.sets));
  localStorage.setItem(KEY.cardio, JSON.stringify(state.cardio));
  localStorage.setItem(KEY.tombstones, JSON.stringify(state.tombstones));
  localStorage.setItem(KEY.exercises, JSON.stringify(state.exercises));
  localStorage.setItem(KEY.activities, JSON.stringify(state.activities));
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
// (milliseconds keep entries logged within the same second in the right order).
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

// Duration in minutes from "45", "32:15" / "32.15" / "32,15" (mm:ss) or "1:05:00" (h:mm:ss).
// The decimal keypad has no colon, so "." and "," work as the separator too.
function parseDuration(v) {
  const parts = String(v).trim().split(/[:.,]/);
  if (!parts.every((p) => /^\d+$/.test(p))) return NaN;
  const [a, b, c] = parts.map(Number);
  if (parts.length === 1) return a;
  if (parts.length === 2 && b < 60) return a + b / 60;
  if (parts.length === 3 && b < 60 && c < 60) return a * 60 + b + c / 60;
  return NaN;
}

// 32.25 → "32:15", 65 → "1:05:00"
function fmtDuration(min) {
  const total = Math.round(Number(min) * 60);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Whole minutes read better as "90 min"; anything with seconds as "32:15".
function fmtDurationShort(min) {
  const total = Math.round(Number(min) * 60);
  return total % 60 === 0 ? `${total / 60} min` : fmtDuration(min);
}

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const fmtNum = (n) => String(round(Number(n) || 0));
const optNum = (v) => (v === '' || v == null ? '' : Number(v));

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

function button(cls, text, onClick) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const byTimeDesc = (a, b) => String(b.timestamp).localeCompare(String(a.timestamp));
const byTimeAsc = (a, b) => String(a.timestamp).localeCompare(String(b.timestamp));

// ---------- CSV ----------

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, rows) {
  const lines = rows.map((r) => columns.map((c) => csvCell(r[c])).join(','));
  return [columns.join(','), ...lines].join('\n') + '\n';
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

const toRow = (columns, e) => Object.fromEntries(columns.map((c) => [c, e[c]]));

function fromRow(kind, r) {
  const base = { id: r.id, timestamp: r.timestamp, date: r.date, notes: r.notes || '' };
  if (kind === 'cardio') {
    return {
      ...base,
      activity: r.activity,
      duration_min: Number(r.duration_min) || 0,
      distance_km: optNum(r.distance_km),
      floors: optNum(r.floors),
      level: optNum(r.level),
    };
  }
  return {
    ...base,
    exercise: r.exercise,
    variation: r.variation || '',
    set_number: Number(r.set_number) || 1,
    reps: Number(r.reps) || 0,
    weight_kg: Number(r.weight_kg) || 0,
    rpe: optNum(r.rpe),
  };
}

// ---------- queries ----------

const exerciseDef = (name) => state.exercises.find((e) => e.name === name);
const liftName = (s) => (s.variation ? `${s.exercise} · ${s.variation}` : s.exercise);
const sameLift = (s, exercise, variation) => s.exercise === exercise && (s.variation || '') === (variation || '');

// Sets on a date, optionally only one exercise + variation.
const setsOn = (date, exercise, variation) =>
  state.sets.filter((s) => s.date === date && (exercise === undefined || sameLift(s, exercise, variation)));

function autoSetNumber() {
  const { exercise, variation } = state.current;
  const nums = setsOn(today(), exercise, variation).map((s) => Number(s.set_number) || 0);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

function currentSetNumber() {
  const c = state.current;
  return c.setNumber ?? (c.exercise ? autoSetNumber() : 1);
}

// Most recent day before today on which this exercise + variation was done.
function lastSession(exercise, variation) {
  const t = today();
  let date = null;
  for (const s of state.sets) {
    if (sameLift(s, exercise, variation) && s.date < t && (!date || s.date > date)) date = s.date;
  }
  if (!date) return null;
  return { date, sets: setsOn(date, exercise, variation).sort((a, b) => a.set_number - b.set_number) };
}

// Latest set of an exercise; pass a variation to narrow it down.
function latestSet(exercise, variation) {
  let latest = null;
  for (const s of state.sets) {
    if (s.exercise !== exercise || (variation !== undefined && (s.variation || '') !== variation)) continue;
    if (!latest || s.timestamp > latest.timestamp) latest = s;
  }
  return latest;
}

function recentExercises(limit = 6) {
  const seen = [];
  for (const s of [...state.sets].sort(byTimeDesc)) {
    if (!seen.includes(s.exercise) && exerciseDef(s.exercise)) seen.push(s.exercise);
    if (seen.length >= limit) break;
  }
  return seen;
}

const cardioActivity = () => CARDIO_TYPES[state.current.cardioType] || state.current.activity;

function latestCardio(activity, beforeDate) {
  let latest = null;
  for (const e of state.cardio) {
    if (e.activity !== activity || (beforeDate && e.date >= beforeDate)) continue;
    if (!latest || e.timestamp > latest.timestamp) latest = e;
  }
  return latest;
}

function describeCardio(e) {
  const parts = [fmtDurationShort(e.duration_min)];
  if (Number(e.distance_km) > 0) {
    parts.push(`${fmtNum(e.distance_km)} km`, `${fmtDuration(e.duration_min / e.distance_km)}/km`);
  }
  if (e.floors !== '' && e.floors != null) parts.push(`${e.floors} floors`);
  if (e.level !== '' && e.level != null) parts.push(`level ${e.level}`);
  return parts.join(' · ');
}

const pendingCount = () =>
  state.sets.filter((s) => s.dirty).length + state.cardio.filter((e) => e.dirty).length + state.tombstones.length;

// ---------- rendering ----------

const els = {};

function setPressed(container, value, attr) {
  container.querySelectorAll(`[${attr}]`).forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute(attr) === value)));
}

// Write a value into an input unless you're typing in it.
function setInput(input, value) {
  if (document.activeElement !== input) input.value = value;
}

function chip(label, pressed, onClick, extraClass = '') {
  const b = button(`chip ${extraClass}`.trim(), label, onClick);
  if (pressed != null) b.setAttribute('aria-pressed', String(pressed));
  return b;
}

function renderForm() {
  const weights = state.current.mode === 'weights';
  setPressed(els.modeSeg, state.current.mode, 'data-mode');
  els.weightsForm.hidden = !weights;
  els.cardioForm.hidden = weights;
  if (weights) renderWeightsForm();
  else renderCardioForm();
}

function renderWeightsForm() {
  const c = state.current;
  els.exerciseBtn.textContent = c.exercise || 'Choose exercise';
  els.exerciseBtn.classList.toggle('empty', !c.exercise);
  setInput(els.reps, c.reps);
  setInput(els.weight, fmtNum(c.weight));
  setInput(els.setNum, currentSetNumber());
  els.saveBtn.disabled = !c.exercise;
  els.saveBtn.textContent = c.exercise ? `Log set ${currentSetNumber()}` : 'Choose an exercise first';

  els.variationChips.replaceChildren();
  els.variationChips.hidden = !c.exercise;
  if (c.exercise) {
    for (const v of exerciseDef(c.exercise)?.variations || []) {
      els.variationChips.append(chip(v, v === c.variation, () => chooseVariation(v)));
    }
    els.variationChips.append(chip('+ Variation', null, addVariation, 'add'));
  }

  const last = c.exercise && lastSession(c.exercise, c.variation);
  els.lastSession.textContent = !c.exercise ? '' : last
    ? `Last time (${fmtDate(last.date)}): ${last.sets.map((s) => `${s.reps}×${fmtNum(s.weight_kg)}`).join(', ')} kg`
    : `First time logging ${c.variation ? 'this variation' : 'this one'}.`;
}

function renderCardioForm() {
  const c = state.current;
  const activity = cardioActivity();
  setPressed(els.cardioSeg, c.cardioType, 'data-cardio');

  els.activityChips.hidden = c.cardioType !== 'other';
  if (c.cardioType === 'other') {
    els.activityChips.replaceChildren();
    for (const a of state.activities) els.activityChips.append(chip(a, a === c.activity, () => chooseActivity(a)));
    els.activityChips.append(chip('+ Activity', null, addActivity, 'add'));
  }

  els.distanceField.hidden = c.cardioType !== 'running';
  els.floorsField.hidden = c.cardioType !== 'stairmaster';
  els.levelField.hidden = c.cardioType !== 'stairmaster';
  setInput(els.cDuration, Math.round(c.duration * 60) % 60 ? fmtDuration(c.duration) : String(Math.round(c.duration)));
  setInput(els.cDistance, fmtNum(c.distance));
  setInput(els.cFloors, Math.round(c.floors));
  setInput(els.cLevel, fmtNum(c.level));

  const last = activity && latestCardio(activity, today());
  els.cardioHint.textContent = !activity ? 'Pick an activity.' : last
    ? `Last time (${fmtDate(last.date)}): ${describeCardio(last)}`
    : `First time logging ${activity.toLowerCase()}.`;

  els.saveBtn.disabled = !activity;
  els.saveBtn.textContent = { running: 'Log run', stairmaster: 'Log stairmaster' }[c.cardioType] ||
    (activity ? `Log ${activity.toLowerCase()}` : 'Pick an activity');
}

function renderToday() {
  const t = today();
  const items = [
    ...setsOn(t).map((e) => ({ kind: 'strength', e, group: `s|${liftName(e)}` })),
    ...state.cardio.filter((e) => e.date === t).map((e) => ({ kind: 'cardio', e, group: `c|${e.activity}` })),
  ].sort((a, b) => byTimeDesc(a.e, b.e));

  els.today.replaceChildren();
  els.undoBtn.hidden = !items.length;
  if (!items.length) {
    els.today.append(el('p', 'empty-note', 'Nothing logged today yet.'));
    return;
  }

  // Groups keep the order of their newest entry, so what you're doing now stays on top.
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }

  for (const list of groups.values()) {
    const first = list[0];
    const group = el('div', 'group');
    let title;
    if (first.kind === 'strength') {
      const volume = list.reduce((sum, { e }) => sum + e.reps * e.weight_kg, 0);
      title = button('group-title', liftName(first.e), () => chooseExercise(first.e.exercise, first.e.variation || ''));
      title.append(el('small', null, `${list.length} ${list.length === 1 ? 'set' : 'sets'} · ${fmtNum(volume)} kg vol`));
    } else {
      const minutes = list.reduce((sum, { e }) => sum + Number(e.duration_min), 0);
      title = button('group-title', first.e.activity, () => selectCardioActivity(first.e.activity));
      title.append(el('small', null, `${list.length > 1 ? `${list.length} sessions · ` : ''}${fmtDurationShort(minutes)}`));
    }
    group.append(title);
    for (const item of list) group.append(item.kind === 'strength' ? setRow(item.e) : cardioRow(item.e));
    els.today.append(group);
  }
}

function pendingDot(e) {
  const dot = el('span', e.dirty ? 'dot pending' : 'dot');
  if (e.dirty) dot.title = 'Waiting to sync';
  return dot;
}

function deleteButton(kind, e, label) {
  const del = button('del', '×', () => deleteEntry(kind, e.id, { confirm: true }));
  del.setAttribute('aria-label', label);
  return del;
}

function setRow(s) {
  const row = el('div', 'set-row');
  const meta = [s.rpe !== '' && s.rpe != null ? `RPE ${s.rpe}` : '', s.notes].filter(Boolean).join(' · ');
  row.append(el('span', 'set-n', `#${s.set_number}`), el('span', 'set-main', `${s.reps} × ${fmtNum(s.weight_kg)} kg`),
    el('span', 'set-meta', meta), pendingDot(s), deleteButton('strength', s, `Delete set ${s.set_number}`));
  return row;
}

function cardioRow(e) {
  const row = el('div', 'set-row cardio-row');
  const text = el('div', 'cardio-text');
  text.append(el('span', 'set-main', describeCardio(e)));
  if (e.notes) text.append(el('span', 'set-meta', e.notes));
  row.append(text, pendingDot(e), deleteButton('cardio', e, `Delete ${e.activity}`));
  return row;
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

function logEntry() {
  if (Date.now() - lastSaveAt < 400) return; // ignore accidental double taps
  readForm();
  if (state.current.mode === 'weights') logSet();
  else logCardio();
}

function logSet() {
  const c = state.current;
  if (!c.exercise) return;
  const reps = Math.round(Number(c.reps));
  const weight = round(Number(c.weight));
  if (!Number.isFinite(reps) || reps < 0) return toast('Reps must be a number', { error: true });
  if (!Number.isFinite(weight) || weight < 0) return toast('Weight must be a number', { error: true });
  const rpe = parseNum(els.rpe.value);

  const set = {
    ...stamp(),
    exercise: c.exercise,
    variation: c.variation || '',
    set_number: currentSetNumber(),
    reps,
    weight_kg: weight,
    rpe: Number.isFinite(rpe) ? rpe : '',
    notes: els.notes.value.trim(),
    dirty: true,
  };
  c.setNumber = null;
  if (addEntry('strength', set, `Set ${set.set_number} logged: ${set.reps} × ${fmtNum(set.weight_kg)} kg`)) {
    els.rpe.value = '';
    els.notes.value = '';
  }
}

function logCardio() {
  const c = state.current;
  const activity = cardioActivity();
  if (!activity) return;
  if (!(c.duration > 0)) return toast('Enter a duration', { error: true });

  const entry = {
    ...stamp(),
    activity,
    duration_min: round(c.duration),
    distance_km: c.cardioType === 'running' ? round(c.distance) : '',
    floors: c.cardioType === 'stairmaster' ? Math.round(c.floors) : '',
    level: c.cardioType === 'stairmaster' ? round(c.level, 1) : '',
    notes: els.cNotes.value.trim(),
    dirty: true,
  };
  if (addEntry('cardio', entry, `${activity} logged: ${describeCardio(entry)}`)) els.cNotes.value = '';
}

function stamp() {
  const now = new Date();
  return { id: uuid(), timestamp: localIso(now), date: localDate(now) };
}

function addEntry(kind, entry, message) {
  entries(kind).push(entry);
  try {
    persist();
  } catch (e) {
    entries(kind).pop();
    toast(`Could not save on this phone: ${e.message}`, { error: true });
    return false;
  }
  lastSaveAt = Date.now();
  renderAll();
  toast(message, { action: { label: 'Undo', run: () => deleteEntry(kind, entry.id) } });
  sync();
  return true;
}

function deleteEntry(kind, id, { confirm: ask = false } = {}) {
  const e = entries(kind).find((x) => x.id === id);
  if (!e) return;
  const what = kind === 'strength'
    ? `${liftName(e)} set #${e.set_number} (${e.reps} × ${fmtNum(e.weight_kg)} kg)`
    : `${e.activity} (${describeCardio(e)})`;
  if (ask && !confirm(`Delete ${what}?`)) return;
  state[TABLES[kind].key] = entries(kind).filter((x) => x.id !== id);
  state.tombstones.push({ id, date: e.date, kind });
  try { persist(); } catch (err) { return toast(`Could not save: ${err.message}`, { error: true }); }
  renderAll();
  toast(kind === 'strength' ? 'Set deleted' : 'Session deleted');
  sync();
}

function undoLast() {
  const t = today();
  const latest = [
    ...setsOn(t).map((e) => ({ kind: 'strength', e })),
    ...state.cardio.filter((e) => e.date === t).map((e) => ({ kind: 'cardio', e })),
  ].sort((a, b) => byTimeDesc(a.e, b.e))[0];
  if (latest) deleteEntry(latest.kind, latest.e.id, { confirm: true });
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

  const duration = parseDuration(els.cDuration.value);
  const distance = parseNum(els.cDistance.value);
  const floors = parseNum(els.cFloors.value);
  const level = parseNum(els.cLevel.value);
  if (duration >= 0) c.duration = round(duration, 4);
  if (distance >= 0) c.distance = round(distance);
  if (floors >= 0) c.floors = Math.round(floors);
  if (level >= 0) c.level = round(level, 1);
  saveCurrent();
}

function step(field, dir) {
  readForm();
  const c = state.current;
  const { repStep, weightStep } = state.settings;
  switch (field) {
    case 'reps': c.reps = Math.max(0, Math.round(c.reps + dir * repStep)); break;
    case 'weight': c.weight = Math.max(0, round(c.weight + dir * weightStep)); break;
    case 'set': c.setNumber = Math.max(1, currentSetNumber() + dir); break;
    case 'duration': c.duration = Math.max(0, round(c.duration + dir, 4)); break;
    case 'distance': c.distance = Math.max(0, round(c.distance + dir * 0.5)); break;
    case 'floors': c.floors = Math.max(0, Math.round(c.floors + dir * 5)); break;
    case 'level': c.level = Math.max(0, round(c.level + dir, 1)); break;
  }
  saveCurrent();
  renderForm();
}

function setMode(mode) {
  readForm();
  state.current.mode = mode;
  saveCurrent();
  renderForm();
}

// Start from whatever you did last time on this exercise + variation.
function prefillLift() {
  const c = state.current;
  const last = latestSet(c.exercise, c.variation);
  if (last) { c.reps = Number(last.reps); c.weight = Number(last.weight_kg); }
  c.setNumber = null;
}

function chooseExercise(name, variation) {
  const c = state.current;
  c.mode = 'weights';
  if (c.exercise !== name || (variation !== undefined && variation !== c.variation)) {
    const vars = exerciseDef(name)?.variations || [];
    if (variation === undefined) {
      // Default to the variation you used last time, else the first one listed.
      const last = latestSet(name);
      variation = last && vars.includes(last.variation) ? last.variation : (vars[0] || '');
    }
    c.exercise = name;
    c.variation = variation;
    prefillLift();
  }
  saveCurrent();
  if (els.picker.open) els.picker.close();
  renderForm();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function chooseVariation(variation) {
  readForm();
  state.current.variation = variation;
  prefillLift();
  saveCurrent();
  renderForm();
}

function addVariation() {
  const c = state.current;
  const name = (prompt(`New variation for ${c.exercise}`, '') || '').trim().replace(/\s+/g, ' ');
  if (!name) return;
  let def = exerciseDef(c.exercise);
  if (!def) {
    def = { name: c.exercise, category: 'Custom', variations: [] };
    state.exercises.push(def);
  }
  const existing = def.variations.find((v) => v.toLowerCase() === name.toLowerCase());
  if (!existing) def.variations.push(name);
  try { persist(); } catch (e) { toast(`Could not save: ${e.message}`, { error: true }); }
  chooseVariation(existing || name);
}

function addExercise(name) {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  const existing = state.exercises.find((e) => e.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing.name;
  state.exercises.push({ name: clean, category: 'Custom', variations: [] });
  try { persist(); } catch (e) { toast(`Could not save: ${e.message}`, { error: true }); }
  return clean;
}

function prefillCardio() {
  const c = state.current;
  const last = latestCardio(cardioActivity());
  if (!last) return;
  if (last.duration_min) c.duration = Number(last.duration_min);
  if (last.distance_km !== '') c.distance = Number(last.distance_km);
  if (last.floors !== '') c.floors = Number(last.floors);
  if (last.level !== '') c.level = Number(last.level);
}

function chooseCardioType(type) {
  readForm();
  state.current.cardioType = type;
  prefillCardio();
  saveCurrent();
  renderForm();
}

function chooseActivity(activity) {
  readForm();
  state.current.activity = activity;
  prefillCardio();
  saveCurrent();
  renderForm();
}

function selectCardioActivity(activity) {
  const type = Object.keys(CARDIO_TYPES).find((k) => CARDIO_TYPES[k] === activity);
  state.current.mode = 'cardio';
  if (type) chooseCardioType(type);
  else { state.current.cardioType = 'other'; chooseActivity(activity); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function addActivity() {
  const name = (prompt('New activity (e.g. Volleyball)', '') || '').trim().replace(/\s+/g, ' ');
  if (!name) return;
  const existing = state.activities.find((a) => a.toLowerCase() === name.toLowerCase());
  if (!existing) {
    state.activities.push(name);
    try { persist(); } catch (e) { toast(`Could not save: ${e.message}`, { error: true }); }
  }
  chooseActivity(existing || name);
}

// ---------- exercise picker ----------

function pickButton(def) {
  const b = button(def.name === state.current.exercise ? 'pick current' : 'pick', def.name, () => chooseExercise(def.name));
  if (def.variations.length) b.append(el('small', null, def.variations.join(' · ')));
  return b;
}

function renderPicker() {
  const q = els.pickerSearch.value.trim().toLowerCase();
  const list = els.pickerList;
  list.replaceChildren();
  const sorted = [...state.exercises].sort((a, b) => a.name.localeCompare(b.name));

  if (q) {
    if (!state.exercises.some((e) => e.name.toLowerCase() === q)) {
      const name = els.pickerSearch.value.trim();
      list.append(button('pick add', `+ Add “${name}”`, () => chooseExercise(addExercise(name))));
    }
    sorted.filter((e) => e.name.toLowerCase().includes(q)).forEach((e) => list.append(pickButton(e)));
    return;
  }

  const recent = recentExercises();
  if (recent.length) {
    list.append(el('h4', null, 'Recent'));
    recent.forEach((name) => list.append(pickButton(exerciseDef(name))));
  }
  for (const category of CATEGORIES) {
    const inCategory = sorted.filter((e) => (CATEGORIES.includes(e.category) ? e.category : 'Custom') === category);
    if (!inCategory.length) continue;
    list.append(el('h4', null, category));
    inCategory.forEach((e) => list.append(pickButton(e)));
  }
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
  const ql = q.toLowerCase();
  const matches = state.exercises.filter((e) => e.name.toLowerCase().includes(ql));
  const exact = state.exercises.find((e) => e.name.toLowerCase() === ql);
  chooseExercise(exact ? exact.name : matches.length === 1 ? matches[0].name : addExercise(q));
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

// Merge local changes into one monthly file (e.g. cardio/2026-10.csv): upsert by id, drop deleted ids.
async function syncFile(kind, month, upserts, deleteIds) {
  const { dir, columns } = TABLES[kind];
  const path = `${dir}/${month}.csv`;
  for (let attempt = 1; ; attempt++) {
    const { sha, text } = await getFile(path);
    const byId = new Map(parseCsv(text).map((r) => [r.id, r]));
    upserts.forEach((e) => byId.set(e.id, toRow(columns, e)));
    deleteIds.forEach((id) => byId.delete(id));
    const csv = toCsv(columns, [...byId.values()].sort(byTimeAsc));
    if (csv === text) return; // already up to date

    const counts = [upserts.length && `+${upserts.length}`, deleteIds.length && `-${deleteIds.length}`].filter(Boolean);
    const body = { message: `Sync ${path} (${counts.join(' ')})`, content: b64encode(csv), branch: state.settings.branch };
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
  if (!pendingCount()) { state.lastError = ''; return renderStatus(); }

  state.syncing = true;
  state.lastError = '';
  renderStatus();

  // One bucket per file: kind + month.
  const buckets = new Map();
  const bucket = (kind, date) => {
    const key = `${kind}|${date.slice(0, 7)}`;
    if (!buckets.has(key)) buckets.set(key, { kind, month: date.slice(0, 7), up: [], del: [] });
    return buckets.get(key);
  };
  for (const kind of Object.keys(TABLES)) {
    entries(kind).filter((e) => e.dirty).forEach((e) => bucket(kind, e.date).up.push(e));
  }
  state.tombstones.forEach((t) => bucket(t.kind, t.date).del.push(t.id));

  try {
    for (const { kind, month, up, del } of buckets.values()) {
      await syncFile(kind, month, up, del);
      // Mark each file done as it lands, so a later failure doesn't redo it.
      const upIds = new Set(up.map((e) => e.id));
      const delIds = new Set(del);
      entries(kind).forEach((e) => { if (upIds.has(e.id)) e.dirty = false; });
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

// Pull every monthly CSV onto this phone (new phone, cleared Safari data, or history logged elsewhere).
async function restoreFromGitHub() {
  const deleted = new Set(state.tombstones.map((t) => t.id));
  let added = 0;
  for (const kind of Object.keys(TABLES)) {
    const res = await gh(`/contents/${TABLES[kind].dir}?ref=${encodeURIComponent(state.settings.branch)}`);
    if (res.status === 404) continue;
    if (!res.ok) throw await apiError(res);
    const files = (await res.json()).filter((f) => f.type === 'file' && f.name.endsWith('.csv'));
    const known = new Set(entries(kind).map((e) => e.id));
    for (const f of files) {
      const { text } = await getFile(f.path);
      for (const row of parseCsv(text)) {
        if (!row.id || known.has(row.id) || deleted.has(row.id)) continue;
        const entry = fromRow(kind, row);
        entries(kind).push({ ...entry, dirty: false });
        known.add(row.id);
        rememberNames(kind, entry);
        added++;
      }
    }
  }
  persist();
  return added;
}

// Make restored exercises, variations and activities show up in the pickers.
function rememberNames(kind, e) {
  if (kind === 'cardio') {
    if (e.activity && !Object.values(CARDIO_TYPES).includes(e.activity) && !state.activities.includes(e.activity)) {
      state.activities.push(e.activity);
    }
    return;
  }
  if (!e.exercise) return;
  let def = exerciseDef(e.exercise);
  if (!def) {
    def = { name: e.exercise, category: 'Custom', variations: [] };
    state.exercises.push(def);
  }
  if (e.variation && !def.variations.includes(e.variation)) def.variations.push(e.variation);
}

async function testConnection() {
  const res = await gh('');
  if (!res.ok) throw await apiError(res);
  const repo = await res.json();
  return `Connected to ${repo.full_name}${repo.private ? ' (private)' : ''}.`;
}

// ---------- export ----------

async function exportCsv() {
  const stampDate = today();
  const files = Object.entries(TABLES)
    .filter(([kind]) => entries(kind).length)
    .map(([kind, { dir, columns }]) => new File(
      [toCsv(columns, [...entries(kind)].sort(byTimeAsc).map((e) => toRow(columns, e)))],
      `${dir}-${stampDate}.csv`,
      { type: 'text/csv' },
    ));
  if (!files.length) return setMsg(els.sDataMsg, 'Nothing logged yet.');
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title: `Workout log ${stampDate}` }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  for (const file of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
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
  renderActivityList();
  const days = new Set([...state.sets, ...state.cardio].map((x) => x.date)).size;
  els.sStats.textContent = `${state.sets.length} sets and ${state.cardio.length} cardio sessions over ${days} ` +
    `${days === 1 ? 'day' : 'days'} on this phone · ${pendingCount()} waiting to sync.`;
}

function renderExerciseList() {
  els.sExList.replaceChildren();
  for (const category of CATEGORIES) {
    const defs = state.exercises
      .filter((e) => (CATEGORIES.includes(e.category) ? e.category : 'Custom') === category)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!defs.length) continue;
    els.sExList.append(el('h4', null, category));
    const ul = el('ul', 'ex-list');
    for (const def of defs) {
      const li = el('li');
      const name = button('ex-name', def.name, () => editVariations(def));
      name.append(el('small', null, def.variations.length ? def.variations.join(' · ') : 'Tap to add variations'));
      const del = button('del', '×', () => {
        if (!confirm(`Remove “${def.name}” from the list? Logged sets are kept.`)) return;
        state.exercises = state.exercises.filter((e) => e !== def);
        persist();
        renderExerciseList();
      });
      del.setAttribute('aria-label', `Remove ${def.name}`);
      li.append(name, del);
      ul.append(li);
    }
    els.sExList.append(ul);
  }
}

function editVariations(def) {
  const input = prompt(`Variations for ${def.name}, separated by commas`, def.variations.join(', '));
  if (input == null) return;
  const seen = new Set();
  def.variations = input.split(',').map((v) => v.trim().replace(/\s+/g, ' ')).filter((v) => {
    const key = v.toLowerCase();
    if (!v || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const c = state.current;
  if (c.exercise === def.name && c.variation && !def.variations.includes(c.variation)) {
    c.variation = def.variations[0] || '';
  }
  persist();
  renderExerciseList();
}

function renderActivityList() {
  els.sActList.replaceChildren();
  for (const name of state.activities) {
    const li = el('li');
    li.append(el('span', null, name));
    const del = button('del', '×', () => {
      if (!confirm(`Remove “${name}”? Logged sessions are kept.`)) return;
      state.activities = state.activities.filter((a) => a !== name);
      persist();
      renderActivityList();
    });
    del.setAttribute('aria-label', `Remove ${name}`);
    li.append(del);
    els.sActList.append(li);
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

function openSettings() {
  renderSettings();
  setMsg(els.sTestMsg, state.lastError, state.lastError ? 'error' : '');
  setMsg(els.sDataMsg, '');
  els.settings.showModal();
}

// ---------- startup ----------

function init() {
  document.querySelectorAll('[id]').forEach((node) => { els[node.id] = node; });

  // A remembered exercise may predate variations; pick a valid one.
  const c = state.current;
  const vars = exerciseDef(c.exercise)?.variations || [];
  if (c.exercise && vars.length && !vars.includes(c.variation)) c.variation = vars[0];

  document.querySelectorAll('[data-step]').forEach((b) =>
    b.addEventListener('click', () => step(b.dataset.step, Number(b.dataset.dir))));
  for (const input of document.querySelectorAll('.stepper input')) {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('change', () => { readForm(); renderForm(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  }
  els.modeSeg.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  els.cardioSeg.querySelectorAll('[data-cardio]').forEach((b) =>
    b.addEventListener('click', () => chooseCardioType(b.dataset.cardio)));

  els.saveBtn.addEventListener('click', logEntry);
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
  const addActivityFromSettings = () => {
    const name = els.sNewAct.value.trim().replace(/\s+/g, ' ');
    if (name && !state.activities.some((a) => a.toLowerCase() === name.toLowerCase())) {
      state.activities.push(name);
      persist();
    }
    els.sNewAct.value = '';
    renderActivityList();
  };
  els.sAddAct.addEventListener('click', addActivityFromSettings);
  els.sNewAct.addEventListener('keydown', (e) => { if (e.key === 'Enter') addActivityFromSettings(); });
  els.sExport.addEventListener('click', exportCsv);
  els.sRestore.addEventListener('click', async () => {
    readSettings();
    if (!state.settings.token) return setMsg(els.sDataMsg, 'Set up the token first.', 'error');
    els.sRestore.disabled = true;
    setMsg(els.sDataMsg, 'Downloading…');
    try {
      const n = await restoreFromGitHub();
      setMsg(els.sDataMsg, n ? `Restored ${n} entries.` : 'Nothing new: this phone already has everything.', 'ok');
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

  try { persist(); } catch { /* first-run migration is retried on the next save */ }
  renderAll();
  sync();
}

init();
