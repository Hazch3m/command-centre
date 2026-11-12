import { useRef, useState, type ReactNode } from "react";
import { db } from "../core/db";
import { useDataVersion, notifyChanged } from "../core/events";
import { cancelled, isNativeApp } from "../core/native";
import { useQuery } from "../core/useQuery";
import { hasAccount, phoneState } from "../core/backend.phone";
import { appleHealthAvailable, appleHealthState, connectAppleHealth } from "../modules/health/appleHealth";
import { importStravaArchive, type ImportProgress, type ImportResult } from "../modules/running/stravaArchive";
import { connectAndSync } from "./Account";

/*
 * "How do you record your runs?" and the steps for that answer, so runs come in by themselves and are
 * kept; then, for older runs, bringing in your Strava archive.
 */

type Source = "garmin" | "watch" | "strava" | "other" | "phoneapp";
const SOURCES: { id: Source; label: string; sub: string }[] = [
  { id: "strava", label: "Strava on my phone", sub: "You press start in the Strava app" },
  { id: "watch", label: "Apple Watch", sub: "The Workout app, or any app on the watch" },
  { id: "garmin", label: "Garmin watch", sub: "Forerunner, Fenix, Venu…" },
  { id: "other", label: "COROS, Polar or Suunto", sub: "A watch with its own app" },
  { id: "phoneapp", label: "Another phone app", sub: "Nike Run Club, Runkeeper, adidas Running…" },
];
const KEY = "pl-run-source";
const loadSource = (): Source | null => {
  try {
    const s = localStorage.getItem(KEY);
    return SOURCES.some((x) => x.id === s) ? (s as Source) : null;
  } catch {
    return null;
  }
};

const fmtDay = (d: string) => new Date(d.slice(0, 10) + "T12:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

function Step({ n, done, title, children }: { n: number; done?: boolean; title: string; children?: ReactNode }) {
  return (
    <li className={"rs-step" + (done ? " done" : "")}>
      <span className="rs-n" aria-hidden="true">
        {done ? "✓" : n}
      </span>
      <div className="rs-body">
        <b>{title}</b>
        {children}
      </div>
    </li>
  );
}

/** The newest run that came in from Apple Health, to show the set-up worked. */
function useLatestHealthRun() {
  const rv = useDataVersion("running");
  return useQuery(async () => (await db.select<{ d: string | null; n: number }>("SELECT MAX(start_local) AS d, COUNT(*) AS n FROM strava_activities WHERE id LIKE 'hk%'"))[0] ?? { d: null, n: 0 }, [rv]).data;
}

function HealthSteps({ first, start }: { first: ReactNode; start: number }) {
  const hv = useDataVersion("health");
  const can = useQuery(appleHealthAvailable, []).data ?? false;
  const st = useQuery(appleHealthState, [hv]).data;
  const latest = useLatestHealthRun();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const on = !!st?.on;
  const connect = async () => {
    setBusy(true);
    setNote(null);
    try {
      const s = await connectAppleHealth();
      await notifyChanged("*");
      setNote(s.lastError ? `Connected, but reading Health failed: ${s.lastError}` : null);
    } catch (e) {
      if (!cancelled(e)) setNote(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {first}
      <Step n={start} done={on} title="Connect Apple Health in Pacelife">
        {on ? (
          <p>Connected. Pacelife reads your runs back to January 2024, then each new one as you open the app, and keeps them.</p>
        ) : can ? (
          <>
            <p>Apple asks what Pacelife may read: allow Workouts, Workout Routes and Heart Rate (sleep and HRV help too).</p>
            <button type="button" className="p-pill" disabled={busy} onClick={connect}>
              {busy ? "Connecting…" : "Connect Apple Health"}
            </button>
          </>
        ) : (
          <p>Apple Health is only on iPhone: open Pacelife on your iPhone to do this step.</p>
        )}
        {note && <p className="rs-note">{note}</p>}
      </Step>
      <Step n={start + 1} done={!!latest?.d} title="Go for a run">
        {latest?.d ? (
          <p>
            Working: {latest.n} {latest.n === 1 ? "run" : "runs"} from Apple Health so far, the newest on {fmtDay(latest.d)}.
          </p>
        ) : (
          <p>Your next run appears here a moment after you save it. Open Pacelife and pull down to refresh if it hasn't.</p>
        )}
      </Step>
    </>
  );
}

function GarminSteps() {
  const connected = !!phoneState.header?.connected.garmin;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <>
      <Step n={1} done={connected} title="Connect Garmin">
        {connected ? (
          <p>Connected. Runs, sleep, HRV and resting heart rate come in by themselves, and workouts can go to your watch.</p>
        ) : (
          <>
            <p>You sign in on Garmin's own page; Pacelife never sees your password.</p>
            <button
              type="button"
              className="p-pill"
              disabled={busy || !hasAccount()}
              onClick={async () => {
                setBusy(true);
                try {
                  setNote(await connectAndSync());
                } catch (e) {
                  if (!cancelled(e)) setNote(String((e as Error)?.message ?? e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Connecting…" : "Connect Garmin"}
            </button>
          </>
        )}
        {note && <p className="rs-note">{note}</p>}
      </Step>
    </>
  );
}

function ArchiveImport() {
  const input = useRef<HTMLInputElement>(null);
  const [prog, setProg] = useState<ImportProgress | null>(null);
  const [res, setRes] = useState<ImportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const busy = !!prog && prog.stage !== "done";
  const go = async (f: File) => {
    setErr(null);
    setRes(null);
    try {
      setRes(await importStravaArchive(f, setProg));
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setProg(null);
    }
  };
  return (
    <section className="rs-card">
      <h2>Your older runs: import your Strava archive</h2>
      <p className="rs-lead">Strava only sends runs to Apple Health from the day you turn it on. Your archive has every run before that, with routes, and once it's here it stays.</p>
      <ol className="rs-steps">
        <Step n={1} title="Ask Strava for your archive">
          <p>
            On strava.com (in a browser, signed in): your picture → Settings → My Account → Download or Delete Your Account → Get Started → Request Your Archive. Strava emails you a link, usually within a few hours.
          </p>
        </Step>
        <Step n={2} title="Download the zip from the email">
          <p>It's called export_ and a number, .zip. On iPhone it goes to Files → Downloads. Don't open or unzip it.</p>
        </Step>
        <Step n={3} done={!!res} title="Choose it here">
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void go(f);
            }}
          />
          <button type="button" className="p-pill" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Importing…" : res ? "Import another archive" : "Choose the zip"}
          </button>
          {prog && (
            <div className="rs-prog" role="status">
              <span className="rs-bar">
                <i style={{ width: prog.total ? `${(prog.done / prog.total) * 100}%` : "8%" }} />
              </span>
              <span className="num">{prog.stage === "reading" ? "Reading the archive…" : `${prog.done} of ${prog.total} runs`}</span>
            </div>
          )}
          {res && (
            <p className="rs-ok">
              {res.runs ? (
                <>
                  Imported {res.runs} {res.runs === 1 ? "run" : "runs"}
                  {res.first && res.last ? `, ${fmtDay(res.first)} ${res.first.slice(0, 4)} to ${fmtDay(res.last)} ${res.last.slice(0, 4)}` : ""}
                  {res.withRoute ? `, ${res.withRoute} with a route` : ""}. Runs that were already here from Garmin or Strava show once.
                </>
              ) : (
                "There were no runs in this archive."
              )}
            </p>
          )}
          {err && <p className="rs-err">{err}</p>}
        </Step>
      </ol>
    </section>
  );
}

export function RunSources() {
  const [src, setSrc] = useState<Source | null>(loadSource);
  const pick = (s: Source) => {
    setSrc(s);
    try {
      localStorage.setItem(KEY, s);
    } catch {
      /* private mode */
    }
  };
  return (
    <div className="p-screen rs">
      <section className="rs-card">
        <h2>How do you record your runs?</h2>
        <div className="rs-choices" role="radiogroup" aria-label="How you record your runs">
          {SOURCES.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={src === s.id} className={"rs-choice" + (src === s.id ? " on" : "")} onClick={() => pick(s.id)}>
              <b>{s.label}</b>
              <span>{s.sub}</span>
            </button>
          ))}
        </div>
      </section>

      {src && (
        <section className="rs-card">
          <h2>{src === "garmin" ? "Connect Garmin" : "Send your runs to Apple Health, then to Pacelife"}</h2>
          {src !== "garmin" && (
            <p className="rs-lead">
              Pacelife reads your runs from Apple Health and keeps them for good, with route and heart rate.
              {src === "strava" && " You don't need to connect Strava itself."}
            </p>
          )}
          <ol className="rs-steps">
            {src === "garmin" && <GarminSteps />}
            {src === "watch" && <HealthSteps start={1} first={null} />}
            {src === "strava" && (
              <HealthSteps
                start={2}
                first={
                  <Step n={1} title="In Strava, turn on Send to Health">
                    <p>Strava app → You → the settings cog → Manage Apps and Devices → Health → Connect. Allow Workouts and Heart Rate, then turn on Send to Health.</p>
                    {isNativeApp() && (
                      <a className="p-pill" href="strava://">
                        Open Strava
                      </a>
                    )}
                    <p className="rs-hint">Record each run in one app only: a run recorded on an Apple Watch as well would be in Health twice.</p>
                  </Step>
                }
              />
            )}
            {src === "other" && (
              <HealthSteps
                start={2}
                first={
                  <Step n={1} title="In your watch's app, turn on Apple Health">
                    <p>In the COROS, Polar Flow or Suunto app, find Apple Health in its settings (under connected, partner or third-party apps) and allow it to save workouts.</p>
                  </Step>
                }
              />
            )}
            {src === "phoneapp" && (
              <HealthSteps
                start={2}
                first={
                  <Step n={1} title="In that app, turn on Apple Health">
                    <p>Look in the app's settings for Apple Health (sometimes under Connected apps or Partners) and allow it to save workouts.</p>
                  </Step>
                }
              />
            )}
          </ol>
        </section>
      )}

      <ArchiveImport />
    </div>
  );
}
