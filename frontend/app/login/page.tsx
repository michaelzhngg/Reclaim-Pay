"use client";

import PayPalMark from "@/components/ui/PayPalMark";
import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useAuth } from "@/context/AuthContext";
import { Eye, EyeOff, ArrowRight, Users, ShieldCheck, Mail, Lock, Loader2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import dynamic from "next/dynamic";
import LoadingOverlay from "@/components/LoadingOverlay";
import { btn, input as inputRecipe } from "@/components/ui/styles";

const HeroScene = dynamic(() => import("@/components/three/HeroScene"), { ssr: false });

const formSchema = z.object({
  email: z.string().email({ message: "Enter a valid email address." }),
  password: z.string().min(1, { message: "Password is required." }),
});

// ─── Main Component ──────────────────────────────────────────────────────────

const DEMO_CREDENTIALS: Record<"hr" | "employee", { email: string; password: string }> = {
  hr: { email: "hr@example.com", password: "password" },
  employee: { email: "employee@example.com", password: "password" },
};

const PAYPAL_FAILED_MESSAGE =
  "We couldn't sign you in with PayPal. Use your email and password, or ask HR to check your PayPal link.";

const PASSWORD_DONE_MESSAGE: Record<string, string> = {
  set: "Password set. Sign in.",
  changed: "Password changed. Sign in.",
};

const inputClass = `${inputRecipe} aria-invalid:shadow-[0_0_0_1px_var(--color-danger),0_0_0_4px_rgb(196_21_63/0.12)]`;

export default function LoginPage() {
  const { login, isLoading } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordDone, setPasswordDone] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [demoBanner, setDemoBanner] = useState<"hr" | "employee" | null>(null);
  const [openingPayPal, setOpeningPayPal] = useState(false);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  async function handleDemoLogin(role: "hr" | "employee") {
    setError(null);
    setDemoBanner(role);
    setIsValidating(true);
    const creds = DEMO_CREDENTIALS[role];
    form.setValue("email", creds.email);
    form.setValue("password", creds.password);
    try {
      await login(creds.email, creds.password);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Demo sign-in failed. Try again.";
      setError(message);
      setDemoBanner(null);
    } finally {
      setIsValidating(false);
    }
  }

  async function onSubmit(values: z.infer<typeof formSchema>) {
    setError(null);
    setIsValidating(true);
    try {
      await login(values.email, values.password);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Login failed. Please check your credentials.";
      setError(message);
    } finally {
      setIsValidating(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const demo = params.get("demo");

    if (params.get("paypal") === "failed") {
      setError(PAYPAL_FAILED_MESSAGE);
      window.history.replaceState(null, "", "/login");
    }

    const done = PASSWORD_DONE_MESSAGE[params.get("password") ?? ""];
    if (done) {
      setPasswordDone(done);
      window.history.replaceState(null, "", "/login");
    }

    if (demo === "hr" || demo === "employee") {
      const creds = DEMO_CREDENTIALS[demo];
      form.setValue("email", creds.email);
      form.setValue("password", creds.password);
      setDemoBanner(demo);
      setIsValidating(true);
      login(creds.email, creds.password).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Demo sign-in failed. Try again.";
        setError(message);
        setDemoBanner(null);
      }).finally(() => setIsValidating(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Coming back from PayPal with the browser's Back button restores this page from memory, mid-"Opening".
  useEffect(() => {
    const reset = () => setOpeningPayPal(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const busy = isLoading || isValidating;

  return (
    <>
      <LoadingOverlay show={isLoading} />
      <main className="flex min-h-dvh w-full bg-white">
        {/* Left, desktop only: brand panel with the live payout card. */}
        <section
          aria-labelledby="login-intro"
          className="mesh-ink relative hidden w-[46%] flex-col justify-between overflow-hidden p-10 text-white lg:flex xl:p-14"
        >
          <div aria-hidden="true" className="dot-grid-light absolute inset-0 [mask-image:radial-gradient(80%_60%_at_30%_0%,black,transparent)]" />
          <div aria-hidden="true" className="absolute -right-48 top-1/4 h-[640px] w-[640px] rounded-full" style={{ background: "radial-gradient(closest-side, #009cde, transparent)", opacity: 0.3 }} />
          <div aria-hidden="true" className="absolute -bottom-56 -left-10 h-[600px] w-[600px] rounded-full" style={{ background: "radial-gradient(closest-side, #9e00b4, transparent)", opacity: 0.3 }} />

          <Link href="/" className="relative z-10 flex w-fit items-center gap-2 rounded-full">
            <Image src="/images/logo.svg" alt="" width={28} height={28} className="h-7 w-7 brightness-0 invert" priority />
            <span className="font-headline text-[20px] font-semibold tracking-[-0.03em]" translate="no">
              Reclaim <span className="text-paypal-sky">Pay</span>
            </span>
          </Link>

          <div className="relative z-10 h-[340px] xl:h-[400px]">
            <HeroScene className="h-full w-full" />
          </div>

          <div className="relative z-10 max-w-md">
            <h1 id="login-intro" className="font-headline text-[38px] font-medium leading-[1.05] tracking-[-0.04em] xl:text-[46px]">
              Expense claims, <span className="text-paypal-sky">paid to your PayPal.</span>
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-white/65">
              Clean claims are paid in under a minute. Anything unusual goes to HR with the evidence.
            </p>
            <p className="mt-8 text-[12px] text-white/45">Demo build. Every payment uses the PayPal sandbox.</p>
          </div>
        </section>

        {/* Right: sign in. */}
        <section className="flex min-h-dvh flex-1 flex-col items-center overflow-y-auto bg-marshmallow px-5 py-8 sm:px-8 lg:bg-white">
          <div className="flex w-full max-w-[420px] items-center justify-between lg:hidden">
            <Link href="/" className="flex items-center gap-2 rounded-full">
              <Image src="/images/logo.svg" alt="" width={26} height={26} className="h-[26px] w-[26px]" priority />
              <span className="font-headline text-[19px] font-semibold tracking-[-0.03em] text-on-surface" translate="no">
                Reclaim <span className="text-paypal-blue">Pay</span>
              </span>
            </Link>
          </div>

          <div className="my-auto w-full max-w-[420px] py-10">
            <div className="rounded-[28px] bg-white p-6 shadow-ambient-lg sm:p-8 lg:p-0 lg:shadow-none">
              <h2 className="font-headline text-[30px] font-semibold tracking-[-0.035em] text-on-surface">
                Sign in to Reclaim Pay
              </h2>
              <p className="mt-1.5 text-[15px] text-on-surface-variant">
                Try a demo account, or sign in with your email.
              </p>

              {/* Demo sign-in */}
              <div className="mt-7 grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => handleDemoLogin("employee")}
                  disabled={isValidating}
                  className={`${btn.secondary} w-full px-3`}
                >
                  <Users className="h-4 w-4 text-primary" aria-hidden="true" />
                  Employee Demo
                </button>
                <button
                  type="button"
                  onClick={() => handleDemoLogin("hr")}
                  disabled={isValidating}
                  className={`${btn.secondary} w-full px-3`}
                >
                  <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                  HR Demo
                </button>
              </div>

              <div className="my-6 flex items-center gap-3 text-[12px] text-on-surface-variant" aria-hidden="true">
                <span className="h-px flex-1 bg-on-surface/10" />
                or with email
                <span className="h-px flex-1 bg-on-surface/10" />
              </div>

              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
                <div aria-live="polite" className="space-y-2 empty:hidden">
                  {passwordDone && !error && !demoBanner && (
                    <div role="status" className="rounded-xl bg-success-soft px-4 py-2.5 text-center text-[13px] font-medium text-success">
                      {passwordDone}
                    </div>
                  )}
                  {demoBanner && !error && (
                    <div role="status" className="flex items-center justify-center gap-2 rounded-xl bg-primary/[0.06] px-4 py-2.5 text-[13px] font-medium text-primary">
                      <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-primary" aria-hidden="true" />
                      Signing in to the {demoBanner === "hr" ? "HR" : "employee"} demo account…
                    </div>
                  )}
                  {error && (
                    <div role="alert" className="rounded-xl bg-danger-soft px-4 py-2.5 text-center text-[13px] font-medium text-danger">
                      {error}
                    </div>
                  )}
                </div>

                <div>
                  <label className="mb-1.5 block text-[13px] font-medium text-on-surface" htmlFor="email">
                    Email
                  </label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-on-surface-variant/70" aria-hidden="true" />
                    <input
                      className={`${inputClass} pl-10`}
                      id="email"
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      spellCheck={false}
                      placeholder="name@company.com"
                      aria-invalid={form.formState.errors.email ? true : undefined}
                      aria-describedby={form.formState.errors.email ? "email-error" : undefined}
                      {...form.register("email")}
                    />
                  </div>
                  {form.formState.errors.email && (
                    <p id="email-error" className="mt-1.5 text-[13px] text-danger">{form.formState.errors.email.message}</p>
                  )}
                </div>

                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className="block text-[13px] font-medium text-on-surface" htmlFor="password">
                      Password
                    </label>
                    <Link
                      href="/forgot-password"
                      className="-my-2 -mr-2 inline-flex min-h-11 items-center rounded-lg px-2 text-[13px] font-medium text-primary hover:text-primary-dim"
                    >
                      Forgot password?
                    </Link>
                  </div>
                  <div className="relative">
                    <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-on-surface-variant/70" aria-hidden="true" />
                    <input
                      className={`${inputClass} pl-10 pr-12`}
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      placeholder="Your password"
                      aria-invalid={form.formState.errors.password ? true : undefined}
                      aria-describedby={form.formState.errors.password ? "password-error" : undefined}
                      {...form.register("password")}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center rounded-xl text-on-surface-variant transition-colors hover:text-on-surface"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                    </button>
                  </div>
                  {form.formState.errors.password && (
                    <p id="password-error" className="mt-1.5 text-[13px] text-danger">{form.formState.errors.password.message}</p>
                  )}
                </div>

                <button className={`${btn.dark} ${btn.lg} mt-2 w-full`} type="submit" disabled={busy} aria-busy={busy}>
                  {busy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      Signing in…
                    </>
                  ) : (
                    <>
                      Sign in
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </>
                  )}
                </button>
              </form>

              <div className="mt-6 border-t border-on-surface/[0.08] pt-6">
                {/* A plain link: this route handler redirects to PayPal, so client-side navigation and prefetch must stay off it. */}
                <a
                  href="/login/paypal/start"
                  aria-disabled={openingPayPal}
                  onClick={(event) => {
                    if (openingPayPal) event.preventDefault();
                    setOpeningPayPal(true);
                  }}
                  className={`${btn.secondary} ${btn.lg} w-full aria-disabled:opacity-60`}
                >
                  <PayPalMark className="h-5 w-5 shrink-0" />
                  {openingPayPal ? "Opening PayPal…" : "Sign in with PayPal"}
                </a>
                <p className="mt-2 text-center text-[13px] text-on-surface-variant">
                  For employees who have linked PayPal in Settings.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
