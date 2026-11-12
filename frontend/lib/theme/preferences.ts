/**
 * Theme and density preferences. Pure helpers shared by the inline boot script in
 * app/layout.tsx, the AppearanceProvider and the settings controls.
 */

export type ThemePref = "light" | "dark" | "system";
export type Theme = "light" | "dark";
export type Density = "comfortable" | "compact";

export const THEME_STORAGE_KEY = "reclaim-theme";
export const DENSITY_STORAGE_KEY = "reclaim-density";

export const THEME_PREFS: readonly ThemePref[] = ["light", "dark", "system"];
export const DENSITIES: readonly Density[] = ["comfortable", "compact"];

export function parseThemePref(raw: unknown): ThemePref {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

export function parseDensity(raw: unknown): Density {
  return raw === "compact" ? "compact" : "comfortable";
}

export function resolveTheme(pref: ThemePref, systemPrefersDark: boolean): Theme {
  if (pref === "system") return systemPrefersDark ? "dark" : "light";
  return pref;
}

/** The marketing landing page keeps its own light look whatever the preference. */
export function isLightLockedPath(pathname: string): boolean {
  return pathname === "/";
}

export function themeForPath(pathname: string, pref: ThemePref, systemPrefersDark: boolean): Theme {
  return isLightLockedPath(pathname) ? "light" : resolveTheme(pref, systemPrefersDark);
}

/**
 * Runs in <head> before first paint so the page never flashes the wrong theme. It repeats
 * themeForPath and parseDensity in plain ES5 because it cannot import; preferences.test.ts
 * runs it against the helpers to keep the two in step. Storage can throw (private mode,
 * blocked site data), so every read sits in a try.
 */
export const THEME_BOOT_SCRIPT = `(function(){var d=document.documentElement,t=null,n=null;try{t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});n=localStorage.getItem(${JSON.stringify(
  DENSITY_STORAGE_KEY,
)})}catch(e){}if(t!=="light"&&t!=="dark")t="system";if(t==="system"){var m=false;try{m=window.matchMedia("(prefers-color-scheme: dark)").matches}catch(e){}t=m?"dark":"light"}if(location.pathname==="/")t="light";d.setAttribute("data-theme",t);d.setAttribute("data-density",n==="compact"?"compact":"comfortable")})()`;
