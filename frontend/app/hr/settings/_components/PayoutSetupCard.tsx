"use client";

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { useToast } from "@/components/toast/ToastProvider";
import type { ContractOptions, PayoutSetup } from "@/lib/contracts";
import { getContractOptions, getPayoutSetup, updatePayoutSetup } from "@/lib/actions/contracts";

const btn =
  "inline-flex items-center justify-center gap-2 min-h-[44px] px-5 rounded-full bg-accent text-on-accent text-sm font-semibold hover:bg-accent-hover cursor-pointer disabled:opacity-50";

export default function PayoutSetupCard() {
  const { toast } = useToast();
  const [setup, setSetup] = useState<PayoutSetup | null>(null);
  const [options, setOptions] = useState<ContractOptions | null>(null);
  const [country, setCountry] = useState("");
  const [currencies, setCurrencies] = useState<string[]>([]);
  const [toAdd, setToAdd] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getPayoutSetup(), getContractOptions()]).then(([row, opts]) => {
      setOptions(opts);
      if (row) {
        setSetup(row);
        setCountry(row.paypal_account_country);
        setCurrencies(row.held_currencies);
      }
    });
  }, []);

  const addCurrency = () => {
    if (!toAdd || currencies.includes(toAdd)) return;
    setCurrencies([...currencies, toAdd]);
    setToAdd("");
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    const result = await updatePayoutSetup(country, currencies);
    setSaving(false);
    if (result.error || !result.setup) {
      setError(result.error ?? "Could not save the payout setup.");
      return;
    }
    setSetup(result.setup);
    setCurrencies(result.setup.held_currencies);
    toast({ tone: "success", title: "Payout setup saved" });
  };

  const available = (options?.currencies ?? []).filter((c) => !currencies.includes(c.code));

  return (
    <section className="bg-surface shadow-ambient rounded-card overflow-hidden">
      <div className="px-4 sm:px-6 py-4 border-b border-line">
        <h2 className="font-display font-semibold text-lg text-ink">Currencies and payouts</h2>
        <p className="font-body text-sm text-ink-muted mt-0.5">
          The currencies the company holds in PayPal, and the rule that decides which payouts can go out.
        </p>
      </div>

      <div className="px-4 sm:px-6 py-5 space-y-5">
        <div>
          <label htmlFor="paypal-account-country" className="font-body text-sm font-medium text-ink">
            PayPal account country
          </label>
          <select
            id="paypal-account-country"
            className="mt-1 w-full min-h-[44px] px-3 bg-surface rounded-control border border-line-strong focus:border-accent outline-none text-sm text-ink"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          >
            {!setup && <option value="">Not set</option>}
            {options?.countries.map((c) => (
              <option key={c.code} value={c.code}>{c.name}</option>
            ))}
          </select>
        </div>

        <div>
          <p className="font-body text-sm font-medium text-ink">Funding currencies</p>
          <p className="font-body text-sm text-ink-muted mt-0.5">
            The balances the company holds in PayPal. Overseas payouts are funded from one of these.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {currencies.length === 0 && <span className="text-sm text-ink-muted">Not set</span>}
            {currencies.map((code) => (
              <span
                key={code}
                className="inline-flex items-center gap-1.5 min-h-[36px] pl-3 pr-1 rounded-full bg-surface-muted text-xs font-semibold text-ink"
              >
                {code}
                <button
                  type="button"
                  aria-label={`Remove ${code}`}
                  onClick={() => setCurrencies(currencies.filter((c) => c !== code))}
                  className="inline-flex items-center justify-center h-7 w-7 rounded-full hover:bg-surface cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
          <div className="mt-3 flex flex-col sm:flex-row gap-2">
            <select
              aria-label="Currency to add"
              className="w-full sm:w-64 min-h-[44px] px-3 bg-surface rounded-control border border-line-strong focus:border-accent outline-none text-sm text-ink"
              value={toAdd}
              onChange={(e) => setToAdd(e.target.value)}
            >
              <option value="">Add a currency</option>
              {available.map((c) => (
                <option key={c.code} value={c.code}>{c.code} · {c.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={addCurrency}
              disabled={!toAdd}
              className="min-h-[44px] px-4 rounded-control border border-line-strong text-sm font-semibold text-ink hover:bg-surface-muted cursor-pointer disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>

        <div className="rounded-control bg-surface-muted px-4 py-3">
          <p className="font-body text-sm font-semibold text-ink">The MYR rule</p>
          <p className="font-body text-sm text-ink-muted mt-1">
            A Malaysian PayPal account can pay MYR only to Malaysian accounts. It cannot pay from a MYR balance
            when the payout needs conversion, so an overseas payout needs a non-MYR balance. Reclaim Pay does not
            top up the balance itself. Keep it funded in PayPal.
          </p>
        </div>

        {error && <p role="alert" className="text-sm text-danger">{error}</p>}

        <button type="button" onClick={save} disabled={saving} className={btn}>
          {saving && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
          Save payout setup
        </button>
      </div>
    </section>
  );
}
