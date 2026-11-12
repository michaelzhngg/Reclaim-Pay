import { describe, expect, it } from "vitest";
import {
  DENSITY_STORAGE_KEY,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  parseDensity,
  parseThemePref,
  resolveTheme,
  themeForPath,
  type ThemePref,
} from "./preferences";

describe("parseThemePref", () => {
  it("keeps the three known values", () => {
    expect(parseThemePref("light")).toBe("light");
    expect(parseThemePref("dark")).toBe("dark");
    expect(parseThemePref("system")).toBe("system");
  });

  it("falls back to system for anything else", () => {
    for (const raw of [null, undefined, "", "Dark", "auto", 1, {}]) expect(parseThemePref(raw)).toBe("system");
  });
});

describe("parseDensity", () => {
  it("only compact turns compact on", () => {
    expect(parseDensity("compact")).toBe("compact");
    for (const raw of ["comfortable", null, "", "COMPACT", "dense", 0]) expect(parseDensity(raw)).toBe("comfortable");
  });
});

describe("resolveTheme", () => {
  it("follows the system only when the choice is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("a manual choice wins over the system in both directions", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("themeForPath", () => {
  it("keeps the landing page light", () => {
    expect(themeForPath("/", "dark", true)).toBe("light");
  });

  it("applies the preference everywhere else", () => {
    expect(themeForPath("/login", "dark", false)).toBe("dark");
    expect(themeForPath("/hr/dashboard", "system", true)).toBe("dark");
    expect(themeForPath("/employee/dashboard", "system", false)).toBe("light");
  });
});

type Store = Record<string, string>;

function runBootScript({ store, systemDark, pathname, storageThrows = false }: {
  store: Store;
  systemDark: boolean;
  pathname: string;
  storageThrows?: boolean;
}) {
  const attrs: Record<string, string> = {};
  const documentElement = { setAttribute: (k: string, v: string) => (attrs[k] = v) };
  const localStorage = {
    getItem: (k: string) => {
      if (storageThrows) throw new Error("SecurityError");
      return k in store ? store[k] : null;
    },
  };
  const window = { matchMedia: () => ({ matches: systemDark }) };
  new Function("document", "localStorage", "window", "location", THEME_BOOT_SCRIPT)(
    { documentElement },
    localStorage,
    window,
    { pathname },
  );
  return attrs;
}

describe("THEME_BOOT_SCRIPT", () => {
  const prefs: (ThemePref | null | "junk")[] = ["light", "dark", "system", null, "junk"];

  it("matches themeForPath for every stored value, system setting and route", () => {
    for (const pref of prefs) {
      for (const systemDark of [true, false]) {
        for (const pathname of ["/", "/login", "/hr/dashboard"]) {
          const store: Store = pref === null ? {} : { [THEME_STORAGE_KEY]: pref };
          const attrs = runBootScript({ store, systemDark, pathname });
          expect(attrs["data-theme"]).toBe(themeForPath(pathname, parseThemePref(pref), systemDark));
        }
      }
    }
  });

  it("matches parseDensity", () => {
    for (const raw of ["compact", "comfortable", "junk", null]) {
      const store: Store = raw === null ? {} : { [DENSITY_STORAGE_KEY]: raw };
      const attrs = runBootScript({ store, systemDark: false, pathname: "/hr/dashboard" });
      expect(attrs["data-density"]).toBe(parseDensity(raw));
    }
  });

  it("still sets a theme when storage throws", () => {
    const attrs = runBootScript({ store: {}, systemDark: true, pathname: "/hr/dashboard", storageThrows: true });
    expect(attrs["data-theme"]).toBe("dark");
    expect(attrs["data-density"]).toBe("comfortable");
  });
});
