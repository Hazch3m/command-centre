import { kvGet, kvSet } from "../../core/db";
import { repeat, step, toToolSteps, fromToolSteps, type Workout } from "./steps";

/** Saved workout templates. The three built-in ones can't be deleted, only overwritten by name. */
export interface Template {
  name: string;
  description: string;
  steps: unknown[]; // garmin-coach format (no ids)
  builtIn?: boolean;
}

export const BUILT_IN: Template[] = [
  {
    name: "Threshold 3×10 min",
    description: "Comfortably hard, about 1-hour race effort. Even reps; relax the shoulders.",
    builtIn: true,
    steps: toToolSteps([
      step("warmup", "15:00", "hr zone 2", "Easy, build to steady"),
      repeat(3, [step("interval", "10:00", "pace 3:40-3:48/km", "Threshold"), step("recovery", "2:00", "open", "Easy jog")]),
      step("cooldown", "10:00", "hr zone 2", "Easy"),
    ]),
  },
  {
    name: "Easy + strides",
    description: "Easy, conversational, then 6 relaxed strides.",
    builtIn: true,
    steps: toToolSteps([
      step("interval", "10km", "hr zone 2", "Easy, conversational"),
      repeat(6, [step("interval", "20s", "open", "Stride: quick and relaxed"), step("recovery", "60s", "open", "Walk or jog back")]),
    ]),
  },
  {
    name: "Long run with MP finish",
    description: "Easy for most of it, then the last 6 km at marathon pace. Fuel every 30–40 min.",
    builtIn: true,
    steps: toToolSteps([step("interval", "22km", "hr zone 2", "Easy"), step("interval", "6km", "pace 4:00-4:05/km", "Marathon pace: smooth, not a race")]),
  },
];

export async function getTemplates(): Promise<Template[]> {
  const mine = await kvGet<Template[]>("watch.templates", []);
  return [...BUILT_IN.filter((b) => !mine.some((m) => m.name === b.name)), ...mine];
}

export async function saveTemplate(w: Workout) {
  const mine = await kvGet<Template[]>("watch.templates", []);
  const t: Template = { name: w.name.trim(), description: w.description, steps: toToolSteps(w.steps) };
  await kvSet("watch.templates", [...mine.filter((m) => m.name !== t.name), t]);
}

export async function deleteTemplate(name: string) {
  const mine = await kvGet<Template[]>("watch.templates", []);
  await kvSet("watch.templates", mine.filter((m) => m.name !== name));
}

export const fromTemplate = (t: Template): Workout => ({ name: t.name, description: t.description, sport: "running", steps: fromToolSteps(t.steps) });
