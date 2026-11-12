import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(__dirname, "globals.css"), "utf8");

function block(selectorStart: string): string {
  const at = css.indexOf(selectorStart);
  if (at < 0) throw new Error(`missing ${selectorStart}`);
  const open = css.indexOf("{", at + selectorStart.length - 1);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed ${selectorStart}`);
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).replace(/\s+/g, " ").trim());
  }
  return out;
}

const light = declarations(block("@theme {"));
const darkMedia = declarations(block(':root:not([data-theme="light"]) {'));
const darkAttr = declarations(block(':root[data-theme="dark"] {'));

function hex(name: string, tokens: Map<string, string>): string {
  const v = tokens.get(`--color-${name}`) ?? light.get(`--color-${name}`);
  if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`--color-${name} is not a 6-digit hex: ${v}`);
  return v;
}

function luminance(h: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("dark theme tokens", () => {
  it("the media-query block and the data-theme block are identical", () => {
    expect([...darkAttr.entries()]).toEqual([...darkMedia.entries()]);
  });

  it("every dark colour overrides a token that exists in light", () => {
    for (const name of darkAttr.keys()) {
      if (name.startsWith("--color-")) expect(light.has(name), name).toBe(true);
    }
  });
});

// [text, background, minimum]. Body text 4.5:1; focus ring and control borders 3:1.
const PAIRS: [string, string, number][] = [
  ["ink", "paper", 4.5],
  ["ink", "surface", 4.5],
  ["ink", "surface-muted", 4.5],
  ["ink-muted", "paper", 4.5],
  ["ink-muted", "surface", 4.5],
  ["ink-muted", "surface-muted", 4.5],
  ["accent", "surface", 4.5],
  ["accent", "accent-soft", 4.5],
  ["on-accent", "accent", 4.5],
  ["on-accent", "accent-hover", 4.5],
  ["on-primary", "primary", 4.5],
  ["on-ink", "ink", 4.5],
  ["success", "surface", 4.5],
  ["success", "success-soft", 4.5],
  ["on-accent", "success", 4.5],
  ["danger", "surface", 4.5],
  ["danger", "danger-soft", 4.5],
  ["on-accent", "danger", 4.5],
  ["warning", "surface", 4.5],
  ["warning", "warning-soft", 4.5],
  ["on-accent", "warning", 4.5],
  ["on-surface", "surface", 4.5],
  ["on-surface-variant", "surface", 4.5],
  ["paypal-blue", "surface", 4.5],
  ["secondary", "surface", 3],
  ["secondary", "paper", 3],
];

describe("dark theme contrast", () => {
  it.each(PAIRS)("%s on %s", (fg, bg, min) => {
    expect(ratio(hex(fg, darkAttr), hex(bg, darkAttr))).toBeGreaterThanOrEqual(min);
  });

  it("control borders clear 3:1 against cards and the page", () => {
    for (const bg of ["surface", "paper", "surface-muted"]) {
      expect(ratio(hex("line-strong", darkAttr), hex(bg, darkAttr))).toBeGreaterThanOrEqual(3);
    }
  });
});
