import type { Metadata } from "next";
import PasswordLinkPage from "@/components/auth/PasswordLinkPage";

// no-referrer: the token in this URL must not travel to other sites.
export const metadata: Metadata = { title: "Set your password | Reclaim Pay", referrer: "no-referrer" };

export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <PasswordLinkPage token={typeof token === "string" ? token : ""} purpose="invite" />;
}
