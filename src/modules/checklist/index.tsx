import { useState } from "react";
import { useDataVersion } from "../../core/events";
import { useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { CardHeader, Empty, ErrorNote, TickButton } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import { addItem, archiveItem, itemText, loadChecklist, migrations, moveItem, parseItem, seedDefaults, setValue, updateItem, type ChecklistItem } from "./data";
import { streaks } from "./streak";

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function Row({ item, value, doneDays, today }: { item: ChecklistItem; value: number; doneDays: string[]; today: string }) {
  const done = value >= item.target;
  const counted = item.target > 1 || !!item.unit;
  const s = streaks(doneDays, today);
  const tap = () => {
    if (!counted) setValue(item.id, done ? 0 : 1);
    else setValue(item.id, done ? 0 : Math.min(item.target, value + item.step));
  };
  return (
    <li className={"check-row" + (done ? " is-done" : "")}>
      <TickButton done={done} onClick={tap} label={done ? `Undo ${item.title}` : `Tick ${item.title}`} progress={value / item.target} />
      <div className="check-main">
        <span className="check-title">{item.title}</span>
        {counted && (
          <span className="check-amount">
            <button className="mini" onClick={() => setValue(item.id, Math.max(0, value - item.step))} aria-label={`Less ${item.title}`} disabled={value <= 0}>
              −
            </button>
            <span className="num">
              {fmt(value)}/{fmt(item.target)}
              {item.unit ?? ""}
            </span>
            <button className="mini" onClick={() => setValue(item.id, value + item.step)} aria-label={`More ${item.title}`}>
              +
            </button>
          </span>
        )}
      </div>
      <div className={"streak" + (s.current === 0 ? " streak-none" : done ? " streak-today" : "")} title={`Best: ${s.best} days`}>
        <span className="num">{s.current}</span>
        <span className="streak-unit">{s.current === 1 ? "day" : "days"}</span>
      </div>
    </li>
  );
}

function Manage({ items, onClose }: { items: ChecklistItem[]; onClose: () => void }) {
  const [draft, setDraft] = useState("");
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const guard = (p: Promise<unknown>) => p.then(() => setErr(null), (e) => setErr((e as Error).message));

  return (
    <div className="card-scroll manage">
      <p className="muted small">Add a number to count instead of tick: “Research 3h”, “Pages 20”. Removing an item keeps its history.</p>
      <ul>
        {items.map((it, i) => {
          const text = edits[it.id] ?? itemText(it);
          const dirty = edits[it.id] != null && edits[it.id] !== itemText(it);
          return (
            <li key={it.id} className="manage-row">
              <input value={text} onChange={(e) => setEdits({ ...edits, [it.id]: e.target.value })} aria-label={`Edit ${it.title}`}
                onKeyDown={(e) => e.key === "Enter" && dirty && guard(updateItem(it.id, text).then(() => setEdits(({ [it.id]: _, ...rest }) => rest)))} />
              {dirty && <button className="btn btn-primary" onClick={() => guard(updateItem(it.id, text).then(() => setEdits(({ [it.id]: _, ...rest }) => rest)))}>Save</button>}
              <button className="btn icon" onClick={() => guard(moveItem(items, i, -1))} disabled={i === 0} aria-label="Move up">↑</button>
              <button className="btn icon" onClick={() => guard(moveItem(items, i, 1))} disabled={i === items.length - 1} aria-label="Move down">↓</button>
              <button className="btn btn-danger" onClick={() => guard(archiveItem(it.id))}>Remove</button>
            </li>
          );
        })}
      </ul>
      <div className="manage-add">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="New item, e.g. Meditate or Research 3h" aria-label="New checklist item"
          onKeyDown={(e) => e.key === "Enter" && draft.trim() && guard(addItem(draft).then(() => setDraft("")))} />
        <button className="btn btn-primary" disabled={!draft.trim()} onClick={() => guard(addItem(draft).then(() => setDraft("")))}>Add</button>
      </div>
      {draft.trim() && <p className="muted small">{describe(draft)}</p>}
      <ErrorNote error={err} />
      <button className="btn" onClick={onClose}>Done</button>
    </div>
  );
}

function describe(text: string) {
  const p = parseItem(text);
  return p.target === 1 && !p.unit ? `“${p.title}” — tick once a day` : `“${p.title}” — target ${fmt(p.target)}${p.unit ?? ""} a day, +${fmt(p.step)} per tap`;
}

function ChecklistCard(_: CardProps) {
  const today = useToday();
  const version = useDataVersion("checklist");
  const { data, error } = useQuery(() => loadChecklist(today), [today, version]);
  const [managing, setManaging] = useState(false);

  const items = data?.items ?? [];
  const doneCount = items.filter((i) => (data?.today.get(i.id) ?? 0) >= i.target).length;

  return (
    <>
      <CardHeader
        title="Daily"
        right={
          <>
            <span className={"pill" + (items.length && doneCount === items.length ? " pill-accent" : "")}>
              {doneCount}/{items.length}
            </span>
            <button className="btn icon ghost" onClick={() => setManaging((m) => !m)} aria-label="Edit checklist items" title="Edit items">
              ✎
            </button>
          </>
        }
      />
      <ErrorNote error={error} />
      {managing ? (
        <Manage items={items} onClose={() => setManaging(false)} />
      ) : (
        <div className="card-scroll">
          {data && items.length === 0 && <Empty>No daily items yet. Use ✎ to add some.</Empty>}
          <ul className="check-list">
            {items.map((it) => (
              <Row key={it.id} item={it} value={data!.today.get(it.id) ?? 0} doneDays={data!.doneDays.get(it.id) ?? []} today={today} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export const checklistModule: DashboardModule = {
  id: "checklist",
  title: "Daily checklist",
  defaultPos: { x: 0, y: 37, w: 12, h: 3 },
  minW: 3,
  minH: 3,
  migrations,
  init: seedDefaults,
  Card: ChecklistCard,
  quickAdd: [
    {
      id: "checklist",
      label: "Checklist item",
      placeholder: "New daily item, e.g. Meditate or Research 3h",
      hint: "Recurring — resets every morning. Add a number to count: “Research 3h”.",
      preview: (t) => (t.trim() ? describe(t) : null),
      add: addItem,
    },
  ],
};
