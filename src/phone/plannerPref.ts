/** Planner (calendar, to-do, habits) is optional: Settings → Show Planner. Kept on this phone. */
const PLANNER_KEY = "cc-show-planner";

export const plannerShown = () => {
  try {
    return localStorage.getItem(PLANNER_KEY) !== "0";
  } catch {
    return true;
  }
};

export function setPlannerShown(on: boolean) {
  try {
    localStorage.setItem(PLANNER_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new Event("cc:tabs-changed"));
}
