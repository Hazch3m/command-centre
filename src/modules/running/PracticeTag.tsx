import { practiceOf, sessionKindOf } from "./planBuilder";

/** Small badges: what the session trains (when its text doesn't say), and race practice / fast finish. */
export function PracticeTag({ text, kind = true }: { text: string; kind?: boolean }) {
  const p = practiceOf(text);
  const k = kind ? sessionKindOf(text) : null;
  if (!p && !k) return null;
  return (
    <>
      {k && <span className="practice-tag kind">{k}</span>}
      {p && <span className={"practice-tag" + (p === "Fast finish" ? " ff" : "")}>{p}</span>}
    </>
  );
}
