"use server";

// Public password flows: forgot password, and setting a password from an invite or reset link.

import { apiPost, API_PREFIX } from "@/lib/api/client";

export type PasswordPurpose = "invite" | "reset";

export interface PasswordTokenInfo {
  purpose: PasswordPurpose;
  name: string;
  email_masked: string;
  expires_at: string;
}

const TOO_MANY = "Too many attempts. Wait a minute and try again.";
const OFFLINE = "We couldn't reach Reclaim Pay. Check your connection and try again.";

function friendly(error: string, status?: number): string {
  if (status === 429) return TOO_MANY;
  if (!status) return OFFLINE;
  return error;
}

export async function requestPasswordReset(email: string): Promise<{ error: string | null }> {
  const result = await apiPost<{ detail: string }>(`${API_PREFIX}/auth/forgot-password`, { email });
  return { error: result.error ? friendly(result.error, result.status) : null };
}

/** null `info` means the link is unknown, expired or already used. */
export async function checkPasswordToken(
  token: string,
  purpose: PasswordPurpose,
): Promise<{ info: PasswordTokenInfo | null; error: string | null }> {
  if (!token) return { info: null, error: null };
  const result = await apiPost<PasswordTokenInfo>(`${API_PREFIX}/auth/password-token`, { token, purpose });
  if (result.data) return { info: result.data, error: null };
  return { info: null, error: result.status === 400 ? null : friendly(result.error ?? "", result.status) };
}

export async function setPassword(
  token: string,
  purpose: PasswordPurpose,
  newPassword: string,
): Promise<{ error: string | null }> {
  const result = await apiPost<{ purpose: PasswordPurpose }>(`${API_PREFIX}/auth/set-password`, {
    token,
    purpose,
    new_password: newPassword,
  });
  return { error: result.error ? friendly(result.error, result.status) : null };
}
