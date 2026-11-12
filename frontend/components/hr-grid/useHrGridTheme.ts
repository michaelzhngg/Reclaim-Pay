"use client";

import { useSyncExternalStore } from "react";
import { useAppearance } from "@/components/theme/AppearanceProvider";
import { hrGridTheme, hrGridThemeCompact } from "./theme";

// Same width as Tailwind's md breakpoint. Below it rows stay 52 px so each one is a full tap target.
const WIDE_QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** The AG Grid theme for the current density setting and screen width. */
export function useHrGridTheme() {
  const { density } = useAppearance();
  const wide = useSyncExternalStore(subscribe, () => window.matchMedia(WIDE_QUERY).matches, () => false);
  return density === "compact" && wide ? hrGridThemeCompact : hrGridTheme;
}
