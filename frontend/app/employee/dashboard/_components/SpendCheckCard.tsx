"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import type { CategoryOption, QaAnswer, SpendCheckResult, TripEstimate } from "@/lib/api/reclaim-pay-types";
import { askPolicy, checkCost, getSpendCategories, planTrip } from "@/lib/actions/spendCheck";
import { useAuth } from "@/context/AuthContext";
import { parseAmount, quantityLabel } from "@/lib/policy/limits";
import {
  GUIDANCE_NOTE, ONE_QUESTION_MESSAGE, askHint, hasSeveralQuestions, tripLineText, tripNotes, tripSummary,
  verdictMessage, zoneText, type SpendTone,
} from "@/lib/policy/spendCopy";

type Mode = "cost" | "trip" | "ask";

const MODES: { mode: Mode; short: string; long: string; hint: string }[] = [
  { mode: "cost", short: "Cost", long: "Check a cost", hint: "See your limit for something you're about to pay for." },
  { mode: "trip", short: "Trip", long: "Plan a trip", hint: "See the most the policy pays for your travel dates." },
  { mode: "ask", short: "Question", long: "Ask a question", hint: "Ask about the policy in your own words. Answers quote the policy." },
];

// Inputs get the focus ring explicitly: the global :focus-visible rule only covers buttons and links.
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary";
const FIELD = `h-11 w-full px-3 rounded-control bg-surface border border-outline text-sm text-ink ${FOCUS}`;
const LABEL = "flex flex-col gap-1 text-xs font-medium text-ink-muted";
const SUBMIT =
  "inline-flex items-center justify-center min-h-11 px-5 rounded-full bg-accent text-on-accent text-sm font-semibold " +
  "hover:bg-accent-hover transition-colors disabled:opacity-50";
const TONE: Record<SpendTone, string> = { ok: "text-ink", warn: "text-warning", info: "text-ink" };
const MAX_QUESTION = 500;

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoDay(d);
};

function Guidance() {
  return <p className="mt-3 text-xs text-ink-muted">{GUIDANCE_NOTE}</p>;
}

/** Employees check a cost, estimate a trip or ask the policy a question before they spend. */
export default function SpendCheckCard({ className = "" }: { className?: string }) {
  const ids = useId();
  const { user } = useAuth();
  // undefined while loading, null when the request failed
  const [options, setOptions] = useState<CategoryOption[] | null | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("cost");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [destination, setDestination] = useState("");
  const [overseas, setOverseas] = useState(false);
  const [result, setResult] = useState<SpendCheckResult | null>(null);

  const [depart, setDepart] = useState(() => inDays(0));
  const [ret, setRet] = useState(() => inDays(1));
  const [trip, setTrip] = useState<TripEstimate | null>(null);

  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<QaAnswer | null>(null);

  useEffect(() => {
    getSpendCategories().then(setOptions).catch(() => setOptions(null));
  }, []);

  // No active policy lists a category, so there is nothing to check against.
  if (options?.length === 0) return null;

  const chosen = options?.find((o) => o.category === category);
  const perDayOrNight = chosen?.unit === "PER_DAY" || chosen?.unit === "PER_NIGHT";
  const qtyLabel = perDayOrNight && chosen?.unit ? quantityLabel(chosen.unit) : null;
  const tripAsksDestination = !!options?.some((o) => o.asks_destination);
  const tripAsksOverseas = !!options?.some((o) => o.asks_overseas);

  const parsedAmount = parseAmount(amount);
  const amountBad = parsedAmount !== null && Number.isNaN(parsedAmount);
  const qty = Number(quantity);
  const qtyBad = !!qtyLabel && !(Number.isInteger(qty) && qty >= 1 && qty <= 60);
  const datesBad = ret < depart;

  // Any edit makes the shown result stale, so it goes.
  const edit = <T,>(set: (v: T) => void, clear: () => void) => (v: T) => {
    set(v);
    clear();
    setError(null);
  };
  const editCost = <T,>(set: (v: T) => void) => edit(set, () => setResult(null));
  const editTrip = <T,>(set: (v: T) => void) => edit(set, () => setTrip(null));
  // Where to and overseas feed both forms, so changing either makes both results stale.
  const editShared = <T,>(set: (v: T) => void) => edit(set, () => { setResult(null); setTrip(null); });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch {
      setError("Couldn't reach Reclaim. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const onCost = (e: FormEvent) => {
    e.preventDefault();
    if (!category || amountBad || qtyBad) return;
    void run(async () => {
      const res = await checkCost({
        category, amount: parsedAmount, quantity: qtyLabel ? qty : 1,
        destination: chosen?.asks_destination ? destination.trim() || null : null,
        overseas: !!chosen?.asks_overseas && overseas,
      });
      setResult(res.result);
      setError(res.error);
    });
  };

  const onTrip = (e: FormEvent) => {
    e.preventDefault();
    if (datesBad) return;
    void run(async () => {
      const res = await planTrip({
        destination: tripAsksDestination ? destination.trim() || null : null,
        overseas: tripAsksOverseas && overseas, depart, return_date: ret,
      });
      setTrip(res.estimate);
      setError(res.error);
    });
  };

  const onAsk = (e: FormEvent) => {
    e.preventDefault();
    if (question.trim().length < 5) {
      setError("Write a question between 5 and 500 characters.");
      return;
    }
    if (hasSeveralQuestions(question)) {
      setError(ONE_QUESTION_MESSAGE);
      return;
    }
    void run(async () => {
      const res = await askPolicy(question.trim());
      setAnswer(res.answer);
      setError(res.error);
    });
  };

  const destinationField = (onChange: (v: string) => void) => (
    <label className={LABEL}>
      Where to
      <input value={destination} onChange={(e) => onChange(e.target.value)} maxLength={120}
        autoComplete="off" placeholder="City or town" className={`${FIELD} placeholder:text-ink-muted`} />
    </label>
  );
  const overseasField = (onChange: (v: boolean) => void) => (
    <label className="flex items-center gap-3 min-h-11 text-sm text-ink sm:self-end">
      <input type="checkbox" checked={overseas} onChange={(e) => onChange(e.target.checked)}
        className={`size-5 shrink-0 accent-accent ${FOCUS}`} />
      Travelling overseas
    </label>
  );

  const message = result ? verdictMessage(result) : null;
  const rule = result?.cap ?? result?.pre_approval;
  const costZone = result ? zoneText(result.zone, result.zone_place) : null;
  const tripZone = trip ? zoneText(trip.zone, trip.zone_place) : null;
  const hint = MODES.find((m) => m.mode === mode)!.hint;

  return (
    <section aria-labelledby={`${ids}-heading`} className={`rounded-card shadow-ambient bg-surface p-4 md:p-6 ${className}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id={`${ids}-heading`} className="font-display text-lg font-semibold text-ink">Check before you spend</h3>
          <p className="mt-1 text-sm text-ink-muted">{hint}</p>
        </div>
        <div role="group" aria-label="What to check" className="flex w-full gap-1 rounded-control border border-outline p-1 sm:w-auto sm:shrink-0">
          {MODES.map((m) => (
            <button key={m.mode} type="button" aria-pressed={mode === m.mode}
              onClick={() => { setMode(m.mode); setError(null); }}
              className={`flex-1 sm:flex-none min-h-11 px-3 rounded-[8px] text-sm font-medium transition-colors ${
                mode === m.mode ? "bg-ink text-on-ink" : "text-ink hover:bg-surface-muted"
              }`}>
              <span className="sm:hidden">{m.short}</span>
              <span className="hidden sm:inline">{m.long}</span>
            </button>
          ))}
        </div>
      </div>

      {mode !== "ask" && options === undefined && <p className="mt-4 text-sm text-ink-muted">Loading your limits</p>}
      {mode !== "ask" && options === null && (
        <p className="mt-4 text-sm text-danger">Couldn&apos;t load your policy limits. Reload the page to try again.</p>
      )}

      {options && mode === "cost" && (
        <form onSubmit={onCost} noValidate className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className={LABEL}>
            What for
            <select required value={category} onChange={(e) => editCost(setCategory)(e.target.value)} className={FIELD}>
              <option value="">Pick a category</option>
              {options.map((o) => <option key={o.category} value={o.category}>{o.category}</option>)}
            </select>
          </label>
          <label className={LABEL}>
            Amount (optional)
            <input value={amount} onChange={(e) => editCost(setAmount)(e.target.value)} inputMode="decimal"
              autoComplete="off" aria-invalid={amountBad} aria-describedby={amountBad ? `${ids}-amount-error` : undefined}
              className={`${FIELD} font-mono tabular-nums`} />
            {amountBad && (
              <span id={`${ids}-amount-error`} className="text-xs font-normal text-danger">
                Enter an amount like 120 or 120.50.
              </span>
            )}
          </label>
          {qtyLabel && (
            <label className={LABEL}>
              {qtyLabel}
              <input type="number" min={1} max={60} step={1} inputMode="numeric" value={quantity}
                onChange={(e) => editCost(setQuantity)(e.target.value)} aria-invalid={qtyBad}
                aria-describedby={qtyBad ? `${ids}-qty-error` : undefined} className={`${FIELD} font-mono tabular-nums`} />
              {qtyBad && (
                <span id={`${ids}-qty-error`} className="text-xs font-normal text-danger">
                  Enter a whole number from 1 to 60.
                </span>
              )}
            </label>
          )}
          {chosen?.asks_destination && destinationField(editShared(setDestination))}
          {chosen?.asks_overseas && overseasField(editShared(setOverseas))}
          <div className="sm:col-span-2 lg:col-span-4">
            <button type="submit" disabled={busy || !category || amountBad || qtyBad} className={SUBMIT}>
              Check my limit
            </button>
          </div>
        </form>
      )}

      {options && mode === "trip" && (
        <form onSubmit={onTrip} noValidate className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className={LABEL}>
            Leaving
            <input type="date" required value={depart} onChange={(e) => editTrip(setDepart)(e.target.value)} className={FIELD} />
          </label>
          <label className={LABEL}>
            Back
            <input type="date" required value={ret} min={depart} onChange={(e) => editTrip(setRet)(e.target.value)}
              aria-invalid={datesBad} aria-describedby={datesBad ? `${ids}-dates-error` : undefined} className={FIELD} />
            {datesBad && (
              <span id={`${ids}-dates-error`} className="text-xs font-normal text-danger">
                The return date is before the departure date.
              </span>
            )}
          </label>
          {tripAsksDestination && destinationField(editShared(setDestination))}
          {tripAsksOverseas && overseasField(editShared(setOverseas))}
          <div className="sm:col-span-2 lg:col-span-4">
            <button type="submit" disabled={busy || !depart || !ret || datesBad} className={SUBMIT}>Estimate my trip</button>
          </div>
        </form>
      )}

      {mode === "ask" && (
        <form onSubmit={onAsk} noValidate className="mt-4 flex flex-col gap-3">
          <label className={LABEL}>
            Your question
            <textarea value={question} maxLength={MAX_QUESTION} rows={3} aria-describedby={`${ids}-ask-hint`}
              onChange={(e) => { setQuestion(e.target.value); setAnswer(null); setError(null); }}
              placeholder="Can I take a taxi to the airport at 5am?"
              className={`${FIELD} h-auto py-2 placeholder:text-ink-muted`} />
          </label>
          <p id={`${ids}-ask-hint`} className="-mt-1 text-xs text-ink-muted">
            <span className="tabular-nums">{question.length} of {MAX_QUESTION}</span> characters. {askHint(user?.rank)}
          </p>
          <div>
            <button type="submit" disabled={busy || question.trim().length === 0} className={SUBMIT}>Ask</button>
          </div>
        </form>
      )}

      <div aria-live="polite" className="max-w-3xl text-sm">
        {busy && <p className="mt-4 text-ink-muted">{mode === "ask" ? "Reading the policy" : "Checking the policy"}</p>}
        {!busy && error && <p className="mt-4 text-danger">{error}</p>}

        {!busy && mode === "cost" && result && message && (
          <div className="mt-4 border-t border-line pt-4">
            <p className={`font-semibold tabular-nums ${TONE[message.tone]}`}>{message.text}</p>
            {costZone && <p className="mt-1 text-ink-muted">{costZone}</p>}
            {result.policy_title && (
              <p className="mt-1 text-ink-muted break-words">
                From {result.policy_title}{rule?.source_section ? `, ${rule.source_section}` : ""}
              </p>
            )}
            <Guidance />
          </div>
        )}

        {!busy && mode === "trip" && trip && (
          <div className="mt-4 border-t border-line pt-4">
            <p className="font-semibold tabular-nums text-ink">{tripSummary(trip)}</p>
            {tripZone && <p className="mt-1 text-ink-muted">{tripZone}</p>}
            {trip.lines.length > 0 && (
              <ul className="mt-3 divide-y divide-line border-y border-line">
                {trip.lines.map((l) => (
                  <li key={l.category} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2">
                    <span className="text-ink">{l.category}</span>
                    <span className="tabular-nums text-ink">{tripLineText(l, trip.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
            {tripNotes(trip).map((n) => <p key={n} className="mt-2 text-ink-muted tabular-nums">{n}</p>)}
            <Guidance />
          </div>
        )}

        {!busy && mode === "ask" && answer && (
          <div className="mt-4 border-t border-line pt-4">
            <p className={answer.covered ? "text-ink" : "font-semibold text-warning"}>{answer.answer}</p>
            {answer.covered && answer.quote && (
              <figure className="mt-3 rounded-control bg-surface-muted p-3">
                <blockquote className="text-ink break-words">&ldquo;{answer.quote}&rdquo;</blockquote>
                {answer.policy_title && (
                  <figcaption className="mt-1 text-xs text-ink-muted">From {answer.policy_title}</figcaption>
                )}
              </figure>
            )}
            <Guidance />
          </div>
        )}
      </div>
    </section>
  );
}
