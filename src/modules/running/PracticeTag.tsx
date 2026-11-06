import { practiceOf } from "./planBuilder";

/** A small badge on sessions that rehearse the race (race pace, race-practice long runs, time trials) or finish fast. */
export function PracticeTag({ text }: { text: string }) {
  const p = practiceOf(text);
  if (!p) return null;
  return <span className={"practice-tag" + (p === "Fast finish" ? " ff" : "")}>{p}</span>;
}
