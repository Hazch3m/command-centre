import { checklistModule } from "./checklist";
import { clockModule } from "./clock";
import { tasksModule } from "./tasks";
import type { DashboardModule } from "./types";

/**
 * Every card on the dashboard. To add a card, create its folder under
 * src/modules/ and add it here — the shell handles layout, edit mode,
 * migrations and quick-add automatically.
 */
export const modules: DashboardModule[] = [clockModule, tasksModule, checklistModule];

export const moduleById = new Map(modules.map((m) => [m.id, m]));
