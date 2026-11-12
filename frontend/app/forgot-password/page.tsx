"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Loader2, Mail } from "lucide-react";
import AuthShell from "@/components/auth/AuthShell";
import { btn, input as inputRecipe } from "@/components/ui/styles";
import { requestPasswordReset } from "@/lib/actions/password";

const schema = z.object({ email: z.string().trim().email({ message: "Enter a valid email address." }) });
type Values = z.infer<typeof schema>;

const inputClass = `${inputRecipe} pl-10 aria-invalid:shadow-[0_0_0_1px_var(--color-danger),0_0_0_4px_rgb(196_21_63/0.12)]`;

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "" } });
  const busy = form.formState.isSubmitting;
  const fieldError = form.formState.errors.email?.message;

  async function onSubmit(values: Values) {
    setError(null);
    const result = await requestPasswordReset(values.email);
    if (result.error) setError(result.error);
    else setSent(true);
  }

  return (
    <AuthShell
      title="Reset your password"
      intro={sent ? undefined : "Enter the email you sign in with. We'll send you a link to choose a new password."}
    >
      <div aria-live="polite">
        {sent && (
          <div role="status">
            <p className="text-[15px] font-medium text-on-surface">
              If an account exists for that email, we sent a reset link.
            </p>
            <p className="mt-2 text-[14px] text-on-surface-variant">
              The link works for 30 minutes. Check your spam folder if it hasn&apos;t arrived in a few minutes.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="mb-4 rounded-xl bg-danger-soft px-4 py-2.5 text-[13px] font-medium text-danger">
            {error}
          </p>
        )}
      </div>

      {!sent && (
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div>
            <label htmlFor="email" className="mb-1.5 block text-[13px] font-medium text-on-surface">
              Email
            </label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-on-surface-variant/70" aria-hidden="true" />
              <input
                id="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                placeholder="name@company.com"
                className={inputClass}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? "email-error" : undefined}
                {...form.register("email")}
              />
            </div>
            {fieldError && <p id="email-error" className="mt-1.5 text-[13px] text-danger">{fieldError}</p>}
          </div>

          <button type="submit" className={`${btn.dark} ${btn.lg} w-full`} disabled={busy} aria-busy={busy}>
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Sending…
              </>
            ) : (
              "Send reset link"
            )}
          </button>
        </form>
      )}

      <Link href="/login" className={`${btn.secondary} ${btn.lg} mt-4 w-full`}>
        Back to sign in
      </Link>
    </AuthShell>
  );
}
