// Mirrors backend/core/password_policy.py; change both together.

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_TOO_LONG =
  `Use a shorter password. The limit is ${PASSWORD_MAX_BYTES} bytes, and emoji or accented letters count as more than one.`;

export interface ChecklistItem {
  id: "length" | "upper" | "lower" | "digit" | "special" | "match";
  label: string;
  met: boolean;
}

// Code points, not UTF-16 units, so an emoji counts once like Python's len().
const length = (p: string) => Array.from(p).length;
const bytes = (p: string) => new TextEncoder().encode(p).length;

const RULES: { id: ChecklistItem["id"]; label: string; problem: string; test: (p: string) => boolean }[] = [
  { id: "length", label: `${PASSWORD_MIN_LENGTH} or more characters`, problem: `Use at least ${PASSWORD_MIN_LENGTH} characters.`, test: (p) => length(p) >= PASSWORD_MIN_LENGTH },
  { id: "upper", label: "An uppercase letter", problem: "Add an uppercase letter.", test: (p) => /[A-Z]/.test(p) },
  { id: "lower", label: "A lowercase letter", problem: "Add a lowercase letter.", test: (p) => /[a-z]/.test(p) },
  { id: "digit", label: "A number", problem: "Add a number.", test: (p) => /[0-9]/.test(p) },
  { id: "special", label: "A special character, such as ! or #", problem: "Add a special character, such as ! or #.", test: (p) => /[^A-Za-z0-9\s]/.test(p) },
];

/** The same messages, in the same order, as the backend's password_problems(). */
export function passwordProblems(password: string): string[] {
  const problems = RULES.filter((r) => !r.test(password)).map((r) => r.problem);
  if (bytes(password) > PASSWORD_MAX_BYTES) problems.push(PASSWORD_TOO_LONG);
  return problems;
}

export function passwordChecklist(password: string, confirm: string): ChecklistItem[] {
  return [
    ...RULES.map((r) => ({ id: r.id, label: r.label, met: r.test(password) })),
    { id: "match", label: "Both passwords match", met: password.length > 0 && password === confirm },
  ];
}

export function passwordIsAcceptable(password: string, confirm: string): boolean {
  return passwordProblems(password).length === 0 && password === confirm;
}
