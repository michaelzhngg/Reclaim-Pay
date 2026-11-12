import { describe, expect, it } from "vitest";
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_TOO_LONG,
  passwordChecklist,
  passwordIsAcceptable,
  passwordProblems,
} from "./passwordPolicy";

const GOOD = "Harbour-Light7";

describe("passwordProblems mirrors the backend rules", () => {
  it("accepts a password that meets every rule", () => {
    expect(passwordProblems(GOOD)).toEqual([]);
  });

  it.each([
    ["Ab1!xyz", "Use at least 8 characters."],
    ["harbour-light7", "Add an uppercase letter."],
    ["HARBOUR-LIGHT7", "Add a lowercase letter."],
    ["Harbour-Light", "Add a number."],
    ["HarbourLight7", "Add a special character, such as ! or #."],
  ])("%s -> %s", (password, problem) => {
    expect(passwordProblems(password)).toEqual([problem]);
  });

  it("does not count a space as a special character", () => {
    expect(passwordProblems("Harbour Light7")).toContain("Add a special character, such as ! or #.");
  });

  it("enforces the 72-byte bcrypt limit in bytes, not characters", () => {
    const atLimit = "Aa1!" + "x".repeat(PASSWORD_MAX_BYTES - 4);
    expect(passwordProblems(atLimit)).toEqual([]);
    expect(passwordProblems(atLimit + "x")).toEqual([PASSWORD_TOO_LONG]);
    expect(passwordProblems("Aa1!" + "\u{1F600}".repeat(18))).toEqual([PASSWORD_TOO_LONG]);
  });

  it("counts an emoji as one character for the length rule", () => {
    expect(passwordProblems("Aa1\u{1F600}\u{1F600}\u{1F600}\u{1F600}")).toEqual(["Use at least 8 characters."]);
  });
});

describe("passwordChecklist", () => {
  it("ticks each rule and the match", () => {
    const items = passwordChecklist(GOOD, GOOD);
    expect(items.map((i) => i.id)).toEqual(["length", "upper", "lower", "digit", "special", "match"]);
    expect(items.every((i) => i.met)).toBe(true);
  });

  it("does not call two empty fields a match", () => {
    expect(passwordChecklist("", "").find((i) => i.id === "match")?.met).toBe(false);
  });

  it("only accepts when every rule passes and both fields match", () => {
    expect(passwordIsAcceptable(GOOD, GOOD)).toBe(true);
    expect(passwordIsAcceptable(GOOD, GOOD + "x")).toBe(false);
    expect(passwordIsAcceptable("password", "password")).toBe(false);
  });
});
