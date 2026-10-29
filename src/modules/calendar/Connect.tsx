import { useState } from "react";
import { backend } from "@backend";
import { notifyChanged, useDataVersion } from "../../core/events";
import { useQuery } from "../../core/useQuery";
import { ErrorNote } from "../../shell/ui";
import { syncCalendar } from "./data";
import { icsName } from "./ics";

/**
 * Adds a calendar by its secret iCal address: the quickest way to show a
 * Google calendar (no Google Cloud project needed). Also lists and removes them.
 */
export function CalendarFeeds({ intro = true }: { intro?: boolean }) {
  const version = useDataVersion("calendar");
  const { data: feeds } = useQuery(() => backend.icsList(), [version]);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      await backend.icsAdd(name, url);
      const list = await backend.icsList();
      const added = list[list.length - 1];
      // Check it really is a calendar, and use its own name if none was typed.
      try {
        const text = await backend.icsFetch(added.id);
        const real = icsName(text);
        if (!name.trim() && real) {
          await backend.icsRemove(added.id);
          await backend.icsAdd(real, url);
        }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (!msg.startsWith("offline")) {
          await backend.icsRemove(added.id);
          throw e;
        }
      }
      setUrl("");
      setName("");
      setOk("Added. Your events will appear in a moment.");
      await syncCalendar();
      await notifyChanged("calendar");
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    await backend.icsRemove(id);
    await syncCalendar();
    await notifyChanged("calendar");
  };

  return (
    <div className="cal-connect">
      {intro && (
        <ol className="steps">
          <li>
            Open <b>calendar.google.com</b> on your computer and click <b>⚙ → Settings</b>.
          </li>
          <li>
            On the left, under <b>Settings for my calendars</b>, click your calendar (usually your name).
          </li>
          <li>
            Scroll to <b>Integrate calendar</b> and copy the <b>Secret address in iCal format</b> (it ends in <code>basic.ics</code>).
          </li>
          <li>Paste it below and click Add. Repeat for any other calendars you want to see.</li>
        </ol>
      )}
      {feeds && feeds.length > 0 && (
        <ul className="feed-list">
          {feeds.map((f) => (
            <li key={f.id}>
              <span>
                {f.name} <span className="muted small">· {f.host}</span>
              </span>
              <button className="btn" onClick={() => remove(f.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="feed-add">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" aria-label="Secret iCal address" onKeyDown={(e) => e.key === "Enter" && url.trim() && add()} />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Calendar name" className="feed-name" />
        <button className="btn btn-primary" disabled={!url.trim() || busy} onClick={add}>
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
      <ErrorNote error={err} />
      {ok && <div className="ok-note">{ok}</div>}
      <p className="muted small">
        The address is stored in Windows Credential Manager, not in the app's files. It's read-only, and works for Outlook and iCloud calendars too. Google can take a little while to
        show brand-new events in this feed; the full Google sign-in further down in Settings is instant, but needs a Google Cloud project.
      </p>
    </div>
  );
}
