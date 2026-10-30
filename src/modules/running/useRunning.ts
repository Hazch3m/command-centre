import { useEffect, useState } from "react";
import { backend } from "@backend";
import { useDataVersion } from "../../core/events";
import { useEvery } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { loadPlan, type Plan } from "./plan";
import { loadRuns, syncState, syncStrava, type Run, type SyncState } from "./strava";

/** Plan + cached Strava runs + connection state, refreshed when anything changes. */
export function useRunningData() {
  const version = useDataVersion("running");
  const [planTick, setPlanTick] = useState(0);
  // Pick up a re-exported training-plan.json without restarting.
  useEvery(5 * 60_000, () => setPlanTick((t) => t + 1));
  useEffect(() => {
    const onFocus = () => setPlanTick((t) => t + 1);
    window.addEventListener("focus", onFocus);
    window.addEventListener("cc:plan-changed", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("cc:plan-changed", onFocus);
    };
  }, []);

  const plan = useQuery(loadPlan, [planTick]);
  const runs = useQuery(() => loadRuns("2024-01-01"), [version]);
  const status = useQuery(
    () => Promise.all([backend.oauthStatus("strava").catch(() => null), syncState()]),
    [version],
  );
  return {
    plan: plan.data?.plan as Plan | undefined,
    planError: plan.data?.error ?? plan.error,
    runs: runs.data as Run[] | undefined,
    connected: !!status.data?.[0]?.connected,
    sync: status.data?.[1] as SyncState | undefined,
  };
}

/** Keeps the Strava cache fresh: now, then every 15 minutes. */
export function useStravaSync() {
  useEvery(15 * 60_000, () => {
    syncStrava().catch(() => {});
  });
}
