"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { getDraftCount } from "@/lib/actions/claims";
import { useAuth } from "@/context/AuthContext";
import { portalLabelForRole } from "@/lib/roles";
import SidebarNav from "@/components/shell/SidebarNav";
import { navLinksForRole } from "./navLinks";

export default function SideNav() {
  const pathname = usePathname();
  const { user } = useAuth();
  const [draftCount, setDraftCount] = useState(0);

  useEffect(() => {
    getDraftCount().then((count) => setDraftCount(count));
  }, [pathname]); // refresh on navigation

  return (
    <SidebarNav
      portal={portalLabelForRole(user?.role)}
      supportHref="/employee/support"
      links={navLinksForRole(user?.role).map((l) =>
        l.href === "/employee/drafts" ? { ...l, badge: draftCount } : l,
      )}
    />
  );
}
