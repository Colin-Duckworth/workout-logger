# Workout Log

A phone-first logger for workouts and cardio that runs as a home-screen web app. Entries save to the phone
instantly, even with no signal, then sync as monthly CSV files to a private GitHub repo you can `git pull` and
hand to AI.

- **App:** this repo, hosted free on GitHub Pages: https://colin-duckworth.github.io/workout-logger/
- **Data:** private repo [`workout-data`](https://github.com/Colin-Duckworth/workout-data), one file per month per type:
  `workouts/2026-10.csv`, `sets/2026-10.csv` and `cardio/2026-10.csv`

Plain HTML/CSS/JS with no build step and no dependencies.

## One-time setup

### 1. Create a GitHub token for the app
The app writes to `workout-data` using a fine-grained token that can't touch anything else.

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
   (direct link: https://github.com/settings/personal-access-tokens/new).
2. **Name:** `workout-logger`. **Expiration:** the longest it allows. You'll paste in a new one when it expires.
3. **Repository access:** *Only select repositories* → `workout-data`.
4. **Permissions → Repository permissions → Contents:** *Read and write*. Leave everything else at the defaults.
5. Generate it and copy the `github_pat_…` value.

### 2. Install on your iPhone
1. Open https://colin-duckworth.github.io/workout-logger/ in **Safari**. It has to be Safari for home-screen install on iOS.
2. Tap **Share → Add to Home Screen → Add**.
3. Open the app from the home screen, tap **⚙︎**, paste the token, and tap **Save & test connection**.
   It should say "Connected to Colin-Duckworth/workout-data (private)."

The token is stored only on your phone. Use the home-screen icon from now on: the home-screen app has its own
storage, separate from the Safari tab.

## Using it
The home screen has **Start workout**, **Log cardio**, and your **History**.

### Workouts
- **Start workout** offers a **blank workout** or a template: Push A/B, Pull A/B, Legs A/B, Rehab A/B. Each
  template shows when you last did it.
- Each exercise is a card with its target (e.g. *Dumbbell · 3 × 6–10 · per arm*) and a progress count. The open
  card has the variation chips, a "last time" hint, the sets you've logged, and weight/reps steppers (weight ±2 kg).
- **Log set.** Weight and reps start from your last working set on that exact exercise + variation. When you hit
  the target number of sets, the next unfinished exercise opens. Tap any card to jump to it.
- **Warm-up** and **To failure** toggles above Log set apply to the next set only. Warm-up sets show as **W**, aren't
  numbered, and don't count toward the target, volume, or starting weights. Failure sets show **(F)**. Tap a logged
  set to flag or unflag it afterwards; the working sets renumber themselves.
- **Swap exercise** (e.g. back squat → hack squat) or **Remove** it while it has no sets. **+ Add exercise** adds
  anything. **+ Variation** adds your own variation.
- Tap the workout name to rename it. **‹** goes home and leaves the workout running; home shows **Resume**.
- **Cancel** (on the home card, or *Cancel workout* at the bottom of the workout) throws the workout away along
  with any sets logged in it, including on GitHub. For a workout reopened from History it says **Close** /
  *Stop editing* instead and keeps everything.
- **Finish** saves the end time and duration. A workout with no sets is discarded. If you forget to tap
  Finish, the workout ends at your last set rather than when you eventually tap it.
- **History:** tap a workout to see its exercises, then **Edit** to reopen it or **Delete** to remove it (from
  GitHub too).
- **Bodyweight moves** (Pull-up, Dip, Nordic Curl, …): log `0` kg, or the added weight for the *Weighted* variation.

### Cardio
- **Running:** duration and distance. Pace is calculated for you.
- **Stairmaster:** duration, floors climbed, and speed level.
- **Other:** pick an activity (Basketball, Swimming, Padel, Soccer, …, or **+ Activity**) and the duration.
- **Duration** accepts minutes (`45`) or minutes and seconds. The iPhone number pad has no colon, so `32.15` or
  `32,15` means 32:15. `1:05:00` works too.

### Everything else
- **Undo** is in the confirmation toast; **×** deletes any single set or cardio session.
- **Sync pill** (top right): `✓ Synced`, `N pending`, `No signal · N pending`, or `Sync failed`. Tap it to retry or
  see the error. Sync runs after every entry, when signal returns, when you reopen the app, and every 30 s while
  anything is pending. Orange dots mark sets that haven't synced yet.
- **Settings:** stepper sizes, exercises and their variations (tap one to edit), other cardio activities,
  **Export everything as CSV** (fallback without GitHub), and **Restore history from GitHub** (for a new phone or
  after clearing Safari data).

## Getting the data on your computer
```bash
git clone https://github.com/Colin-Duckworth/workout-data.git
```
After that, `git pull` inside `workout-data` gets the latest. For a monthly review, open Claude Code in that folder and
ask something like *"Analyse October (workouts/, sets/ and cardio/ 2026-10.csv): progress on main lifts per
template, weekly volume, running pace, consistency, stalls, compared with last month."*

If you ever fix a typo in a CSV on your computer, `git pull` first, then commit and push. The app merges by `id`,
so your edit stays unless you also change that entry on the phone.

## CSV schema
### `workouts/YYYY-MM.csv`: one row per workout
| column | example | notes |
|---|---|---|
| `id` | `b9f9…` | UUID; sets point at it with `workout_id` |
| `date` | `2026-10-24` | the day the workout started |
| `name` | `Push A` | template name, `Workout` for blank ones, or whatever you renamed it to |
| `template` | `Push A` | blank if started without a template |
| `started_at`, `ended_at` | `2026-10-24T18:05:12.345+02:00` | phone's local time with offset |
| `duration_min` | `62` | |

### `sets/YYYY-MM.csv`: one row per set (long format)
| column | example | notes |
|---|---|---|
| `id` | `3f2c…` | UUID made on the phone; sync merges on it, so rows never duplicate |
| `timestamp` | `2026-10-24T18:05:12.345+02:00` | when the set was logged |
| `date` | `2026-10-24` | the workout's date (stays the same if a workout runs past midnight) |
| `workout_id` | `b9f9…` | links to `workouts/*.csv`; blank for sets logged before workouts existed |
| `workout` | `Push A` | workout name, so the file reads on its own |
| `exercise` | `Bench Press` | |
| `variation` | `Dumbbell` | blank for exercises without variations |
| `set_number` | `3` | working sets 1, 2, 3… per exercise within the workout; blank for warm-ups |
| `reps` | `5` | |
| `weight_kg` | `82.5` | `0` for bodyweight movements |
| `warmup` | `false` | `true` for warm-up sets |
| `failure` | `false` | `true` for sets taken to failure |
| `rpe` | `8` | optional, blank if not entered |
| `notes` | `paused` | optional |

### `cardio/YYYY-MM.csv`: one row per session
| column | example | notes |
|---|---|---|
| `id`, `timestamp`, `date` | | same as above |
| `activity` | `Running`, `Stairmaster`, `Padel` | |
| `duration_min` | `32.25` | minutes as a decimal (32.25 = 32:15) |
| `distance_km` | `5.2` | running only |
| `floors` | `105` | stairmaster only |
| `level` | `9` | stairmaster speed level |
| `notes` | `intervals` | optional |

## Releasing changes
Edit the files, then:
```bash
./release.sh "what changed"
```
That bumps the service-worker version, commits and pushes. GitHub Pages redeploys in about a minute. The phone
picks up the update the next time it opens the app online and shows an **App updated · Reload** toast.

To try changes locally first:
```bash
python3 -m http.server 8000
```
Then open http://localhost:8000.

## How it works
- `index.html`, `styles.css`: UI. Large touch targets, dark mode follows the system setting.
- `app.js`: logging, history, templates, picker, settings, and sync. The exercise catalogue (`DEFAULT_EXERCISES`)
  and workout templates (`TEMPLATES`) are at the top of the file. Entries live in `localStorage` (the phone is the
  source of truth). Sync reads each month's CSV through the GitHub Contents API, adds new and changed entries and
  removes deleted ones by `id`, and writes it back. It retries if the file changed in between.
- `sw.js`: service worker that caches the app so it opens with no signal.
