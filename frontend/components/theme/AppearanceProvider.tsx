"use client";

import { createContext, useContext, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  DENSITY_STORAGE_KEY,
  THEME_STORAGE_KEY,
  parseDensity,
  parseThemePref,
  resolveTheme,
  themeForPath,
  type Density,
  type Theme,
  type ThemePref,
} from "@/lib/theme/preferences";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();
// Holds a choice when storage refuses writes, so it still applies until the tab closes.
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
    memory.delete(key);
  } catch {
    memory.set(key, value);
  }
}

const readPref = () => parseThemePref(memory.get(THEME_STORAGE_KEY) ?? read(THEME_STORAGE_KEY));
const readDensity = () => parseDensity(memory.get(DENSITY_STORAGE_KEY) ?? read(DENSITY_STORAGE_KEY));
const readSystemDark = () => window.matchMedia(DARK_QUERY).matches;

/** Writes the resolved theme to <html> before anyone re-renders, so canvas charts read fresh tokens. */
function applyToDocument(pathname = window.location.pathname) {
  const root = document.documentElement;
  root.setAttribute("data-theme", themeForPath(pathname, readPref(), readSystemDark()));
  root.setAttribute("data-density", readDensity());
}

function notify() {
  applyToDocument();
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  if (listeners.size === 1) {
    window.matchMedia(DARK_QUERY).addEventListener("change", notify);
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      window.matchMedia(DARK_QUERY).removeEventListener("change", notify);
      window.removeEventListener("storage", onStorage);
    }
  };
}

function onStorage(e: StorageEvent) {
  if (e.key === THEME_STORAGE_KEY || e.key === DENSITY_STORAGE_KEY || e.key === null) notify();
}

interface Appearance {
  /** What the person picked. */
  pref: ThemePref;
  /** What the portal screens show after resolving System. */
  theme: Theme;
  density: Density;
  setPref: (pref: ThemePref) => void;
  setDensity: (density: Density) => void;
}

const AppearanceContext = createContext<Appearance | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const pref = useSyncExternalStore(subscribe, readPref, () => "system" as const);
  const density = useSyncExternalStore(subscribe, readDensity, () => "comfortable" as const);
  const systemDark = useSyncExternalStore(subscribe, readSystemDark, () => false);

  // Client-side navigation does not rerun the boot script, so landing <-> app moves re-apply
  // here, before paint.
  useLayoutEffect(() => {
    applyToDocument(pathname);
  }, [pathname]);

  const value = useMemo<Appearance>(
    () => ({
      pref,
      theme: resolveTheme(pref, systemDark),
      density,
      setPref: (next) => {
        write(THEME_STORAGE_KEY, next);
        notify();
      },
      setDensity: (next) => {
        write(DENSITY_STORAGE_KEY, next);
        notify();
      },
    }),
    [pref, density, systemDark],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): Appearance {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error("useAppearance must be used inside <AppearanceProvider>");
  return ctx;
}
