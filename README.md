# Command Centre

A full-screen personal dashboard for a second monitor. Built with Tauri 2 (Rust) and React + TypeScript. All data is stored locally in SQLite, with automatic daily backups.

## Status

| Stage | Contents | State |
|---|---|---|
| 1 | App shell, monitor placement, editable grid, clock, daily checklist, tasks, quick-add, backups | **Done** |
| 2 | Tasks v2 (projects, subtasks, statuses, board, repeats), Google Calendar, Google Tasks sync, Running card and page (training plan + Strava) | **Done** |
| 2b | Fitness card (VO2 max trend vs projection, race predictor, training load), Latest run card, shoes, aerobic efficiency | **Done** |
| 2c | Overview + tabs with animated transitions, Slate/Light/Dark themes, text size, training calendar | **Done** |
| 3 | Research goals, gym tracker (with strength A/B from the plan), photos | Next |
| 4 | Weather, Pomodoro, notes, polish | |

## Installing

Run `Command Centre_x.y.z_x64-setup.exe`. It installs for your user only, without admin rights. On first launch the app:

- opens full-screen on your secondary monitor (it prefers a portrait one) and remembers it
- turns on launch at login (you can switch this off in Settings)
- creates its data folder at `%APPDATA%\CommandCentre\`

Windows SmartScreen may warn that the installer is from an unknown publisher, because it isn't code-signed. Choose **More info → Run anyway**.

## Using it

| Action | How |
|---|---|
| Quick-add a task or checklist item from any app | **Ctrl+Alt+Space** (Tab switches between Task and Checklist item) |
| Switch tab | Click it, or **Ctrl+1…6** |
| Rearrange, resize or hide overview tiles | **Ctrl+E**, or **Edit** (top right) |
| Settings | **Ctrl+,**, or ⚙ (top right) |
| Toggle full-screen | **F11** |

**Tasks** are added with a title plus fields for project, due date, priority, time estimate and repeat. The Overview shows them as a simple **To do** list. The Tasks tab has three views: **Focus** (overdue, today, in progress, next 7 days, waiting, scheduled), **Projects** (each project with its colour and progress) and **Board** (drag cards between To do, In progress, Waiting and Done). Click any task to open its detail panel: status, priority, project, start date, due date, estimate, repeat, notes and subtasks.

**Task syntax**, which works both in the Tasks card and in quick-add:

```
Email supervisor about chapter 2 #thesis !1 @fri
```

| Token | Meaning |
|---|---|
| `#project` | Project. Dashes become spaces: `#lit-review` |
| `!1` `!2` `!3` | High, medium or low priority (`!high`, `!med` and `!low` also work) |
| `@today` `@tom` | Today or tomorrow |
| `@fri` | The coming Friday (today if it is Friday) |
| `@nextweek` | Next Monday |
| `@3/11` | 3 November (day/month) |
| `@2027-05-30` | An exact date |
| `@+5` | In five days |
| `^mon` | Start date: hidden from Focus until then (same date words as `@`) |
| `~45m` `~2h` `~1h30` | Time estimate |
| `*daily` `*weekdays` `*weekly` `*2w` `*monthly` `*mon,thu` | Repeat. The next one is created when you finish this one |

Click a task to edit it. Ticked tasks stay visible (struck through) under "Done today" until the day ends, so a mis-tap is easy to undo.

**Habits** (the old daily checklist) show the last 7 days as ticks on the Overview and 28 days on the Habits tab; click a past day to fill it in. Items reset each morning at 04:00 by default, so anything ticked after midnight still counts for the evening before. You can change the reset time in Settings. To track an amount rather than a simple tick, add a number to the item: `Research 3h` counts in half-hour steps up to 3 h. A day only counts towards the streak once the target is reached. Removing an item keeps its history.

**Layout.** The top bar has tabs: **Overview** (the key facts from everything, as tiles you can rearrange with Ctrl+E), then **Training**, **Fitness**, **Calendar**, **Tasks** and **Daily**. Click a tab, a tile's title, or press Ctrl+1…6 (Ctrl+PageUp/PageDown cycles). Settings → Display has the theme (Slate, the mid-tone default; Light; Dark; or match Windows) and text size.

**Training calendar.** On the Overview, this week; on the Training tab, six weeks at a time. For each day: each day's session, an estimated distance (≈ km), the target pace, strength A/B days and races, and what you actually ran (click a run to open it on Strava). Scroll the mouse wheel over it, use ← →, or click a week in the strip underneath to move through the plan; **This week** jumps back. Distances for the days the plan doesn't name are sized from the weekly structure so the week adds up to its target, so treat them as a guide. Weeks after Edinburgh show the block's focus until the doc has day-by-day sessions for them.

**Running.** The card shows this week's kilometres against the plan, today's and tomorrow's sessions, your last run, the last 12 weeks and the next race countdowns. Click **Plan ›** for the full page: this week, the whole plan with what you actually ran, races and benchmark status, progression (same numbers as your Running progression review) and paces and strength.

The plan comes from your Claude doc "Sub-2:50 Training Plan". It's stored as `training-plan.json` in the data folder and the app picks up changes within five minutes. When the plan changes, ask Claude: *"Re-export my training plan for Command Centre"*. That reads the doc and runs `tools/plan_from_doc.py`, then writes the new file.

**Fitness.** VO2 max is estimated from your *key runs*: any run with at least three steady kilometres above 80% of max heart rate (first 30 km only). Each such kilometre's grade-adjusted pace and heart rate give an estimate (Daniels' oxygen cost + heart-rate reserve); the run's value is their median. Garmin readings you type in are shown next to the estimates but don't change them: Garmin's VO2 max runs a few points above the race-result (VDOT) scale that the goals and predictions use. Weekly key-run values are compared with a projection from your current level to the VO2 max (VDOT) your goals need: 57.3 for sub-2:50 at Edinburgh, 59.3 for sub-2:45 at Valencia. Estimates are put on your race-result scale, or on Garmin's scale once you type in a reading from Garmin Connect (Running page → Fitness & VO2 max). Max/resting heart rate and the projection are editable there, and saved in `fitness.json`. Race predictions are *race-ready* times: they use the better of your current key-run level and your best race of the last 12 months, since training-run estimates dip after a marathon or in a recovery block; the Fitness tab also shows the current-form times. The same tab has a race predictor, Garmin-style training load (acute vs chronic), aerobic efficiency on easy runs, and shoe mileage.

**Health** (Garmin). Settings → Connections → Connect Garmin opens Garmin's own sign-in page in a small window (password and two-step code go straight to Garmin). The Health tab and tile then show training readiness, HRV (last night, 7-day average and your normal range), resting heart rate, sleep, Body Battery, Garmin's VO2 max and Garmin's race predictions, synced every 30 minutes and cached for offline use. Garmin has no public API for personal use, so this signs in the way Garmin's phone app does; if Garmin changes that, the sync stops (your saved data stays) until the app is updated.

**Predictions** use your own speed–endurance curve (time ∝ distance^k, with k fitted to your best races of the last 9 months, anchored on your best 10 km-equivalent of the last year), the same idea as Garmin's predictor. Plain VDOT columns are shown alongside, and Garmin's own predictions once Garmin is connected.

**Pace on point** (Training tab) scores each run against the plan's pace for that day: easy and long runs on the whole run (slower than the easy range still counts), sessions on the work only — watch laps that look like reps, otherwise the fastest kilometres. The Running tile shows the last 14 days. **Marathon shape** (as in Runalyze) checks weekly km (last 6 months) and long runs (last 10 weeks) against what a marathon at your level needs, and slows the marathon prediction when they aren't there yet.

**Changing the plan.** On the Training tab, hover a day and click ✎ to change it, swap it with another day, or go back to the plan. Your changes are kept in the app; the doc stays the master copy.

**Latest run** shows your most recent Strava run: route, distance, time, pace, heart rate, shoe, km splits and its VO2 estimate. Click *Strava ↗* to open it.

The first time you connect Strava, the app reads the heart-rate splits of your last ~14 months of runs, 25 runs per sync, so the VO2 history fills in over the first couple of hours (it stays well within Strava's rate limits).

**Calendar** shows today (with the current event highlighted and a countdown to the next one) and the next 7 days. Choose which calendars appear with the ✎ button.

**Google Tasks sync.** Each project is a list in Google Tasks; tasks without a project go to your default list. Title, notes, due date, done and subtasks sync both ways every two minutes (and shortly after any change). Priority, status, start date, estimate and repeat rules stay on the dashboard; a repeating task ticked on your phone still repeats. Turn it off in Settings if you prefer.

Everything from Strava and Google is cached locally, so the cards keep showing the last data when you're offline.

## Your data

Everything lives in `%APPDATA%\CommandCentre\`:

| File | What it is |
|---|---|
| `command-centre.db` | SQLite database holding all cards' data, the layout and settings |
| `config.json` | Which monitor, the quick-add shortcut, full-screen on/off |
| `backups\YYYY-MM-DD\` | Daily snapshot of the database and the JSON files. The last 30 are kept |
| Logs | `%LOCALAPPDATA%\com.harry.commandcentre\logs\` |

To restore a backup, quit the app, copy `command-centre.db` from a backup folder over the live one, and start the app again.

API keys and tokens (from Stage 2 onwards) are stored in **Windows Credential Manager**. They are never written to these files or to the code.

## Getting credentials (needed for Stage 2)

### Strava

1. Go to <https://www.strava.com/settings/api> and create an application. Any name and website will do. Set **Authorization Callback Domain** to `localhost`.
2. Copy the **Client ID** and **Client Secret** into Command Centre → Settings → Strava, then click **Connect**. Your browser opens and asks you to approve read-only access.

### Calendar (quick way, about a minute)

1. Open **calendar.google.com** on your computer and click **⚙ → Settings**.
2. On the left, under **Settings for my calendars**, click your calendar (usually your name).
3. Scroll to **Integrate calendar** and copy the **Secret address in iCal format** (it ends in `basic.ics`).
4. In Command Centre, paste it into the Calendar tile (or Settings → Calendar) and click **Add**. Repeat for other calendars.

The address is stored in Windows Credential Manager. Outlook and iCloud calendar links work the same way. Google can take a while to put brand-new events into this feed; the full Google sign-in below is instant.

### Google (Tasks sync, and instant calendar)

1. Open <https://console.cloud.google.com/>, create a project (e.g. "Command Centre"), and enable both the **Google Calendar API** and the **Google Tasks API** for it.
2. Under **OAuth consent screen**, choose **External** and fill in the app name and your email. Add yourself as a test user.
3. Then click **Publish app**. Without this step, Google expires the sign-in every 7 days. Publishing a personal app is fine: Google will show an "unverified app" warning when you sign in, which you can click through, since you are the only user.
4. Under **Credentials**, choose **Create credentials → OAuth client ID → Desktop app**. Copy the **Client ID** and **Client Secret** into Command Centre → Settings → Google Calendar, then click **Connect**.

The app requests read-only calendar access and access to your Google Tasks.

## Development

Requirements: Node 22+, Rust (stable), and on Windows the Visual Studio C++ Build Tools. WebView2 is already part of Windows 11.

```bash
npm install
npm run tauri dev          # run the desktop app with hot reload
npm test                   # frontend unit tests
cd src-tauri && cargo test # backend unit tests
npm run tauri build        # produce the installer in src-tauri/target/release/bundle/nsis
npm run preview:browser    # UI-only preview in a normal browser (in-browser SQLite, no desktop features)
```

Every push to `main` builds the Windows installer on GitHub Actions (`.github/workflows/build.yml`).

### Layout of the code

```
src-tauri/src/
  db.rs         SQLite connection, JSON <-> SQL, transactions, snapshots
  backup.rs     daily backup + pruning
  config.rs     config.json (monitor, shortcut)
  window.rs     monitor choice, full-screen, watchdog that keeps it there
  quickadd.rs   global shortcut + quick-add popup window
  lib.rs        wiring and commands
src/
  core/         backend bridge, db helpers, migrations, events, time, settings
  shell/        dashboard grid, edit mode, settings panel, quick-add popup
  modules/      one folder per card + registry.ts
```

### Adding a card

1. Create `src/modules/<name>/index.tsx` exporting a `DashboardModule` (see `src/modules/types.ts`):

   ```tsx
   import type { DashboardModule } from "../types";
   // For data from an API, use backend.apiRequest(...) — tokens stay in the keychain.
   import { CardHeader } from "../../shell/ui";

   function QuoteCard() {
     return (
       <>
         <CardHeader title="Quote" />
         <p>Run the mile you're in.</p>
       </>
     );
   }

   export const quoteModule: DashboardModule = {
     id: "quote",                               // stable, never change it
     title: "Quote",
     defaultPos: { x: 0, y: 36, w: 12, h: 4 },  // 12 columns × 40 rows
     migrations: [],                            // SQL strings, run once each; only ever append
     Card: QuoteCard,
     // quickAdd: [...]                         // optional quick-add targets
   };
   ```

2. Add it to the list in `src/modules/registry.ts`.

That's all. The shell gives the card a place in the grid (free space first, otherwise the hidden tray in edit mode), an error boundary, edit-mode handles, and runs its migrations. For data, use `db.select/execute/batch` from `core/db.ts`. Call `notifyChanged("<topic>")` after writing and `useDataVersion("<topic>")` to re-load. For time, use `useNow()` and `useToday()` from `core/time.ts` rather than `setInterval`, because one shared timer keeps memory flat over long runs.
