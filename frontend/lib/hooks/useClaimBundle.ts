"use client";

import { useCallback, useEffect, useState } from "react";
import { getHRClaimBundle } from "@/lib/actions/hr";
import type { ClaimBundle } from "@/lib/api/types";

export type ClaimLoad =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "failed" }
  | { state: "ready"; bundle: ClaimBundle };

/**
 * Loads one claim for the HR detail pages. "missing" means the backend said the claim doesn't
 * exist; "failed" means the request itself went wrong, so the page offers a retry instead.
 */
export function useClaimBundle(id: string) {
  const [load, setLoad] = useState<ClaimLoad>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getHRClaimBundle(id)
      .then((bundle) => {
        if (!cancelled) setLoad(bundle ? { state: "ready", bundle } : { state: "missing" });
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  const retry = useCallback(() => {
    setLoad({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  /** Re-fetch without dropping the current bundle, for actions that change the claim in place. */
  const refresh = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  return { load, retry, refresh };
}
