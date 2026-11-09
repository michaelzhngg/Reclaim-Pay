"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import TopBar from "@/components/shell/TopBar";
import { btn } from "@/components/ui/styles";
import { EMPLOYEE_LINKS } from "./navLinks";

export default function TopNav() {
  return (
    <TopBar
      portal="Employee"
      links={EMPLOYEE_LINKS}
      helpHref="/employee/support"
      settingsHref="/employee/settings"
      actions={
        <Link
          id="topnav-upload-claim-btn"
          href="/employee/claims"
          className={`${btn.primary} ${btn.sm} mr-1 max-md:hidden`}
        >
          <Plus className="h-4 w-4" strokeWidth={2.25} aria-hidden="true" />
          New Claim
        </Link>
      }
    />
  );
}
