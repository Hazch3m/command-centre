import { calendarModule } from "./calendar";
import { checklistModule } from "./checklist";
import { clockModule } from "./clock";
import { runningModule } from "./running";
import { fitnessModule } from "./running/FitnessCard";
import { trainingWeekModule } from "./running/WeekCalendar";
import { latestRunModule } from "./running/LatestRun";
import { tasksModule } from "./tasks";
import { healthModule } from "./health";
import type { DashboardModule } from "./types";

/**
 * Every card on the dashboard. To add a card, create its folder under
 * src/modules/ and add it here — the shell handles layout, edit mode,
 * migrations and quick-add automatically.
 */
export const modules: DashboardModule[] = [clockModule, runningModule, trainingWeekModule, calendarModule, fitnessModule, healthModule, latestRunModule, tasksModule, checklistModule];

export const moduleById = new Map(modules.map((m) => [m.id, m]));
