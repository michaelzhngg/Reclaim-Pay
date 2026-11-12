import Link from "next/link";
import AuthShell from "@/components/auth/AuthShell";
import PasswordForm from "@/components/auth/PasswordForm";
import { btn } from "@/components/ui/styles";
import { checkPasswordToken, type PasswordPurpose } from "@/lib/actions/password";

const DEAD_LINK = {
  invite: "This link has expired or was already used. Ask HR to send a new invitation.",
  reset: "This link has expired or was already used. Request a new reset link.",
} as const;

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** Server side: the token is checked before any form shows, so a dead link never asks for a password. */
export default async function PasswordLinkPage({ token, purpose }: { token: string; purpose: PasswordPurpose }) {
  const { info, error } = await checkPasswordToken(token, purpose);

  if (error) {
    return (
      <AuthShell title="Something went wrong">
        <p role="alert" className="text-[15px] text-on-surface">{error}</p>
      </AuthShell>
    );
  }

  if (!info) {
    return (
      <AuthShell title="This link no longer works">
        <p role="alert" className="text-[15px] text-on-surface">{DEAD_LINK[purpose]}</p>
        <div className="mt-6 flex flex-col gap-2.5">
          {purpose === "reset" && (
            <Link href="/forgot-password" className={`${btn.dark} ${btn.lg} w-full`}>
              Request a new reset link
            </Link>
          )}
          <Link href="/login" className={`${btn.secondary} ${btn.lg} w-full`}>
            Back to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  const name = firstName(info.name);
  return purpose === "invite" ? (
    <AuthShell
      title={name ? `Welcome, ${name}` : "Welcome"}
      intro={<>Set your password for <span className="font-medium text-on-surface">{info.email_masked}</span>. You&apos;ll use it to sign in to Reclaim Pay.</>}
    >
      <PasswordForm token={token} purpose="invite" />
    </AuthShell>
  ) : (
    <AuthShell
      title="Choose a new password"
      intro={<>For <span className="font-medium text-on-surface">{info.email_masked}</span>. Saving it signs you out on every other device.</>}
    >
      <PasswordForm token={token} purpose="reset" />
    </AuthShell>
  );
}
