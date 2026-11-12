"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads one Payouts tab. `fetcher` must be stable and throw on failure. `refresh` updates in the
 * background after an action, keeping the rows on screen; `retry` goes back through the loading state.
 * `onLoaded` (stable) runs once loading has settled, so slower side checks can start after the tab's data.
 */
export function useTabData<T>(fetcher: () => Promise<T>, failureMessage: string, onLoaded?: () => void) {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const run = useCallback(
    (background: boolean) => {
      latest.current += 1;
      const mine = latest.current;
      return fetcher()
        .then((next) => {
          if (mine !== latest.current) return;
          setData(next);
          setError(null);
        })
        .catch(() => {
          if (mine === latest.current && !background) setError(failureMessage);
        })
        .finally(() => {
          if (mine === latest.current) setIsLoading(false);
        });
    },
    [fetcher, failureMessage],
  );

  useEffect(() => {
    void run(false);
  }, [run]);

  useEffect(() => {
    if (!isLoading) onLoaded?.();
  }, [isLoading, onLoaded]);

  const retry = useCallback(() => {
    setIsLoading(true);
    setError(null);
    void run(false);
  }, [run]);

  const refresh = useCallback(() => void run(true), [run]);

  return { data, isLoading, error, retry, refresh };
}
