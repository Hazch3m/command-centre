import { isoWeek, useNow } from "../../core/time";
import type { DashboardModule } from "../types";

const dateFmt = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });
const pad = (n: number) => String(n).padStart(2, "0");

function ClockCard() {
  const now = useNow("second");
  return (
    <div className="clock">
      <div className="clock-time num" aria-label="Current time">
        {pad(now.getHours())}:{pad(now.getMinutes())}
        <span className="clock-sec">{pad(now.getSeconds())}</span>
      </div>
      <div className="clock-date">
        <span>{dateFmt.format(now)}</span>
        <span className="muted">Week {isoWeek(now)}</span>
      </div>
    </div>
  );
}

export const clockModule: DashboardModule = {
  id: "clock",
  title: "Clock",
  defaultPos: { x: 0, y: 0, w: 12, h: 2 },
  minW: 3,
  minH: 2,
  defaultHidden: true,
  Card: ClockCard,
};
