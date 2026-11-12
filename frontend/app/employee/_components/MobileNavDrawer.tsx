"use client";

import MobileDrawer from "@/components/shell/MobileDrawer";
import { useAuth } from "@/context/AuthContext";
import { portalLabelForRole } from "@/lib/roles";
import { drawerLinksForRole } from "./navLinks";

export default function MobileNavDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  return (
    <MobileDrawer
      open={open}
      onClose={onClose}
      portal={portalLabelForRole(user?.role)}
      links={drawerLinksForRole(user?.role)}
    />
  );
}
