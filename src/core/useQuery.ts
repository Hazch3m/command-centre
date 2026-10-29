import { useEffect, useRef, useState } from "react";

/**
 * Runs an async loader and re-runs it when `deps` change. Stale results from
 * an earlier run are dropped, so fast clicking can't show out-of-order data.
 */
export function useQuery<T>(load: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  useEffect(() => {
    const id = ++run.current;
    load().then(
      (d) => {
        if (id === run.current) {
          setData(d);
          setError(null);
        }
      },
      (e) => {
        if (id === run.current) setError(String(e?.message ?? e));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error };
}
