import { useEffect, useState } from "react";
import { notifyChanged } from "../core/events";
import { accountInfo, cloudRun, connectGarmin, connectGoogle, disconnectGoogle, deleteAccount, disconnectGarmin, hasAccount, makeComputerCode, phoneState, refresh, unpair, type AccountInfo } from "../core/backend.phone";
import { isEmptyPlan } from "../core/account";
import { cancelled } from "../core/native";
import { showCode } from "../core/sync";
import { useRunningData } from "../modules/running/useRunning";
import { Section, usePhoneNav } from "./common";

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
          <span className="p-row-title">Command Centre on a PC</span>
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

/** A new account's first steps, on Today until they're done. */
export function GettingStarted() {
  const nav = usePhoneNav();
  const { plan } = useRunningData();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!hasAccount()) return null;
  const garmin = !!phoneState.header?.connected.garmin;
  const noPlan = isEmptyPlan(plan);
  if (garmin && !noPlan) return null;
  return (
    <section className="p-start">
      <h2>Getting started</h2>
      <button
        className={"p-start-step" + (garmin ? " done" : "")}
        disabled={garmin || busy}
        onClick={async () => {
          setBusy(true);
          setNote(null);
          try {
            setNote(await connectAndSync());
          } catch (e) {
            if (!cancelled(e)) setNote(msg(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="p-start-n">{garmin ? "✓" : "1"}</span>
        <span className="p-row-main">
          <span className="p-row-title">{busy ? "Connecting Garmin…" : "Connect Garmin"}</span>
          <span className="p-row-sub">Your runs, PBs, sleep, HRV and VO2 max</span>
        </span>
      </button>
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
