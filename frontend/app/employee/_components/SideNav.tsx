"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { getDraftCount } from "@/lib/actions/claims";
import SidebarNav from "@/components/shell/SidebarNav";
import { EMPLOYEE_LINKS } from "./navLinks";

export default function SideNav() {
  const pathname = usePathname();
  const [draftCount, setDraftCount] = useState(0);

  useEffect(() => {
    getDraftCount().then((count) => setDraftCount(count));
  }, [pathname]); // refresh on navigation

  return (
    <SidebarNav
      portal="Employee"
      supportHref="/employee/support"
      links={EMPLOYEE_LINKS.map((l) =>
        l.href === "/employee/drafts" ? { ...l, badge: draftCount } : l,
      )}
    />
  );
}
