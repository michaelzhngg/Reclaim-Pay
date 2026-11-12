"use client";

import Link from "next/link";
import { formatClaimRef } from "@/lib/format";

/** The claim reference as a link to the read-only claim page. */
export default function ClaimLink({ reimId }: { reimId: string }) {
  return (
    <Link
      href={`/hr/view/${reimId}`}
      className="inline-flex items-center min-h-[44px] -my-2 rounded-md font-mono text-xs text-accent underline underline-offset-2 hover:text-accent-hover focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
    >
      {formatClaimRef(reimId)}
    </Link>
  );
}
