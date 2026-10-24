# Workout Log

A phone-first workout logger for weight training and cardio that runs as a home-screen web app. Entries save to
the phone instantly, even with no signal, then sync as monthly CSV files to a private GitHub repo you can `git pull`
and hand to AI.

- **App:** this repo, hosted free on GitHub Pages: https://colin-duckworth.github.io/workout-logger/
- **Data:** private repo [`workout-data`](https://github.com/Colin-Duckworth/workout-data), one file per month per type:
  `sets/2026-10.csv` (weights) and `cardio/2026-10.csv`

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
Switch between **Weights** and **Cardio** at the top of the form.

### Weights
- **Pick an exercise.** Recent ones are at the top, then Push / Pull / Legs / Arms / Core. Type a new name to add it.
- **Pick a variation** (Barbell, Dumbbell, Smith Machine…) from the chips under the exercise. Use **+ Variation** to
  add your own. Each variation is tracked on its own: set numbers, the "last time" hint, and the starting reps
  and weight all come from that exact variation.
- **Adjust with − / +**, or tap a number to type it. Weight accepts `82,5` or `82.5`.
- **Log set.** The values stay filled in, so the next set is usually one tap. Set numbers count up automatically;
  use the Set stepper to override.
- **Bodyweight moves** (Pull-up, Dip, …): log `0` kg, or the added weight for the *Weighted* variation.

### Cardio
- **Running:** duration and distance. Pace is calculated for you.
- **Stairmaster:** duration, floors climbed, and speed level.
- **Other:** pick an activity (Basketball, Swimming, Padel, Soccer, …, or **+ Activity**) and the duration.
- **Duration** accepts minutes (`45`) or minutes and seconds. The iPhone number pad has no colon, so `32.15` or
  `32,15` means 32:15. `1:05:00` works too.

### Both
- **Undo** in the confirmation toast, **Undo last** next to Today, or **×** on any entry to delete it. Tap a group
  title under Today to jump back to that exercise or activity.
- **Sync pill** (top right): `✓ Synced`, `N pending`, `No signal · N pending`, or `Sync failed`. Tap it to retry or
  see the error. Sync runs after every set, when signal returns, when you reopen the app, and every 30 s while
  anything is pending. Orange dots mark entries that haven't synced yet.
- **Settings:** stepper sizes, exercises and their variations (tap one to edit), other cardio activities,
  **Export all sets as CSV** (fallback without GitHub), and
  **Restore history from GitHub** (for a new phone or after clearing Safari data).

## Getting the data on your computer
```bash
git clone https://github.com/Colin-Duckworth/workout-data.git
```
After that, `git pull` inside `workout-data` gets the latest. For a monthly review, open Claude Code in that folder and
ask something like *"Analyse sets/2026-10.csv and cardio/2026-10.csv: progress on main lifts, weekly volume,
running pace trends, consistency, stalls, compared with last month."*

If you ever fix a typo in a CSV on your computer, `git pull` first, then commit and push. The app merges by `id`,
so your edit stays unless you also delete that set on the phone.

## CSV schema
### `sets/YYYY-MM.csv`: one row per set (long format)

| column | example | notes |
|---|---|---|
| `id` | `3f2c…` | UUID made on the phone; sync merges on it, so rows never duplicate |
| `timestamp` | `2026-10-24T18:05:12.345+02:00` | when the set was logged, phone's local time with offset |
| `date` | `2026-10-24` | local date, for grouping by day/week/month |
| `exercise` | `Bench Press` | |
| `variation` | `Dumbbell` | blank for exercises without variations |
| `set_number` | `3` | per exercise + variation per day |
| `reps` | `5` | |
| `weight_kg` | `82.5` | `0` for bodyweight movements |
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
- `app.js`: logging, today's list, picker, settings, and sync. Entries live in `localStorage` (the phone is the
  source of truth). Sync reads the month's CSV through the GitHub Contents API, adds new entries and removes
  deleted ones by `id`, and writes it back. It retries if the file changed in between. The exercise catalogue
  (`DEFAULT_EXERCISES`) is at the top of the file.
- `sw.js`: service worker that caches the app so it opens with no signal.
