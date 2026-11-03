import { fmtTime, MEDAL_LABEL, pbLabel, type Medal } from "./pbs";

/** Gold, silver and bronze discs, Strava-style. */
export function MedalBadges({ medals, max = 3, full }: { medals: Medal[] | undefined; max?: number; full?: boolean }) {
  if (!medals?.length) return null;
  const shown = medals.slice(0, max);
  return (
    <span className="medals">
      {shown.map((m) => (
        <span key={m.name} className={`medal medal-${m.rank}`} title={`${m.rank === 1 ? "PR" : MEDAL_LABEL[m.rank] + " fastest"}: ${pbLabel(m.name)} in ${fmtTime(m.seconds)}`}>
          <i>{m.rank === 1 ? "PR" : m.rank}</i>
          {full && (
            <>
              {pbLabel(m.name)} <b>{fmtTime(m.seconds)}</b>
            </>
          )}
        </span>
      ))}
      {medals.length > max && <span className="muted small">+{medals.length - max}</span>}
    </span>
  );
}

