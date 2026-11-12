"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import { useToast } from "@/components/toast/ToastProvider";
import { formatMoney } from "@/lib/api/reclaim-pay-types";
import type { Policy } from "@/lib/api/types";
import {
  formatRate,
  type ContractOptions,
  type ContractorRow,
  type RateUnit,
} from "@/lib/contracts";
import {
  createContract,
  getContractOptions,
  getContractors,
  updateContract,
} from "@/lib/actions/contracts";
import { getPolicies } from "@/lib/actions/policies";

const input =
  "w-full min-h-[44px] px-3 bg-surface rounded-control border border-line-strong focus:border-accent outline-none text-sm text-ink";
const label = "font-body text-sm font-medium text-ink";

interface FormState {
  user_id: string;
  name: string;
  country_code: string;
  currency: string;
  rate_amount: string;
  rate_unit: RateUnit;
  service_category: string;
  categories_text: string;
  selected_categories: string[];
  max_company_amount_per_claim: string;
  policy_id: string;
  effective_from: string;
  effective_to: string;
  is_active: boolean;
}

function emptyForm(row: ContractorRow): FormState {
  return {
    user_id: row.user_id,
    name: row.name,
    country_code: "MY",
    currency: "MYR",
    rate_amount: "",
    rate_unit: "DAY",
    service_category: "",
    categories_text: "",
    selected_categories: [],
    max_company_amount_per_claim: "",
    policy_id: "",
    effective_from: new Date().toISOString().slice(0, 10),
    effective_to: "",
    is_active: true,
  };
}

function formFromRow(row: ContractorRow): FormState {
  const contract = row.contract;
  if (!contract) return emptyForm(row);
  return {
    user_id: row.user_id,
    name: row.name,
    country_code: contract.country_code,
    currency: contract.currency,
    rate_amount: String(contract.rate_amount),
    rate_unit: contract.rate_unit,
    service_category: contract.service_category,
    categories_text: contract.categories.join(", "),
    selected_categories: contract.categories,
    max_company_amount_per_claim: String(contract.max_company_amount_per_claim),
    policy_id: contract.policy_id ?? "",
    effective_from: contract.effective_from,
    effective_to: contract.effective_to ?? "",
    is_active: contract.is_active,
  };
}

export default function ContractorsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState<ContractorRow[]>([]);
  const [options, setOptions] = useState<ContractOptions | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [contractors, opts, allPolicies] = await Promise.all([
      getContractors(),
      getContractOptions(),
      getPolicies().catch(() => []),
    ]);
    setRows(contractors.rows);
    setOptions(opts);
    setPolicies(allPolicies);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const activePolicies = useMemo(
    () => policies.filter((p) => p.status === "ACTIVE"),
    [policies],
  );
  const selectedPolicy = useMemo(
    () => activePolicies.find((p) => p.policy_id === form?.policy_id) ?? null,
    [activePolicies, form?.policy_id],
  );
  const editing = form ? rows.find((r) => r.user_id === form.user_id) : null;

  const open = (row: ContractorRow) => {
    setError(null);
    setForm(row.contract ? formFromRow(row) : emptyForm(row));
  };

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const submit = async () => {
    if (!form) return;
    setError(null);
    setSaving(true);
    const categories = form.policy_id
      ? form.selected_categories
      : form.categories_text.split(",").map((c) => c.trim()).filter(Boolean);
    const payload = {
      user_id: form.user_id,
      country_code: form.country_code,
      currency: form.currency,
      rate_amount: Number(form.rate_amount),
      rate_unit: form.rate_unit,
      service_category: form.service_category,
      categories,
      max_company_amount_per_claim: Number(form.max_company_amount_per_claim),
      policy_id: form.policy_id || null,
      effective_from: form.effective_from,
      effective_to: form.effective_to || null,
      is_active: form.is_active,
    };
    const result = editing?.contract
      ? await updateContract(editing.contract.contract_id, payload)
      : await createContract(payload);
    setSaving(false);
    if (result.error || !result.contract) {
      setError(result.error ?? "Could not save the contract.");
      return;
    }
    toast({ tone: "success", title: "Contract saved" });
    setForm(null);
    await load();
  };

  return (
    <div className="min-h-full px-4 py-5 sm:px-6 md:px-8 md:py-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-5">
          <h1 className="font-display font-semibold text-2xl md:text-3xl text-ink">Contractors</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Contracts decide the payout currency, the invoice rate and the expense categories a contractor can claim.
          </p>
        </header>

        <div className="bg-surface shadow-ambient rounded-card overflow-x-auto">
          <table className="w-full min-w-[900px] text-left">
            <thead className="border-b border-line">
              <tr className="text-xs font-semibold text-ink-muted">
                <th className="py-3 px-5">Contractor</th>
                <th className="py-3 px-5">Country</th>
                <th className="py-3 px-5">Payout</th>
                <th className="py-3 px-5">Rate</th>
                <th className="py-3 px-5">Limit per claim</th>
                <th className="py-3 px-5">Categories</th>
                <th className="py-3 px-5">Contract</th>
                <th className="py-3 px-5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => (
                <tr key={row.user_id} className="text-sm align-top">
                  <td className="py-3 px-5">
                    <p className="font-semibold text-ink">{row.name}</p>
                    <p className="text-ink-muted">{row.email}</p>
                  </td>
                  <td className="py-3 px-5 text-ink">{row.contract?.country_name ?? "Not set"}</td>
                  <td className="py-3 px-5 text-ink">{row.contract?.currency ?? "Not set"}</td>
                  <td className="py-3 px-5 text-ink">
                    {row.contract
                      ? formatRate(row.contract.currency, row.contract.rate_amount, row.contract.rate_unit)
                      : "Not set"}
                  </td>
                  <td className="py-3 px-5 text-ink">
                    {row.contract
                      ? formatMoney(row.contract.company_currency, row.contract.max_company_amount_per_claim)
                      : "Not set"}
                  </td>
                  <td className="py-3 px-5 text-ink">
                    {row.contract?.categories.length ? row.contract.categories.join(", ") : "Not set"}
                  </td>
                  <td className="py-3 px-5">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
                        row.contract
                          ? row.contract.is_active
                            ? "bg-success-soft text-success"
                            : "bg-surface-muted text-ink-muted"
                          : "bg-warning-soft text-warning"
                      }`}
                    >
                      {row.contract ? (row.contract.is_active ? "Active" : "Inactive") : "Missing setup"}
                    </span>
                  </td>
                  <td className="py-3 px-5 text-right">
                    <button
                      type="button"
                      onClick={() => open(row)}
                      className="min-h-[36px] px-3 rounded-control border border-line-strong text-xs font-semibold text-ink hover:bg-surface-muted cursor-pointer"
                    >
                      {row.contract ? "Edit contract" : "Set up contract"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <p className="px-5 py-8 text-sm text-ink-muted">Loading contractors…</p>}
          {!loading && rows.length === 0 && (
            <p className="px-5 py-8 text-sm text-ink-muted">
              No contractors yet. Create a user with the Contractor role on the Employees page.
            </p>
          )}
        </div>

        {form && (
          <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 sm:p-6">
            <div className="absolute inset-0 bg-ink/40" onClick={() => !saving && setForm(null)} />
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="contract-title"
              className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-surface rounded-dialog border border-line shadow-overlay"
            >
              <div className="flex items-start justify-between gap-4 px-5 sm:px-6 py-4 border-b border-line">
                <div>
                  <h2 id="contract-title" className="font-display font-semibold text-lg text-ink">
                    {editing?.contract ? "Edit contract" : "Set up contract"}
                  </h2>
                  <p className="text-sm text-ink-muted mt-0.5">{form.name}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setForm(null)}
                  aria-label="Close"
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-control hover:bg-surface-muted cursor-pointer"
                >
                  <X className="w-5 h-5" aria-hidden="true" />
                </button>
              </div>

              <div className="px-5 sm:px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={label} htmlFor="contract-country">Country</label>
                  <select
                    id="contract-country"
                    className={input}
                    value={form.country_code}
                    onChange={(e) => set("country_code", e.target.value)}
                  >
                    {options?.countries.map((c) => (
                      <option key={c.code} value={c.code}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="contract-currency">Payout currency</label>
                  <select
                    id="contract-currency"
                    className={input}
                    value={form.currency}
                    onChange={(e) => set("currency", e.target.value)}
                  >
                    {options?.currencies.map((c) => (
                      <option key={c.code} value={c.code}>{c.code} · {c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="contract-rate">Rate</label>
                  <input
                    id="contract-rate"
                    className={input}
                    inputMode="decimal"
                    value={form.rate_amount}
                    onChange={(e) => set("rate_amount", e.target.value)}
                  />
                </div>
                <div>
                  <label className={label} htmlFor="contract-unit">Rate unit</label>
                  <select
                    id="contract-unit"
                    className={input}
                    value={form.rate_unit}
                    onChange={(e) => set("rate_unit", e.target.value as RateUnit)}
                  >
                    {options?.rate_units.map((unit) => (
                      <option key={unit} value={unit}>{unit}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="contract-service">Invoice category</label>
                  <input
                    id="contract-service"
                    className={input}
                    placeholder="Design services"
                    value={form.service_category}
                    onChange={(e) => set("service_category", e.target.value)}
                  />
                </div>
                <div>
                  <label className={label} htmlFor="contract-limit">Limit per claim (company currency)</label>
                  <input
                    id="contract-limit"
                    className={input}
                    inputMode="decimal"
                    value={form.max_company_amount_per_claim}
                    onChange={(e) => set("max_company_amount_per_claim", e.target.value)}
                  />
                </div>
                <div>
                  <label className={label} htmlFor="contract-from">Effective from</label>
                  <input
                    id="contract-from"
                    type="date"
                    className={input}
                    value={form.effective_from}
                    onChange={(e) => set("effective_from", e.target.value)}
                  />
                </div>
                <div>
                  <label className={label} htmlFor="contract-to">Effective to</label>
                  <input
                    id="contract-to"
                    type="date"
                    className={input}
                    value={form.effective_to}
                    onChange={(e) => set("effective_to", e.target.value)}
                  />
                  <p className="mt-1 text-xs text-ink-muted">Leave empty for no end date.</p>
                </div>

                <div className="sm:col-span-2">
                  <label className={label} htmlFor="contract-policy">Policy</label>
                  <select
                    id="contract-policy"
                    className={input}
                    value={form.policy_id}
                    onChange={(e) => {
                      set("policy_id", e.target.value);
                      set("selected_categories", []);
                      set("categories_text", "");
                    }}
                  >
                    <option value="">No contract policy</option>
                    {activePolicies.map((p) => (
                      <option key={p.policy_id} value={p.policy_id}>{p.title}</option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <p className={label}>Expense categories</p>
                  {selectedPolicy ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedPolicy.reimbursable_categories.map((category) => {
                        const checked = form.selected_categories.includes(category);
                        return (
                          <button
                            key={category}
                            type="button"
                            aria-pressed={checked}
                            onClick={() =>
                              set(
                                "selected_categories",
                                checked
                                  ? form.selected_categories.filter((c) => c !== category)
                                  : [...form.selected_categories, category],
                              )
                            }
                            className={`min-h-[36px] px-3 rounded-full text-xs font-semibold border transition-colors cursor-pointer ${
                              checked
                                ? "bg-accent text-on-accent border-accent"
                                : "bg-surface text-ink border-line-strong hover:bg-surface-muted"
                            }`}
                          >
                            {category}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <>
                      <input
                        id="contract-categories"
                        className={`${input} mt-2`}
                        placeholder="Meals, Transportation"
                        value={form.categories_text}
                        onChange={(e) => set("categories_text", e.target.value)}
                      />
                      <p className="mt-1 text-xs text-ink-muted">Separate categories with commas.</p>
                    </>
                  )}
                </div>

                {editing?.contract && (
                  <label className="sm:col-span-2 flex items-center gap-3 min-h-[44px] text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={form.is_active}
                      onChange={(e) => set("is_active", e.target.checked)}
                    />
                    Contract is active
                  </label>
                )}

                {error && <p role="alert" className="sm:col-span-2 text-sm text-danger">{error}</p>}
              </div>

              <div className="flex flex-col-reverse sm:flex-row gap-3 px-5 sm:px-6 py-4 border-t border-line">
                <button
                  type="button"
                  onClick={() => setForm(null)}
                  disabled={saving}
                  className="flex-1 min-h-[44px] px-6 rounded-control text-sm font-semibold text-ink border border-line-strong hover:bg-surface-muted cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={saving}
                  className="flex-1 inline-flex items-center justify-center gap-2 min-h-[44px] px-6 rounded-full bg-accent text-on-accent text-sm font-semibold hover:bg-accent-hover cursor-pointer disabled:opacity-50"
                >
                  {saving && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                  Save contract
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
