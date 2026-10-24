# Workout Log

A phone-first workout logger that runs as a home-screen web app. Sets save to the phone instantly, even
with no signal, then sync as monthly CSV files to a private GitHub repo you can `git pull` and hand to AI.

- **App:** this repo, hosted free on GitHub Pages: https://colin-duckworth.github.io/workout-logger/
- **Data:** private repo [`workout-data`](https://github.com/Colin-Duckworth/workout-data), one file per month: `sets/2026-10.csv`

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
- **Pick an exercise** (recent ones are at the top; type a new name to add it). Reps and weight start from what
  you did last time, and the hint shows your last session's sets.
- **Adjust with − / +**, or tap a number to type it. Weight accepts `82,5` or `82.5`.
- **Log set.** The values stay filled in, so the next set is usually one tap. Set numbers count up automatically;
  use the Set stepper to override.
- **Undo** in the confirmation toast, **Undo last** next to Today, or **×** on any set to delete it.
- **Sync pill** (top right): `✓ Synced`, `N pending`, `No signal · N pending`, or `Sync failed`. Tap it to retry or
  see the error. Sync runs after every set, when signal returns, when you reopen the app, and every 30 s while
  anything is pending. Orange dots mark sets that haven't synced yet.
- **Settings:** stepper sizes, exercise list, **Export all sets as CSV** (fallback without GitHub), and
  **Restore history from GitHub** (for a new phone or after clearing Safari data).

## Getting the data on your computer
```bash
git clone https://github.com/Colin-Duckworth/workout-data.git
```
After that, `git pull` inside `workout-data` gets the latest. For a monthly review, open Claude Code in that folder and
ask something like *"Analyse sets/2026-10.csv: progress on main lifts, weekly volume, consistency, stalls,
compared with last month."*

If you ever fix a typo in a CSV on your computer, `git pull` first, then commit and push. The app merges by `id`,
so your edit stays unless you also delete that set on the phone.

## CSV schema
One row per set (long format):

| column | example | notes |
|---|---|---|
| `id` | `3f2c…` | UUID made on the phone; sync merges on it, so rows never duplicate |
| `timestamp` | `2026-10-24T18:05:12.345+02:00` | when the set was logged, phone's local time with offset |
| `date` | `2026-10-24` | local date, for grouping by day/week/month |
| `exercise` | `Bench Press` | |
| `set_number` | `3` | per exercise per day |
| `reps` | `5` | |
| `weight_kg` | `82.5` | `0` for bodyweight movements |
| `rpe` | `8` | optional, blank if not entered |
| `notes` | `paused` | optional |

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
- `app.js`: logging, today's list, picker, settings, and sync. Sets live in `localStorage` (the phone is the source
  of truth). Sync reads the month's CSV through the GitHub Contents API, adds new sets and removes deleted ones by
  `id`, and writes it back. It retries if the file changed in between.
- `sw.js`: service worker that caches the app so it opens with no signal.
