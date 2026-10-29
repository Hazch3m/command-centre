import { useEffect, useState } from "react";
import { backend } from "@backend";
import type { OAuthStatus, Provider } from "../core/backend.types";
import { notifyChanged } from "../core/events";

const INFO: Record<Provider, { name: string; help: string; uses: string; topics: string[] }> = {
  strava: {
    name: "Strava",
    uses: "Running card: weekly km, last run, progression",
    help: "Create an app at strava.com/settings/api with Authorization Callback Domain “localhost”, then paste its Client ID and Client Secret.",
    topics: ["running"],
  },
  google: {
    name: "Google",
    uses: "Calendar card (read-only) and Tasks sync with Google Tasks",
    help: "In Google Cloud: enable the Calendar API and Tasks API, publish the OAuth consent screen, and create an OAuth client of type Desktop app. Paste its client ID and secret.",
    topics: ["calendar", "tasks"],
  },
};

function Connection({ p }: { p: Provider }) {
  const info = INFO[p];
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  const refresh = () => backend.oauthStatus(p).then(setStatus, () => setStatus(null));
  useEffect(() => {
    refresh();
  }, []);

  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ text: ok });
      await Promise.all(info.topics.map((t) => notifyChanged(t)));
    } catch (e) {
      setMsg({ text: String((e as Error)?.message ?? e), error: true });
    }
    setBusy(null);
    refresh();
  };

  const showForm = editing || (status && !status.configured);
  return (
    <div className="connection">
      <div className="connection-head">
        <div>
          <div className="setting-label">{info.name}</div>
          <div className="muted small">{info.uses}</div>
        </div>
        <div className="inline">
          {status?.connected ? (
            <>
              <span className="pill pill-accent">Connected{status.account ? ` · ${status.account}` : ""}</span>
              <button className="btn" disabled={!!busy} onClick={() => run("disconnect", () => backend.oauthDisconnect(p, false), "Disconnected.")}>
                Disconnect
              </button>
            </>
          ) : status?.configured ? (
            <button className="btn btn-primary" disabled={!!busy} onClick={() => run("connect", () => backend.oauthConnect(p), `${info.name} connected.`)}>
              {busy === "connect" ? "Waiting for your browser…" : "Connect"}
            </button>
          ) : null}
          {status?.configured && !editing && (
            <button className="btn ghost" onClick={() => setEditing(true)}>
              Change app keys
            </button>
          )}
        </div>
      </div>
      {showForm && (
        <div className="connection-form">
          <p className="muted small">{info.help}</p>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Client ID" aria-label={`${info.name} client ID`} />
          <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Client secret" type="password" aria-label={`${info.name} client secret`} />
          <div className="inline">
            <button
              className="btn btn-primary"
              disabled={!id.trim() || !secret.trim() || !!busy}
              onClick={() =>
                run("save", async () => {
                  await backend.oauthSetClient(p, id, secret);
                  setId("");
                  setSecret("");
                  setEditing(false);
                }, "Saved to Windows Credential Manager. Now click Connect.")
              }
            >
              Save keys
            </button>
            {editing && (
              <button className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
      {busy === "connect" && <div className="muted small">Approve access in the browser window that opened. This waits up to 5 minutes.</div>}
      {msg && <div className={msg.error ? "error-note" : "ok-note"}>{msg.text}</div>}
    </div>
  );
}

export function Connections() {
  return (
    <>
      <Connection p="strava" />
      <Connection p="google" />
      <p className="muted small">Keys and sign-ins are stored in Windows Credential Manager, never in files.</p>
    </>
  );
}
