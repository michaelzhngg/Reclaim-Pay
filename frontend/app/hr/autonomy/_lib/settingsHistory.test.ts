import { describe, it, expect } from "vitest";
import type { AgentAction } from "@/lib/api/reclaim-pay-types";
import { describeChange, historyTime, SETTINGS_HISTORY_TYPES } from "./settingsHistory";

const HR = "5c2e8f10-4a3b-4c6d-8e9f-0a1b2c3d4e5f";

const action = (over: Partial<AgentAction>): AgentAction => ({
  action_id: 7,
  action_type: "CONFIG_CHANGED",
  actor: HR,
  actor_name: "Aisyah",
  reim_id: null,
  payload: {},
  hash: "h",
  created_at: "2026-11-12T06:20:00Z",
  ...over,
});

describe("describeChange: who", () => {
  it("uses the name the server sent", () => {
    expect(describeChange(action({}), "MYR").who).toBe("Aisyah");
  });

  it("falls back to a short user ID when the name is missing", () => {
    expect(describeChange(action({ actor_name: null }), "MYR").who).toBe("User 5c2e8f10");
  });

  it("names the agent", () => {
    expect(describeChange(action({ actor: "agent", actor_name: null }), "MYR").who).toBe("Reclaim agent");
  });
});

describe("describeChange: autonomy settings", () => {
  it("lists one changed limit with old and new values", () => {
    const e = describeChange(
      action({ payload: { changed: ["auto_limit_trusted"], old: { auto_limit_trusted: 200 }, new: { auto_limit_trusted: 250 }, reason: " Q4 review " } }),
      "MYR",
    );
    expect(e.title).toBe("Changed trusted employee limit");
    expect(e.changes).toEqual([{ label: "Trusted employee limit", before: "MYR 200", after: "MYR 250" }]);
    expect(e.reason).toBe("Q4 review");
  });

  it("counts several changes and formats each kind", () => {
    const e = describeChange(
      action({
        payload: {
          changed: ["audit_sample_rate", "breaker_pause_minutes"],
          old: { audit_sample_rate: 0.05, breaker_pause_minutes: 60 },
          new: { audit_sample_rate: 0.1, breaker_pause_minutes: 30 },
        },
      }),
      "MYR",
    );
    expect(e.title).toBe("Changed 2 auto-pay limits");
    expect(e.changes.map((c) => `${c.before} → ${c.after}`)).toEqual(["5% → 10%", "60 min → 30 min"]);
    expect(e.reason).toBeNull();
  });

  it("still shows a field it has no label for", () => {
    const e = describeChange(action({ payload: { changed: ["new_knob"], old: { new_knob: 1 }, new: { new_knob: 2 } } }), "MYR");
    expect(e.changes).toEqual([{ label: "New knob", before: "1", after: "2" }]);
  });

  it("handles a save with nothing listed", () => {
    expect(describeChange(action({ payload: { version: 3 } }), "MYR").title).toBe("Saved auto-pay limits");
  });

  it("describes the kill switch both ways", () => {
    expect(describeChange(action({ action_type: "KILL_SWITCH", payload: { enabled: false, reason: "Audit" } }), "MYR")).toMatchObject({
      title: "Paused auto-pay",
      reason: "Audit",
    });
    expect(describeChange(action({ action_type: "KILL_SWITCH", payload: { enabled: true } }), "MYR").title).toBe("Turned auto-pay back on");
  });

  it("gives the breaker's end time", () => {
    const e = describeChange(
      action({ action_type: "BREAKER_TRIPPED", actor: "agent", payload: { until: "2026-11-12T07:30:00Z", reason: "6 of 20 high risk" } }),
      "MYR",
      "Asia/Kuala_Lumpur",
    );
    expect(e.title).toBe("Circuit breaker paused auto-pay until 15:30");
    expect(e.reason).toBe("6 of 20 high risk");
  });
});

describe("describeChange: policies", () => {
  it("names the policy for upload, retire and delete", () => {
    const payload = { policy_id: "p1", alias: "Travel Policy" };
    expect(describeChange(action({ action_type: "POLICY_UPLOADED", payload }), "MYR").title).toBe("Uploaded policy “Travel Policy”");
    expect(describeChange(action({ action_type: "POLICY_DEPRECATED", payload }), "MYR").title).toBe("Retired policy “Travel Policy”");
    expect(describeChange(action({ action_type: "POLICY_DELETED", payload }), "MYR").title).toBe("Deleted policy “Travel Policy”");
    expect(describeChange(action({ action_type: "POLICY_DELETED", payload: {} }), "MYR").title).toBe("Deleted a policy");
  });

  it("shows budget changes, including no limit, added and removed categories", () => {
    const e = describeChange(
      action({
        action_type: "POLICY_BUDGETS_CHANGED",
        payload: {
          alias: "Travel Policy",
          old: { Meals: 50, Transport: null, Lodging: 200 },
          new: { Meals: 75, Transport: 40, Software: 100 },
        },
      }),
      "MYR",
    );
    expect(e.title).toBe("Changed auto-approval budgets on “Travel Policy”");
    expect(e.changes).toEqual([
      { label: "Lodging", before: "MYR 200", after: "Removed" },
      { label: "Meals", before: "MYR 50", after: "MYR 75" },
      { label: "Software", before: "Not listed", after: "MYR 100" },
      { label: "Transport", before: "No limit", after: "MYR 40" },
    ]);
  });
});

describe("describeChange: unknown types", () => {
  it("falls back to a plain title", () => {
    expect(describeChange(action({ action_type: "SOMETHING_NEW" }), "MYR").title).toBe("Settings changed");
  });
});

describe("SETTINGS_HISTORY_TYPES", () => {
  it("covers the autonomy and policy actions the backend logs", () => {
    expect([...SETTINGS_HISTORY_TYPES]).toEqual([
      "CONFIG_CHANGED",
      "KILL_SWITCH",
      "BREAKER_TRIPPED",
      "POLICY_UPLOADED",
      "POLICY_DEPRECATED",
      "POLICY_DELETED",
      "POLICY_BUDGETS_CHANGED",
    ]);
  });
});

describe("historyTime", () => {
  it("formats date and time in the given zone", () => {
    expect(historyTime("2026-11-12T06:20:00Z", "Asia/Kuala_Lumpur")).toBe("12 Nov 2026, 14:20");
  });
});
