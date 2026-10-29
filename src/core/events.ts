import { useEffect, useState } from "react";
import { backend } from "@backend";

/**
 * Cross-window "something changed" signal. Writers call `notifyChanged("tasks")`;
 * cards re-query when `useDataVersion("tasks")` ticks. Works across the
 * dashboard and the quick-add popup.
 */
const EVENT = "data-changed";

export function notifyChanged(topic: string) {
  return backend.emit(EVENT, { topic });
}

export function useDataVersion(topic: string): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    backend
      .listen(EVENT, (p) => {
        const t = (p as { topic?: string } | undefined)?.topic;
        if (t === topic || t === "*") setVersion((v) => v + 1);
      })
      .then((unlisten) => (cancelled ? unlisten() : (off = unlisten)));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [topic]);
  return version;
}
