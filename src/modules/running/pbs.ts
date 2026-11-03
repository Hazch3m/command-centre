import type { Run, RunDetail } from "./strava";

/** Strava's best-effort distances, shortest first. */
export const PB_DISTANCES = [
  { name: "400m", label: "400 m", m: 400 },
  { name: "1/2 mile", label: "½ mile", m: 804.67 },
  { name: "1K", label: "1 km", m: 1000 },
  { name: "1 mile", label: "1 mile", m: 1609.34 },
  { name: "2 mile", label: "2 miles", m: 3218.69 },
  { name: "5K", label: "5k", m: 5000 },
  { name: "10K", label: "10k", m: 10000 },
  { name: "15K", label: "15k", m: 15000 },
  { name: "10 mile", label: "10 miles", m: 16093.4 },
  { name: "20K", label: "20k", m: 20000 },
  { name: "Half-Marathon", label: "Half marathon", m: 21097.5 },
  { name: "30K", label: "30k", m: 30000 },
  { name: "Marathon", label: "Marathon", m: 42195 },
] as const;
export type PbName = (typeof PB_DISTANCES)[number]["name"];

export interface Effort {
  name: PbName;
  runId: string;
  date: string;
  runName: string;
  seconds: number;
  /** "best effort" inside a run (Strava), or the whole run at a race distance. */
  source: "effort" | "run";
}

/** Whole runs that are (almost exactly) a standard distance count too: races before details were kept, or runs without heart rate. */
const WHOLE: PbName[] = ["5K", "10K", "15K", "10 mile", "Half-Marathon", "30K", "Marathon"];

export function collectEfforts(runs: Run[], details: Map<string, RunDetail>): Effort[] {
  const out: Effort[] = [];
  for (const r of runs) {
    const d = details.get(r.id);
    const have = new Set<string>();
    for (const b of d?.bestEfforts ?? []) {
      const dist = PB_DISTANCES.find((x) => x.name === b.name);
      if (!dist || !b.time) continue;
      out.push({ name: dist.name, runId: r.id, date: r.date, runName: r.name, seconds: b.time, source: "effort" });
      have.add(dist.name);
    }
    for (const name of WHOLE) {
      if (have.has(name)) continue;
      const dist = PB_DISTANCES.find((x) => x.name === name)!;
      // Within 1.5 % over (courses measure long) or 0.5 % under; time scaled to the exact distance.
      if (r.distance < dist.m * 0.995 || r.distance > dist.m * 1.015) continue;
      const t = (r.workout_type === 1 ? r.elapsed_time : r.moving_time) * (dist.m / r.distance);
      out.push({ name, runId: r.id, date: r.date, runName: r.name, seconds: Math.round(t), source: "run" });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.seconds - b.seconds);
}

export interface Medal {
  name: PbName;
  /** 1 = fastest ever (PR), 2 = second fastest, 3 = third — at the time of the run, like Strava. */
  rank: 1 | 2 | 3;
  seconds: number;
}

/** Strava-style medals: each run's efforts ranked against everything you'd run before it. */
export function medalsByRun(efforts: Effort[]): Map<string, Medal[]> {
  const out = new Map<string, Medal[]>();
  const seen = new Map<string, number[]>();
  for (const e of efforts) {
    const prior = seen.get(e.name) ?? [];
    const rank = 1 + prior.filter((s) => s < e.seconds).length;
    if (rank <= 3) {
      const list = out.get(e.runId) ?? [];
      list.push({ name: e.name, rank: rank as 1 | 2 | 3, seconds: e.seconds });
      out.set(e.runId, list);
    }
    prior.push(e.seconds);
    seen.set(e.name, prior);
  }
  for (const list of out.values()) list.sort((a, b) => a.rank - b.rank || PB_INDEX(b.name) - PB_INDEX(a.name));
  return out;
}
const PB_INDEX = (n: PbName) => PB_DISTANCES.findIndex((d) => d.name === n);

export interface PbRow {
  name: PbName;
  label: string;
  m: number;
  /** Fastest three, from different runs. */
  top: Effort[];
  /** Each time the PB was broken, oldest first. */
  progression: Effort[];
  /** Efforts at this distance in the last 365 days. */
  yearBest: Effort | null;
}

export function pbTable(efforts: Effort[], today: string): PbRow[] {
  const yearAgo = `${+today.slice(0, 4) - 1}${today.slice(4)}`;
  return PB_DISTANCES.map((d) => {
    const es = efforts.filter((e) => e.name === d.name);
    const perRun = new Map<string, Effort>();
    for (const e of es) if (!perRun.has(e.runId) || perRun.get(e.runId)!.seconds > e.seconds) perRun.set(e.runId, e);
    const top = [...perRun.values()].sort((a, b) => a.seconds - b.seconds).slice(0, 3);
    const progression: Effort[] = [];
    for (const e of es) if (!progression.length || e.seconds < progression[progression.length - 1].seconds) progression.push(e);
    const recent = es.filter((e) => e.date >= yearAgo).sort((a, b) => a.seconds - b.seconds)[0] ?? null;
    return { name: d.name, label: d.label, m: d.m, top, progression, yearBest: recent };
  }).filter((r) => r.top.length);
}

export function fmtTime(s: number): string {
  const r = Math.round(s);
  const h = Math.floor(r / 3600);
  const m = Math.floor((r % 3600) / 60);
  const sec = r % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
export const MEDAL_LABEL = { 1: "PR", 2: "2nd", 3: "3rd" } as const;
export const pbLabel = (n: PbName) => PB_DISTANCES.find((d) => d.name === n)?.label ?? n;
