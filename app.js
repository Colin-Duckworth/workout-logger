'use strict';

/*
 * Workout Log: an offline-first logger for workouts (sets grouped into workouts,
 * optionally started from a template) and cardio sessions.
 *
 * Everything is saved to localStorage the moment it's logged; that copy on the
 * phone is the source of truth. Entries then sync to monthly CSV files in a
 * private GitHub repo through the Contents API:
 *   workouts/YYYY-MM.csv  one row per workout (date, name, template, start/end)
 *   sets/YYYY-MM.csv      one row per set, tagged with its workout
 *   cardio/YYYY-MM.csv    one row per cardio session
 * Each row carries a UUID, so a sync merges by id: retries never duplicate rows,
 * and anything already in the file (e.g. edits made on a computer) is preserved.
 */

// Stamped by release.sh (same value as sw.js VERSION) and shown in Settings.
const APP_VERSION = '20261031-132933';

const WORKOUT_COLUMNS = ['id', 'date', 'name', 'template', 'started_at', 'ended_at', 'duration_min'];
const SET_COLUMNS = ['id', 'timestamp', 'date', 'workout_id', 'workout', 'exercise', 'variation', 'set_number', 'reps',
  'weight_kg', 'warmup', 'failure', 'rpe', 'notes'];
const CARDIO_COLUMNS = ['id', 'timestamp', 'date', 'activity', 'duration_min', 'distance_km', 'floors', 'level', 'notes'];
const BODYWEIGHT_COLUMNS = ['id', 'timestamp', 'date', 'weight_kg', 'notes'];

const CATEGORIES = ['Push', 'Pull', 'Legs', 'Arms', 'Core', 'Rehab', 'Custom'];

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
  ['Pec Deck', 'Push', []],
  ['Lateral Raise', 'Push', ['Dumbbell', 'Cable', 'Machine']],
  ['Front Raise', 'Push', ['Dumbbell', 'Cable', 'Plate']],
  ['Pull-up', 'Pull', BODYWEIGHT],
  ['Chin-up', 'Pull', BODYWEIGHT],
  ['Lat Pulldown', 'Pull', ['Wide Grip', 'Close Grip', 'Neutral Grip', 'Single-Arm']],
  ['Row', 'Pull', ['Barbell', 'Dumbbell', 'Seated Cable', 'Single-Arm Cable', 'Machine', 'T-Bar', 'Chest-Supported']],
  ['Face Pull', 'Pull', []],
  ['Rear Delt Fly', 'Pull', ['Dumbbell', 'Cable', 'Machine']],
  ['Reverse Pec Deck', 'Pull', []],
  ['Shrug', 'Pull', ['Barbell', 'Dumbbell', 'Trap Bar']],
  ['Straight-Arm Pulldown', 'Pull', []],
  ['Squat', 'Legs', ['Back', 'Front', 'Goblet', 'Smith Machine']],
  ['Hack Squat', 'Legs', []],
  ['Deadlift', 'Legs', ['Conventional', 'Sumo', 'Trap Bar']],
  ['Romanian Deadlift', 'Legs', ['Barbell', 'Dumbbell']],
  ['Single-Leg RDL', 'Legs', ['Dumbbell', 'Kettlebell', 'Barbell', 'Bodyweight']],
  ['Bulgarian Split Squat', 'Legs', ['Dumbbell', 'Barbell', 'Smith Machine', 'Bodyweight']],
  ['Lunge', 'Legs', ['Dumbbell', 'Barbell', 'Bodyweight']],
  ['Step-up', 'Legs', ['Dumbbell', 'Barbell', 'Bodyweight']],
  ['Leg Press', 'Legs', []],
  ['Leg Extension', 'Legs', []],
  ['Leg Curl', 'Legs', ['Lying', 'Seated']],
  ['Hip Thrust', 'Legs', ['Barbell', 'Machine', 'Smith Machine']],
  ['Good Morning', 'Legs', []],
  ['Hip Abduction', 'Legs', []],
  ['Calf Raise', 'Legs', ['Standing', 'Seated', 'Leg Press']],
  ['Bicep Curl', 'Arms', ['Dumbbell', 'Incline Dumbbell', 'Barbell', 'EZ Bar', 'Cable']],
  ['Hammer Curl', 'Arms', ['Dumbbell', 'Cable']],
  ['Preacher Curl', 'Arms', ['EZ Bar', 'Dumbbell', 'Machine']],
  ['Tricep Pushdown', 'Arms', ['Rope', 'Straight Bar', 'V-Bar']],
  ['Skull Crusher', 'Arms', ['EZ Bar', 'Barbell', 'Dumbbell']],
  ['Overhead Tricep Extension', 'Arms', ['Dumbbell', 'Cable']],
  ['Hanging Leg Raise', 'Core', []],
  ['Cable Crunch', 'Core', []],
  ['Ab Wheel', 'Core', []],
  ['Pallof Press', 'Core', ['Cable', 'Band']],
  ['Nordic Curl', 'Rehab', ['Bodyweight', 'Band-Assisted']],
  ['Hamstring Slider Curl', 'Rehab', []],
  ['45° Back Extension', 'Rehab', []],
  ['External Rotation', 'Rehab', ['Cable', 'Side-Lying Dumbbell', 'Band']],
  ['Prone Y-T Raise', 'Rehab', []],
  ['Band Pull-Apart', 'Rehab', []],
].map(([name, category, variations]) => ({ name, category, variations }));

// Bumped when DEFAULT_EXERCISES gains entries, so existing phones pick them up once.
const CATALOG_VERSION = 3;

// Names from the first exercise list that are now variations (Row → Barbell, Bicep Curl → Dumbbell).
const RETIRED_EXERCISES = ['Barbell Row', 'Dumbbell Curl'];

// Items: [exercise, variation (null = last used, else first listed), sets, reps, note]
const TEMPLATES = [
  { group: 'Push', name: 'Push A', focus: 'Incline and shoulder focus', items: [
    ['Incline Bench Press', 'Dumbbell', 3, '6–10'],
    ['Overhead Press', 'Seated Dumbbell', 3, '8–12'],
    ['Pec Deck', null, 3, '10–15'],
    ['Lateral Raise', 'Cable', 3, '12–20'],
    ['Overhead Tricep Extension', 'Cable', 3, '10–15'],
  ] },
  { group: 'Push', name: 'Push B', focus: 'Flat pressing focus', items: [
    ['Bench Press', 'Barbell', 3, '5–8'],
    ['Overhead Press', 'Machine', 3, '8–12'],
    ['Dip', 'Weighted', 3, '6–12', 'weighted if possible'],
    ['Lateral Raise', 'Dumbbell', 3, '12–20'],
    ['Tricep Pushdown', 'Rope', 3, '10–15'],
  ] },
  { group: 'Pull', name: 'Pull A', focus: 'Lat focus', items: [
    ['Lat Pulldown', null, 3, '8–12'],
    ['Row', 'Chest-Supported', 3, '8–12', 'dumbbell'],
    ['Row', 'Single-Arm Cable', 3, '10–12', 'per arm'],
    ['Reverse Pec Deck', null, 3, '12–20'],
    ['Bicep Curl', 'Incline Dumbbell', 3, '10–15'],
  ] },
  { group: 'Pull', name: 'Pull B', focus: 'Upper back focus', items: [
    ['Pull-up', 'Bodyweight', 3, '5–10'],
    ['Row', 'Barbell', 3, '6–10'],
    ['Face Pull', null, 3, '15–20'],
    ['Straight-Arm Pulldown', null, 2, '12–15'],
    ['Hammer Curl', 'Dumbbell', 3, '10–15'],
  ] },
  { group: 'Legs', name: 'Legs A', focus: 'Squat and hinge focus', items: [
    ['Squat', 'Back', 3, '5–8', 'or hack squat'],
    ['Single-Leg RDL', 'Kettlebell', 3, '8–10', 'per leg'],
    ['Leg Extension', null, 3, '10–15'],
    ['Leg Curl', 'Seated', 3, '10–15'],
    ['Calf Raise', 'Standing', 3, '10–15'],
  ] },
  { group: 'Legs', name: 'Legs B', focus: 'Unilateral focus', items: [
    ['Bulgarian Split Squat', null, 3, '8–12', 'per leg'],
    ['Hip Thrust', null, 3, '8–12'],
    ['Leg Press', null, 3, '10–15'],
    ['Leg Curl', 'Lying', 3, '10–15'],
    ['Calf Raise', 'Seated', 3, '12–20'],
  ] },
  { group: 'Rehab', name: 'Rehab A', focus: 'Eccentric hamstrings, rotator cuff, core', items: [
    ['Nordic Curl', null, 3, '3–6', 'slow lowering, band-assist if needed'],
    ['Ab Wheel', null, 3, '6–12'],
    ['Face Pull', null, 3, '15–20'],
    ['External Rotation', 'Cable', 3, '12–15', 'per arm'],
    ['Prone Y-T Raise', null, 2, '10', 'each'],
  ] },
  { group: 'Rehab', name: 'Rehab B', focus: 'Lighter hamstrings, scapular stability, anti-rotation core', items: [
    ['Hamstring Slider Curl', null, 3, '8–12'],
    ['45° Back Extension', null, 3, '10–15', 'rounded back to bias hamstrings'],
    ['Band Pull-Apart', null, 3, '15–25'],
    ['External Rotation', 'Side-Lying Dumbbell', 3, '12–15', 'per arm'],
    ['Pallof Press', null, 3, '10–12', 'per side'],
  ] },
].map((t) => ({
  ...t,
  items: t.items.map(([exercise, variation, sets, reps, note = '']) => ({ exercise, variation, sets, reps, note })),
}));

const CARDIO_TYPES = { running: 'Running', stairmaster: 'Stairmaster' };
const DEFAULT_ACTIVITIES = ['Basketball', 'Swimming', 'Padel', 'Soccer', 'Cycling', 'Tennis', 'Hiking', 'Rowing', 'Climbing', 'Yoga'];

const DEFAULT_SETTINGS = {
  owner: 'Colin-Duckworth',
  repo: 'workout-data',
  branch: 'main',
  token: '',
  repStep: 1,
  weightStep: 2,
  version: 2,
};

const KEY = {
  workouts: 'wl.workouts',
  sets: 'wl.sets',
  cardio: 'wl.cardio',
  bodyweight: 'wl.bodyweight',
  tombstones: 'wl.tombstones',
  exercises: 'wl.exercises.v2',
  legacyExercises: 'wl.exercises',
  catalogVersion: 'wl.catalogVersion',
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

function loadExercises() {
  const saved = load(KEY.exercises, null);
  if (saved) {
    if (load(KEY.catalogVersion, 2) < CATALOG_VERSION) mergeDefaults(saved);
    return saved;
  }
  // First run on v2+: start from the catalogue and keep any exercises added to the v1 list.
  const list = DEFAULT_EXERCISES.map((e) => ({ ...e, variations: [...e.variations] }));
  for (const name of load(KEY.legacyExercises, [])) {
    if (typeof name === 'string' && !RETIRED_EXERCISES.includes(name) && !list.some((e) => e.name === name)) {
      list.push({ name, category: 'Custom', variations: [] });
    }
  }
  return list;
}

function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, version: 1, ...load(KEY.settings, {}) };
  // Version 1 defaulted the weight step to 2.5 kg; move that default to 2 kg once, keeping any other choice.
  if (s.version < 2) {
    if (s.weightStep === 2.5) s.weightStep = 2;
    s.version = 2;
  }
  return s;
}

// Add new catalogue exercises and variations without undoing your own edits.
function mergeDefaults(list) {
  for (const def of DEFAULT_EXERCISES) {
    const mine = list.find((e) => e.name.toLowerCase() === def.name.toLowerCase());
    if (!mine) list.push({ ...def, variations: [...def.variations] });
    else def.variations.forEach((v) => { if (!mine.variations.includes(v)) mine.variations.push(v); });
  }
}

const state = {
  workouts: load(KEY.workouts, []),       // [{id, date, name, template, started_at, ended_at, duration_min, items, focus}]
  sets: load(KEY.sets, []),               // weight-training sets, each tagged with workout_id
  cardio: load(KEY.cardio, []),           // cardio sessions
  bodyweight: load(KEY.bodyweight, []),   // daily weigh-ins, one per date
  tombstones: load(KEY.tombstones, []).map((t) => ({ kind: 'strength', ...t })), // deleted, not yet removed from GitHub
  exercises: loadExercises(),             // [{name, category, variations}]
  activities: load(KEY.activities, DEFAULT_ACTIVITIES.slice()), // "Other" cardio activities
  settings: loadSettings(),
  current: {
    view: 'home',                         // home | workout | cardio
    activeWorkout: null,
    cardioType: 'running',
    activity: 'Basketball',
    duration: 30,
    distance: 5,
    floors: 100,
    level: 8,
    bodyweight: null,                     // weight in the body-weight form
    ...load(KEY.current, {}),
  },
  ui: { expanded: new Set(), historyLimit: 15, editSet: null },
  picker: { mode: 'add', key: null },
  syncing: false,
  syncQueued: false,
  noSignal: false,
  lastError: '',
};

// The record types and where each one syncs to (workouts first, so a workout lands before its sets).
const TABLES = {
  workouts: { key: 'workouts', dir: 'workouts', columns: WORKOUT_COLUMNS },
  strength: { key: 'sets', dir: 'sets', columns: SET_COLUMNS },
  cardio: { key: 'cardio', dir: 'cardio', columns: CARDIO_COLUMNS },
  bodyweight: { key: 'bodyweight', dir: 'bodyweight', columns: BODYWEIGHT_COLUMNS },
};
const entries = (kind) => state[TABLES[kind].key];

// Throws if storage is full/blocked so callers can tell the user instead of silently losing an entry.
function persist() {
  localStorage.setItem(KEY.workouts, JSON.stringify(state.workouts));
  localStorage.setItem(KEY.sets, JSON.stringify(state.sets));
  localStorage.setItem(KEY.cardio, JSON.stringify(state.cardio));
  localStorage.setItem(KEY.bodyweight, JSON.stringify(state.bodyweight));
  localStorage.setItem(KEY.tombstones, JSON.stringify(state.tombstones));
  localStorage.setItem(KEY.exercises, JSON.stringify(state.exercises));
  localStorage.setItem(KEY.catalogVersion, JSON.stringify(CATALOG_VERSION));
  localStorage.setItem(KEY.activities, JSON.stringify(state.activities));
  localStorage.setItem(KEY.settings, JSON.stringify(state.settings));
  localStorage.setItem(KEY.current, JSON.stringify(state.current));
}

// For in-progress edits (drafts, focus, view) where a failed write isn't worth an error.
function persistQuietly() {
  try { persist(); } catch { /* retried on the next real save */ }
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
const fmtTime = (iso) => String(iso).slice(11, 16);

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
const sum = (list, f) => list.reduce((total, x) => total + f(x), 0);

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
// Workouts have no timestamp column; sort them by start time like everything else.
const rowTime = (r) => r.timestamp || r.started_at || '';

function fromRow(kind, r) {
  if (kind === 'workouts') {
    return {
      id: r.id,
      date: r.date,
      name: r.name,
      template: r.template || '',
      started_at: r.started_at,
      ended_at: r.ended_at || '',
      duration_min: optNum(r.duration_min),
      items: [],
      focus: null,
    };
  }
  const base = { id: r.id, timestamp: r.timestamp, date: r.date, notes: r.notes || '' };
  if (kind === 'bodyweight') return { ...base, weight_kg: Number(r.weight_kg) || 0 };
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
    workout_id: r.workout_id || '',
    workout: r.workout || '',
    exercise: r.exercise,
    variation: r.variation || '',
    set_number: optNum(r.set_number),
    reps: Number(r.reps) || 0,
    weight_kg: Number(r.weight_kg) || 0,
    warmup: r.warmup === 'true',
    failure: r.failure === 'true',
    rpe: optNum(r.rpe),
  };
}

// ---------- queries ----------

const exerciseDef = (name) => state.exercises.find((e) => e.name === name);
const liftName = (s) => (s.variation ? `${s.exercise} · ${s.variation}` : s.exercise);
const sameLift = (s, exercise, variation) => s.exercise === exercise && (s.variation || '') === (variation || '');
const categoryOf = (def) => (CATEGORIES.includes(def.category) ? def.category : 'Custom');

const activeWorkout = () => state.workouts.find((w) => w.id === state.current.activeWorkout) || null;
const workoutSets = (w) => state.sets.filter((s) => s.workout_id === w.id).sort(byTimeAsc);
const itemSets = (w, item) => workoutSets(w).filter((s) => s.item === item.key);
const focusedItem = (w) => (w ? w.items.find((i) => i.key === w.focus) || null : null);
// Warm-ups are logged but don't count toward targets, set numbers, volume or starting weights.
const isWorking = (s) => !s.warmup;
const workingSets = (sets) => sets.filter(isWorking);
const itemDone = (w, item) => {
  const n = workingSets(itemSets(w, item)).length;
  return item.sets ? n >= item.sets : n > 0;
};
const volumeOf = (sets) => sum(workingSets(sets), (s) => s.reps * s.weight_kg);

// The most recent day this exercise + variation was done (working sets), outside the given workout.
function lastSession(exercise, variation, excludeWorkoutId) {
  const matches = state.sets.filter((s) => isWorking(s) && sameLift(s, exercise, variation) && s.workout_id !== excludeWorkoutId);
  let date = null;
  for (const s of matches) if (!date || s.date > date) date = s.date;
  if (!date) return null;
  return { date, sets: matches.filter((s) => s.date === date).sort(byTimeAsc) };
}

// Latest set of an exercise; pass a variation to narrow it down, workingOnly to skip warm-ups.
function latestSet(exercise, variation, workingOnly = false) {
  let latest = null;
  for (const s of state.sets) {
    if (s.exercise !== exercise || (variation !== undefined && (s.variation || '') !== variation)) continue;
    if (workingOnly && !isWorking(s)) continue;
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

function templateLastDone(name) {
  let date = null;
  for (const w of state.workouts) {
    if (w.template === name && w.id !== state.current.activeWorkout && (!date || w.date > date)) date = w.date;
  }
  return date;
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

// Weight first, matching the logger: "34 kg × 5". (F) marks a set taken to failure.
const setText = (s) => `${fmtNum(s.weight_kg)} kg × ${s.reps}${s.failure ? ' (F)' : ''}`;

function setsText(sets) {
  const working = workingSets(sets);
  const warmups = sets.length - working.length;
  return [working.map(setText).join(', '), warmups && `+${warmups} warm-up`].filter(Boolean).join(' · ');
}

const pendingCount = () =>
  Object.keys(TABLES).reduce((n, kind) => n + entries(kind).filter((e) => e.dirty).length, 0) + state.tombstones.length;

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

function currentView() {
  if (state.current.view === 'workout' && !activeWorkout()) state.current.view = 'home';
  return state.current.view;
}

function renderAll() {
  const view = currentView();
  els.homeView.hidden = view !== 'home';
  els.workoutView.hidden = view !== 'workout';
  els.cardioView.hidden = view !== 'cardio';
  els.bodyweightView.hidden = view !== 'bodyweight';
  if (view === 'home') renderHome();
  else if (view === 'workout') renderWorkout();
  else if (view === 'bodyweight') renderBodyweight();
  else renderCardioForm();
  renderStatus();
}

function showView(view) {
  state.current.view = view;
  persistQuietly();
  renderAll();
  window.scrollTo({ top: 0 });
}

// ----- home -----

function renderHome() {
  const w = activeWorkout();
  els.activeCard.hidden = !w;
  els.startBtn.hidden = !!w;
  if (w) {
    const n = workingSets(workoutSets(w)).length;
    els.activeName.textContent = w.name;
    els.activeMeta.textContent = `${fmtDate(w.date)} · started ${fmtTime(w.started_at)} · ${n} ${n === 1 ? 'set' : 'sets'}`;
    els.activeCancelBtn.textContent = isReopened(w) ? 'Close' : 'Cancel';
  }
  const todays = weighInOn(today());
  const last = weighInsDesc()[0];
  els.weightBtnSub.textContent = todays ? `Today: ${fmtNum(todays.weight_kg)} kg` : last ? `Last: ${fmtNum(last.weight_kg)} kg` : '';
  renderHistory();
}

// ----- body weight -----

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n));
}

const weighInOn = (date) => state.bodyweight.find((e) => e.date === date);
const weighInsDesc = () => [...state.bodyweight].sort((a, b) => b.date.localeCompare(a.date));
const fmtSigned = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmtNum(Math.abs(n))}`;

function averageBetween(from, to) {
  const list = state.bodyweight.filter((e) => e.date >= from && e.date <= to);
  return list.length ? sum(list, (e) => e.weight_kg) / list.length : null;
}

function renderBodyweight() {
  const t = today();
  els.bwDate.max = t;
  if (!els.bwDate.value) els.bwDate.value = t;
  if (state.current.bodyweight == null) loadWeighInDraft();
  const existing = weighInOn(els.bwDate.value);
  setInput(els.bwWeight, fmtNum(state.current.bodyweight));
  els.bwSaveBtn.textContent = existing ? 'Update weight' : 'Log weight';
  els.bwHint.textContent = existing
    ? `${fmtDate(existing.date)} already has ${fmtNum(existing.weight_kg)} kg. Saving replaces it.`
    : '';

  // This week's average against the week before smooths out day-to-day water swings.
  const avg = averageBetween(addDays(t, -6), t);
  const prev = averageBetween(addDays(t, -13), addDays(t, -7));
  els.bwStats.hidden = avg == null;
  els.bwStats.textContent = avg == null ? '' : `7-day average ${fmtNum(round(avg, 1))} kg` +
    (prev == null ? '' : ` · ${fmtSigned(round(avg - prev, 1))} kg vs the week before`);

  const list = weighInsDesc();
  els.bwListTitle.hidden = !list.length;
  els.bwList.hidden = !list.length;
  els.bwList.replaceChildren();
  list.slice(0, 30).forEach((e, i) => {
    const before = list[i + 1];
    const change = before ? fmtSigned(round(e.weight_kg - before.weight_kg, 1)) : '';
    const del = button('del', '×', () => deleteEntry('bodyweight', e.id, { confirm: true }));
    del.setAttribute('aria-label', `Delete weigh-in for ${fmtDate(e.date)}`);
    const row = el('div', 'set-row bw-row');
    row.append(el('span', 'bw-date', fmtDate(e.date)), el('span', 'set-main', `${fmtNum(e.weight_kg)} kg`),
      el('span', 'set-meta', [change, e.notes].filter(Boolean).join(' · ')), pendingDot(e), del);
    els.bwList.append(row);
  });
}

// Fill the form from that day's weigh-in if there is one, else start from your latest weight.
function loadWeighInDraft() {
  const existing = weighInOn(els.bwDate.value);
  state.current.bodyweight = existing ? existing.weight_kg : weighInsDesc()[0]?.weight_kg ?? state.current.bodyweight ?? 75;
  els.bwNotes.value = existing ? existing.notes : '';
}

function openBodyweight() {
  els.bwDate.value = today();
  loadWeighInDraft();
  showView('bodyweight');
}

function readBodyweight() {
  const n = parseNum(els.bwWeight.value);
  if (n > 0) state.current.bodyweight = round(n);
  persistQuietly();
}

function logBodyweight() {
  if (Date.now() - lastSaveAt < 400) return;
  readBodyweight();
  const weight = state.current.bodyweight;
  if (!(weight >= 20 && weight <= 400)) return toast('Enter your weight in kg', { error: true });
  const date = els.bwDate.value || today();
  const notes = els.bwNotes.value.trim();
  const existing = weighInOn(date);
  if (!existing) {
    addEntry('bodyweight', { id: uuid(), timestamp: localIso(), date, weight_kg: weight, notes, dirty: true },
      `Logged ${fmtNum(weight)} kg for ${fmtDate(date)}`);
    return;
  }

  // One weigh-in per day: replace that day's entry in place (same id, so its CSV row is updated, not duplicated).
  const before = { ...existing };
  Object.assign(existing, { timestamp: localIso(), weight_kg: weight, notes, dirty: true });
  try { persist(); } catch (e) {
    Object.assign(existing, before);
    return toast(`Could not save on this phone: ${e.message}`, { error: true });
  }
  lastSaveAt = Date.now();
  renderAll();
  toast(`Updated ${fmtDate(date)} to ${fmtNum(weight)} kg`, {
    action: {
      label: 'Undo',
      run: () => {
        Object.assign(existing, before, { dirty: true });
        persistQuietly();
        loadWeighInDraft();
        renderAll();
        sync();
      },
    },
  });
  sync();
}

function renderHistory() {
  const setsByWorkout = new Map();
  for (const s of state.sets) {
    const k = s.workout_id || `day:${s.date}`; // sets logged before workouts existed group by day
    if (!setsByWorkout.has(k)) setsByWorkout.set(k, []);
    setsByWorkout.get(k).push(s);
  }

  const items = [];
  for (const w of state.workouts) {
    const sets = setsByWorkout.get(w.id) || [];
    if (w.id !== state.current.activeWorkout && sets.length) items.push({ type: 'workout', w, sets, time: w.started_at });
  }
  for (const [k, sets] of setsByWorkout) {
    if (k.startsWith('day:')) items.push({ type: 'workout', w: null, sets, time: sets.sort(byTimeAsc)[0].timestamp });
  }
  for (const e of state.cardio) items.push({ type: 'cardio', e, time: e.timestamp });
  items.sort((a, b) => String(b.time).localeCompare(String(a.time)));

  els.history.replaceChildren();
  if (!items.length) {
    els.history.append(el('p', 'empty-note', 'Nothing logged yet. Start a workout or log some cardio.'));
    return;
  }
  for (const item of items.slice(0, state.ui.historyLimit)) {
    els.history.append(item.type === 'workout' ? historyWorkout(item) : historyCardio(item.e));
  }
  if (items.length > state.ui.historyLimit) {
    els.history.append(button('secondary', 'Show more', () => { state.ui.historyLimit += 15; renderHistory(); }));
  }
}

function historyWorkout({ w, sets }) {
  sets.sort(byTimeAsc);
  const id = w ? w.id : `day:${sets[0].date}`;
  const date = w ? w.date : sets[0].date;
  const open = state.ui.expanded.has(id);
  const card = el('div', 'hist-card');

  const head = button('hist-head', null, () => {
    if (open) state.ui.expanded.delete(id); else state.ui.expanded.add(id);
    renderHistory();
  });
  head.setAttribute('aria-expanded', String(open));
  const info = el('div', 'hist-info');
  info.append(el('strong', null, w ? w.name : 'Sets'),
    el('small', null, [fmtDate(date), w && fmtTime(w.started_at), w && w.duration_min ? `${w.duration_min} min` : '']
      .filter(Boolean).join(' · ')));
  const n = workingSets(sets).length;
  head.append(info, el('span', 'hist-stat', `${n} ${n === 1 ? 'set' : 'sets'} · ${fmtNum(volumeOf(sets))} kg`));
  card.append(head);

  if (open) {
    const body = el('div', 'hist-body');
    const byLift = new Map();
    for (const s of sets) {
      if (!byLift.has(liftName(s))) byLift.set(liftName(s), []);
      byLift.get(liftName(s)).push(s);
    }
    for (const [name, list] of byLift) {
      const line = el('div', 'hist-line');
      line.append(el('strong', null, name), el('span', null, setsText(list)));
      body.append(line);
    }
    const actions = el('div', 'hist-actions');
    if (w) actions.append(button('link-btn', 'Edit', () => editWorkout(w.id)));
    actions.append(button('link-btn danger', 'Delete', () => deleteWorkout(w, sets)));
    body.append(actions);
    card.append(body);
  }
  return card;
}

function historyCardio(e) {
  const card = el('div', 'hist-card');
  const row = el('div', 'hist-head');
  const info = el('div', 'hist-info');
  info.append(el('strong', null, e.activity), el('small', null, `${fmtDate(e.date)} · ${fmtTime(e.timestamp)}`),
    el('span', 'hist-detail', describeCardio(e)));
  if (e.notes) info.append(el('small', null, e.notes));
  const del = button('del', '×', () => deleteEntry('cardio', e.id, { confirm: true }));
  del.setAttribute('aria-label', `Delete ${e.activity}`);
  row.append(info, del);
  card.append(row);
  return card;
}

// ----- workout -----

function renderWorkout() {
  const w = activeWorkout();
  if (!w) return;
  els.wName.textContent = w.name;
  els.cancelWorkoutBtn.textContent = isReopened(w) ? 'Stop editing' : 'Cancel workout';
  renderWorkoutMeta();

  els.exerciseList.replaceChildren();
  if (!w.items.length) els.exerciseList.append(el('p', 'empty-note', 'No exercises yet. Add one below.'));
  w.items.forEach((item, i) => {
    const sets = itemSets(w, item);
    const working = workingSets(sets).length;
    const current = item.key === w.focus;
    const card = el('div', `ex-card${current ? ' current' : ''}${itemDone(w, item) ? ' done' : ''}`);
    card.dataset.key = item.key;

    const head = button('ex-head', null, () => focusItem(item.key));
    head.setAttribute('aria-expanded', String(current));
    const info = el('div', 'ex-info');
    const target = [item.variation, item.sets && `${item.sets} × ${item.reps}`, item.note].filter(Boolean).join(' · ');
    info.append(el('strong', null, item.exercise));
    if (target) info.append(el('small', null, target));
    head.append(el('span', 'ex-num', itemDone(w, item) ? '✓' : String(i + 1)), info,
      el('span', 'ex-progress', item.sets ? `${working}/${item.sets}` : `${working}`));
    card.append(head);

    if (current) card.append(els.setLogger);
    else if (sets.length) card.append(el('p', 'ex-summary', setsText(sets)));
    els.exerciseList.append(card);
  });
  if (!focusedItem(w)) els.loggerHome.append(els.setLogger);
  renderLogger();
}

function renderWorkoutMeta() {
  const w = activeWorkout();
  if (!w) return;
  const n = workingSets(workoutSets(w)).length;
  const minutes = Math.max(0, Math.round((Date.now() - new Date(w.started_at)) / 60000));
  const live = w.date === today() && !w.ended_at;
  els.wMeta.textContent = [fmtDate(w.date), `started ${fmtTime(w.started_at)}`, live ? `${minutes} min` : '',
    `${n} ${n === 1 ? 'set' : 'sets'}`].filter(Boolean).join(' · ');
}

// The set logger is one fixed block that moves into whichever exercise card is open,
// so its inputs keep focus and values while the rest of the screen re-renders.
function renderLogger() {
  const w = activeWorkout();
  const item = focusedItem(w);
  if (!item) return;
  const sets = itemSets(w, item);

  els.variationChips.replaceChildren();
  for (const v of exerciseDef(item.exercise)?.variations || []) {
    els.variationChips.append(chip(v, v === item.variation, () => chooseVariation(v)));
  }
  els.variationChips.append(chip('+ Variation', null, addVariation, 'add'));

  const last = lastSession(item.exercise, item.variation, w.id);
  els.lastSession.textContent = last
    ? `Last time (${fmtDate(last.date)}): ${setsText(last.sets)}`
    : `First time logging ${item.variation ? `${item.exercise} · ${item.variation}` : item.exercise}.`;

  els.loggedSets.replaceChildren();
  for (const s of sets) els.loggedSets.append(...setRow(s, item));
  els.loggedHint.hidden = !sets.length;

  setInput(els.reps, item.draft.reps);
  setInput(els.weight, fmtNum(item.draft.weight));
  els.flagWarmup.setAttribute('aria-pressed', String(!!item.draft.warmup));
  els.flagFailure.setAttribute('aria-pressed', String(!!item.draft.failure));
  els.logSetBtn.textContent = item.draft.warmup ? 'Log warm-up set' : `Log set ${nextSetNumber(sets)}`;
  els.swapBtn.hidden = sets.length > 0;
  els.removeItemBtn.hidden = sets.length > 0;
}

// Working sets are numbered 1, 2, 3…; warm-ups get no number.
const nextSetNumber = (sets) => Math.max(0, ...workingSets(sets).map((s) => Number(s.set_number) || 0)) + 1;

function pendingDot(e) {
  const dot = el('span', e.dirty ? 'dot pending' : 'dot');
  if (e.dirty) dot.title = 'Waiting to sync';
  return dot;
}

// A logged set; tapping it opens warm-up / failure toggles underneath.
function setRow(s, item) {
  const editing = state.ui.editSet === s.id;
  const row = el('div', `set-row tappable${s.warmup ? ' warmup' : ''}`);
  row.setAttribute('role', 'button');
  row.setAttribute('aria-expanded', String(editing));
  row.addEventListener('click', () => {
    state.ui.editSet = editing ? null : s.id;
    renderLogger();
  });
  const meta = [
    (s.variation || '') !== (item.variation || '') ? s.variation : '',
    s.warmup ? 'Warm-up' : '',
    s.failure ? 'Failure' : '',
    s.rpe !== '' && s.rpe != null ? `RPE ${s.rpe}` : '',
    s.notes,
  ].filter(Boolean).join(' · ');
  const del = button('del', '×', (e) => {
    e.stopPropagation();
    deleteEntry('strength', s.id, { confirm: true });
  });
  del.setAttribute('aria-label', s.warmup ? 'Delete warm-up set' : `Delete set ${s.set_number}`);
  row.append(el('span', 'set-n', s.warmup ? 'W' : `#${s.set_number}`), el('span', 'set-main', `${fmtNum(s.weight_kg)} kg × ${s.reps}`),
    el('span', 'set-meta', meta), pendingDot(s), del);
  if (!editing) return [row];

  const edit = el('div', 'set-edit chips');
  edit.append(chip('Warm-up', !!s.warmup, () => toggleSetFlag(s.id, 'warmup')),
    chip('To failure', !!s.failure, () => toggleSetFlag(s.id, 'failure')));
  return [row, edit];
}

// ----- cardio -----

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

  els.cardioSaveBtn.disabled = !activity;
  els.cardioSaveBtn.textContent = { running: 'Log run', stairmaster: 'Log stairmaster' }[c.cardioType] ||
    (activity ? `Log ${activity.toLowerCase()}` : 'Pick an activity');
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

// ---------- workout actions ----------

// Starting weight/reps: your last working set on this exercise + variation, else the bottom of the target range.
// The warm-up and failure toggles always start off.
function draftFor(item) {
  const last = latestSet(item.exercise, item.variation, true);
  return {
    reps: last ? Number(last.reps) : parseInt(item.reps, 10) || 8,
    weight: last ? Number(last.weight_kg) : 0,
    warmup: false,
    failure: false,
  };
}

// Use the requested variation if the exercise has it, else the one used last time, else the first listed.
function pickVariation(exercise, variation) {
  const vars = exerciseDef(exercise)?.variations || [];
  if (variation && vars.includes(variation)) return variation;
  const last = latestSet(exercise);
  return last && vars.includes(last.variation) ? last.variation : (vars[0] || '');
}

function makeItem(exercise, variation = null, sets = null, reps = '', note = '') {
  const item = { key: uuid().slice(0, 8), exercise, variation: pickVariation(exercise, variation), sets, reps, note };
  item.draft = draftFor(item);
  return item;
}

function startWorkout(template) {
  if (activeWorkout()) return toast('Finish your current workout first', { error: true });
  const now = new Date();
  const w = {
    id: uuid(),
    date: localDate(now),
    name: template ? template.name : 'Workout',
    template: template ? template.name : '',
    started_at: localIso(now),
    ended_at: '',
    duration_min: '',
    items: template ? template.items.map((i) => makeItem(i.exercise, i.variation, i.sets, i.reps, i.note)) : [],
    focus: null,
    dirty: true,
  };
  w.focus = w.items[0]?.key ?? null;
  state.workouts.push(w);
  state.current.activeWorkout = w.id;
  if (els.templates.open) els.templates.close();
  showView('workout');
  if (!template) openPicker('add'); // blank workout: go straight to choosing the first exercise
}

function focusItem(key) {
  const w = activeWorkout();
  readLogger();
  w.focus = w.focus === key ? null : key; // tapping the open exercise collapses it
  persistQuietly();
  renderWorkout();
  scrollToItem(w.focus);
}

function scrollToItem(key) {
  if (!key) return;
  const card = els.exerciseList.querySelector(`[data-key="${key}"]`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function chooseVariation(variation) {
  const item = focusedItem(activeWorkout());
  readLogger();
  item.variation = variation;
  item.draft = draftFor(item);
  persistQuietly();
  renderWorkout();
}

function addVariation() {
  const item = focusedItem(activeWorkout());
  const name = (prompt(`New variation for ${item.exercise}`, '') || '').trim().replace(/\s+/g, ' ');
  if (!name) return;
  let def = exerciseDef(item.exercise);
  if (!def) {
    def = { name: item.exercise, category: 'Custom', variations: [] };
    state.exercises.push(def);
  }
  const existing = def.variations.find((v) => v.toLowerCase() === name.toLowerCase());
  if (!existing) def.variations.push(name);
  chooseVariation(existing || name);
}

function addItem(exercise) {
  const w = activeWorkout();
  readLogger();
  const item = makeItem(exercise);
  w.items.push(item);
  w.focus = item.key;
  persistQuietly();
  renderWorkout();
  scrollToItem(item.key);
}

function swapItem(key, exercise) {
  const w = activeWorkout();
  const item = w.items.find((i) => i.key === key);
  const fresh = makeItem(exercise, null, item.sets, item.reps, item.note);
  Object.assign(item, { exercise, variation: fresh.variation, draft: fresh.draft });
  persistQuietly();
  renderWorkout();
}

function removeItem() {
  const w = activeWorkout();
  const item = focusedItem(w);
  const index = w.items.indexOf(item);
  w.items.splice(index, 1);
  w.focus = (w.items[index] || w.items[index - 1])?.key ?? null;
  persistQuietly();
  renderWorkout();
}

function renameWorkout() {
  const w = activeWorkout();
  const name = (prompt('Workout name', w.name) || '').trim().replace(/\s+/g, ' ');
  if (!name || name === w.name) return;
  w.name = name;
  w.dirty = true;
  for (const s of workoutSets(w)) { s.workout = name; s.dirty = true; }
  persistQuietly();
  renderAll();
  sync();
}

// Copy the typed reps/weight into the open exercise's draft.
function readLogger() {
  const item = focusedItem(activeWorkout());
  if (!item) return;
  const reps = parseNum(els.reps.value);
  const weight = parseNum(els.weight.value);
  if (reps >= 0) item.draft.reps = Math.round(reps);
  if (weight >= 0) item.draft.weight = round(weight);
  persistQuietly();
}

// Next exercise that still needs sets: after this one first, then any skipped earlier.
function nextUnfinished(w, item) {
  const i = w.items.indexOf(item);
  return [...w.items.slice(i + 1), ...w.items.slice(0, i)].find((x) => !itemDone(w, x)) || null;
}

let lastSaveAt = 0;

function logSet() {
  if (Date.now() - lastSaveAt < 400) return; // ignore accidental double taps
  const w = activeWorkout();
  const item = focusedItem(w);
  if (!item) return;
  readLogger();
  const reps = Math.round(Number(item.draft.reps));
  const weight = round(Number(item.draft.weight));
  if (!Number.isFinite(reps) || reps < 0) return toast('Reps must be a number', { error: true });
  if (!Number.isFinite(weight) || weight < 0) return toast('Weight must be a number', { error: true });
  const rpe = parseNum(els.rpe.value);
  const done = itemSets(w, item);
  const warmup = !!item.draft.warmup;

  const set = {
    id: uuid(),
    timestamp: localIso(),
    date: w.date, // a set belongs to its workout's day, even after midnight
    workout_id: w.id,
    workout: w.name,
    item: item.key, // local only: which card in the workout it belongs to
    exercise: item.exercise,
    variation: item.variation || '',
    set_number: warmup ? '' : nextSetNumber(done),
    reps,
    weight_kg: weight,
    warmup,
    failure: !!item.draft.failure,
    rpe: Number.isFinite(rpe) ? rpe : '',
    notes: els.notes.value.trim(),
    dirty: true,
  };

  // Hit the target number of working sets? Open the next exercise.
  let message = `${warmup ? 'Warm-up' : `Set ${set.set_number}`} logged: ${setText(set)}`;
  const previousFocus = w.focus;
  if (!warmup && item.sets && workingSets(done).length + 1 >= item.sets) {
    const next = nextUnfinished(w, item);
    w.focus = next ? next.key : null;
    message += next ? ` · next: ${next.exercise}` : ' · all exercises done!';
  }

  const ok = addEntry('strength', set, message, () => { w.focus = previousFocus; persistQuietly(); renderAll(); });
  if (!ok) { w.focus = previousFocus; return; }
  els.rpe.value = '';
  els.notes.value = '';
  item.draft.warmup = false; // toggles apply to one set at a time
  item.draft.failure = false;
  persistQuietly();
  renderLogger();
  if (w.focus !== previousFocus) scrollToItem(w.focus);
}

function toggleDraftFlag(flag) {
  const item = focusedItem(activeWorkout());
  if (!item) return;
  readLogger();
  item.draft[flag] = !item.draft[flag];
  persistQuietly();
  renderLogger();
}

// Flag (or unflag) a set that's already logged, e.g. marking the first set as a warm-up afterwards.
function toggleSetFlag(id, flag) {
  const s = state.sets.find((x) => x.id === id);
  if (!s) return;
  s[flag] = !s[flag];
  s.dirty = true;
  renumber(s);
  try { persist(); } catch (e) { return toast(`Could not save: ${e.message}`, { error: true }); }
  renderWorkout();
  sync();
}

// Keep working sets numbered 1, 2, 3… in logged order after a set is flagged or deleted.
function renumber(s) {
  if (!s.workout_id) return;
  const siblings = state.sets
    .filter((x) => x.workout_id === s.workout_id && (s.item ? x.item === s.item : sameLift(x, s.exercise, s.variation)))
    .sort(byTimeAsc);
  let n = 0;
  for (const x of siblings) {
    const number = x.warmup ? '' : ++n;
    if (x.set_number !== number) { x.set_number = number; x.dirty = true; }
  }
}

function finishWorkout() {
  const w = activeWorkout();
  if (!w) return;
  readLogger();
  const sets = workoutSets(w);
  if (!sets.length) {
    if (!confirm('No sets logged. Discard this workout?')) return;
    removeWorkout(w);
  } else {
    // The workout ends at the last activity before the first 30-minute gap, so neither a late Finish
    // nor a set typed in hours afterwards stretches the duration.
    let end = new Date(sets[0].timestamp);
    for (const t of [...sets.map((s) => new Date(s.timestamp)), new Date()]) {
      if (t - end > 30 * 60000) break;
      end = t;
    }
    w.ended_at = localIso(end);
    w.duration_min = Math.max(1, Math.round((end - new Date(w.started_at)) / 60000));
    w.dirty = true;
    toast(`${w.name} done: ${workingSets(sets).length} sets · ${fmtNum(volumeOf(sets))} kg · ${w.duration_min} min`);
  }
  state.current.activeWorkout = null;
  try { persist(); } catch (e) { return toast(`Could not save: ${e.message}`, { error: true }); }
  showView('home');
  sync();
}

function removeWorkout(w) {
  state.workouts = state.workouts.filter((x) => x !== w);
  state.tombstones.push({ id: w.id, date: w.date, kind: 'workouts' });
  if (state.current.activeWorkout === w.id) state.current.activeWorkout = null;
}

// Rebuild exercise cards for a workout restored from GitHub (CSV rows don't carry the card layout).
function itemsFromSets(w) {
  const items = new Map();
  for (const s of workoutSets(w)) {
    const k = `${s.exercise}|${s.variation || ''}`;
    if (!items.has(k)) items.set(k, { ...makeItem(s.exercise, s.variation), variation: s.variation || '' });
    s.item = items.get(k).key;
  }
  return [...items.values()];
}

function editWorkout(id) {
  if (activeWorkout()) return toast('Finish your current workout first', { error: true });
  const w = state.workouts.find((x) => x.id === id);
  const sets = workoutSets(w);
  if (!w.items || !w.items.length || sets.some((s) => !w.items.some((i) => i.key === s.item))) w.items = itemsFromSets(w);
  w.focus = null;
  state.current.activeWorkout = w.id;
  showView('workout');
}

// Delete a workout and its sets here and (on the next sync) on GitHub.
function dropWorkout(w, sets, message) {
  const ids = new Set(sets.map((s) => s.id));
  state.sets = state.sets.filter((s) => !ids.has(s.id));
  sets.forEach((s) => state.tombstones.push({ id: s.id, date: s.date, kind: 'strength' }));
  if (w) removeWorkout(w);
  try { persist(); } catch (e) { return toast(`Could not save: ${e.message}`, { error: true }); }
  showView('home');
  toast(message);
  sync();
}

function deleteWorkout(w, sets) {
  const label = w ? `${w.name} on ${fmtDate(w.date)}` : `sets from ${fmtDate(sets[0].date)}`;
  if (!confirm(`Delete ${label} (${sets.length} sets)? This removes it from GitHub too.`)) return;
  dropWorkout(w, sets, 'Workout deleted');
}

// A workout reopened from history was already finished: "cancel" just stops editing it.
const isReopened = (w) => !!w.ended_at;

function cancelWorkout() {
  const w = activeWorkout();
  if (!w) return;
  readLogger();
  if (isReopened(w)) {
    state.current.activeWorkout = null;
    showView('home');
    return toast('Stopped editing');
  }
  const sets = workoutSets(w);
  const n = `${sets.length} logged ${sets.length === 1 ? 'set' : 'sets'}`;
  if (sets.length && !confirm(`Cancel ${w.name}? Its ${n} will be deleted.`)) return;
  dropWorkout(w, sets, 'Workout cancelled');
}

// ---------- shared entry actions ----------

function addEntry(kind, entry, message, onUndo) {
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
  toast(message, { action: { label: 'Undo', run: () => { deleteEntry(kind, entry.id); if (onUndo) onUndo(); } } });
  sync();
  return true;
}

function deleteEntry(kind, id, { confirm: ask = false } = {}) {
  const e = entries(kind).find((x) => x.id === id);
  if (!e) return;
  const what = {
    strength: () => `${liftName(e)} ${e.warmup ? 'warm-up set' : `set #${e.set_number}`} (${setText(e)})`,
    cardio: () => `${e.activity} (${describeCardio(e)})`,
    bodyweight: () => `the weigh-in for ${fmtDate(e.date)} (${fmtNum(e.weight_kg)} kg)`,
  }[kind]();
  if (ask && !confirm(`Delete ${what}?`)) return;
  state[TABLES[kind].key] = entries(kind).filter((x) => x.id !== id);
  state.tombstones.push({ id, date: e.date, kind });
  if (kind === 'strength') renumber(e);
  try { persist(); } catch (err) { return toast(`Could not save: ${err.message}`, { error: true }); }
  renderAll();
  toast({ strength: 'Set deleted', cardio: 'Session deleted', bodyweight: 'Weigh-in deleted' }[kind]);
  sync();
}

function step(field, dir) {
  const c = state.current;
  if (field === 'reps' || field === 'weight') {
    readLogger();
    const item = focusedItem(activeWorkout());
    if (!item) return;
    const { repStep, weightStep } = state.settings;
    if (field === 'reps') item.draft.reps = Math.max(0, Math.round(item.draft.reps + dir * repStep));
    else item.draft.weight = Math.max(0, round(item.draft.weight + dir * weightStep));
    persistQuietly();
    renderLogger();
    return;
  }
  if (field === 'bw') {
    readBodyweight();
    c.bodyweight = Math.max(0, round(c.bodyweight + dir * 0.1));
    persistQuietly();
    renderBodyweight();
    return;
  }
  readCardio();
  switch (field) {
    case 'duration': c.duration = Math.max(0, round(c.duration + dir, 4)); break;
    case 'distance': c.distance = Math.max(0, round(c.distance + dir * 0.5)); break;
    case 'floors': c.floors = Math.max(0, Math.round(c.floors + dir * 5)); break;
    case 'level': c.level = Math.max(0, round(c.level + dir, 1)); break;
  }
  persistQuietly();
  renderCardioForm();
}

// ---------- cardio actions ----------

function readCardio() {
  const c = state.current;
  const duration = parseDuration(els.cDuration.value);
  const distance = parseNum(els.cDistance.value);
  const floors = parseNum(els.cFloors.value);
  const level = parseNum(els.cLevel.value);
  if (duration >= 0) c.duration = round(duration, 4);
  if (distance >= 0) c.distance = round(distance);
  if (floors >= 0) c.floors = Math.round(floors);
  if (level >= 0) c.level = round(level, 1);
  persistQuietly();
}

function logCardio() {
  if (Date.now() - lastSaveAt < 400) return;
  readCardio();
  const c = state.current;
  const activity = cardioActivity();
  if (!activity) return;
  if (!(c.duration > 0)) return toast('Enter a duration', { error: true });

  const now = new Date();
  const entry = {
    id: uuid(),
    timestamp: localIso(now),
    date: localDate(now),
    activity,
    duration_min: round(c.duration),
    distance_km: c.cardioType === 'running' ? round(c.distance) : '',
    floors: c.cardioType === 'stairmaster' ? Math.round(c.floors) : '',
    level: c.cardioType === 'stairmaster' ? round(c.level, 1) : '',
    notes: els.cNotes.value.trim(),
    dirty: true,
  };
  state.current.view = 'home'; // cardio is a one-off: back to home, where it shows in history
  if (addEntry('cardio', entry, `${activity} logged: ${describeCardio(entry)}`)) {
    els.cNotes.value = '';
    window.scrollTo({ top: 0 });
  } else {
    state.current.view = 'cardio';
  }
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
  readCardio();
  state.current.cardioType = type;
  prefillCardio();
  persistQuietly();
  renderCardioForm();
}

function chooseActivity(activity) {
  readCardio();
  state.current.activity = activity;
  prefillCardio();
  persistQuietly();
  renderCardioForm();
}

function addActivity() {
  const name = (prompt('New activity (e.g. Volleyball)', '') || '').trim().replace(/\s+/g, ' ');
  if (!name) return;
  const existing = state.activities.find((a) => a.toLowerCase() === name.toLowerCase());
  if (!existing) state.activities.push(name);
  chooseActivity(existing || name);
}

// ---------- template sheet ----------

const itemLabel = (i) => (i.variation && i.variation !== 'Bodyweight' ? `${i.variation} ${i.exercise}` : i.exercise);

function renderTemplates() {
  const list = els.templateList;
  list.replaceChildren();
  const blank = button('tpl-card blank', null, () => startWorkout(null));
  blank.append(el('strong', null, 'Blank workout'), el('small', null, 'No template: add exercises as you go'));
  list.append(blank);

  for (const group of [...new Set(TEMPLATES.map((t) => t.group))]) {
    list.append(el('h4', null, group));
    for (const t of TEMPLATES.filter((x) => x.group === group)) {
      const card = button('tpl-card', null, () => startWorkout(t));
      const top = el('div', 'tpl-top');
      const last = templateLastDone(t.name);
      top.append(el('strong', null, t.name), el('span', 'tpl-last', last ? `Last: ${fmtDate(last)}` : 'Not done yet'));
      card.append(top, el('span', null, t.focus), el('small', null, t.items.map(itemLabel).join(' · ')));
      list.append(card);
    }
  }
}

function openTemplates() {
  if (activeWorkout()) return showView('workout');
  renderTemplates();
  els.templates.showModal();
  els.templateList.scrollTop = 0;
}

// ---------- exercise picker ----------

function pickButton(def) {
  const b = button('pick', def.name, () => pickExercise(def.name));
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
      list.append(button('pick add', `+ Add “${name}”`, () => pickExercise(addExercise(name))));
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
    const inCategory = sorted.filter((e) => categoryOf(e) === category);
    if (!inCategory.length) continue;
    list.append(el('h4', null, category));
    inCategory.forEach((e) => list.append(pickButton(e)));
  }
}

function openPicker(mode, key = null) {
  state.picker = { mode, key };
  els.pickerSearch.value = '';
  els.pickerSearch.placeholder = mode === 'swap' ? 'Swap to…' : 'Search or add…';
  renderPicker();
  els.picker.showModal();
  els.pickerList.scrollTop = 0;
}

function pickExercise(name) {
  if (!name) return;
  els.picker.close();
  if (state.picker.mode === 'swap') swapItem(state.picker.key, name);
  else addItem(name);
}

function onPickerEnter() {
  const q = els.pickerSearch.value.trim();
  if (!q) return;
  const ql = q.toLowerCase();
  const matches = state.exercises.filter((e) => e.name.toLowerCase().includes(ql));
  const exact = state.exercises.find((e) => e.name.toLowerCase() === ql);
  pickExercise(exact ? exact.name : matches.length === 1 ? matches[0].name : addExercise(q));
}

function addExercise(name) {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  const existing = state.exercises.find((e) => e.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing.name;
  state.exercises.push({ name: clean, category: 'Custom', variations: [] });
  persistQuietly();
  return clean;
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

// Merge local changes into one monthly file (e.g. sets/2026-10.csv): upsert by id, drop deleted ids.
async function syncFile(kind, month, upserts, deleteIds) {
  const { dir, columns } = TABLES[kind];
  const path = `${dir}/${month}.csv`;
  for (let attempt = 1; ; attempt++) {
    const { sha, text } = await getFile(path);
    const byId = new Map(parseCsv(text).map((r) => [r.id, r]));
    upserts.forEach((e) => byId.set(e.id, toRow(columns, e)));
    deleteIds.forEach((id) => byId.delete(id));
    if (!sha && !byId.size) return; // nothing to write, and no file to create
    const csv = toCsv(columns, [...byId.values()].sort((a, b) => rowTime(a).localeCompare(rowTime(b))));
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
      // Snapshot what's being sent, so an edit made mid-sync stays dirty for the next round.
      const sent = up.map((e) => [e, JSON.stringify(toRow(TABLES[kind].columns, e))]);
      await syncFile(kind, month, up, del);
      // Mark each file done as it lands, so a later failure doesn't redo it.
      for (const [e, snapshot] of sent) {
        if (JSON.stringify(toRow(TABLES[kind].columns, e)) === snapshot) e.dirty = false;
      }
      const delIds = new Set(del);
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
    // Only refresh the parts showing sync state; a full re-render could pull focus from an input.
    if (currentView() === 'workout') renderLogger();
    else if (currentView() === 'home') renderHome();
    else if (currentView() === 'bodyweight') renderBodyweight();
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
  if (kind !== 'strength' || !e.exercise) return;
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
      [toCsv(columns, [...entries(kind)].sort((a, b) => rowTime(a).localeCompare(rowTime(b))).map((e) => toRow(columns, e)))],
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
  const finished = state.workouts.filter((w) => w.id !== state.current.activeWorkout).length;
  els.sVersion.textContent = `App version ${APP_VERSION}`;
  els.sStats.textContent = `${finished} workouts, ${state.sets.length} sets and ${state.cardio.length} cardio sessions ` +
    `on this phone · ${pendingCount()} waiting to sync.`;
}

function renderExerciseList() {
  els.sExList.replaceChildren();
  for (const category of CATEGORIES) {
    const defs = state.exercises.filter((e) => categoryOf(e) === category).sort((a, b) => a.name.localeCompare(b.name));
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
        persistQuietly();
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
  persistQuietly();
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
      persistQuietly();
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
  persistQuietly();
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

  // Steppers and number inputs
  document.querySelectorAll('[data-step]').forEach((b) =>
    b.addEventListener('click', () => step(b.dataset.step, Number(b.dataset.dir))));
  for (const input of [els.reps, els.weight]) {
    input.addEventListener('change', () => { readLogger(); renderLogger(); });
  }
  for (const input of [els.cDuration, els.cDistance, els.cFloors, els.cLevel]) {
    input.addEventListener('change', () => { readCardio(); renderCardioForm(); });
  }
  for (const input of document.querySelectorAll('.stepper input')) {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  }

  // Home
  els.startBtn.addEventListener('click', openTemplates);
  els.resumeBtn.addEventListener('click', () => showView('workout'));
  els.activeFinishBtn.addEventListener('click', finishWorkout);
  els.activeCancelBtn.addEventListener('click', cancelWorkout);
  els.cardioBtn.addEventListener('click', () => showView('cardio'));
  els.weightBtn.addEventListener('click', openBodyweight);

  // Body weight
  els.bwBack.addEventListener('click', () => { readBodyweight(); showView('home'); });
  els.bwDate.addEventListener('change', () => { loadWeighInDraft(); renderBodyweight(); });
  els.bwWeight.addEventListener('change', () => { readBodyweight(); renderBodyweight(); });
  els.bwSaveBtn.addEventListener('click', logBodyweight);

  // Workout
  els.workoutBack.addEventListener('click', () => { readLogger(); showView('home'); });
  els.wName.addEventListener('click', renameWorkout);
  els.finishBtn.addEventListener('click', finishWorkout);
  els.cancelWorkoutBtn.addEventListener('click', cancelWorkout);
  els.addExerciseBtn.addEventListener('click', () => openPicker('add'));
  els.logSetBtn.addEventListener('click', logSet);
  els.flagWarmup.addEventListener('click', () => toggleDraftFlag('warmup'));
  els.flagFailure.addEventListener('click', () => toggleDraftFlag('failure'));
  els.swapBtn.addEventListener('click', () => openPicker('swap', activeWorkout().focus));
  els.removeItemBtn.addEventListener('click', removeItem);

  // Cardio
  els.cardioBack.addEventListener('click', () => { readCardio(); showView('home'); });
  els.cardioSeg.querySelectorAll('[data-cardio]').forEach((b) =>
    b.addEventListener('click', () => chooseCardioType(b.dataset.cardio)));
  els.cardioSaveBtn.addEventListener('click', logCardio);

  // Sheets
  els.pickerSearch.addEventListener('input', renderPicker);
  els.pickerSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onPickerEnter(); } });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  els.syncBtn.addEventListener('click', () => {
    if (!state.settings.token) return openSettings();
    if (state.lastError) toast(state.lastError, { error: true });
    sync();
  });

  // Settings
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
      persistQuietly();
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
    if (document.visibilityState === 'visible') { renderAll(); sync(); }
  });
  setInterval(() => {
    if (pendingCount() && !state.syncing) sync();
    if (currentView() === 'workout') renderWorkoutMeta(); // keep the elapsed time ticking
  }, 30000);

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

  persistQuietly(); // saves any catalogue migration
  renderAll();
  sync();
}

init();
