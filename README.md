# Command Centre

A full-screen personal dashboard for a second monitor. Built with Tauri 2 (Rust) and React + TypeScript. All data is stored locally in SQLite, with automatic daily backups.

## Status

| Stage | Contents | State |
|---|---|---|
| 1 | App shell, monitor placement, editable grid, clock, daily checklist, tasks, quick-add, backups | **Done** |
| 2 | Google Calendar, Strava running card | Next |
| 3 | Research goals, gym tracker, photos | |
| 4 | Weather, Pomodoro, notes, polish, signed installer | |

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
| Rearrange, resize or hide cards | **Ctrl+E**, or move the mouse and click **Edit layout** (top right) |
| Settings | **Ctrl+,**, or move the mouse and click **Settings** |
| Toggle full-screen | **F11** |

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

Click a task to edit it. Ticked tasks stay visible (struck through) under "Done today" until the day ends, so a mis-tap is easy to undo.

**Daily checklist.** Items reset each morning at 04:00 by default, so anything ticked after midnight still counts for the evening before. You can change the reset time in Settings. To track an amount rather than a simple tick, add a number to the item: `Research 3h` counts in half-hour steps up to 3 h. A day only counts towards the streak once the target is reached. Removing an item keeps its history.

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

### Google Calendar

1. Open <https://console.cloud.google.com/>, create a project (e.g. "Command Centre"), and enable the **Google Calendar API** for it.
2. Under **OAuth consent screen**, choose **External** and fill in the app name and your email. Add yourself as a test user.
3. Then click **Publish app**. Without this step, Google expires the sign-in every 7 days. Publishing a personal app is fine: Google will show an "unverified app" warning when you sign in, which you can click through, since you are the only user.
4. Under **Credentials**, choose **Create credentials → OAuth client ID → Desktop app**. Copy the **Client ID** and **Client Secret** into Command Centre → Settings → Google Calendar, then click **Connect**.

The app only requests read-only calendar access.

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
     defaultPos: { x: 0, y: 17, w: 6, h: 4 },   // 12 columns × 30 rows
     migrations: [],                            // SQL strings, run once each; only ever append
     Card: QuoteCard,
     // quickAdd: [...]                         // optional quick-add targets
   };
   ```

2. Add it to the list in `src/modules/registry.ts`.

That's all. The shell gives the card a place in the grid (free space first, otherwise the hidden tray in edit mode), an error boundary, edit-mode handles, and runs its migrations. For data, use `db.select/execute/batch` from `core/db.ts`. Call `notifyChanged("<topic>")` after writing and `useDataVersion("<topic>")` to re-load. For time, use `useNow()` and `useToday()` from `core/time.ts` rather than `setInterval`, because one shared timer keeps memory flat over long runs.
