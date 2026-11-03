import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Runs an async loader and re-runs it when `deps` change (or on `reload()`).
 * Stale results from an earlier run are dropped, so fast clicking can't show
 * out-of-order data.
 */
export function useQuery<T>(load: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const run = useRef(0);
  useEffect(() => {
    const id = ++run.current;
    setLoading(true);
    load().then(
      (d) => {
        if (id === run.current) {
          setData(d);
          setError(null);
          setLoading(false);
        }
      },
      (e) => {
        if (id === run.current) {
          setError(String(e?.message ?? e));
          setLoading(false);
        }
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
