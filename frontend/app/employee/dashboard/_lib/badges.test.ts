import { describe, it, expect } from "vitest";
import type { TrustInfo } from "@/lib/api/reclaim-pay-types";
import { trustVariants } from "@/src/mocks/reclaimPayFixtures";
import { badgeArcLabel, badgeLevels, badgeProgress, badgeStatusLine, resolveLevels } from "./badges";
import { correctionRuleLine, EXPLAINER_INTRO, EXPLAINER_OPEN_NOTICE_LINE, recentChangeLines } from "./copy";

const levels: TrustInfo["levels"] = [
  { tier: "NEW", auto_limit: 50, min_paid_claims: 0 },
  { tier: "STANDARD", auto_limit: 100, min_paid_claims: 3 },
  { tier: "TRUSTED", auto_limit: 200, min_paid_claims: 10 },
];

const silver: TrustInfo = {
  trust_tier: "STANDARD", auto_limit: 100, paid_claims: 6, next_tier: "TRUSTED", claims_to_next_tier: 4,
  reasons: [], currency: "MYR", next_limit: 200, limited_until: null, levels, hold_days: 90, trusted_clean_days: 180,
};
const bronze: TrustInfo = {
  ...silver, trust_tier: "NEW", auto_limit: 50, paid_claims: 1, next_tier: "STANDARD", claims_to_next_tier: 2, next_limit: 100,
};
const gold: TrustInfo = {
  ...silver, trust_tier: "TRUSTED", auto_limit: 200, paid_claims: 14, next_tier: null, claims_to_next_tier: 0, next_limit: null,
};
const reason = "Instant payouts are limited after a recent correction. They return to normal on 27 Jan 2027.";
const held: TrustInfo = { ...bronze, paid_claims: 6, claims_to_next_tier: 0, reasons: [reason] };

describe("badge progress arc", () => {
  it("counts Bronze to Silver from the level thresholds", () => {
    expect(badgeProgress(bronze)).toEqual({ done: 1, total: 3, fraction: 1 / 3, label: "1/3", top: false });
    expect(badgeStatusLine(bronze)).toBe("2 more approved claims to unlock Silver (MYR 100)");
    expect(badgeArcLabel(bronze)).toBe("1 of 3 approved claims toward Silver");
  });
  it("counts Silver to Gold as 10 - 3 = 7 claims", () => {
    expect(badgeProgress(silver)).toMatchObject({ done: 3, total: 7, label: "3/7" });
    expect(badgeProgress(silver).fraction).toBeCloseTo(3 / 7);
    expect(badgeStatusLine(silver)).toBe("4 more approved claims to unlock Gold (MYR 200)");
    expect(badgeArcLabel(silver)).toBe("3 of 7 approved claims toward Gold");
  });
  it("uses the singular for one claim", () => {
    expect(badgeStatusLine({ ...silver, claims_to_next_tier: 1 })).toBe("1 more approved claim to unlock Gold (MYR 200)");
  });
  it("fills the whole arc at Gold", () => {
    expect(badgeProgress(gold)).toEqual({ done: 0, total: 0, fraction: 1, label: "Max", top: true });
    expect(badgeStatusLine(gold)).toBe("Highest level");
    expect(badgeArcLabel(gold)).toBe("Gold badge, the highest level");
  });
  it("shows the backend's reason instead of the progress line when held back", () => {
    expect(badgeStatusLine(held)).toBe(reason);
    expect(badgeProgress(held)).toMatchObject({ done: 3, total: 3, fraction: 1, label: "3/3" });
  });
  it("clamps a claim count larger than the gap", () => {
    expect(badgeProgress({ ...silver, claims_to_next_tier: 12 })).toMatchObject({ done: 0, total: 7, fraction: 0, label: "0/7" });
    expect(badgeStatusLine({ ...silver, claims_to_next_tier: 12 })).toBe("7 more approved claims to unlock Gold (MYR 200)");
  });
  it("handles zero and negative counts", () => {
    expect(badgeProgress({ ...silver, claims_to_next_tier: 0 })).toMatchObject({ done: 7, total: 7, fraction: 1 });
    expect(badgeProgress({ ...silver, claims_to_next_tier: -3 })).toMatchObject({ done: 7, total: 7 });
    expect(badgeStatusLine({ ...silver, claims_to_next_tier: 0 })).toBe("You have the approved claims for Gold (MYR 200).");
    expect(badgeProgress({ ...bronze, paid_claims: 0, claims_to_next_tier: 3 })).toMatchObject({ done: 0, total: 3, fraction: 0, label: "0/3" });
  });
  it("never divides by zero when the levels give no gap", () => {
    const flat = { ...silver, levels: levels!.map(l => ({ ...l, min_paid_claims: 3 })) };
    expect(badgeProgress(flat)).toMatchObject({ done: 0, total: 4, label: "0/4" });
    expect(badgeProgress({ ...flat, claims_to_next_tier: 0 })).toMatchObject({ done: 1, total: 1, fraction: 1 });
  });
});

describe("missing levels from an older backend", () => {
  const old: TrustInfo = { ...silver, levels: undefined, auto_limit: 120, next_limit: 250, trusted_clean_days: null };
  it("falls back to the default thresholds with the live limits", () => {
    expect(resolveLevels(old).map(l => [l.tier, l.auto_limit, l.min_paid_claims])).toEqual([
      ["NEW", 50, 0], ["STANDARD", 120, 3], ["TRUSTED", 250, 10],
    ]);
    expect(badgeProgress(old)).toMatchObject({ done: 3, total: 7 });
    expect(badgeStatusLine(old)).toBe("4 more approved claims to unlock Gold (MYR 250)");
  });
  it("treats an empty list the same way", () => {
    expect(badgeProgress({ ...silver, levels: [] })).toMatchObject({ done: 3, total: 7 });
  });
});

describe("badge list in the dialog", () => {
  it("lists every badge with its limit and how to earn it, marking the employee's own", () => {
    expect(badgeLevels(silver)).toEqual([
      { tier: "NEW", name: "Bronze", autoLimit: 50, limit: "Instant payouts up to MYR 50", howTo: "Everyone starts here.", current: false },
      { tier: "STANDARD", name: "Silver", autoLimit: 100, limit: "Instant payouts up to MYR 100", howTo: "After 3 approved claims.", current: true },
      { tier: "TRUSTED", name: "Gold", autoLimit: 200, limit: "Instant payouts up to MYR 200",
        howTo: "After 10 approved claims, with no correction in the last 180 days.", current: false },
    ]);
  });
  it("leaves out the clean-days rule when the backend does not send it", () => {
    expect(badgeLevels({ ...gold, trusted_clean_days: null })[2].howTo).toBe("After 10 approved claims.");
  });
});

describe("fairness", () => {
  const banned = /risk|score|signal|check|flag|tier|standard|trusted/i;
  it("never names a score, signal, check or internal level in any badge copy", () => {
    for (const info of Object.values(trustVariants).filter((v): v is TrustInfo => v !== null).concat([bronze, silver, gold])) {
      const now = new Date("2026-11-12T08:00:00Z");
      const copy = [
        badgeStatusLine(info), badgeArcLabel(info), correctionRuleLine(info), EXPLAINER_INTRO, EXPLAINER_OPEN_NOTICE_LINE,
        ...badgeLevels(info).flatMap(l => [l.name, l.limit, l.howTo]),
        ...recentChangeLines(info, now, "Asia/Kuala_Lumpur"),
      ].filter(line => line !== reason);
      for (const line of copy) expect(line).not.toMatch(banned);
    }
  });
});
