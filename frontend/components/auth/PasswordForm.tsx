"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Check, Eye, EyeOff, Loader2 } from "lucide-react";
import { btn, input as inputRecipe } from "@/components/ui/styles";
import { setPassword, type PasswordPurpose } from "@/lib/actions/password";
import { passwordChecklist, passwordIsAcceptable, passwordProblems, PASSWORD_TOO_LONG } from "@/lib/passwordPolicy";

const schema = z
  .object({ password: z.string(), confirm: z.string() })
  .refine((v) => passwordIsAcceptable(v.password, v.confirm), { message: "Meet every rule below.", path: ["password"] });

type Values = z.infer<typeof schema>;

const SUBMIT = { invite: "Set password", reset: "Change password" } as const;
const DONE_PARAM = { invite: "set", reset: "changed" } as const;

/** Shared by /set-password and /reset-password. The rules come from lib/passwordPolicy, which mirrors the backend. */
export default function PasswordForm({ token, purpose }: { token: string; purpose: PasswordPurpose }) {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { password: "", confirm: "" } });
  const password = useWatch({ control: form.control, name: "password" });
  const confirm = useWatch({ control: form.control, name: "confirm" });
  const items = passwordChecklist(password, confirm);
  const tooLong = passwordProblems(password).includes(PASSWORD_TOO_LONG);
  const ready = passwordIsAcceptable(password, confirm);
  const busy = form.formState.isSubmitting;

  async function onSubmit(values: Values) {
    setError(null);
    const result = await setPassword(token, purpose, values.password);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.push(`/login?password=${DONE_PARAM[purpose]}`);
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div aria-live="polite">
        {error && (
          <p role="alert" className="rounded-xl bg-danger-soft px-4 py-2.5 text-[13px] font-medium text-danger">
            {error}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="new-password" className="mb-1.5 block text-[13px] font-medium text-on-surface">
          New password
        </label>
        <div className="relative">
          <input
            id="new-password"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            className={`${inputRecipe} pr-12`}
            aria-describedby="password-rules"
            aria-invalid={tooLong || undefined}
            {...form.register("password")}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "Hide passwords" : "Show passwords"}
            aria-pressed={show}
            className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center rounded-xl text-on-surface-variant transition-colors hover:text-on-surface"
          >
            {show ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
      </div>

      <div>
        <label htmlFor="confirm-password" className="mb-1.5 block text-[13px] font-medium text-on-surface">
          Type it again
        </label>
        <input
          id="confirm-password"
          type={show ? "text" : "password"}
          autoComplete="new-password"
          className={inputRecipe}
          aria-describedby="password-rules"
          {...form.register("confirm")}
        />
      </div>

      <div id="password-rules">
        <p className="text-[13px] font-medium text-on-surface">Your password needs</p>
        <ul className="mt-2 grid gap-1.5 text-[13px]">
          {items.map((item) => (
            <li key={item.id} className={`flex items-center gap-2 ${item.met ? "text-success" : "text-on-surface-variant"}`}>
              <span
                aria-hidden="true"
                className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${item.met ? "bg-success-soft" : "border border-line-strong"}`}
              >
                {item.met && <Check className="h-3 w-3" />}
              </span>
              {item.label}
              <span className="sr-only">{item.met ? ", done" : ", not yet"}</span>
            </li>
          ))}
        </ul>
        {tooLong && <p className="mt-2 text-[13px] font-medium text-danger">{PASSWORD_TOO_LONG}</p>}
      </div>

      <button type="submit" className={`${btn.dark} ${btn.lg} w-full`} disabled={!ready || busy} aria-busy={busy}>
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Saving…
          </>
        ) : (
          SUBMIT[purpose]
        )}
      </button>
    </form>
  );
}
