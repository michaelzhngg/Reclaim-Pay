/** Where the submit dialog is. "closed" means the review form is showing. */
export type SubmitPhase = "closed" | "checking" | "result" | "error";

/**
 * What an Escape or close attempt does. Mid-check the dialog stays open, since
 * closing would hide the progress; the person is told they can leave instead.
 */
export function closeAttempt(phase: SubmitPhase): "close" | "notice" | "ignore" {
  if (phase === "checking") return "notice";
  if (phase === "result" || phase === "error") return "close";
  return "ignore";
}

/** One line naming the claim: the first merchant, plus how many more receipts. */
export function claimSummary(merchants: string[]): string {
  const named = merchants.map(m => m.trim()).filter(Boolean);
  if (merchants.length === 0) return "Your claim";
  const first = named[0] ?? "Receipt 1";
  const rest = merchants.length - 1;
  return rest > 0 ? `${first} and ${rest} more receipt${rest === 1 ? "" : "s"}` : first;
}
