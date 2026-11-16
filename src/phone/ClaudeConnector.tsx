import { useState } from "react";
import { connectorState, setConnector, testConnector, type ConnectorState } from "../core/backend.phone";
import { useQuery } from "../core/useQuery";
import { Section } from "./common";

/*
 * Settings → Claude: a private link that lets Claude read your plan and runs (read only), to analyse
 * your history, improvement, plan and predicted paces with you. Off until you turn it on.
 */
export function ClaudeConnector() {
  const [tick, setTick] = useState(0);
  const q = useQuery(connectorState, [tick]);
  const [st, setSt] = useState<ConnectorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [check, setCheck] = useState<string | null>(null);
  // The latest from the service once it agrees with what you just did (it carries Claude's last request).
  const cur = q.data && (!st || (q.data.on === st.on && q.data.url === st.url)) ? q.data : (st ?? q.data ?? null);
  if (q.data === null) return null; // not linked to the sync service: nothing for Claude to read
  const flip = async (on: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      setSt(await setConnector(on));
      setCheck(null);
      setTick((t) => t + 1);
      setConfirmOff(false);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!cur?.url) return;
    try {
      await navigator.clipboard.writeText(cur.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("Couldn't copy: press and hold the link to copy it.");
    }
  };
  return (
    <Section title="Claude">
      <div className="cc-box">
        {!cur?.on ? (
          <>
            <p>
              Ask Claude about your running: how you've improved, how your plan is going, what pace to run your next race. Claude reads your plan, your runs and your fitness, and can't change anything.
            </p>
            <p className="cc-small">Runs that came through Strava's connection aren't shared (Strava doesn't allow it). Your Garmin, Apple Health and Strava-archive runs are. You can turn this off at any time.</p>
            <button type="button" className="p-pill" disabled={busy || q.data === undefined} onClick={() => flip(true)}>
              {busy ? "Turning on…" : "Connect to Claude"}
            </button>
          </>
        ) : (
          <>
            <p>
              <b>On.</b> Add this private link to Claude once. Anyone with the link can read your running data, so keep it to yourself.
            </p>
            <div className="cc-link">
              <code>{cur.url}</code>
              <button type="button" className="p-pill" onClick={copy}>
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
            <details className="cc-log">
              <summary>Or use a header instead of the long link</summary>
              <p className="cc-small">URL: https://pacelife.run/api/mcp, and under Request headers add the name Authorization with this value:</p>
              <code className="cc-key">Bearer {cur.url!.split("/api/mcp/")[1]?.replace("/", ".")}</code>
            </details>
            <ol className="cc-steps">
              <li>In Claude (claude.ai or the app): Settings → Connectors → Add custom connector.</li>
              <li>Name it Pacelife and paste the link as the URL. Under Authentication choose <b>No sign-in</b> (the link is the key), add no headers, then Add.</li>
              <li>In a chat, turn on Pacelife under the tools menu and ask, for example: "How has my running improved this year?" or "Am I on track for my marathon goal, and what pace should I run?"</li>
            </ol>
            <div className="cc-check">
              <button
                type="button"
                className="p-pill"
                disabled={busy}
                onClick={async () => {
                  setCheck("Checking…");
                  try {
                    setCheck(await testConnector(cur.url!));
                  } catch (e) {
                    setCheck(`Couldn't check: ${String((e as Error)?.message ?? e)}`);
                  }
                  setTick((t) => t + 1);
                }}
              >
                Check the link
              </button>
              {check && <p>{check}</p>}
              {(cur.log?.length ? cur.log : cur.last ? [cur.last] : []).length > 0 && (
                <details className="cc-log">
                  <summary>Recent requests to this link</summary>
                  <ul>
                    {(cur.log?.length ? cur.log : [cur.last!]).map((e, i) => (
                      <li key={i}>
                        {new Date(e.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}: {e.what || "?"} → {e.result}
                        {e.from ? ` (${e.from})` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            {!confirmOff ? (
              <button type="button" className="cc-off" onClick={() => setConfirmOff(true)}>
                Turn off
              </button>
            ) : (
              <p className="cc-confirm">
                Turning off stops the link working in Claude straight away. A new link later is a different one.{" "}
                <button type="button" className="p-pill" disabled={busy} onClick={() => flip(false)}>
                  Turn off
                </button>{" "}
                <button type="button" className="cc-off" onClick={() => setConfirmOff(false)}>
                  Keep it on
                </button>
              </p>
            )}
          </>
        )}
        {err && <p className="cc-err">{err}</p>}
      </div>
    </Section>
  );
}
