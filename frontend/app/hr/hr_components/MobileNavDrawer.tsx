"use client";

import MobileDrawer from "@/components/shell/MobileDrawer";
import { HR_DRAWER_LINKS } from "./navLinks";

export default function MobileNavDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <MobileDrawer open={open} onClose={onClose} portal="HR" links={HR_DRAWER_LINKS} />;
}
