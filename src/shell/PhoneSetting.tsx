import { useEffect, useMemo, useState } from "react";
import { backend } from "@backend";
import qrcode from "qr-lib";
import { connectService, disconnectService, getPhoneStatus, makePairCode, pullPhoneChanges, pushSnapshot, unlinkPhones, type PhoneStatus } from "../core/phoneSync";
import { showCode } from "../core/sync";
import { ErrorNote } from "./ui";

/** A QR code drawn as SVG squares. */
function Qr({ text, size = 200 }: { text: string; size?: number }) {
  const cells = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    const out: [number, number][] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) out.push([c, r]);
    return { n, out };
  }, [text]);
  const m = 4; // quiet zone
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${cells.n + 2 * m} ${cells.n + 2 * m}`} shapeRendering="crispEdges" role="img" aria-label="QR code">
      <rect width="100%" height="100%" fill="#fff" />
      {cells.out.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x + m} y={y + m} width={1} height={1} fill="#000" />
      ))}
    </svg>
  );
}

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** Settings → Phone: connect the sync service, link phones, see when it last synced. */
export function PhoneSetting() {
  const [linked, setLinked] = useState<{ url: string } | null | undefined>(undefined);
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pair, setPair] = useState<{ code: string; url: string; expires: number } | null>(null);
  const [armed, setArmed] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = async () => {
    const l = await backend.phoneLinkGet().catch(() => null);
    setLinked(l ? { url: l.url } : null);
    setStatus(await getPhoneStatus());
  };
  useEffect(() => {
    refresh();
    const iv = window.setInterval(() => setTick((t) => t + 1), 15_000);
    return () => window.clearInterval(iv);
  }, []);
  useEffect(() => {
    getPhoneStatus().then(setStatus);
  }, [tick]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e).replace(/^offline: /, ""));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (linked === undefined) return null;
  if (!linked)
    return (
      <div className="phone-setting">
        <p className="muted small">
          Puts your dashboard on your iPhone: an encrypted copy goes to your own free Cloudflare sync service, and changes you make on the phone (tasks, habits, plan days)
          come back here. Paste the service's address once it's deployed (see the README, "Phone").
        </p>
        <div className="inline">
          <input className="phone-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://command-centre-sync.yourname.workers.dev" spellCheck={false} />
          <button className="btn btn-primary" disabled={busy || !url.trim()} onClick={() => run(() => connectService(url))}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
        <ErrorNote error={err} />
      </div>
    );

  const left = pair ? Math.max(0, Math.round((pair.expires - Date.now()) / 60000)) : 0;
  return (
    <div className="phone-setting">
      <div className="small">
        Connected to <span className="num">{linked.url.replace(/^https:\/\//, "")}</span> · sent to the phone {ago(status?.lastPush ?? null)}
        {status?.size ? ` (${(status.size / 1e6).toFixed(1)} MB, encrypted)` : ""} · phone changes checked {ago(status?.lastPull ?? null)}
      </div>
      {status?.error && <div className="error-note small">{status.error.replace(/^offline: /, "")}</div>}
      <div className="inline phone-actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => setPair(await makePairCode()))}>
          Link a phone
        </button>
        <button className="btn" disabled={busy} onClick={() => run(async () => (await pullPhoneChanges(), await pushSnapshot()))}>
          {busy ? "Syncing…" : "Sync now"}
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            if (!armed) {
              setArmed(true);
              window.setTimeout(() => setArmed(false), 4000);
              return;
            }
            setArmed(false);
            run(unlinkPhones);
          }}
        >
          {armed ? "Click again: every phone will need linking again" : "Unlink all phones"}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => run(disconnectService)}>
          Disconnect
        </button>
      </div>
      {pair && left > 0 && (
        <div className="phone-pair">
          <Qr text={`${pair.url}/#pair=${pair.code}`} />
          <ol className="small">
            <li>Point your iPhone's camera at the code and open the link.</li>
            <li>
              In Safari, tap <b>Share</b> → <b>Add to Home Screen</b>.
            </li>
            <li>Open Command Centre from your home screen and enter this code:</li>
          </ol>
          <div className="phone-code num">{showCode(pair.code)}</div>
          <div className="muted small">Works for {left} more minute{left === 1 ? "" : "s"}, for up to three phones or browsers.</div>
        </div>
      )}
      <ErrorNote error={err} />
    </div>
  );
}
