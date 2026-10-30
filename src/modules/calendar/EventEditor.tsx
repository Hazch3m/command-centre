import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { dateKey } from "../../core/time";
import { ErrorNote } from "../../shell/ui";
import { createEvent, deleteEvent, hhmm, updateEvent, type CalEvent, type CalendarInfo } from "./data";

export type EditTarget = { kind: "new"; date: string; start?: string } | { kind: "edit"; event: CalEvent };

const addHour = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${String(Math.min(23, h + 1)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

/** Add or change an event in one of your Google calendars. */
export function EventEditor({ target, cals, onClose }: { target: EditTarget; cals: CalendarInfo[]; onClose: () => void }) {
  const writable = cals.filter((c) => c.writable && !c.id.startsWith("ics:"));
  const ev = target.kind === "edit" ? target.event : null;
  const evStart = ev && !ev.all_day ? new Date(ev.start) : null;
  const evEnd = ev && !ev.all_day ? new Date(ev.end) : null;
  const [summary, setSummary] = useState(ev?.summary ?? "");
  const [date, setDate] = useState(ev ? (ev.all_day ? ev.start : dateKey(evStart!)) : target.kind === "new" ? target.date : "");
  const [allDay, setAllDay] = useState(!!ev?.all_day);
  const [start, setStart] = useState(evStart ? hhmm(evStart) : target.kind === "new" ? (target.start ?? "09:00") : "09:00");
  const [end, setEnd] = useState(evEnd ? hhmm(evEnd) : addHour(target.kind === "new" ? (target.start ?? "09:00") : "09:00"));
  const [location, setLocation] = useState(ev?.location ?? "");
  const [notes, setNotes] = useState("");
  const [cal, setCal] = useState(ev?.calendar_id ?? writable.find((c) => c.primary)?.id ?? writable[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const readOnly = ev && !writable.some((c) => c.id === ev.calendar_id);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onClose();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setBusy(false);
    }
  };
  const input = { summary: summary.trim(), date, allDay, start, end, location, description: notes };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal event-editor" role="dialog" aria-label={ev ? "Edit event" : "New event"}>
        <header className="modal-header">
          <h2>{ev ? (readOnly ? "Event" : "Edit event") : "New event"}</h2>
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {!writable.length ? (
          <p className="small">
            Adding events needs the Google sign-in (Settings → Connections → Google). A secret iCal link only lets the dashboard read your calendar. If you've already
            signed in, Disconnect and Connect again once so Google can grant the new "add events" permission.
          </p>
        ) : readOnly ? (
          <p className="small muted">This event comes from a read-only calendar ({cals.find((c) => c.id === ev!.calendar_id)?.name ?? "iCal link"}), so it can't be changed here.</p>
        ) : (
          <>
            <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Title" aria-label="Title" autoFocus />
            <div className="event-row">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
              <label className="inline small">
                <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day
              </label>
              {!allDay && (
                <>
                  <input type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Starts" />
                  <span className="muted">to</span>
                  <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="Ends" />
                </>
              )}
            </div>
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (optional)" aria-label="Location" />
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={ev ? "Notes (replaces the event's notes)" : "Notes (optional)"} aria-label="Notes" />
            {!ev && writable.length > 1 && (
              <select value={cal} onChange={(e) => setCal(e.target.value)} aria-label="Calendar">
                {writable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <ErrorNote error={err} />
            <footer className="modal-footer">
              {ev && (
                <button className="btn btn-danger" disabled={busy} onClick={() => run(() => deleteEvent(ev.calendar_id, ev.id))}>
                  Delete
                </button>
              )}
              <button
                className="btn btn-primary"
                disabled={busy || !summary.trim() || !date}
                onClick={() => run(() => (ev ? updateEvent(ev.calendar_id, ev.id, input) : createEvent(cal, input)))}
              >
                {busy ? "Saving…" : ev ? "Save" : "Add to Google Calendar"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
