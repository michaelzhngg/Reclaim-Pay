"use client";

import { useEffect, useState } from "react";
import { contractSummaryRows, type ContractRecord } from "@/lib/contracts";
import { getMyContract } from "@/lib/actions/contracts";

export default function ContractSummaryCard() {
  const [contract, setContract] = useState<ContractRecord | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getMyContract().then((row) => {
      setContract(row);
      setLoaded(true);
    });
  }, []);

  if (!loaded) return null;

  if (!contract) {
    return (
      <section className="bg-surface shadow-ambient rounded-card px-5 py-4">
        <h2 className="font-display font-semibold text-lg text-ink">Your contract</h2>
        <p className="font-body text-sm text-ink-muted mt-1">
          Not set up yet. Ask HR to add your contract before you submit a claim.
        </p>
      </section>
    );
  }

  return (
    <section id="contract" aria-labelledby="contract-title" className="scroll-mt-24 bg-surface shadow-ambient rounded-card">
      <div className="px-5 pt-5 pb-2">
        <h2 id="contract-title" className="font-display font-semibold text-lg text-ink">
          Your contract
        </h2>
        <p className="font-body text-sm text-ink-muted mt-0.5">
          These terms decide how your claims and invoices are paid.
        </p>
      </div>
      <dl className="divide-y divide-line px-5 pb-3">
        {contractSummaryRows(contract).map((row) => (
          <div key={row.label} className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 py-2.5">
            <dt className="font-body text-sm text-ink-muted">{row.label}</dt>
            <dd className="font-body text-sm font-medium text-ink text-right">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
