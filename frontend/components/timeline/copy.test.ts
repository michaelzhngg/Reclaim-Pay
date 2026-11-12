import { describe, it, expect } from "vitest";
import { employeeSafeSteps } from "./copy";

describe("employeeSafeSteps", () => {
  it("drops the detail of a step that warned and keeps the row", () => {
    const out = employeeSafeSteps([
      { step: "policy.check", label: "Checking policy", status: "warn", detail: "over meal cap" },
      { step: "totals.aggregate", label: "Adding up", status: "done", detail: "MYR 48.00 claimed" },
    ] as never);
    expect(out[0]).toMatchObject({ status: "warn", detail: null, label: "Checking policy" });
    expect(out[1].detail).toBe("MYR 48.00 claimed");
  });
});
