/** Little line icons for kinds of session, drawn to match the tab bar. */
const PATHS: Record<string, string> = {
  // A leaf: easy, aerobic
  easy: "M5 19c0-8 5-13 14-14-1 9-6 14-14 14zM5 19l7-7",
  // A road into the distance: long run
  long: "M9 3 4 21M15 3l5 18M12 4v2.5M12 10v3M12 17v4",
  // A flame: threshold
  threshold: "M12 21c-3.5 0-6-2.4-6-5.6 0-3.4 3-5 3.5-8.4 2 1.3 3 3.2 3 4.6 1-.6 1.6-1.8 1.6-3.2C16.5 10 18 12.5 18 15.4c0 3.2-2.5 5.6-6 5.6z",
  // A lightning bolt: VO2 max
  vo2: "M13 2 5 13h6l-1 9 8-11h-6z",
  // A flag: race
  race: "M5 21V4M5 4h11l-2 4 2 4H5",
  // A moon: rest
  rest: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  // A mountain: hills
  hills: "M2 20 9 8l4 6 3-4 6 10z",
  // A gauge: race pace
  pace: "M12 20a8 8 0 1 1 8-8M12 12l4-3",
};
export const zoneIconPath = (zone: string, title?: string) => PATHS[/hill/i.test(title ?? "") ? "hills" : /race pace/i.test(title ?? "") ? "pace" : zone] ?? PATHS.easy;

export function ZoneIcon({ zone, title, size = 18 }: { zone: string; title?: string; size?: number }) {
  return (
    <svg className="zone-icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={zoneIconPath(zone, title)} />
    </svg>
  );
}

/** A flame for streaks. */
export function StreakIcon({ size = 16 }: { size?: number }) {
  return (
    <svg className="streak-icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d="M12 22c-4 0-7-2.8-7-6.6 0-4 3.4-5.8 4-9.9 2.4 1.5 3.6 3.8 3.6 5.4 1.2-.7 1.9-2.1 1.9-3.8 2.6 2 4.5 5 4.5 8.3 0 3.8-3 6.6-7 6.6z" />
    </svg>
  );
}

/** A tick that draws itself. */
export function DrawnTick({ size = 22 }: { size?: number }) {
  return (
    <svg className="drawn-tick" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M7 12.5l3.2 3.2L17 9" />
    </svg>
  );
}
