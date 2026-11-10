import { useEffect, useState } from "react";
import { notifyChanged } from "../core/events";
import { accountInfo, cloudRun, connectGarmin, connectGoogle, disconnectGoogle, deleteAccount, disconnectGarmin, hasAccount, makeComputerCode, phoneState, refresh, unpair, type AccountInfo } from "../core/backend.phone";
import { isEmptyPlan } from "../core/account";
import { cancelled } from "../core/native";
import { showCode } from "../core/sync";
import { useRunningData } from "../modules/running/useRunning";
import { Section, usePhoneNav } from "./common";
import { appleHealthAvailable, appleHealthState, connectAppleHealth, disconnectAppleHealth, type AppleHealthState } from "../modules/health/appleHealth";
import { useQuery } from "../core/useQuery";
import { useDataVersion } from "../core/events";

/** Apple Health: can it be connected here, and is it. */
function useAppleHealth() {
  const hv = useDataVersion("health");
  const can = useQuery(appleHealthAvailable, []).data ?? false;
  const st = useQuery(appleHealthState, [hv]).data ?? null;
  return { can, st };
}

/** Connect Apple Health, then read it straight away. */
async function connectHealthAndSay(): Promise<string> {
  const s: AppleHealthState = await connectAppleHealth();
  if (s.lastError) return `Apple Health connected, but reading it failed: ${s.lastError}`;
  await notifyChanged("*");
  return "Apple Health connected: your runs, heart rate, sleep and HRV are coming in. If nothing appears, check Settings → Health → Data Access & Devices → Pacelife.";
}

const msg = (e: unknown) => String((e as Error)?.message ?? e).replace(/^offline: /, "");

/** Connect Garmin, then fetch straight away so runs and health appear. */
export async function connectAndSync(): Promise<string> {
  await connectGarmin();
  const r = await cloudRun().catch(() => null);
  if (await refresh()) await notifyChanged("*");
  const problems = Object.values(r?.errors ?? {}).filter(Boolean);
  return problems.length ? `Garmin connected. ${problems.join(" · ")}` : `Garmin connected${r?.newRuns ? `: ${r.newRuns} runs so far` : ""}. Older runs keep arriving over the next syncs.`;
}

/** More → Account: Garmin, a PC, signing out, deleting the account. */
export function AccountSection() {
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [code, setCode] = useState<{ code: string; expires: number } | null>(null);
  const [armed, setArmed] = useState<"out" | "delete" | null>(null);
  const load = () => accountInfo().then(setInfo).catch((e) => setNote(msg(e)));
  useEffect(() => {
    load();
  }, []);
  if (!hasAccount()) return null;
  const act = async (what: string, fn: () => Promise<string | void>) => {
    setBusy(what);
    setNote(null);
    try {
      const out = await fn();
      if (out) setNote(out);
      await load();
    } catch (e) {
      if (!cancelled(e)) setNote(msg(e));
    } finally {
      setBusy(null);
    }
  };
  const arm = (a: "out" | "delete") => {
    setArmed(a);
    window.setTimeout(() => setArmed((x) => (x === a ? null : x)), 4000);
  };
  return (
    <Section title="Account">
      <div className="p-row">
        <span className="p-row-main">
          <span className="p-row-title">Garmin</span>
          <span className="p-row-sub">{info?.garmin ? `Connected${info.last?.ranAt ? ` · synced ${new Date(info.last.ranAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : ""}` : "Runs, health and watch workouts come from Garmin"}</span>
        </span>
        {info?.garmin ? (
          <button className="p-link" disabled={!!busy} onClick={() => act("garmin", async () => (await disconnectGarmin(), "Garmin disconnected."))}>
            Disconnect
          </button>
        ) : (
          <button className="p-pill" disabled={!!busy} onClick={() => act("garmin", connectAndSync)}>
            {busy === "garmin" ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>
      <AppleHealthRow busy={busy} act={act} />
      <div className="p-row">
        <span className="p-row-main">
          <span className="p-row-title">Google Calendar</span>
          <span className="p-row-sub">{info?.google ? "Connected · your events and tasks sync every hour" : "Your events in the Planner and on Today"}</span>
        </span>
        {info?.google ? (
          <button className="p-link" disabled={!!busy} onClick={() => act("google", async () => (await disconnectGoogle(), "Google disconnected."))}>
            Disconnect
          </button>
        ) : (
          <button
            className="p-pill"
            disabled={!!busy}
            onClick={() =>
              act("google", async () => {
                const m = await connectGoogle();
                await cloudRun().catch(() => null);
                if (await refresh()) await notifyChanged("*");
                return `${m}. Your calendar is syncing.`;
              })
            }
          >
            {busy === "google" ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>
      <div className="p-row">
        <span className="p-row-main">
          <span className="p-row-title">Pacelife on a PC</span>
          <span className="p-row-sub">{code ? `On the PC: Settings → Phone & cloud → Sign in with Apple, or enter ${showCode(code.code)} there (valid 15 minutes).` : info?.pc ? "A PC is linked and stays in step" : "Optional: the desktop dashboard, synced with this account"}</span>
        </span>
        <button className="p-link" disabled={!!busy} onClick={() => act("code", async () => setCode(await makeComputerCode()))}>
          {code ? "New code" : "Link a PC"}
        </button>
      </div>
      {note && <div className="p-row p-row-note">{note}</div>}
      <button
        className="p-row p-row-btn"
        onClick={async () => {
          if (armed !== "out") return arm("out");
          await unpair();
          location.reload();
        }}
      >
        <span className="p-row-title">{armed === "out" ? "Tap again to sign out" : "Sign out"}</span>
      </button>
      <button
        className="p-row p-row-btn danger"
        disabled={!!busy}
        onClick={async () => {
          if (armed !== "delete") return arm("delete");
          await act("delete", async () => {
            await deleteAccount();
            location.reload();
          });
        }}
      >
        <span className="p-row-title">{armed === "delete" ? "Tap again: delete the account and all its data" : "Delete account"}</span>
      </button>
    </Section>
  );
}

function AppleHealthRow({ busy, act }: { busy: string | null; act: (what: string, fn: () => Promise<string | void>) => Promise<void> }) {
  const { can, st } = useAppleHealth();
  if (!can) return null;
  return (
    <div className="p-row">
      <span className="p-row-main">
        <span className="p-row-title">Apple Health</span>
        <span className="p-row-sub">
          {st?.on ? `Connected${st.lastSync ? ` · read ${new Date(st.lastSync).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : ""}${st.lastError ? ` · ${st.lastError}` : ""}` : "Runs from Apple Watch, COROS, Polar, Suunto or any app that saves to Health, plus sleep and HRV"}
        </span>
      </span>
      {st?.on ? (
        <button className="p-link" disabled={!!busy} onClick={() => act("health", async () => (await disconnectAppleHealth(), "Apple Health disconnected. Runs already here stay; to remove Pacelife's access, use Settings → Health."))}>
          Disconnect
        </button>
      ) : (
        <button className="p-pill" disabled={!!busy} onClick={() => act("health", connectHealthAndSay)}>
          {busy === "health" ? "Connecting…" : "Connect"}
        </button>
      )}
    </div>
  );
}

/** A new account's first steps, on Today until they're done. */
export function GettingStarted() {
  const nav = usePhoneNav();
  const { plan } = useRunningData();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ah = useAppleHealth();
  if (!hasAccount()) return null;
  const garmin = !!phoneState.header?.connected.garmin;
  const health = !!ah.st?.on;
  const linked = garmin || health;
  const noPlan = isEmptyPlan(plan);
  if (linked && !noPlan) return null;
  const go = (fn: () => Promise<string>) => async () => {
    setBusy(true);
    setNote(null);
    try {
      setNote(await fn());
    } catch (e) {
      if (!cancelled(e)) setNote(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="p-start">
      <h2>Getting started</h2>
      <div className={"p-start-step p-start-multi" + (linked ? " done" : "")}>
        <span className="p-start-n">{linked ? "✓" : "1"}</span>
        <span className="p-row-main">
          <span className="p-row-title">{busy ? "Connecting…" : "Connect your runs"}</span>
          <span className="p-row-sub">{linked ? `${[garmin && "Garmin", health && "Apple Health"].filter(Boolean).join(" and ")} connected` : "Garmin for runs, sleep, HRV and workouts on your watch; Apple Health for any other watch or app"}</span>
          {!linked && (
            <span className="p-start-pills">
              <button className="p-pill" disabled={busy} onClick={go(connectAndSync)}>
                Garmin
              </button>
              {ah.can && (
                <button className="p-pill" disabled={busy} onClick={go(connectHealthAndSay)}>
                  Apple Health
                </button>
              )}
            </span>
          )}
        </span>
      </div>
      <button className={"p-start-step" + (noPlan ? "" : " done")} disabled={!noPlan} onClick={() => nav.push("adjust")}>
        <span className="p-start-n">{noPlan ? "2" : "✓"}</span>
        <span className="p-row-main">
          <span className="p-row-title">Build your training plan</span>
          <span className="p-row-sub">Pick your race and how many days a week; it's built from your recent running</span>
        </span>
      </button>
      {note && <p className="p-start-note">{note}</p>}
    </section>
  );
}
