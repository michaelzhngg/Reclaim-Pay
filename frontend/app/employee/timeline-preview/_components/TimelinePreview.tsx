"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import AgentTimeline from "@/components/timeline/AgentTimeline";
import DecisionCard from "@/components/timeline/DecisionCard";
import MoneyFlow from "@/components/timeline/MoneyFlow";
import { useTimeline, type TimelineAudience } from "@/lib/hooks/useTimeline";
import type { AutonomyDecision, TimelineEvent } from "@/lib/api/reclaim-pay-types";
import { decisions, payoutS1, timelineS1, timelineS4 } from "@/src/mocks/reclaimPayFixtures";

type ScenarioId = "S1" | "S4";

const SCENARIOS: Record<ScenarioId, { name: string; events: TimelineEvent[]; decision: AutonomyDecision[]; amount: string }> = {
  S1: { name: "S1 · Clean ride", events: timelineS1, decision: [decisions.S1], amount: "MYR 48.00" },
  S4: { name: "S4 · Hidden instructions", events: timelineS4, decision: [decisions.S4], amount: "MYR 95.00" },
};

function Replay({ scenario, audience }: { scenario: ScenarioId; audience: TimelineAudience }) {
  const s = SCENARIOS[scenario];
  const { steps, decisions: decided, done } = useTimeline(null, {
    replay: s.events,
    replayDecisions: s.decision,
    audience,
  });

  return (
    <div className="flex flex-col gap-4">
      <AgentTimeline steps={steps} />
      {done &&
        decided.map(d => (
          <DecisionCard key={d.tier} decision={d} amount={s.amount} audience={audience} />
        ))}
      {done && scenario === "S1" && <MoneyFlow reimId={payoutS1.reim_id} claimStatus="APPROVED" tier="AUTO_PAY" />}
    </div>
  );
}

function Toggle<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; name: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map(o => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={`min-h-11 px-4 rounded-full font-body text-sm font-semibold border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            value === o.id
              ? "bg-ink text-on-ink border-ink"
              : "bg-surface text-ink border-line hover:bg-surface-muted"
          }`}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}

export default function TimelinePreview() {
  const [scenario, setScenario] = useState<ScenarioId>("S1");
  const [audience, setAudience] = useState<TimelineAudience>("employee");
  const [run, setRun] = useState(0);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:py-10">
      <h1 className="font-display text-xl sm:text-2xl font-bold text-ink">Agent timeline preview</h1>
      <p className="mt-1 font-body text-sm text-ink-muted">
        Sample data. Replays what the agent shows while it checks a claim.
      </p>

      <div className="mt-6 flex flex-col gap-3">
        <Toggle
          label="Scenario"
          options={(Object.keys(SCENARIOS) as ScenarioId[]).map(id => ({ id, name: SCENARIOS[id].name }))}
          value={scenario}
          onChange={setScenario}
        />
        <Toggle
          label="Shown to"
          options={[
            { id: "employee" as const, name: "Employee view" },
            { id: "hr" as const, name: "HR view" },
          ]}
          value={audience}
          onChange={setAudience}
        />
        <button
          type="button"
          onClick={() => setRun(r => r + 1)}
          className="self-start inline-flex items-center gap-2 min-h-11 px-4 rounded-control font-body text-sm font-semibold text-accent-hover hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <RotateCcw className="w-4 h-4" aria-hidden="true" />
          Replay
        </button>
      </div>

      <div className="mt-6 rounded-card shadow-ambient bg-surface p-4 sm:p-6">
        <Replay key={`${scenario}-${audience}-${run}`} scenario={scenario} audience={audience} />
      </div>
    </div>
  );
}
