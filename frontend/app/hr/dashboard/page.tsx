import { getHRClaims } from "@/lib/actions/hr";
import ClaimsQueue from "./_components/ClaimsQueue";

// Loads the claims during the server render (loading.tsx shows meanwhile), so the browser
// doesn't wait for hydration and the session check before it can ask for them.
export default async function HRDashboardPage() {
  const initial = await getHRClaims().catch(() => null);
  return <ClaimsQueue initial={initial} />;
}
