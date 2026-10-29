import type { ReactNode } from "react";

/** Standard card header: title on the left, small status on the right. */
export function CardHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <header className="card-header">
      <h2>{title}</h2>
      {right != null && <div className="card-header-right">{right}</div>}
    </header>
  );
}

/** Large round tick button used by tasks and checklist. */
export function TickButton({ done, onClick, label, progress }: { done: boolean; onClick: () => void; label: string; progress?: number }) {
  const p = Math.max(0, Math.min(1, progress ?? (done ? 1 : 0)));
  return (
    <button className={"tick" + (done ? " tick-done" : "")} onClick={onClick} aria-label={label} aria-pressed={done} title={label}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle className="tick-track" cx="18" cy="18" r="15" />
        {!done && p > 0 && (
          <circle className="tick-progress" cx="18" cy="18" r="15" pathLength={100} strokeDasharray={`${p * 100} 100`} transform="rotate(-90 18 18)" />
        )}
        {done && <path className="tick-mark" d="M11 18.5l4.5 4.5L25 13.5" />}
      </svg>
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <div className="error-note">{error}</div> : null;
}
