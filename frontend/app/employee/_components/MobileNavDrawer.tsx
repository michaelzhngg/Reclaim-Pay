"use client";

import MobileDrawer from "@/components/shell/MobileDrawer";
import { EMPLOYEE_DRAWER_LINKS } from "./navLinks";

export default function MobileNavDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <MobileDrawer open={open} onClose={onClose} portal="Employee" links={EMPLOYEE_DRAWER_LINKS} />;
}
