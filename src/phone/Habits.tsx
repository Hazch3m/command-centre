import { useState } from "react";
import { useDataVersion } from "../core/events";
import { addDays, parseKey, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { addItem, archiveItem, loadChecklist, setValue, type ChecklistItem } from "../modules/checklist/data";
import { streaks } from "../modules/checklist/streak";
import { Section, Sheet } from "./common";

const DOW1 = ["S", "M", "T", "W", "T", "F", "S"];
const amount = (i: ChecklistItem, v: number) => (i.target > 1 || i.unit ? `${v}/${i.target}${i.unit ?? ""}` : "");

/** A round button: tap to tick (or add one step for an amount, like "Research 3h"). */
export function HabitButton({ item, value }: { item: ChecklistItem; value: number }) {
  const done = value >= item.target;
  const counted = item.target > 1 || !!item.unit;
  const frac = Math.min(1, value / item.target);
  const tap = () => {
    if (!counted) return setValue(item.id, done ? 0 : item.target);
    return setValue(item.id, done ? 0 : Math.min(item.target, value + item.step));
  };
  return (
    <button className={"p-habit" + (done ? " done" : "")} onClick={tap} aria-pressed={done} aria-label={item.title}>
      <span className="p-habit-ring" style={{ ["--f" as string]: frac }}>
        <span className="p-habit-tick">{done ? "✓" : counted ? amount(item, value) : ""}</span>
      </span>
      <span className="p-habit-name">{item.title}</span>
    </button>
  );
}

export function Habits() {
  const today = useToday();
  const v = useDataVersion("checklist");
  const data = useQuery(() => loadChecklist(today), [v, today]).data;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [armed, setArmed] = useState<number | null>(null);
  if (!data) return <div className="p-screen" />;
  const days = Array.from({ length: 28 }, (_, i) => addDays(today, i - 27));
  const doneCount = data.items.filter((i) => (data.today.get(i.id) ?? 0) >= i.target).length;
  return (
    <div className="p-screen">
      <div className="p-summary">
        <span className="p-big num">
          {doneCount}
          <small> of {data.items.length} today</small>
        </span>
        <span className="p-bar">
          <span style={{ width: `${data.items.length ? (doneCount / data.items.length) * 100 : 0}%` }} />
        </span>
      </div>
      {data.items.map((i) => {
        const value = data.today.get(i.id) ?? 0;
        const doneDays = new Set(data.doneDays.get(i.id) ?? []);
        const s = streaks(doneDays, today);
        const counted = i.target > 1 || !!i.unit;
        return (
          <Section key={i.id} className="p-habit-card">
            <div className="p-habit-head">
              <HabitButton item={i} value={value} />
              <div className="p-habit-info">
                <b>{i.title}</b>
                <span className="p-row-sub">
                  {s.current ? `🔥 ${s.current} day${s.current > 1 ? "s" : ""}` : "No streak yet"}
                  {s.best > s.current ? ` · best ${s.best}` : ""}
                </span>
                {counted && (
                  <span className="p-stepper">
                    <button onClick={() => setValue(i.id, Math.max(0, value - i.step))} aria-label={`Less ${i.title}`}>
                      −
                    </button>
                    <span className="num">{amount(i, value)}</span>
                    <button onClick={() => setValue(i.id, value + i.step)} aria-label={`More ${i.title}`}>
                      +
                    </button>
                  </span>
                )}
              </div>
            </div>
            <div className="p-habit-grid">
              {days.map((d) => (
                <button
                  key={d}
                  className={"p-hday" + (doneDays.has(d) ? " hit" : "") + (d === today ? " today" : "")}
                  onClick={() => setValue(i.id, doneDays.has(d) ? 0 : i.target, d)}
                  aria-label={`${i.title} on ${d}`}
                >
                  {d >= addDays(today, -6) ? DOW1[parseKey(d).getDay()] : ""}
                </button>
              ))}
            </div>
            <button
              className="p-link danger small"
              onClick={() => {
                if (armed !== i.id) {
                  setArmed(i.id);
                  window.setTimeout(() => setArmed(null), 3500);
                  return;
                }
                archiveItem(i.id);
              }}
            >
              {armed === i.id ? "Tap again to remove (history is kept)" : "Remove"}
            </button>
          </Section>
        );
      })}
      <button className="p-fab" onClick={() => setAdding(true)} aria-label="Add a habit">
        +
      </button>
      {adding && (
        <Sheet title="New habit" onClose={() => setAdding(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) addItem(draft).then(() => (setDraft(""), setAdding(false)));
            }}
          >
            <input className="p-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Stretching, or Research 3h, Pages 20" />
            <p className="p-hint">Add a number to count an amount instead of a simple tick.</p>
            <button className="p-primary" disabled={!draft.trim()}>
              Add habit
            </button>
          </form>
        </Sheet>
      )}
    </div>
  );
}
