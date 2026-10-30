import { useState } from "react";
import { addDays, dateKey, relativeDayLabel, useToday } from "../../core/time";
import { LineChart } from "../../shell/charts";
import { ErrorNote } from "../../shell/ui";
import { fitnessConfigChanged, fmtVo2, saveFitnessConfig, showVo2, type Fitness, type FitnessConfig } from "./fitness";
import { LOAD_LABEL, Legend, STATUS_CLASS, STATUS_LABEL, vo2Series } from "./FitnessCard";
import { duration } from "./stats";
import { addReading, deleteReading } from "./strava";
import { judge, vdot } from "./vo2";

function Settings({ f }: { f: Fitness }) {
  const [c, setC] = useState<FitnessConfig>(f.config);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (next: FitnessConfig) => {
    setC(next);
    await saveFitnessConfig(next);
    fitnessConfigChanged();
    setMsg("Saved.");
  };
  return (
    <div className="fit-settings">
      <label>
        Max heart rate
        <input type="number" value={c.hrMax} onChange={(e) => setC({ ...c, hrMax: Number(e.target.value) })} onBlur={() => save(c)} style={{ width: "5em" }} />
      </label>
      <label>
        Resting heart rate
        <input type="number" value={c.hrRest} onChange={(e) => setC({ ...c, hrRest: Number(e.target.value) })} onBlur={() => save(c)} style={{ width: "5em" }} />
      </label>
      <label className="inline">
        <input type="checkbox" checked={c.calibrate} onChange={(e) => save({ ...c, calibrate: e.target.checked })} />
        Calibrate to my race results (recommended)
      </label>
      <label>
        Show VO2 max on
        <select value={c.displayScale ?? "garmin"} onChange={(e) => save({ ...c, displayScale: e.target.value as "race" | "garmin" })}>
          <option value="garmin">Garmin's scale (when you have a Garmin reading)</option>
          <option value="race">Race-result scale (VDOT)</option>
        </select>
      </label>
      <div className="fit-milestones">
        <div className="label">Projection</div>
        <label>
          Starts
          <input type="date" value={c.projection.start.date} onChange={(e) => save({ ...c, projection: { ...c.projection, start: { ...c.projection.start, date: e.target.value } } })} />
          from
          <input
            type="number"
            step="0.1"
            placeholder="auto"
            value={c.projection.start.vo2 ?? ""}
            onChange={(e) => setC({ ...c, projection: { ...c.projection, start: { ...c.projection.start, vo2: e.target.value ? Number(e.target.value) : null } } })}
            onBlur={() => save(c)}
            style={{ width: "5em" }}
          />
          <span className="muted small">(blank = your estimate at that date)</span>
        </label>
        {c.projection.milestones.map((m, i) => (
          <label key={i}>
            <input
              type="date"
              value={m.date}
              onChange={(e) => {
                const ms = [...c.projection.milestones];
                ms[i] = { ...m, date: e.target.value };
                save({ ...c, projection: { ...c.projection, milestones: ms } });
              }}
            />
            <input
              type="number"
              step="0.1"
              value={m.vo2}
              onChange={(e) => {
                const ms = [...c.projection.milestones];
                ms[i] = { ...m, vo2: Number(e.target.value) };
                setC({ ...c, projection: { ...c.projection, milestones: ms } });
              }}
              onBlur={() => save(c)}
              style={{ width: "5em" }}
            />
            <input
              value={m.label}
              onChange={(e) => {
                const ms = [...c.projection.milestones];
                ms[i] = { ...m, label: e.target.value };
                setC({ ...c, projection: { ...c.projection, milestones: ms } });
              }}
              onBlur={() => save(c)}
            />
          </label>
        ))}
        <p className="muted small">
          Goal values are the VO2 max (VDOT) a race time needs: sub-2:50 = {vdot(42195, 170 * 60).toFixed(1)}, sub-2:45 = {vdot(42195, 165 * 60).toFixed(1)}.
        </p>
      </div>
      {msg && <div className="ok-note">{msg}</div>}
    </div>
  );
}

function GarminReadings({ f }: { f: Fitness }) {
  const today = useToday();
  const [date, setDate] = useState(dateKey(new Date()));
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <p className="muted small">
        Type in your watch's VO2 max now and then (Garmin Connect → Performance stats → VO2 max) to compare the two. Garmin's number is on its own scale, usually a few points
        above VDOT, the race-result scale your goals and predictions use, so readings don't change the estimates.
        {f.garmin
          ? ` Your Garmin reads ${f.garmin.offset >= 0 ? "+" : ""}${f.garmin.offset.toFixed(1)} above the race scale, so your goals are about ${f.config.projection.milestones.map((m) => `${(m.vo2 + f.garmin!.offset).toFixed(0)} (${m.label.split(" · ")[0]})`).join(" and ")} on the watch.`
          : ""}
      </p>
      <div className="inline">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Reading date" />
        <input type="number" step="1" placeholder="e.g. 57" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Garmin VO2 max" style={{ width: "6em" }} />
        <button
          className="btn btn-primary"
          disabled={!value}
          onClick={() =>
            addReading(date, Number(value)).then(
              () => {
                setValue("");
                setErr(null);
              },
              (e) => setErr(e.message),
            )
          }
        >
          Add reading
        </button>
      </div>
      <ErrorNote error={err} />
      {f.readings.length > 0 && (
        <ul className="readings">
          {[...f.readings].reverse().map((r) => (
            <li key={r.date}>
              {relativeDayLabel(r.date, today)} · <span className="num">{r.vo2}</span>{" "}
              <button className="btn icon ghost" onClick={() => deleteReading(r.date)} aria-label={`Delete reading ${r.date}`}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FitnessTab({ f }: { f: Fitness }) {
  const today = useToday();
  const from = addDays(today, -52 * 7);
  const lastMs = [...f.config.projection.milestones].sort((a, b) => b.date.localeCompare(a.date))[0]?.date ?? addDays(today, 52 * 7);
  const recentKey = f.estimates.filter((e) => e.date >= addDays(today, -12 * 7)).reverse();
  const loadFrom = f.loadSeries[0]?.date ?? today;
  return (
    <>
      <div className="tiles">
        <div className="tile">
          <div className="label">VO2 max now</div>
          <div className="tile-value num">{showVo2(f, f.current)}</div>
          <div className="muted small">
            {f.shift ? `Garmin scale · ${fmtVo2(f.current)} on the race scale` : f.calibration === "races" ? "On your race-result scale" : "Estimate from key runs"}
            {!f.shift && f.garmin?.equivalent != null ? ` · ≈${f.garmin.equivalent.toFixed(0)} on Garmin` : ""}
          </div>
        </div>
        <div className="tile">
          <div className="label">This week vs plan</div>
          <div className="tile-value">
            <span className={`status ${STATUS_CLASS[f.thisWeek.status]}`}>{STATUS_LABEL[f.thisWeek.status]}</span>
          </div>
          <div className="muted small">
            Key runs {showVo2(f, f.thisWeek.value)} · plan {showVo2(f, f.thisWeek.projected)}
          </div>
        </div>
        <div className="tile">
          <div className="label">Trend, last 8 weeks</div>
          <div className="tile-value num">{f.slope == null ? "–" : `${f.slope >= 0 ? "+" : ""}${f.slope.toFixed(2)}`}</div>
          <div className="muted small">per week{f.neededSlope != null ? `; ${f.neededSlope.toFixed(2)} needed for ${f.nextMilestone?.label}` : ""}</div>
        </div>
        <div className="tile">
          <div className="label">Training load</div>
          <div className="tile-value num">{f.load.ratio == null ? "–" : f.load.ratio.toFixed(2)}</div>
          <div className="muted small">{f.load.status ? `${LOAD_LABEL[f.load.status]} · acute ${Math.round(f.load.acute)} / chronic ${Math.round(f.load.chronic)}` : "Not enough runs yet"}</div>
        </div>
      </div>

      <h3>VO2 max: last year and the plan to your goals</h3>
      <Legend garmin={f.readings.length > 0} />
      <LineChart
        series={vo2Series(f, from, lastMs)}
        from={from}
        to={lastMs}
        height={260}
        today={today}
        markers={f.config.projection.milestones.map((m) => ({ x: m.date, label: m.label }))}
      />
      <p className="muted small">
        Each dot is one key run: a run with at least three steady kilometres above 80% of max heart rate (the first 30 km only, before heart-rate drift). Its estimate uses Daniels' oxygen cost of your grade-adjusted pace and
        your heart-rate reserve, then shifted onto the scale of your race results (VDOT), which is what the goals and predictions use. The trend is a 4-week rolling median. Diamonds are your races converted to VDOT. A single run can be off by ±2 (heat, hills, fatigue); the
        trend is what to watch.
      </p>

      <h3>Key runs, last 12 weeks</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Run</th>
            <th className="num-col">Steady km</th>
            <th className="num-col">VO2 est.</th>
            <th className="num-col">Plan</th>
            <th>vs plan</th>
          </tr>
        </thead>
        <tbody>
          {recentKey.map((e) => {
            const p = f.project(e.date);
            const st = p == null ? "no-data" : judge(e.vo2, p);
            return (
              <tr key={e.id}>
                <td className="nowrap">{e.date}</td>
                <td>{e.name}</td>
                <td className="num-col">{e.n}</td>
                <td className="num-col">{showVo2(f, e.vo2)}</td>
                <td className="num-col">{showVo2(f, p)}</td>
                <td>
                  <span className={`status ${STATUS_CLASS[st]}`}>{p == null ? "before plan" : STATUS_LABEL[st]}</span>
                </td>
              </tr>
            );
          })}
          {!recentKey.length && (
            <tr>
              <td colSpan={6} className="muted">
                No key runs yet in the last 12 weeks.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h3>Race predictor</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Distance</th>
            <th className="num-col">{f.predictions.some((p) => p.source === "garmin") ? "Garmin" : "Prediction"}</th>
            <th className="num-col">Your curve</th>
            <th className="num-col">Equal endurance (VDOT)</th>
            <th className="num-col">Current form</th>
            <th>Next target</th>
          </tr>
        </thead>
        <tbody>
          {f.predictions.map((p) => (
            <tr key={p.name}>
              <td>{p.name}</td>
              <td className="num-col">
                <b>{p.seconds ? duration(p.seconds) : "–"}</b>
              </td>
              <td className="num-col">{p.ownSeconds ? duration(p.ownSeconds) : "–"}</td>
              <td className="num-col muted">{p.vdotSeconds ? duration(p.vdotSeconds) : "–"}</td>
              <td className="num-col muted">{p.formSeconds ? duration(p.formSeconds) : "–"}</td>
              <td>{p.target ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        {f.endurance && (
          <>
            {f.predictions.some((p) => p.source === "garmin") ? <>The main column is Garmin's own predictor. </> : null}
            <b>Your curve</b> is your own speed–endurance fit: time grows with distance to the power of <b>{f.endurance.k.toFixed(3)}</b>
            {f.endurance.fitted ? `, fitted to your best recent races (${f.endurance.used.join(", ")})` : " (a typical value; it's fitted once you have races at two distances in the last 9 months)"}, and
            anchored on {f.endurance.anchor === "current form" ? "your current form" : f.endurance.anchor} ({duration(f.endurance.ten)} for 10 km). That's the same idea as
            Garmin's predictor, which also learns how well you hold pace over longer races; plain VDOT assumes everyone's endurance is the same, which flatters the marathon
            for most people and undersells the 5k.{" "}
          </>
        )}
        {f.garminPredictionsDate && <>Garmin's column is synced from Garmin Connect ({f.garminPredictionsDate}). </>}
        {f.shape && (
          <>
            <b>Marathon shape {Math.round(f.shape.total * 100)}%</b> (as in Runalyze): {f.shape.kmPerWeek.toFixed(0)} km/week over the last 6 months against the ~
            {f.shape.targetKm.toFixed(0)} a marathon at this level needs, and long runs over the last 10 weeks against ~{f.shape.targetLong.toFixed(0)} km. It rises as the plan's
            volume builds.
          </>
        )}
      </p>

      <h3>Training load (Garmin-style acute vs chronic)</h3>
      <LineChart
        from={loadFrom}
        to={today}
        height={170}
        digits={0}
        yMin={0}
        series={[
          { name: "Chronic (28-day)", kind: "area", className: "s-chronic", points: f.loadSeries.map((d) => ({ x: d.date, y: d.chronic })) },
          { name: "Chronic (28-day)", kind: "line", className: "s-chronic", points: f.loadSeries.map((d) => ({ x: d.date, y: d.chronic })) },
          { name: "Acute (7-day)", kind: "line", className: "s-acute", points: f.loadSeries.map((d) => ({ x: d.date, y: d.acute })) },
        ]}
      />
      <p className="muted small">
        Load is heart-rate based (TRIMP: minutes weighted by intensity). An acute:chronic ratio of 0.8–1.3 is the productive range; above 1.5 is where injuries cluster — the same
        idea as the plan's "never add more than 25 km in a week" rule.
      </p>

      <h3>Aerobic efficiency on easy runs</h3>
      <LineChart
        from={from}
        to={today}
        height={140}
        digits={2}
        unit=" m/beat"
        series={[
          { name: "Efficiency", kind: "line", className: "s-eff", points: f.efficiency.map((e) => ({ x: addDays(e.week, 3), y: e.value })) },
          { name: "Efficiency", kind: "dots", className: "s-eff", points: f.efficiency.map((e) => ({ x: addDays(e.week, 3), y: e.value })) },
        ]}
      />
      <p className="muted small">Metres covered per heartbeat on easy runs (under 78% of max heart rate, 6 km+). It rises as your aerobic base grows: more speed for the same heart rate.</p>

      <h3>Shoes</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Shoe</th>
            <th className="num-col">km</th>
            <th>Wear</th>
          </tr>
        </thead>
        <tbody>
          {f.shoes.map((s) => {
            const pct = s.km / s.limit;
            return (
              <tr key={s.id}>
                <td>
                  {s.name}
                  {s.racing ? <span className="muted small"> · racing</span> : null}
                  {s.primary ? <span className="muted small"> · default</span> : null}
                </td>
                <td className="num-col">{Math.round(s.km)}</td>
                <td style={{ width: "40%" }}>
                  <div className={"wear" + (pct >= 1 ? " over" : pct >= 0.8 ? " warn" : "")}>
                    <span style={{ width: `${Math.min(1, pct) * 100}%` }} />
                  </div>
                  <span className="small muted">{pct >= 1 ? `Past ${s.limit} km — time to replace` : `${Math.round(s.limit - s.km)} km left of ~${s.limit}`}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="two-col">
        <div>
          <h3>Garmin VO2 max readings</h3>
          <GarminReadings f={f} />
        </div>
        <div>
          <h3>Settings</h3>
          <Settings f={f} />
        </div>
      </div>
    </>
  );
}
